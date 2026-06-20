import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface SquidEgressStackProps extends cdk.StackProps {
  /** Single token that namespaces the log group and ECR repo reference. */
  resourcePrefix?: string;
  egressVpcSsmPath: string;
  egressSubnetASsmPath: string;
  egressSubnetBSsmPath: string;
  egressSubnetCSsmPath: string;
  egressSgSsmPath: string;
  serviceNetworkIds: { dev: string; test: string; prod: string };
  allowedDomains: string;
  desiredCount: number;
  cpu: number;
  memory: number;
  /** SSM parameter path holding the custom Squid image URI built by CodeBuild. */
  squidImageUriSsmPath: string;
}

/**
 * Deploys a centralized Squid forward proxy on ECS Fargate with FQDN
 * allowlist filtering. Traffic from workload accounts reaches this proxy
 * through a VPC Lattice Resource Configuration pointing to the internal NLB.
 *
 * Architecture: Workload VPC -> Lattice -> Resource GW -> NLB -> Squid -> NAT GW -> Internet
 */
export class SquidEgressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SquidEgressStackProps) {
    super(scope, id, props);

    const resourcePrefix = props.resourcePrefix ?? 'netfabric';

    // Resolve VPC and subnet IDs from SSM parameters (3 AZs for HA)
    const egressVpcId = ssm.StringParameter.valueForStringParameter(this, props.egressVpcSsmPath);
    const subnetAId = ssm.StringParameter.valueForStringParameter(this, props.egressSubnetASsmPath);
    const subnetBId = ssm.StringParameter.valueForStringParameter(this, props.egressSubnetBSsmPath);
    const subnetCId = ssm.StringParameter.valueForStringParameter(this, props.egressSubnetCSsmPath);
    const sgId = ssm.StringParameter.valueForStringParameter(this, props.egressSgSsmPath);

    // Import existing VPC (deployed by NetworkFoundationStack)
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'EgressVpc', {
      vpcId: egressVpcId,
      availabilityZones: [
        `${this.region}a`,
        `${this.region}b`,
        `${this.region}c`,
      ],
      privateSubnetIds: [subnetAId, subnetBId, subnetCId],
    });

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'SquidCluster', {
      vpc,
      clusterName: `${resourcePrefix}-squid-egress-cluster`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // CloudWatch Logs
    const logGroup = new logs.LogGroup(this, 'SquidLogs', {
      logGroupName: `/${resourcePrefix}/ecs/squid-egress-proxy`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Task Definition
    const taskDef = new ecs.FargateTaskDefinition(this, 'SquidTaskDef', {
      cpu: props.cpu,
      memoryLimitMiB: props.memory,
      family: `${resourcePrefix}-squid-egress-proxy`,
    });

    // Custom Squid image (with baked-in FQDN allowlist) built by CodeBuild and
    // published to SSM. The stock ubuntu/squid image does NOT enforce the
    // allowlist, so the custom image is required for FQDN filtering.
    const squidImageUri = ssm.StringParameter.valueForStringParameter(this, props.squidImageUriSsmPath);

    // The image lives in this account's ECR; grant the task execution role pull.
    taskDef.addToExecutionRolePolicy(new iam.PolicyStatement({
      actions: [
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:BatchCheckLayerAvailability',
      ],
      resources: [`arn:aws:ecr:${this.region}:${this.account}:repository/${resourcePrefix}-squid-proxy`],
    }));
    taskDef.addToExecutionRolePolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    // Squid container
    taskDef.addContainer('squid', {
      image: ecs.ContainerImage.fromRegistry(squidImageUri),
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: 'squid',
      }),
      portMappings: [{ containerPort: 3128, protocol: ecs.Protocol.TCP }],
      essential: true,
      // Enable ECS Exec for troubleshooting
      linuxParameters: new ecs.LinuxParameters(this, 'SquidLinuxParams', {
        initProcessEnabled: true,
      }),
    });

    // Security Group for Squid tasks
    const squidSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'SquidSg', sgId);

    // ECS Service
    const service = new ecs.FargateService(this, 'SquidService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: props.desiredCount,
      assignPublicIp: false,
      securityGroups: [squidSg],
      vpcSubnets: { subnets: vpc.privateSubnets },
      enableExecuteCommand: true,
      minHealthyPercent: 50,
      circuitBreaker: { rollback: true },
    });

    // Internal Network Load Balancer (TCP:3128)
    const nlb = new elbv2.NetworkLoadBalancer(this, 'SquidNlb', {
      vpc,
      loadBalancerName: `${resourcePrefix}-squid-egress-nlb`,
      internetFacing: false,
      crossZoneEnabled: true,
      vpcSubnets: { subnets: vpc.privateSubnets },
    });

    const listener = nlb.addListener('SquidListener', {
      port: 3128,
      protocol: elbv2.Protocol.TCP,
    });

    listener.addTargets('SquidTargets', {
      port: 3128,
      protocol: elbv2.Protocol.TCP,
      targets: [service],
      healthCheck: {
        enabled: true,
        port: '3128',
        protocol: elbv2.Protocol.TCP,
        interval: cdk.Duration.seconds(30),
      },
    });

    // Resource Gateway in Egress VPC
    const resourceGateway = new cdk.CfnResource(this, 'EgressResourceGateway', {
      type: 'AWS::VpcLattice::ResourceGateway',
      properties: {
        Name: `${resourcePrefix}-egress-resource-gateway`,
        VpcIdentifier: egressVpcId,
        SubnetIds: [subnetAId, subnetBId, subnetCId],
        SecurityGroupIds: [sgId],
      },
    });

    // Resource Configuration: squid-proxy-rc -> NLB DNS.
    // CustomDomainName is the stable consumer-facing proxy domain that VPC
    // Lattice provisions a Private Hosted Zone for in associated workload VPCs.
    // Workloads set HTTP_PROXY/HTTPS_PROXY to http://squid-proxy.egress.internal:3128.
    const squidRc = new cdk.CfnResource(this, 'SquidProxyRC', {
      type: 'AWS::VpcLattice::ResourceConfiguration',
      properties: {
        Name: `${resourcePrefix}-squid-egress-proxy-rc`,
        ResourceConfigurationType: 'SINGLE',
        AllowAssociationToSharableServiceNetwork: true,
        ResourceGatewayId: resourceGateway.getAtt('Id'),
        CustomDomainName: 'squid-proxy.egress.internal',
        ResourceConfigurationDefinition: {
          DnsResource: {
            DomainName: nlb.loadBalancerDnsName,
            IpAddressType: 'IPV4',
          },
        },
        PortRanges: ['3128'],
        ProtocolType: 'TCP',
      },
    });

    // Associate squid RC with all three service networks. PrivateDnsEnabled
    // triggers managed PHZ creation for squid-proxy.egress.internal in
    // associated workload VPCs.
    for (const [envName, snId] of Object.entries(props.serviceNetworkIds)) {
      new cdk.CfnResource(this, `SquidRCAssoc-${envName}`, {
        type: 'AWS::VpcLattice::ServiceNetworkResourceAssociation',
        properties: {
          ServiceNetworkId: snId,
          ResourceConfigurationId: squidRc.getAtt('Id'),
          PrivateDnsEnabled: true,
        },
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'NlbDnsName', { value: nlb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'EgressResourceGatewayId', {
      value: resourceGateway.getAtt('Id').toString(),
    });
    new cdk.CfnOutput(this, 'SquidProxyRcId', {
      value: squidRc.getAtt('Id').toString(),
    });

    // ----------------------------------------------------------------
    // cdk-nag suppressions
    // ----------------------------------------------------------------

    // ALLOWED_DOMAINS is a non-sensitive configuration value (list of permitted FQDNs).
    // It does not contain secrets, credentials, or sensitive data. Using Secrets Manager
    // or SSM SecureString would add unnecessary complexity and cost for a public allowlist.
    NagSuppressions.addResourceSuppressionsByPath(this,
      `/${this.stackName}/SquidTaskDef/Resource`,
      [{
        id: 'AwsSolutions-ECS2',
        reason: 'ALLOWED_DOMAINS is a non-sensitive configuration value containing a public FQDN allowlist. It does not contain secrets or credentials.',
      }],
    );

    // This is an internal NLB that is only reachable via VPC Lattice Resource Gateway.
    // Access logging is provided by VPC Lattice access logs at the service network level.
    // NLB access logs require an S3 bucket which adds cost for an internal-only load balancer.
    NagSuppressions.addResourceSuppressionsByPath(this,
      `/${this.stackName}/SquidNlb/Resource`,
      [{
        id: 'AwsSolutions-ELB2',
        reason: 'Internal NLB only reachable via VPC Lattice Resource Gateway. Observability is provided by VPC Lattice access logs at the service network level.',
      }],
    );

    // The ECS task role wildcard permission is for ECS Exec (ssmmessages:*) which requires
    // wildcard resource per AWS documentation for execute-command functionality.
    NagSuppressions.addResourceSuppressionsByPath(this,
      `/${this.stackName}/SquidTaskDef/TaskRole/DefaultPolicy/Resource`,
      [{
        id: 'AwsSolutions-IAM5',
        reason: 'ECS Exec (enableExecuteCommand) requires ssmmessages:* with wildcard resource per AWS documentation. This is scoped to the task role only.',
        appliesTo: ['Resource::*'],
      }],
    );

    // ecr:GetAuthorizationToken does not support resource-level permissions;
    // wildcard is required per AWS docs. Pull actions are scoped to the repo.
    NagSuppressions.addResourceSuppressionsByPath(this,
      `/${this.stackName}/SquidTaskDef/ExecutionRole/DefaultPolicy/Resource`,
      [{
        id: 'AwsSolutions-IAM5',
        reason: 'ecr:GetAuthorizationToken does not support resource-level permissions; wildcard required per AWS documentation. ECR pull actions are scoped to the specific repository.',
        appliesTo: ['Resource::*'],
      }],
    );
  }
}
