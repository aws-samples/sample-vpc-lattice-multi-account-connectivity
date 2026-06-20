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
  /** VPC Name tag. Override per environment; defaults to 'workload-dev-vpc'. */
  vpcName?: string;
  /** SSM namespace prefix for published identifiers. */
  ssmPrefix?: string;
}

/**
 * WorkloadFoundationStack (Workload Account)
 *
 * Provisions a dedicated, fully ISOLATED workload VPC across THREE Availability
 * Zones for the VPC Lattice reference architecture, so onboarding does not
 * depend on any pre-existing network. The VPC ID is published to SSM at
 * `vpcSsmPath`, which WorkloadAssociationStack reads to create the service
 * network VPC association.
 *
 * By design this VPC has NO NAT gateway, NO internet gateway, and NO public
 * subnets. That is the whole point of the pattern: a workload account reaches
 * AWS service endpoints and filtered internet egress entirely through the VPC
 * Lattice fabric (the shared Resource Configurations and the Squid egress
 * proxy), not through per-account networking.
 *
 * Deploy order matters. The throwaway validator (WorkloadValidatorStack) can
 * only reach SSM after the service network association is in place and Private
 * DNS is resolving ssm/ssmmessages/ec2messages to the shared endpoints. Deploy
 * the association before the validator so the validation proves the Lattice
 * path, not a local NAT path.
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

    const vpcSsmPath = props.vpcSsmPath ?? '/netfabric/workload/dev-vpc/id';
    const vpcCidr = props.vpcCidr ?? '10.7.0.0/16';
    const vpcName = props.vpcName ?? 'workload-vpc';

    // Fully isolated VPC: no NAT gateway, no internet gateway, no public subnets.
    // All connectivity (AWS service access and filtered egress) is delivered
    // through the VPC Lattice service network association, not per-account
    // networking. This is the behavior the guide prescribes for workload VPCs.
    const vpc = new ec2.Vpc(this, 'WorkloadVpc', {
      vpcName: props.vpcName ?? 'workload-dev-vpc',
      ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
      maxAzs: 3,
      natGateways: 0,
      restrictDefaultSecurityGroup: true,
      flowLogs: {
        cw: { destination: ec2.FlowLogDestination.toCloudWatchLogs() },
      },
      subnetConfiguration: [
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const appSubnetIds = vpc.selectSubnets({ subnetGroupName: 'app' }).subnetIds;

    // Free gateway endpoints for S3 and DynamoDB so workloads reach those
    // services on the AWS backbone without a NAT gateway or interface endpoint.
    // (Interface-endpoint services such as SSM, STS, ECR, Logs reach the shared
    // Endpoint VPC through the VPC Lattice fabric instead.)
    vpc.addGatewayEndpoint('S3GatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    vpc.addGatewayEndpoint('DynamoDbGatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // Publish identifiers for WorkloadAssociationStack and validation tooling.
    // Derive the per-environment base path from vpcSsmPath (e.g.
    // /netfabric/workload/test-vpc/id -> /netfabric/workload/test-vpc) so the
    // cidr and subnet parameters land under the same environment prefix that
    // WorkloadAppStack and WorkloadValidatorStack read. Do not hardcode 'dev'.
    const vpcBasePath = vpcSsmPath.replace(/\/id$/, '');
    new ssm.StringParameter(this, 'WorkloadVpcIdParam', {
      parameterName: vpcSsmPath,
      stringValue: vpc.vpcId,
      description: `Workload VPC ID (${vpcName})`,
    });
    new ssm.StringParameter(this, 'WorkloadVpcCidrParam', {
      parameterName: `${vpcBasePath}/cidr`,
      stringValue: vpc.vpcCidrBlock,
      description: `Workload VPC CIDR (${vpcName})`,
    });
    appSubnetIds.forEach((id, i) =>
      new ssm.StringParameter(this, `WorkloadSubnet${['A', 'B', 'C'][i]}Param`, {
        parameterName: `${vpcBasePath}/subnet/${['a', 'b', 'c'][i]}/id`,
        stringValue: id,
        description: `Workload VPC app subnet ${['a', 'b', 'c'][i]} (${vpcName})`,
      }),
    );

    new cdk.CfnOutput(this, 'WorkloadVpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'WorkloadAppSubnetIds', { value: appSubnetIds.join(',') });
  }
}
