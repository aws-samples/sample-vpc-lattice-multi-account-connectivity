import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface WorkloadValidatorStackProps extends cdk.StackProps {
  /** SSM parameter path holding the workload VPC ID. */
  vpcSsmPath: string;
  /** SSM parameter path holding a private app subnet ID. */
  subnetSsmPath: string;
}

/**
 * WorkloadValidatorStack (Workload Dev account) — VALIDATION ONLY
 *
 * A single, small SSM-managed EC2 instance placed in the workload VPC so that
 * connectivity can be validated from inside the VPC:
 *   - DNS resolution of AWS service endpoints to VPC Lattice IPs
 *   - End-to-end AWS API calls (STS, SSM) through Lattice -> endpoint VPCE
 *   - Internet egress through the Lattice-exposed Squid proxy
 *
 * Access is via SSM Session Manager / Run Command only: the security group has
 * NO inbound rules. This stack is throwaway and is destroyed during cleanup.
 */
export class WorkloadValidatorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkloadValidatorStackProps) {
    super(scope, id, props);

    const vpcId = ssm.StringParameter.valueForStringParameter(this, props.vpcSsmPath);
    const subnetId = ssm.StringParameter.valueForStringParameter(this, props.subnetSsmPath);

    const vpc = ec2.Vpc.fromVpcAttributes(this, 'WorkloadVpc', {
      vpcId,
      availabilityZones: [`${this.region}a`],
      privateSubnetIds: [subnetId],
    });

    const validatorSubnet = ec2.Subnet.fromSubnetAttributes(this, 'ValidatorSubnet', {
      subnetId,
      availabilityZone: `${this.region}a`,
    });

    // Instance role: SSM core for Session Manager/Run Command + minimal read
    // permissions for the validation API calls in tasks 9.5-9.7.
    const role = new iam.Role(this, 'ValidatorRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:DescribeInstanceInformation'],
      resources: ['*'],
    }));

    // No-inbound security group; egress open (Session Manager is outbound-only,
    // and egress validation routes through the Lattice proxy).
    const sg = new ec2.SecurityGroup(this, 'ValidatorSg', {
      vpc,
      description: 'Validator instance - no inbound, SSM-managed',
      allowAllOutbound: true,
    });

    const instance = new ec2.Instance(this, 'Validator', {
      vpc,
      vpcSubnets: { subnets: [validatorSubnet] },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role,
      securityGroup: sg,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(8, {
            encrypted: true,
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      userData: ec2.UserData.custom(
        [
          '#!/bin/bash',
          'dnf install -y bind-utils >/tmp/validator-bootstrap.log 2>&1 || true',
        ].join('\n'),
      ),
      detailedMonitoring: false,
    });

    new cdk.CfnOutput(this, 'ValidatorInstanceId', { value: instance.instanceId });

    // ----------------------------------------------------------------
    // cdk-nag suppressions (throwaway validation instance)
    // ----------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(role, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AmazonSSMManagedInstanceCore is the AWS-recommended policy for Session Manager managed instances.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'ssm:DescribeInstanceInformation does not support resource-level permissions; read-only validation call.',
        appliesTo: ['Resource::*'],
      },
    ], true);

    NagSuppressions.addResourceSuppressions(instance, [
      {
        id: 'AwsSolutions-EC28',
        reason: 'Throwaway validation instance; detailed monitoring/ASG not warranted for a short-lived test host.',
      },
      {
        id: 'AwsSolutions-EC29',
        reason: 'Throwaway validation instance; termination protection/ASG not warranted for a short-lived test host.',
      },
    ], true);
  }
}
