import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface VpcLatticeEndpointsStackProps extends cdk.StackProps {
  endpointVpcSsmPath: string;
  endpointSubnetASsmPath: string;
  endpointSubnetBSsmPath: string;
  endpointSubnetCSsmPath: string;
  endpointSgSsmPath: string;
  serviceNetworkIds: { dev: string; test: string; prod: string };
  /** AWS Organizations ID, used to scope the VPC endpoint policies. */
  orgId: string;
  /** Single token that namespaces every resource Name (Resource Gateway, RCs). */
  resourcePrefix?: string;
}

/**
 * Creates centralized interface VPC endpoints, a Lattice Resource Gateway, and
 * a Resource Configuration per endpoint in the Endpoint VPC.
 *
 * Proven pattern (mirrors the reference solution):
 *  - Interface endpoints have PrivateDnsEnabled = FALSE. The Endpoint VPC must
 *    not hijack the public service domain; instead each endpoint keeps its own
 *    regional DNS name (e.g. vpce-xxx.ssm.us-east-2.vpce.amazonaws.com).
 *  - Each Resource Configuration sets:
 *      CustomDomainName            = public service domain (what consumers
 *                                    resolve, e.g. ssm.us-east-2.amazonaws.com)
 *      DnsResource.DomainName      = the endpoint's OWN regional DNS name,
 *                                    read natively from DnsEntries (no Lambda).
 *  - RC -> service network associations set PrivateDnsEnabled = true so VPC
 *    Lattice provisions managed Private Hosted Zones for the custom domain in
 *    associated workload VPCs.
 */
export class VpcLatticeEndpointsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VpcLatticeEndpointsStackProps) {
    super(scope, id, props);

    const resourcePrefix = props.resourcePrefix ?? 'netfabric';

    // Resolve VPC / subnets / SG from SSM parameters (3 AZs)
    const endpointVpcId = ssm.StringParameter.valueForStringParameter(this, props.endpointVpcSsmPath);
    const subnetAId = ssm.StringParameter.valueForStringParameter(this, props.endpointSubnetASsmPath);
    const subnetBId = ssm.StringParameter.valueForStringParameter(this, props.endpointSubnetBSsmPath);
    const subnetCId = ssm.StringParameter.valueForStringParameter(this, props.endpointSubnetCSsmPath);
    const sgId = ssm.StringParameter.valueForStringParameter(this, props.endpointSgSsmPath);
    const subnetIds = [subnetAId, subnetBId, subnetCId];

    // VPC endpoint policy: allow only principals within the organization.
    const orgScopedPolicy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AllowOrgPrincipals',
          Effect: 'Allow',
          Principal: '*',
          Action: '*',
          Resource: '*',
          Condition: { StringEquals: { 'aws:PrincipalOrgID': props.orgId } },
        },
        {
          Sid: 'DenyNonOrgAccess',
          Effect: 'Deny',
          Principal: '*',
          Action: '*',
          Resource: '*',
          Condition: { StringNotEquals: { 'aws:PrincipalOrgID': props.orgId } },
        },
      ],
    };

    // Each endpoint: service short name (for com.amazonaws.<region>.<svc>) and
    // the public custom domain consumers resolve.
    const endpoints = [
      { key: 'ssm', service: 'ssm', customDomain: 'ssm' },
      { key: 'ssmmessages', service: 'ssmmessages', customDomain: 'ssmmessages' },
      { key: 'ec2messages', service: 'ec2messages', customDomain: 'ec2messages' },
      { key: 'sts', service: 'sts', customDomain: 'sts' },
      { key: 'logs', service: 'logs', customDomain: 'logs' },
      { key: 'ecs', service: 'ecs', customDomain: 'ecs' },
      { key: 'ecsagent', service: 'ecs-agent', customDomain: 'ecs-agent' },
      { key: 'ecstelemetry', service: 'ecs-telemetry', customDomain: 'ecs-telemetry' },
      // ECR uses dotted service names with distinct public custom domains.
      { key: 'ecrapi', service: 'ecr.api', customDomain: 'api.ecr' },
      { key: 'ecrdkr', service: 'ecr.dkr', customDomain: 'dkr.ecr' },
    ];

    // Resource Gateway in the Endpoint VPC
    const resourceGateway = new cdk.CfnResource(this, 'EndpointResourceGateway', {
      type: 'AWS::VpcLattice::ResourceGateway',
      properties: {
        Name: `${resourcePrefix}-endpoint-resource-gateway`,
        VpcIdentifier: endpointVpcId,
        SubnetIds: subnetIds,
        SecurityGroupIds: [sgId],
        IpAddressType: 'IPV4',
        Ipv4AddressesPerEni: 4,
      },
    });

    // Create endpoints + RCs + associations. Chain sequentially to avoid
    // VPC Lattice API throttling (429) on parallel association creation.
    let previous: cdk.CfnResource | undefined;
    for (const ep of endpoints) {
      // Interface endpoint with private DNS DISABLED (keeps its own regional DNS).
      const vpce = new ec2.CfnVPCEndpoint(this, `Vpce-${ep.key}`, {
        vpcEndpointType: 'Interface',
        serviceName: `com.amazonaws.${this.region}.${ep.service}`,
        vpcId: endpointVpcId,
        subnetIds,
        securityGroupIds: [sgId],
        privateDnsEnabled: false,
        policyDocument: orgScopedPolicy,
      });

      // The endpoint's own regional DNS name from DnsEntries[0], which is
      // formatted as "<hostedZoneId>:<dnsName>"; take the dnsName half.
      const vpceDnsName = cdk.Fn.select(1, cdk.Fn.split(':', cdk.Fn.select(0, vpce.attrDnsEntries)));

      const rc = new cdk.CfnResource(this, `RC-${ep.key}`, {
        type: 'AWS::VpcLattice::ResourceConfiguration',
        properties: {
          Name: `${resourcePrefix}-${ep.key}-endpoint-rc`,
          ResourceConfigurationType: 'SINGLE',
          ProtocolType: 'TCP',
          ResourceGatewayId: resourceGateway.getAtt('Id'),
          // Public domain consumers resolve; Lattice creates the PHZ for this.
          CustomDomainName: `${ep.customDomain}.${this.region}.amazonaws.com`,
          ResourceConfigurationDefinition: {
            DnsResource: {
              // The endpoint's OWN regional DNS name (resolves to VPCE ENIs).
              DomainName: vpceDnsName,
              IpAddressType: 'IPV4',
            },
          },
          PortRanges: ['443'],
        },
      });
      rc.addDependency(vpce);
      if (previous) {
        rc.addDependency(previous);
      }
      previous = rc;

      // Associate with all three service networks; PrivateDnsEnabled triggers
      // managed PHZ creation for the CustomDomainName in associated VPCs.
      for (const [envName, snId] of Object.entries(props.serviceNetworkIds)) {
        const assoc = new cdk.CfnResource(this, `RCAssoc-${ep.key}-${envName}`, {
          type: 'AWS::VpcLattice::ServiceNetworkResourceAssociation',
          properties: {
            ServiceNetworkId: snId,
            ResourceConfigurationId: rc.getAtt('Id'),
            PrivateDnsEnabled: true,
          },
        });
        assoc.addDependency(previous);
        previous = assoc;
      }
    }

    // Outputs
    new cdk.CfnOutput(this, 'ResourceGatewayId', {
      value: resourceGateway.getAtt('Id').toString(),
    });
  }
}
