import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface WorkloadFoundationStackProps extends cdk.StackProps {
  /** SSM parameter path to publish the workload VPC ID under. */
  vpcSsmPath?: string;
  /** Concrete AZ names to spread subnets across (3 for a customer-grade layout). */
  availabilityZoneNames?: string[];
  vpcCidr?: string;
}

/**
 * WorkloadFoundationStack (Workload Dev Account)
 *
 * Provisions a dedicated workload VPC across THREE Availability Zones for the
 * VPC Lattice reference architecture, so onboarding does not depend on any
 * pre-existing network. The VPC ID is published to SSM at `vpcSsmPath`, which
 * WorkloadAssociationStack reads to create the service network VPC association.
 *
 * A self-resolving (private, NAT-egress) subnet tier plus an interface endpoint
 * for SSM is included so that validation (Sessions Manager, dig, AWS CLI calls)
 * can run from inside the VPC.
 */
export class WorkloadFoundationStack extends cdk.Stack {
  private readonly azNames: string[];

  get availabilityZones(): string[] {
    return this.azNames;
  }

  constructor(scope: Construct, id: string, props: WorkloadFoundationStackProps = {}) {
    super(scope, id, props);

    this.azNames = props.availabilityZoneNames ?? [
      `${this.region}a`,
      `${this.region}b`,
      `${this.region}c`,
    ];

    const vpcSsmPath = props.vpcSsmPath ?? '/apg-lattice/workload/dev-vpc/id';
    const vpcCidr = props.vpcCidr ?? '10.82.0.0/16';

    const vpc = new ec2.Vpc(this, 'WorkloadVpc', {
      vpcName: 'apg-lattice-workload-dev-vpc',
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
      maxAzs: 3,
      natGateways: 1, // bootstrap egress for SSM agent before Lattice egress is wired
      restrictDefaultSecurityGroup: true,
      flowLogs: {
        cw: { destination: ec2.FlowLogDestination.toCloudWatchLogs() },
      },
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    const appSubnetIds = vpc.selectSubnets({ subnetGroupName: 'app' }).subnetIds;

    // Publish identifiers for WorkloadAssociationStack and validation tooling.
    new ssm.StringParameter(this, 'WorkloadVpcIdParam', {
      parameterName: vpcSsmPath,
      stringValue: vpc.vpcId,
      description: 'APG Lattice Workload Dev VPC ID',
    });
    new ssm.StringParameter(this, 'WorkloadVpcCidrParam', {
      parameterName: '/apg-lattice/workload/dev-vpc/cidr',
      stringValue: vpc.vpcCidrBlock,
      description: 'APG Lattice Workload Dev VPC CIDR',
    });
    appSubnetIds.forEach((id, i) =>
      new ssm.StringParameter(this, `WorkloadSubnet${['A', 'B', 'C'][i]}Param`, {
        parameterName: `/apg-lattice/workload/dev-vpc/subnet/${['a', 'b', 'c'][i]}/id`,
        stringValue: id,
        description: `APG Lattice Workload Dev VPC app subnet ${['a', 'b', 'c'][i]}`,
      }),
    );

    new cdk.CfnOutput(this, 'WorkloadVpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'WorkloadAppSubnetIds', { value: appSubnetIds.join(',') });
  }
}
