import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface VpcLatticeIngressZoneStackProps extends cdk.StackProps {
  /** Private hosted zone name for ingress custom domains. */
  zoneName?: string;
  /** Ingress VPC to associate the zone with. Defaults to the foundation Ingress VPC from SSM. */
  ingressVpcId?: string;
  /** SSM namespace under which the zone ID is published. */
  ssmPrefix?: string;
  /** Single token that namespaces resource Name tags. */
  resourcePrefix?: string;
}

/**
 * VpcLatticeIngressZoneStack (Network account): Phase 5 ingress hosted zone.
 *
 * Creates the Route 53 private hosted zone that holds the custom-domain CNAME
 * records for resources exposed through the Service Network VPC Endpoint (SN-E).
 * The zone is associated to the Ingress VPC so the inbound Route 53 Resolver
 * endpoint (created by VpcLatticeIngressStack) can answer external and
 * on-premises queries for it. The zone ID is published to SSM so the ingress
 * DNS automation (VpcLatticeIngressDnsStack) can resolve it without manual wiring.
 *
 * Kept at parity with cloudformation/vpc-lattice-ingress-zone.yaml.
 */
export class VpcLatticeIngressZoneStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: VpcLatticeIngressZoneStackProps = {}) {
    super(scope, id, props);

    const resourcePrefix = props.resourcePrefix ?? 'netfabric';
    const ssmPrefix = props.ssmPrefix ?? `/${resourcePrefix}`;
    const zoneName = props.zoneName ?? 'ingress.internal';
    const ingressVpcId = props.ingressVpcId
      ?? ssm.StringParameter.valueForStringParameter(this, `${ssmPrefix}/network/ingress-vpc/id`);

    const zone = new route53.CfnHostedZone(this, 'IngressZone', {
      name: zoneName,
      vpcs: [{ vpcId: ingressVpcId, vpcRegion: this.region }],
      hostedZoneConfig: { comment: `${resourcePrefix} ingress custom-domain zone` },
    });

    new ssm.StringParameter(this, 'IngressZoneIdParam', {
      parameterName: `${ssmPrefix}/ingress/hosted-zone-id`,
      stringValue: zone.attrId,
      description: `Route 53 private hosted zone ID for ingress custom domains (${zoneName})`,
    });

    new cdk.CfnOutput(this, 'IngressHostedZoneId', { value: zone.attrId });
    new cdk.CfnOutput(this, 'IngressZoneName', { value: zoneName });
  }
}
