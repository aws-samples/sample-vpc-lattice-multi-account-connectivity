import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2t from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface WorkloadAppStackProps extends cdk.StackProps {
  /** Service network ID to associate the app Resource Configuration to (RAM-shared to the workload OU). */
  serviceNetworkId: string;
  /** VPC Lattice managed prefix list ID (scopes the Resource Gateway SG to the Lattice data plane). */
  latticePrefixListId: string;
  /** Consumer-facing ingress custom domain for the app. */
  customDomainName?: string;
  /** Environment segment (dev/test/prod) used to resolve the workload VPC SSM paths. */
  workloadEnvironment?: string;
  /** Workload VPC CIDR; scopes in-VPC HTTP access to the app. Defaults to 10.7.0.0/16 (dev). */
  workloadVpcCidr?: string;
  /** SSM namespace for the workload VPC identifiers. */
  ssmPrefix?: string;
  resourcePrefix?: string;
}

/**
 * WorkloadAppStack (Workload account): Phase 5 ingress PRODUCER.
 *
 * Demonstrates a workload account exposing an internal application to the shared
 * VPC Lattice fabric so external, on-premises, and cross-Region consumers can
 * reach it through the Service Network VPC Endpoint (SN-E), with no proxy fleet.
 *
 * It deploys a minimal app (an SSM-managed EC2 serving HTTP on port 80) behind
 * an internal Network Load Balancer, a workload Resource Gateway, and a Resource
 * Configuration (SINGLE, targeting the NLB) associated to the shared dev Service
 * Network. The SN-E in the Network account's Ingress VPC then surfaces this
 * Resource Configuration to consumers, and the ingress DNS automation publishes
 * its custom domain. The Service Network IAM auth policy still governs access.
 */
export class WorkloadAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkloadAppStackProps) {
    super(scope, id, props);

    const resourcePrefix = props.resourcePrefix ?? 'netfabric';
    const ssmPrefix = props.ssmPrefix ?? `/${resourcePrefix}`;
    const customDomainName = props.customDomainName ?? 'app.ingress.internal';
    const env = props.workloadEnvironment ?? 'dev';
    const workloadVpcCidr = props.workloadVpcCidr ?? '10.7.0.0/16';

    const vpcId = ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/workload/${env}-vpc/id`);
    const subnetIds = ['a', 'b', 'c'].map((z) =>
      ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/workload/${env}-vpc/subnet/${z}/id`));

    const vpc = ec2.Vpc.fromVpcAttributes(this, 'WorkloadVpc', {
      vpcId,
      availabilityZones: [`${this.region}a`, `${this.region}b`, `${this.region}c`],
      privateSubnetIds: subnetIds,
    });
    const azs = [`${this.region}a`, `${this.region}b`, `${this.region}c`];
    const importedSubnets = subnetIds.map((sid, i) =>
      ec2.Subnet.fromSubnetAttributes(this, `AppSubnet${['A', 'B', 'C'][i]}`, { subnetId: sid, availabilityZone: azs[i] }));
    const vpcSubnets: ec2.SubnetSelection = { subnets: importedSubnets };

    // App security group: HTTP 80 from within the workload VPC (the NLB targets
    // the instance, and the Resource Gateway reaches the NLB, both in-VPC).
    const appSg = new ec2.SecurityGroup(this, 'AppSg', {
      vpc,
      description: 'Workload ingress demo app - HTTP 80 from within the VPC',
      allowAllOutbound: true,
    });
    appSg.addIngressRule(ec2.Peer.ipv4(workloadVpcCidr), ec2.Port.tcp(80), 'HTTP from within the workload VPC');

    const role = new iam.Role(this, 'AppRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });

    const app = new ec2.Instance(this, 'App', {
      vpc,
      vpcSubnets: { subnets: [importedSubnets[0]] },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      instanceName: `${resourcePrefix}-workload-app`,
      role,
      securityGroup: appSg,
      requireImdsv2: true,
      blockDevices: [{ deviceName: '/dev/xvda', volume: ec2.BlockDeviceVolume.ebs(8, { encrypted: true, volumeType: ec2.EbsDeviceVolumeType.GP3 }) }],
      userData: ec2.UserData.custom([
        '#!/bin/bash',
        'mkdir -p /opt/app && cd /opt/app',
        'echo "ingress-demo OK from workload account $(hostname)" > index.html',
        // Serve HTTP on 80 and log requests to a file we can read via SSM Run Command.
        'nohup python3 -m http.server 80 >>/var/log/ingress-app.log 2>&1 &',
      ].join('\n')),
      detailedMonitoring: false,
    });

    // Internal NLB fronting the app (TCP 80).
    const nlb = new elbv2.NetworkLoadBalancer(this, 'AppNlb', {
      vpc,
      loadBalancerName: `${resourcePrefix}-workload-app-nlb`,
      internetFacing: false,
      crossZoneEnabled: true,
      vpcSubnets,
    });
    const listener = nlb.addListener('AppListener', { port: 80, protocol: elbv2.Protocol.TCP });
    listener.addTargets('AppTargets', {
      port: 80,
      protocol: elbv2.Protocol.TCP,
      targets: [new elbv2t.InstanceIdTarget(app.instanceId, 80)],
      healthCheck: { enabled: true, port: '80', protocol: elbv2.Protocol.TCP },
    });

    // Resource Gateway SG: the Lattice data plane reaches the gateway on 80.
    const rgwSg = new ec2.SecurityGroup(this, 'AppRgwSg', {
      vpc,
      description: 'Workload app Resource Gateway - HTTP 80 from the VPC Lattice data plane',
      allowAllOutbound: true,
    });
    rgwSg.addIngressRule(ec2.Peer.prefixList(props.latticePrefixListId), ec2.Port.tcp(80), 'HTTP from the VPC Lattice data plane (managed prefix list)');

    const rgw = new cdk.CfnResource(this, 'AppResourceGateway', {
      type: 'AWS::VpcLattice::ResourceGateway',
      properties: {
        Name: `${resourcePrefix}-workload-app-rgw`,
        VpcIdentifier: vpcId,
        SubnetIds: subnetIds,
        SecurityGroupIds: [rgwSg.securityGroupId],
      },
    });

    // Resource Configuration targeting the app NLB, associated to the shared SN.
    // The PublishIngressDns tag opts this RC in to the ingress DNS automation:
    // its value is the consumer-facing custom domain to publish (a CNAME to the
    // SN-E generated name). VPC Lattice tag values cannot contain commas.
    const rc = new cdk.CfnResource(this, 'AppResourceConfiguration', {
      type: 'AWS::VpcLattice::ResourceConfiguration',
      properties: {
        Name: `${resourcePrefix}-workload-app-rc`,
        ResourceConfigurationType: 'SINGLE',
        AllowAssociationToSharableServiceNetwork: true,
        ResourceGatewayId: rgw.getAtt('Id'),
        CustomDomainName: customDomainName,
        ResourceConfigurationDefinition: {
          DnsResource: { DomainName: nlb.loadBalancerDnsName, IpAddressType: 'IPV4' },
        },
        PortRanges: ['80'],
        ProtocolType: 'TCP',
        Tags: [{ Key: 'PublishIngressDns', Value: customDomainName }],
      },
    });

    new cdk.CfnResource(this, 'AppRcAssociation', {
      type: 'AWS::VpcLattice::ServiceNetworkResourceAssociation',
      properties: {
        ServiceNetworkId: props.serviceNetworkId,
        ResourceConfigurationId: rc.getAtt('Id'),
        PrivateDnsEnabled: true,
      },
    });

    new cdk.CfnOutput(this, 'AppInstanceId', { value: app.instanceId });
    new cdk.CfnOutput(this, 'AppNlbDns', { value: nlb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'AppResourceConfigurationId', { value: rc.getAtt('Id').toString() });

    // ----------------------------------------------------------------
    // cdk-nag suppressions (throwaway ingress demo app)
    // ----------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(role, [
      { id: 'AwsSolutions-IAM4', reason: 'AmazonSSMManagedInstanceCore is the AWS-recommended policy for Session Manager managed instances.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore'] },
    ], true);
    NagSuppressions.addResourceSuppressions(appSg, [
      { id: 'AwsSolutions-EC23', reason: 'HTTP 80 ingress is scoped to the workload VPC CIDR, not 0.0.0.0/0; this is the in-VPC NLB-to-target and Resource Gateway path.' },
    ]);
    NagSuppressions.addResourceSuppressions(app, [
      { id: 'AwsSolutions-EC28', reason: 'Throwaway ingress demo instance; detailed monitoring/ASG not warranted.' },
      { id: 'AwsSolutions-EC29', reason: 'Throwaway ingress demo instance; termination protection/ASG not warranted.' },
    ], true);
    NagSuppressions.addResourceSuppressions(nlb, [
      { id: 'AwsSolutions-ELB2', reason: 'Internal NLB reachable only via the VPC Lattice Resource Gateway; observability is provided by VPC Lattice access logs.' },
    ]);
  }
}
