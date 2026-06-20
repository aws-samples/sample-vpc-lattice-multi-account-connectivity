import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface WorkloadIngressDnsForwarderStackProps extends cdk.StackProps {
  /** Network account ID that hosts the ingress DNS automation and its cross-account bus. */
  networkAccountId: string;
  /** Name of the cross-account ingress DNS event bus in the Network account. */
  ingressDnsBusName?: string;
  /** Tag key that opts a Resource Configuration in to ingress DNS publishing. */
  publishTagKey?: string;
  resourcePrefix?: string;
}

/**
 * WorkloadIngressDnsForwarderStack (Workload account): Phase 5 ingress DNS, the
 * workload-account half of the cross-account automation.
 *
 * A workload account exposes its application as a Resource Configuration in its
 * OWN account, so the "publish" tag change fires on this account's default
 * EventBridge bus, not in the Network account where the DNS automation runs.
 * This stack forwards those VPC Lattice Resource Configuration tag-change events
 * to the Network account's cross-account ingress DNS bus, where the Step
 * Functions automation creates or deletes the custom-domain CNAME.
 *
 * Deploy once per workload account (alongside or after the workload app). No
 * Lambda: a single EventBridge rule with a cross-account event-bus target.
 * Kept at parity with cloudformation/workload-ingress-dns-forwarder.yaml.
 */
export class WorkloadIngressDnsForwarderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkloadIngressDnsForwarderStackProps) {
    super(scope, id, props);

    const resourcePrefix = props.resourcePrefix ?? 'netfabric';
    const tagKey = props.publishTagKey ?? 'PublishIngressDns';
    const busName = props.ingressDnsBusName ?? `${resourcePrefix}-ingress-dns-bus`;
    const targetBusArn = `arn:${this.partition}:events:${this.region}:${props.networkAccountId}:event-bus/${busName}`;

    // Role EventBridge assumes to put forwarded events onto the Network bus.
    const forwarderRole = new iam.Role(this, 'ForwarderRole', {
      roleName: `${resourcePrefix}-ingress-dns-forwarder-role-${this.region}`,
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
    });
    forwarderRole.addToPolicy(new iam.PolicyStatement({
      actions: ['events:PutEvents'],
      resources: [targetBusArn],
    }));

    // Forward this account's RC publish-tag changes to the Network DNS bus.
    new events.CfnRule(this, 'ForwardRcTagChanges', {
      name: `${resourcePrefix}-ingress-dns-forward`,
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
        id: 'NetworkIngressDnsBus',
        arn: targetBusArn,
        roleArn: forwarderRole.roleArn,
      }],
    });

    new cdk.CfnOutput(this, 'TargetBusArn', { value: targetBusArn });

    NagSuppressions.addResourceSuppressions(forwarderRole, [
      { id: 'AwsSolutions-IAM5', reason: 'events:PutEvents is scoped to the single Network-account ingress DNS bus ARN; no wildcard resource.' },
    ], true);
  }
}
