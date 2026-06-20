import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as route53resolver from 'aws-cdk-lib/aws-route53resolver';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface VpcLatticeIngressStackProps extends cdk.StackProps {
  /** ARN of the RAM-shared service network to expose through the SN-E. */
  serviceNetworkArn: string;
  /** Ingress VPC where the SN-E ENIs are created. Defaults to the foundation Ingress VPC from SSM. */
  ingressVpcId?: string;
  /** Subnets (one per AZ, /28 or larger) for the SN-E ENIs. Defaults to the foundation Ingress subnets from SSM. */
  ingressSubnetIds?: string[];
  /** IPv4 CIDR allowed to reach the SN-E on the workload app port(s). Never 0.0.0.0/0. */
  consumerSourceCidr: string;
  /** Consumer-facing workload application port(s) the SN-E fronts. Defaults to [80]. */
  appPorts?: number[];
  /** VPC Lattice managed prefix list ID; scopes SN-E egress to the Lattice data plane. */
  latticePrefixListId: string;
  /** Create an inbound Route 53 Resolver endpoint for on-premises / cross-Region resolvers. */
  createInboundResolver?: boolean;
  /** IPv4 CIDR of resolvers allowed to query the inbound Resolver endpoint (when enabled). */
  resolverQuerySourceCidr?: string;
  /** Environment this SN-E fronts (dev/test/prod); sets the SSM publish path. */
  environment?: string;
  /** SSM namespace under which the SN-E ID is published. */
  ssmPrefix?: string;
  /** Single token that namespaces resource Name tags. */
  resourcePrefix?: string;
}

/**
 * VpcLatticeIngressStack (Network account): Phase 5 ingress, minimal SN-E.
 *
 * Stands up a Service Network VPC Endpoint (SN-E) that fronts a workload
 * application (exposed on the RAM-shared service network as a Resource
 * Configuration) to consumers an association (SN-A) cannot serve: external
 * clients in another AWS Organization, on-premises over Direct Connect or VPN,
 * and cross-Region consumers. Those consumers reach this Ingress VPC over their
 * own backbone (Cloud WAN attachment, VPC peering, Transit Gateway, or DX/VPN),
 * then traverse SN-E -> service network -> workload Resource Gateway -> app.
 * Nothing on this path is internet-facing.
 *
 * This is the Network-account piece only. The custom-domain DNS record that
 * maps your domain to the endpoint's generated name is created by the ingress
 * DNS automation (VpcLatticeIngressDnsStack). An optional inbound Route 53
 * Resolver endpoint is included so on-premises and cross-Region resolvers can
 * resolve the Lattice-managed names.
 *
 * Kept at parity with cloudformation/vpc-lattice-ingress-sne.yaml.
 */
export class VpcLatticeIngressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VpcLatticeIngressStackProps) {
    super(scope, id, props);

    const resourcePrefix = props.resourcePrefix ?? 'netfabric';
    const ssmPrefix = props.ssmPrefix ?? `/${resourcePrefix}`;
    const environment = props.environment ?? 'dev';
    const appPorts = props.appPorts ?? [80];

    // Ingress VPC and subnets default to the foundation Ingress VPC (published
    // to SSM by NetworkFoundationStack), mirroring how the endpoints and Squid
    // stacks resolve their VPCs. Context values still override.
    const ingressVpcId = props.ingressVpcId
      ?? ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/network/ingress-vpc/id`);
    const ingressSubnetIds = props.ingressSubnetIds
      ?? ['a', 'b', 'c'].map((z) =>
        ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/network/ingress-vpc/subnet/${z}/id`));

    // SG for the SN-E ENIs: external/on-premises/cross-Region consumers connect
    // inbound on the workload app port(s); the SN-E forwards into the Lattice
    // data plane on the same port(s). Both ingress (consumer CIDR) and egress
    // (Lattice managed prefix list) are tightly scoped, never 0.0.0.0/0.
    const sneSg = new ec2.CfnSecurityGroup(this, 'SneSecurityGroup', {
      groupDescription: `${resourcePrefix} VPC Lattice SN-E ingress to workload app`,
      vpcId: ingressVpcId,
      securityGroupIngress: appPorts.map((p) => ({
        ipProtocol: 'tcp',
        fromPort: p,
        toPort: p,
        cidrIp: props.consumerSourceCidr,
        description: `Workload app port ${p} from approved consumers (external / on-premises / cross-Region)`,
      })),
      securityGroupEgress: appPorts.map((p) => ({
        ipProtocol: 'tcp',
        fromPort: p,
        toPort: p,
        destinationPrefixListId: props.latticePrefixListId,
        description: `Workload app port ${p} into the VPC Lattice data plane`,
      })),
      tags: [{ key: 'Name', value: `${resourcePrefix}-sne-sg` }],
    });

    // Service Network VPC Endpoint. Unlike an association, an SN-E publishes a
    // generated DNS name per associated service/resource; you map your custom
    // domain to it with a CNAME or Route 53 alias (created by the DNS
    // automation, deferred to the AWS Guidance solution).
    const sne = new ec2.CfnVPCEndpoint(this, 'ServiceNetworkEndpoint', {
      vpcEndpointType: 'ServiceNetwork',
      serviceNetworkArn: props.serviceNetworkArn,
      vpcId: ingressVpcId,
      subnetIds: ingressSubnetIds,
      securityGroupIds: [sneSg.ref],
      ipAddressType: 'ipv4',
      // Custom-domain DNS is managed by this guide's ingress DNS automation (the
      // ingress.internal private hosted zone + CNAME records), so the SN-E's own
      // managed private DNS is not needed. Keeping it disabled also avoids a
      // CloudFormation stabilization timeout: with private DNS enabled the
      // endpoint provisions a managed hosted zone for every associated resource
      // configuration, which on a service network with many associations can
      // exceed the AWS::EC2::VPCEndpoint stabilization window and fail the stack.
      // PrivateDnsEnabled is immutable, so it must be set at creation time.
      privateDnsEnabled: false,
      tags: [{ key: 'Name', value: `${resourcePrefix}-sne` }],
    });

    // Optional inbound Route 53 Resolver endpoint so external/on-premises and
    // cross-Region resolvers can resolve the Lattice-managed names. The private
    // hosted zone and the custom-domain record are created by the DNS
    // automation (the AWS Guidance solution), not by this stack.
    if (props.createInboundResolver) {
      const resolverCidr = props.resolverQuerySourceCidr ?? '192.0.2.0/24';
      const resolverSg = new ec2.CfnSecurityGroup(this, 'ResolverSecurityGroup', {
        groupDescription: `${resourcePrefix} Route 53 inbound resolver`,
        vpcId: ingressVpcId,
        securityGroupIngress: [
          { ipProtocol: 'tcp', fromPort: 53, toPort: 53, cidrIp: resolverCidr, description: 'DNS over TCP from approved resolvers' },
          { ipProtocol: 'udp', fromPort: 53, toPort: 53, cidrIp: resolverCidr, description: 'DNS over UDP from approved resolvers' },
        ],
        securityGroupEgress: [
          { ipProtocol: 'udp', fromPort: 53, toPort: 53, cidrIp: props.consumerSourceCidr, description: 'DNS responses to the resolver source range' },
        ],
        tags: [{ key: 'Name', value: `${resourcePrefix}-resolver-sg` }],
      });

      new route53resolver.CfnResolverEndpoint(this, 'InboundResolverEndpoint', {
        name: `${resourcePrefix}-inbound`,
        direction: 'INBOUND',
        securityGroupIds: [resolverSg.ref],
        ipAddresses: ingressSubnetIds.slice(0, 2).map((subnetId) => ({ subnetId })),
      });
    }

    new cdk.CfnOutput(this, 'ServiceNetworkEndpointId', {
      value: sne.ref,
      description: 'SN-E ID. Read its generated DNS names with aws ec2 describe-vpc-endpoints.',
    });
    new cdk.CfnOutput(this, 'SneSecurityGroupId', { value: sneSg.ref });

    // Publish the SN-E ID so the ingress DNS automation can resolve its
    // generated DNS names (VpcLatticeIngressDnsStack reads these paths).
    new ssm.StringParameter(this, 'SneIdParam', {
      parameterName: `${ssmPrefix}/ingress/${environment}/sne/id`,
      stringValue: sne.ref,
      description: `VPC Lattice Service Network VPC Endpoint (SN-E) ID for the ${environment} environment`,
    });
  }
}
