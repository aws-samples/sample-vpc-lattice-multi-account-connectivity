import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface NetworkFoundationStackProps extends cdk.StackProps {
  /** SSM namespace prefix under which VPC/subnet/SG IDs are published. */
  ssmPrefix?: string;
  /** Single token that namespaces resource Name tags (e.g. '{prefix}-endpoint-vpc'). */
  resourcePrefix?: string;
  /** Concrete AZ names to spread subnets across (3 for a customer-grade layout). */
  availabilityZoneNames?: string[];
  endpointVpcCidr?: string;
  egressVpcCidr?: string;
  /** IPv4 CIDR for the Ingress VPC (home of the Service Network VPC Endpoint). */
  ingressVpcCidr?: string;
  /**
   * Number of NAT gateways in the Egress VPC. Defaults to one per AZ (HA), the
   * Well-Architected Reliability posture. Override to 1 for a cost-sensitive env.
   */
  egressNatGateways?: number;
}

/**
 * NetworkFoundationStack (Network Account)
 *
 * Provisions DEDICATED VPCs for the VPC Lattice reference architecture so the
 * guide does not depend on any pre-existing (e.g. Landing Zone Accelerator)
 * network. Three VPCs are created, each spanning THREE Availability Zones, and
 * every subnet is sized /22 to give VPC Lattice Resource Gateway and Service
 * Network VPC Endpoint ENIs ample contiguous address space:
 *
 *   1. Endpoint VPC  - hosts interface VPC endpoints (SSM, STS, ECR, Logs, ECS...)
 *                      with Private DNS enabled, along with a dedicated subnet/SG tier
 *                      for the VPC Lattice Resource Gateway.
 *   2. Egress VPC    - public + private(NAT-egress) subnets used by the Squid
 *                      Fargate proxy, along with a subnet/SG tier for the egress
 *                      Resource Gateway.
 *   3. Ingress VPC   - isolated subnets hosting the Service Network VPC Endpoints
 *                      (SN-E, one per environment) for external/on-premises/
 *                      cross-Region ingress (Phase 5).
 *
 * All identifiers consumed by the Lattice stacks are published to SSM under
 * `ssmPrefix` (default `/netfabric`) so the deliverable stacks resolve them
 * exactly like they would resolve LZA parameters.
 */
export class NetworkFoundationStack extends cdk.Stack {
  private readonly azNames: string[];

  // Hardcoded AZ override avoids environment lookups so the stack synthesizes
  // deterministically (and cross-account) without requiring cdk.context.json.
  get availabilityZones(): string[] {
    return this.azNames;
  }

  constructor(scope: Construct, id: string, props: NetworkFoundationStackProps = {}) {
    super(scope, id, props);

    this.azNames = props.availabilityZoneNames ?? [
      `${this.region}a`,
      `${this.region}b`,
      `${this.region}c`,
    ];

    const resourcePrefix = props.resourcePrefix ?? 'netfabric';
    const prefix = props.ssmPrefix ?? `/${resourcePrefix}`;
    const endpointVpcCidr = props.endpointVpcCidr ?? '10.5.0.0/16';
    const egressVpcCidr = props.egressVpcCidr ?? '10.6.0.0/16';
    const ingressVpcCidr = props.ingressVpcCidr ?? '10.8.0.0/16';

    // ----------------------------------------------------------------
    // Endpoint VPC: isolated subnets (no NAT) across 3 AZs
    // ----------------------------------------------------------------
    const endpointVpc = new ec2.Vpc(this, 'EndpointVpc', {
      vpcName: `${resourcePrefix}-endpoint-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(endpointVpcCidr),
      maxAzs: 3,
      natGateways: 0,
      restrictDefaultSecurityGroup: true,
      flowLogs: {
        cw: { destination: ec2.FlowLogDestination.toCloudWatchLogs() },
      },
      subnetConfiguration: [
        {
          name: 'endpoint',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 22,
        },
      ],
    });

    // SG for the interface endpoints AND the Lattice Resource Gateway in the
    // Endpoint VPC. Per the proven pattern, a single SG allows 443 from the VPC
    // CIDR (Resource Gateway -> VPCE) and from the VPC Lattice managed prefix
    // list (Lattice data plane -> Resource Gateway). Interface endpoints are
    // created in the endpoints stack so their per-endpoint DNS names can feed
    // the Resource Configurations natively.
    const latticePrefixListV4 = this.node.tryGetContext('latticePrefixListV4');

    const endpointRgSg = new ec2.SecurityGroup(this, 'EndpointRgSg', {
      vpc: endpointVpc,
      description: 'VPC endpoints + Lattice Resource Gateway - HTTPS',
      allowAllOutbound: true,
    });
    endpointRgSg.addIngressRule(
      ec2.Peer.ipv4(endpointVpc.vpcCidrBlock),
      ec2.Port.tcp(443),
      'HTTPS from within the Endpoint VPC (Resource Gateway to VPCE)',
    );
    if (latticePrefixListV4) {
      endpointRgSg.addIngressRule(
        ec2.Peer.prefixList(latticePrefixListV4),
        ec2.Port.tcp(443),
        'HTTPS from the VPC Lattice data plane (managed prefix list)',
      );
    }

    NagSuppressions.addResourceSuppressions(endpointRgSg, [
      {
        id: 'CdkNagValidationFailure',
        reason:
          'AwsSolutions-EC23 cannot evaluate the ingress source because it is the VPC CidrBlock intrinsic (Fn::GetAtt), not a literal. Ingress is scoped to the VPC CIDR and the VPC Lattice managed prefix list, never 0.0.0.0/0 or ::/0.',
      },
    ]);

    // Interface endpoints are created in VpcLatticeEndpointsStack so that each
    // endpoint's own regional DNS name (from DnsEntries) can be wired directly
    // into the matching Resource Configuration, mirroring the proven pattern.

    // ----------------------------------------------------------------
    // Egress VPC: public + private(NAT-egress) subnets across 3 AZs
    // ----------------------------------------------------------------
    const egressVpc = new ec2.Vpc(this, 'EgressVpc', {
      vpcName: `${resourcePrefix}-egress-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(egressVpcCidr),
      maxAzs: 3,
      natGateways: props.egressNatGateways ?? this.azNames.length, // one NAT per AZ (HA) by default; override to 1 for a env
      restrictDefaultSecurityGroup: true,
      flowLogs: {
        cw: { destination: ec2.FlowLogDestination.toCloudWatchLogs() },
      },
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 22 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
      ],
    });

    // SG used by both the egress Resource Gateway ENIs AND the Squid Fargate
    // tasks/NLB targets (the Squid stack resolves this single SG from SSM).
    // Inbound 3128 must be allowed from the VPC Lattice data plane (managed
    // prefix list) for the Resource Gateway, and from within the Egress VPC
    // for the internal NLB to reach the Squid tasks.
    const egressRgSg = new ec2.SecurityGroup(this, 'EgressRgSg', {
      vpc: egressVpc,
      description: 'VPC Lattice egress Resource Gateway + Squid tasks - proxy port 3128',
      allowAllOutbound: true,
    });
    if (latticePrefixListV4) {
      egressRgSg.addIngressRule(
        ec2.Peer.prefixList(latticePrefixListV4),
        ec2.Port.tcp(3128),
        'Squid proxy port from the VPC Lattice data plane (managed prefix list)',
      );
    }
    egressRgSg.addIngressRule(
      ec2.Peer.ipv4(egressVpc.vpcCidrBlock),
      ec2.Port.tcp(3128),
      'Internal NLB to Squid task within the Egress VPC',
    );

    NagSuppressions.addResourceSuppressions(egressRgSg, [
      {
        id: 'CdkNagValidationFailure',
        reason:
          'AwsSolutions-EC23 cannot evaluate the ingress source because it is the VPC CidrBlock intrinsic (Fn::GetAtt), not a literal. Ingress is scoped to the VPC CIDR and the VPC Lattice managed prefix list, never 0.0.0.0/0 or ::/0.',
      },
    ]);

    // ----------------------------------------------------------------
    // Publish identifiers to SSM (the contract consumed by Lattice stacks)
    // ----------------------------------------------------------------
    const endpointSubnetIds = endpointVpc.selectSubnets({ subnetGroupName: 'endpoint' }).subnetIds;
    const egressPrivateSubnetIds = egressVpc.selectSubnets({ subnetGroupName: 'private' }).subnetIds;

    const writeParam = (name: string, value: string, description: string) =>
      new ssm.StringParameter(this, `Param${name.replace(/[^a-zA-Z0-9]/g, '')}`, {
        parameterName: name,
        stringValue: value,
        description,
      });

    // Endpoint VPC
    writeParam(`${prefix}/network/endpoint-vpc/id`, endpointVpc.vpcId, 'Network fabric Endpoint VPC ID');
    writeParam(`${prefix}/network/endpoint-vpc/cidr`, endpointVpc.vpcCidrBlock, 'Network fabric Endpoint VPC CIDR');
    endpointSubnetIds.forEach((id, i) =>
      writeParam(
        `${prefix}/network/endpoint-vpc/subnet/${['a', 'b', 'c'][i]}/id`,
        id,
        `Network fabric Endpoint VPC Resource Gateway subnet ${['a', 'b', 'c'][i]}`,
      ),
    );
    writeParam(`${prefix}/network/endpoint-vpc/sg/rg/id`, endpointRgSg.securityGroupId, 'Network fabric Endpoint Resource Gateway SG');

    // Egress VPC
    writeParam(`${prefix}/network/egress-vpc/id`, egressVpc.vpcId, 'Network fabric Egress VPC ID');
    writeParam(`${prefix}/network/egress-vpc/cidr/ipv4`, egressVpc.vpcCidrBlock, 'Network fabric Egress VPC CIDR (IPv4)');
    egressPrivateSubnetIds.forEach((id, i) =>
      writeParam(
        `${prefix}/network/egress-vpc/subnet/${['a', 'b', 'c'][i]}/id`,
        id,
        `Network fabric Egress VPC private subnet ${['a', 'b', 'c'][i]}`,
      ),
    );
    writeParam(`${prefix}/network/egress-vpc/sg/rg/id`, egressRgSg.securityGroupId, 'Network fabric Egress Resource Gateway SG');

    // ----------------------------------------------------------------
    // Ingress VPC: isolated subnets (no NAT) across 3 AZs. Home for the
    // Service Network VPC Endpoint (SN-E) that fronts external, on-premises,
    // and cross-Region consumers (Phase 5). Attach your Direct Connect, VPN,
    // Transit Gateway, or Cloud WAN reach to this VPC; that attachment is
    // consumer-specific and out of scope for this guide.
    // ----------------------------------------------------------------
    const ingressVpc = new ec2.Vpc(this, 'IngressVpc', {
      vpcName: `${resourcePrefix}-ingress-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(ingressVpcCidr),
      maxAzs: 3,
      natGateways: 0,
      restrictDefaultSecurityGroup: true,
      flowLogs: {
        cw: { destination: ec2.FlowLogDestination.toCloudWatchLogs() },
      },
      subnetConfiguration: [
        // SN-E ENIs allocate contiguous /28 blocks per subnet, and the number of
        // blocks scales with the resource configurations/services associated to
        // the service network. With multiple SN-Es (one per environment) sharing
        // the Ingress VPC, each service network here has ~12 associations, so
        // /24 (and even /23) subnets can run out of CONTIGUOUS /28 space and the
        // SN-E fails to stabilize. /22 subnets give every SN-E ample contiguous
        // headroom so all environments provision cleanly in one VPC.
        { name: 'ingress', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 22 },
      ],
    });
    const ingressSubnetIds = ingressVpc.selectSubnets({ subnetGroupName: 'ingress' }).subnetIds;

    writeParam(`${prefix}/network/ingress-vpc/id`, ingressVpc.vpcId, 'Network fabric Ingress VPC ID');
    writeParam(`${prefix}/network/ingress-vpc/cidr`, ingressVpc.vpcCidrBlock, 'Network fabric Ingress VPC CIDR');
    ingressSubnetIds.forEach((id, i) =>
      writeParam(
        `${prefix}/network/ingress-vpc/subnet/${['a', 'b', 'c'][i]}/id`,
        id,
        `Network fabric Ingress VPC SN-E subnet ${['a', 'b', 'c'][i]}`,
      ),
    );

    // ----------------------------------------------------------------
    // Outputs
    // ----------------------------------------------------------------
    new cdk.CfnOutput(this, 'EndpointVpcId', { value: endpointVpc.vpcId });
    new cdk.CfnOutput(this, 'EgressVpcId', { value: egressVpc.vpcId });
    new cdk.CfnOutput(this, 'EndpointSubnetIds', { value: endpointSubnetIds.join(',') });
    new cdk.CfnOutput(this, 'EgressPrivateSubnetIds', { value: egressPrivateSubnetIds.join(',') });
    new cdk.CfnOutput(this, 'IngressVpcId', { value: ingressVpc.vpcId });
    new cdk.CfnOutput(this, 'IngressSubnetIds', { value: ingressSubnetIds.join(',') });
  }
}
