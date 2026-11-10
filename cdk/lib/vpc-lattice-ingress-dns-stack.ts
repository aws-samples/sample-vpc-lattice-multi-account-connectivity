import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as events from 'aws-cdk-lib/aws-events';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface VpcLatticeIngressDnsStackProps extends cdk.StackProps {
  /** Route 53 private hosted zone ID for the ingress custom domain. Defaults to SSM (from the zone stack). */
  privateHostedZoneId?: string;
  /** Tag key on a Resource Configuration that opts it in to ingress DNS publishing. */
  publishTagKey?: string;
  /** SSM namespace under which the per-environment SN-E IDs are published. */
  ssmPrefix?: string;
  /** Comma-separated SN-E IDs to query. Defaults to the dev SN-E from SSM. */
  sneEndpointIds?: string;
  /** Environments whose SN-E IDs the state machine should query (reads <ssmPrefix>/ingress/<env>/sne/id for each). Defaults to ['dev']. */
  sneEnvironments?: string[];
  /** AWS Organizations ID. When set, a cross-account ingress DNS event bus is
   *  created and scoped to the org so workload accounts can forward their
   *  Resource Configuration tag-change events to this automation. */
  orgId?: string;
  /** Single token that namespaces every resource name. */
  resourcePrefix?: string;
}

/**
 * VpcLatticeIngressDnsStack (Network account): Phase 5 ingress DNS automation.
 *
 * Event-driven, Lambda-free automation that keeps custom-domain CNAME records
 * current for Resource Configurations exposed through a Service Network VPC
 * Endpoint (SN-E). When a shared Resource Configuration is tagged with the
 * publish tag (value = the consumer-facing ingress domain, e.g.
 * proxy.ingress.internal), EventBridge starts a Step Functions state machine
 * (native AWS SDK integrations) that finds the matching generated DNS name on
 * the SN-E and UPSERTs a CNAME at that domain in the ingress private hosted
 * zone. On tag removal the record is deleted. A DynamoDB table tracks records
 * for clean deletion.
 *
 * Adapted from "Guidance for Amazon VPC Lattice Automated DNS Configuration on
 * AWS" and re-targeted from Lattice Services to the VPC Resources model used by
 * this guide. Kept at parity with
 * cloudformation/vpc-lattice-ingress-dns-automation.yaml.
 */
export class VpcLatticeIngressDnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VpcLatticeIngressDnsStackProps) {
    super(scope, id, props);

    const resourcePrefix = props.resourcePrefix ?? 'netfabric';
    const ssmPrefix = props.ssmPrefix ?? `/${resourcePrefix}`;
    const tagKey = props.publishTagKey ?? 'PublishIngressDns';

    // Ingress hosted zone ID defaults to the zone published by
    // VpcLatticeIngressZoneStack (SSM). Context/prop can override.
    const privateHostedZoneId = props.privateHostedZoneId
      ?? ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/ingress/hosted-zone-id`);

    // Customer managed key for the DLQ, the DynamoDB tracker and the state machine logs.
    const dnsKey = new kms.Key(this, 'DnsKmsKey', {
      description: 'CMK for the ingress DNS automation (SQS DLQ, DynamoDB tracker, state machine logs)',
      enableKeyRotation: true,
    });
    dnsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchLogs',
      principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
      actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
      resources: ['*'],
      conditions: {
        ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*` },
      },
    }));
    dnsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowEventBridgeToSendToEncryptedDlq',
      principals: [new iam.ServicePrincipal('events.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
    }));

    const dlq = new sqs.Queue(this, 'DlqQueue', {
      queueName: `${resourcePrefix}-ingress-dns-dlq`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: dnsKey,
      dataKeyReuse: cdk.Duration.minutes(5),
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    const table = new dynamodb.Table(this, 'DnsRecordTracker', {
      tableName: `${resourcePrefix}-ingress-dns-records`,
      partitionKey: { name: 'ResourceArn', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: dnsKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logGroup = new logs.LogGroup(this, 'StateMachineLogGroup', {
      logGroupName: `/${resourcePrefix}/ingress-dns-automation/state-machine`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey: dnsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const sfnRole = new iam.Role(this, 'StepFunctionsRole', {
      roleName: `${resourcePrefix}-ingress-dns-sfn-role-${this.region}`,
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });
    // Managed (not inline) policy attached to the state machine role.
    const sfnPolicy = new iam.ManagedPolicy(this, 'StepFunctionsPolicy', {
      description: 'Ingress DNS automation state machine permissions (EC2 read, DynamoDB tracker, Route 53 zone, KMS, log delivery)',
      roles: [sfnRole],
      statements: [
        new iam.PolicyStatement({
          sid: 'DescribeSneAssociations',
          actions: ['ec2:DescribeVpcEndpointAssociations'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'TrackerTable',
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
          resources: [table.tableArn],
        }),
        new iam.PolicyStatement({
          sid: 'TrackerTableKms',
          actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
          resources: [dnsKey.keyArn],
          conditions: { StringEquals: { 'kms:ViaService': `dynamodb.${this.region}.amazonaws.com` } },
        }),
        new iam.PolicyStatement({
          sid: 'IngressZoneRecords',
          actions: ['route53:ListResourceRecordSets', 'route53:ChangeResourceRecordSets'],
          resources: [`arn:${this.partition}:route53:::hostedzone/${privateHostedZoneId}`],
        }),
        // Step Functions log delivery: these CloudWatch Logs delivery actions do not
        // support resource-level permissions, so '*' is required by the service.
        new iam.PolicyStatement({
          sid: 'StateMachineLogDelivery',
          actions: [
            'logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery',
            'logs:DeleteLogDelivery', 'logs:ListLogDeliveries', 'logs:PutResourcePolicy',
            'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'StateMachineLogStreams',
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [logGroup.logGroupArn],
        }),
      ],
    });

    // SN-E IDs to query. Defaults to the dev SN-E (the documented example);
    // when multiple environments are enabled, the state machine queries every
    // environment's SN-E so a Resource Configuration in any of them is found.
    const sneEnvironments = props.sneEnvironments ?? ['dev'];
    const sneIds = props.sneEndpointIds
      ?? cdk.Fn.join(',', sneEnvironments.map((e) =>
        ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/ingress/${e}/sne/id`)));

    // ASL definition is kept byte-identical with the CloudFormation template.
    const definition = JSON.stringify({
      Comment: "Ingress DNS for VPC Lattice Resource Configurations: UPSERT a CNAME from the consumer-facing ingress domain (publish tag value) to the resource's SN-E generated DNS name.",
      QueryLanguage: 'JSONata',
      StartAt: 'ActionType',
      States: {
        ActionType: {
          Type: 'Choice',
          Default: 'Pass',
          Choices: [
            { Next: 'FindSneDns', Condition: '{% $exists($states.input.detail.tags.${tagKey}) %}', Assign: { ResourceArn: '{% $states.input.resources[0] %}', IngressDomain: '{% $states.input.detail.tags.${tagKey} %}' } },
            { Next: 'GetTrackedRecord', Condition: "{% '${tagKey}' in $states.input.detail.'changed-tag-keys' and $not($exists($states.input.detail.tags.${tagKey})) %}", Assign: { ResourceArn: '{% $states.input.resources[0] %}' } },
          ],
        },
        FindSneDns: {
          Type: 'Task',
          Resource: 'arn:aws:states:::aws-sdk:ec2:describeVpcEndpointAssociations',
          Next: 'ExtractSneDns',
          Arguments: { VpcEndpointIds: "{% $split('${sneIds}', ',') %}" },
          Output: { Associations: '{% $states.result.VpcEndpointAssociations %}' },
        },
        ExtractSneDns: {
          Type: 'Pass',
          Next: 'CreateDnsRecords',
          Output: { SneDnsName: '{% $states.input.Associations[AssociatedResourceArn = $ResourceArn][0].DnsEntry.DnsName %}' },
        },
        CreateDnsRecords: {
          Type: 'Parallel',
          End: true,
          Branches: [
            { StartAt: 'UpsertCnameRecord', States: { UpsertCnameRecord: { Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:route53:changeResourceRecordSets', End: true, Arguments: { HostedZoneId: '${phz}', ChangeBatch: { Changes: [{ Action: 'UPSERT', ResourceRecordSet: { Name: '{% $IngressDomain %}', Type: 'CNAME', Ttl: 60, ResourceRecords: [{ Value: '{% $states.input.SneDnsName %}' }] } }] } } } } },
            { StartAt: 'TrackInDynamoDB', States: { TrackInDynamoDB: { Type: 'Task', Resource: 'arn:aws:states:::dynamodb:putItem', End: true, Arguments: { TableName: '${dynamodbtable}', Item: { ResourceArn: { S: '{% $ResourceArn %}' }, CustomDomainName: { S: '{% $IngressDomain %}' }, VpcLatticeDomainName: { S: '{% $states.input.SneDnsName %}' }, HostedZoneId: { S: '${phz}' } } } } } },
          ],
        },
        GetTrackedRecord: {
          Type: 'Task',
          Resource: 'arn:aws:states:::dynamodb:getItem',
          Next: 'CheckTrackedRecord',
          Arguments: { TableName: '${dynamodbtable}', Key: { ResourceArn: { S: '{% $ResourceArn %}' } } },
        },
        CheckTrackedRecord: {
          Type: 'Choice',
          Default: 'Pass',
          Choices: [
            { Next: 'DeleteDnsRecord', Condition: '{% $exists($states.input.Item) %}', Output: { CustomDomainName: '{% $states.input.Item.CustomDomainName.S %}', VpcLatticeDomainName: '{% $states.input.Item.VpcLatticeDomainName.S %}', HostedZoneId: '{% $states.input.Item.HostedZoneId.S %}' } },
          ],
        },
        DeleteDnsRecord: {
          Type: 'Parallel',
          End: true,
          Branches: [
            { StartAt: 'DeleteCnameRecord', States: { DeleteCnameRecord: { Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:route53:changeResourceRecordSets', End: true, Arguments: { HostedZoneId: '{% $states.input.HostedZoneId %}', ChangeBatch: { Changes: [{ Action: 'DELETE', ResourceRecordSet: { Name: '{% $states.input.CustomDomainName %}', Type: 'CNAME', Ttl: 60, ResourceRecords: [{ Value: '{% $states.input.VpcLatticeDomainName %}' }] } }] } } } } },
            { StartAt: 'DeleteDynamoItem', States: { DeleteDynamoItem: { Type: 'Task', Resource: 'arn:aws:states:::dynamodb:deleteItem', End: true, Arguments: { TableName: '${dynamodbtable}', Key: { ResourceArn: { S: '{% $ResourceArn %}' } } } } } },
          ],
        },
        Pass: { Type: 'Pass', End: true },
      },
    });

    const stateMachine = new sfn.CfnStateMachine(this, 'DnsConfigStateMachine', {
      stateMachineName: `${resourcePrefix}-ingress-dns`,
      roleArn: sfnRole.roleArn,
      stateMachineType: 'STANDARD',
      definitionString: definition,
      definitionSubstitutions: {
        phz: privateHostedZoneId,
        dynamodbtable: table.tableName,
        sneIds,
        tagKey,
      },
      loggingConfiguration: {
        includeExecutionData: true,
        level: 'ALL',
        destinations: [{ cloudWatchLogsLogGroup: { logGroupArn: logGroup.logGroupArn } }],
      },
    });

    const eventsRole = new iam.Role(this, 'EventBridgeTargetRole', {
      roleName: `${resourcePrefix}-ingress-dns-events-role-${this.region}`,
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
    });
    new iam.ManagedPolicy(this, 'EventBridgeTargetPolicy', {
      description: 'Allows EventBridge rules to start the ingress DNS state machine',
      roles: [eventsRole],
      statements: [new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [stateMachine.ref],
      })],
    });

    // Rules that deliver failed events to the DLQ (granted below via the queue policy).
    const dlqSourceRuleArns: string[] = [];

    const dnsRule = new events.CfnRule(this, 'DnsAutomationRule', {
      name: `${resourcePrefix}-ingress-dns-trigger`,
      state: 'ENABLED',
      eventPattern: {
        source: ['aws.tag'],
        'detail-type': ['Tag Change on Resource'],
        detail: {
          service: ['vpc-lattice'],
          'resource-type': ['resourceconfiguration'],
          'changed-tag-keys': [tagKey],
        },
      },
      targets: [{
        id: 'StepFunctionsTarget',
        arn: stateMachine.ref,
        roleArn: eventsRole.roleArn,
        retryPolicy: { maximumEventAgeInSeconds: 60, maximumRetryAttempts: 5 },
        deadLetterConfig: { arn: dlq.queueArn },
      }],
    });
    dlqSourceRuleArns.push(dnsRule.attrArn);

    // ----------------------------------------------------------------
    // Cross-account ingress: workload accounts expose applications as Resource
    // Configurations in their OWN account, so the RC tag-change event fires on
    // the workload account's default bus, not here. A dedicated custom event
    // bus (org-scoped) receives those forwarded events; a second rule on it
    // drives the same state machine. Workload accounts forward via
    // WorkloadIngressDnsForwarderStack / workload-ingress-dns-forwarder.yaml.
    // ----------------------------------------------------------------
    if (props.orgId) {
      const crossAccountBus = new events.CfnEventBus(this, 'IngressDnsBus', {
        name: `${resourcePrefix}-ingress-dns-bus`,
      });

      // Allow any account in the organization to PutEvents onto this bus.
      // Rendered as a raw CfnResource to avoid the deprecated L1 props on
      // events.CfnEventBusPolicy (action/principal/condition); output is identical.
      new cdk.CfnResource(this, 'IngressDnsBusPolicy', {
        type: 'AWS::Events::EventBusPolicy',
        properties: {
          EventBusName: crossAccountBus.ref,
          StatementId: `${resourcePrefix}-ingress-dns-org`,
          Statement: {
            Effect: 'Allow',
            Principal: '*',
            Action: 'events:PutEvents',
            Resource: crossAccountBus.attrArn,
            Condition: { StringEquals: { 'aws:PrincipalOrgID': props.orgId } },
          },
        },
      });

      const crossAccountRule = new events.CfnRule(this, 'DnsAutomationRuleCrossAccount', {
        name: `${resourcePrefix}-ingress-dns-trigger-xacct`,
        eventBusName: crossAccountBus.ref,
        state: 'ENABLED',
        eventPattern: {
          source: ['aws.tag'],
          'detail-type': ['Tag Change on Resource'],
          detail: {
            service: ['vpc-lattice'],
            'resource-type': ['resourceconfiguration'],
            'changed-tag-keys': [tagKey],
          },
        },
        targets: [{
          id: 'StepFunctionsTarget',
          arn: stateMachine.ref,
          roleArn: eventsRole.roleArn,
          retryPolicy: { maximumEventAgeInSeconds: 60, maximumRetryAttempts: 5 },
          deadLetterConfig: { arn: dlq.queueArn },
        }],
      });
      dlqSourceRuleArns.push(crossAccountRule.attrArn);

      // Publish the bus name so workload-account forwarders (in other accounts)
      // can be pointed at it via context; also surfaced as a stack output.
      new ssm.StringParameter(this, 'IngressDnsBusNameParam', {
        parameterName: `${ssmPrefix}/ingress/dns-bus/name`,
        stringValue: crossAccountBus.ref,
        description: 'Cross-account ingress DNS event bus name (workload forwarders target this bus in the Network account).',
      });
      new cdk.CfnOutput(this, 'IngressDnsBusName', { value: crossAccountBus.ref });
      new cdk.CfnOutput(this, 'IngressDnsBusArn', { value: crossAccountBus.attrArn });
    }

    // EventBridge needs an explicit allow to deliver failed events to a rule DLQ.
    dlq.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowEventBridgeRulesToSend',
      principals: [new iam.ServicePrincipal('events.amazonaws.com')],
      actions: ['sqs:SendMessage'],
      resources: [dlq.queueArn],
      conditions: { ArnEquals: { 'aws:SourceArn': dlqSourceRuleArns } },
    }));

    new cdk.CfnOutput(this, 'StateMachineArn', { value: stateMachine.ref });
    new cdk.CfnOutput(this, 'DnsRecordTableName', { value: table.tableName });

    // ----------------------------------------------------------------
    // cdk-nag suppressions
    // ----------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(sfnPolicy, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'ec2:DescribeVpcEndpointAssociations does not support resource-level permissions; CloudWatch Logs delivery actions for Step Functions logging require wildcard per AWS documentation. DynamoDB and Route 53 access are scoped to the specific table and hosted zone.',
        appliesTo: ['Resource::*'],
      },
    ]);

    NagSuppressions.addResourceSuppressions(stateMachine, [
      {
        id: 'AwsSolutions-SF2',
        reason: 'X-Ray tracing is not required for this low-volume control-plane DNS automation; execution data is already logged to CloudWatch Logs.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(dlq, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This queue IS the dead-letter queue for the EventBridge rule target; a DLQ does not need its own DLQ.',
      },
    ]);
  }
}
