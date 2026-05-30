import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface NetworkFoundationStackProps extends cdk.StackProps {
  /** SSM namespace prefix under which VPC/subnet/SG IDs are published. */
  ssmPrefix?: string;
  /** Concrete AZ names to spread subnets across (3 for a customer-grade layout). */
  availabilityZoneNames?: string[];
  endpointVpcCidr?: string;
  egressVpcCidr?: string;
}

/**
 * NetworkFoundationStack (Network Account)
 *
 * Provisions DEDICATED VPCs for the VPC Lattice reference architecture so the
 * guide does not depend on any pre-existing (e.g. Landing Zone Accelerator)
 * network. Two VPCs are created, each spanning THREE Availability Zones:
 *
 *   1. Endpoint VPC  - hosts interface VPC endpoints (SSM, STS, ECR, Logs, ECS...)
 *                      with Private DNS enabled, plus a dedicated subnet/SG tier
 *                      for the VPC Lattice Resource Gateway.
 *   2. Egress VPC    - public + private(NAT-egress) subnets used by the Squid
 *                      Fargate proxy, plus a subnet/SG tier for the egress
 *                      Resource Gateway.
 *
 * All identifiers consumed by the Lattice stacks are published to SSM under
 * `ssmPrefix` (default `/apg-lattice`) so the deliverable stacks resolve them
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

    const prefix = props.ssmPrefix ?? '/apg-lattice';
    const endpointVpcCidr = props.endpointVpcCidr ?? '10.80.0.0/16';
    const egressVpcCidr = props.egressVpcCidr ?? '10.81.0.0/16';

    // ----------------------------------------------------------------
    // Endpoint VPC: isolated subnets (no NAT) across 3 AZs
    // ----------------------------------------------------------------
    const endpointVpc = new ec2.Vpc(this, 'EndpointVpc', {
      vpcName: 'apg-lattice-endpoint-vpc',
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
          cidrMask: 24,
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

    // Interface endpoints are created in VpcLatticeEndpointsStack so that each
    // endpoint's own regional DNS name (from DnsEntries) can be wired directly
    // into the matching Resource Configuration, mirroring the proven pattern.

    // ----------------------------------------------------------------
    // Egress VPC: public + private(NAT-egress) subnets across 3 AZs
    // ----------------------------------------------------------------
    const egressVpc = new ec2.Vpc(this, 'EgressVpc', {
      vpcName: 'apg-lattice-egress-vpc',
      ipAddresses: ec2.IpAddresses.cidr(egressVpcCidr),
      maxAzs: 3,
      natGateways: 1, // single NAT GW for the reference lab; raise to 3 for prod HA
      restrictDefaultSecurityGroup: true,
      flowLogs: {
        cw: { destination: ec2.FlowLogDestination.toCloudWatchLogs() },
      },
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
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
    writeParam(`${prefix}/network/endpoint-vpc/id`, endpointVpc.vpcId, 'APG Lattice Endpoint VPC ID');
    writeParam(`${prefix}/network/endpoint-vpc/cidr`, endpointVpc.vpcCidrBlock, 'APG Lattice Endpoint VPC CIDR');
    endpointSubnetIds.forEach((id, i) =>
      writeParam(
        `${prefix}/network/endpoint-vpc/subnet/${['a', 'b', 'c'][i]}/id`,
        id,
        `APG Lattice Endpoint VPC Resource Gateway subnet ${['a', 'b', 'c'][i]}`,
      ),
    );
    writeParam(`${prefix}/network/endpoint-vpc/sg/rg/id`, endpointRgSg.securityGroupId, 'APG Lattice Endpoint Resource Gateway SG');

    // Egress VPC
    writeParam(`${prefix}/network/egress-vpc/id`, egressVpc.vpcId, 'APG Lattice Egress VPC ID');
    writeParam(`${prefix}/network/egress-vpc/cidr/ipv4`, egressVpc.vpcCidrBlock, 'APG Lattice Egress VPC CIDR (IPv4)');
    egressPrivateSubnetIds.forEach((id, i) =>
      writeParam(
        `${prefix}/network/egress-vpc/subnet/${['a', 'b', 'c'][i]}/id`,
        id,
        `APG Lattice Egress VPC private subnet ${['a', 'b', 'c'][i]}`,
      ),
    );
    writeParam(`${prefix}/network/egress-vpc/sg/rg/id`, egressRgSg.securityGroupId, 'APG Lattice Egress Resource Gateway SG');

    // ----------------------------------------------------------------
    // Outputs
    // ----------------------------------------------------------------
    new cdk.CfnOutput(this, 'EndpointVpcId', { value: endpointVpc.vpcId });
    new cdk.CfnOutput(this, 'EgressVpcId', { value: egressVpc.vpcId });
    new cdk.CfnOutput(this, 'EndpointSubnetIds', { value: endpointSubnetIds.join(',') });
    new cdk.CfnOutput(this, 'EgressPrivateSubnetIds', { value: egressPrivateSubnetIds.join(',') });
  }
}
