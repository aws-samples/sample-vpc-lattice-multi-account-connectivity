import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface IngressConsumerValidatorStackProps extends cdk.StackProps {
  /** Workload app port the SN-E fronts (matches the SN-E and the app RC). Defaults to 80. */
  appPort?: number;
  /** Ingress VPC CIDR; scopes the validator and endpoint SG rules. Defaults to 10.8.0.0/16. */
  ingressVpcCidr?: string;
  ssmPrefix?: string;
  resourcePrefix?: string;
}

/**
 * IngressConsumerValidatorStack (Network account, Ingress VPC): VALIDATION ONLY
 *
 * Simulates an EXTERNAL consumer that has already reached the Ingress VPC over
 * its own backbone (Cloud WAN attachment, VPC peering, Transit Gateway, or
 * Direct Connect / VPN). From inside the Ingress VPC it exercises the private
 * ingress path end to end:
 *
 *   this instance -> Service Network VPC Endpoint (SN-E) -> shared Service
 *     Network -> workload Resource Gateway -> workload app (HTTP)
 *
 * The Ingress VPC is isolated (no NAT, no IGW), so this stack adds its own
 * SSM/SSMMessages/EC2Messages interface endpoints to give the instance Session
 * Manager / Run Command access without any internet path. In a real deployment
 * the consumer brings its own management plane; here the validator is fully
 * self-contained. Access is via SSM only (no inbound SG rules). Throwaway:
 * destroy after validating.
 */
export class IngressConsumerValidatorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IngressConsumerValidatorStackProps = {}) {
    super(scope, id, props);

    const resourcePrefix = props.resourcePrefix ?? 'netfabric';
    const ssmPrefix = props.ssmPrefix ?? `/${resourcePrefix}`;
    const appPort = props.appPort ?? 80;
    const ingressVpcCidr = props.ingressVpcCidr ?? '10.8.0.0/16';

    const vpcId = ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/network/ingress-vpc/id`);
    const azs = [`${this.region}a`, `${this.region}b`, `${this.region}c`];
    const subnetIds = ['a', 'b', 'c'].map((z) =>
      ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/network/ingress-vpc/subnet/${z}/id`));
    const subnets = subnetIds.map((sid, i) =>
      ec2.Subnet.fromSubnetAttributes(this, `IngressSubnet${['A', 'B', 'C'][i]}`, { subnetId: sid, availabilityZone: azs[i] }));
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'IngressVpc', {
      vpcId,
      availabilityZones: azs,
      privateSubnetIds: subnetIds,
      vpcCidrBlock: ingressVpcCidr,
    });

    // Interface endpoints so the isolated Ingress VPC can reach Systems Manager
    // for Session Manager / Run Command. 443 from the Ingress VPC CIDR only.
    const epSg = new ec2.SecurityGroup(this, 'SsmEndpointSg', {
      vpc,
      description: 'SSM interface endpoints for the ingress consumer validator',
      allowAllOutbound: true,
    });
    epSg.addIngressRule(ec2.Peer.ipv4(ingressVpcCidr), ec2.Port.tcp(443), 'HTTPS from the Ingress VPC for SSM');
    for (const svc of [
      ec2.InterfaceVpcEndpointAwsService.SSM,
      ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
    ]) {
      new ec2.InterfaceVpcEndpoint(this, `${svc.shortName.replace(/[^a-zA-Z0-9]/g, '')}Endpoint`, {
        vpc,
        service: svc,
        subnets: { subnets },
        securityGroups: [epSg],
        privateDnsEnabled: true,
      });
    }

    const role = new iam.Role(this, 'ValidatorRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });

    // No-inbound SG. Egress is scoped to the Ingress VPC CIDR only: 443 to the
    // SSM interface endpoints and the app port to the SN-E ENIs (both live in
    // this VPC). The validator never talks to the internet.
    const sg = new ec2.SecurityGroup(this, 'ValidatorSg', {
      vpc,
      description: 'Ingress consumer validator - no inbound, SSM-managed',
      allowAllOutbound: false,
    });
    sg.addEgressRule(ec2.Peer.ipv4(ingressVpcCidr), ec2.Port.tcp(443), 'HTTPS to the SSM interface endpoints in the Ingress VPC');
    sg.addEgressRule(ec2.Peer.ipv4(ingressVpcCidr), ec2.Port.tcp(appPort), 'App port to the SN-E ENIs in the Ingress VPC');

    const instance = new ec2.Instance(this, 'Validator', {
      vpc,
      vpcSubnets: { subnets: [subnets[0]] },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      instanceName: 'netfabric-ingress-consumer-validator',
      role,
      securityGroup: sg,
      requireImdsv2: true,
      blockDevices: [{ deviceName: '/dev/xvda', volume: ec2.BlockDeviceVolume.ebs(8, { encrypted: true, volumeType: ec2.EbsDeviceVolumeType.GP3 }) }],
      userData: ec2.UserData.custom(['#!/bin/bash', 'dnf install -y bind-utils >/tmp/validator-bootstrap.log 2>&1 || true'].join('\n')),
      detailedMonitoring: false,
    });

    new cdk.CfnOutput(this, 'ValidatorInstanceId', { value: instance.instanceId });

    // ----------------------------------------------------------------
    // cdk-nag suppressions (throwaway validation instance)
    // ----------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(role, [
      { id: 'AwsSolutions-IAM4', reason: 'AmazonSSMManagedInstanceCore is the AWS-recommended policy for Session Manager managed instances.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore'] },
    ], true);
    NagSuppressions.addResourceSuppressions(epSg, [
      { id: 'AwsSolutions-EC23', reason: 'SSM interface-endpoint SG allows 443 only from the Ingress VPC CIDR, not 0.0.0.0/0.' },
    ], true);
    NagSuppressions.addResourceSuppressions(instance, [
      { id: 'AwsSolutions-EC28', reason: 'Throwaway validation instance; detailed monitoring/ASG not warranted.' },
      { id: 'AwsSolutions-EC29', reason: 'Throwaway validation instance; termination protection/ASG not warranted.' },
    ], true);
  }
}
