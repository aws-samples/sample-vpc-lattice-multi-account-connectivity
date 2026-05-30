import * as cdk from 'aws-cdk-lib';
import * as ram from 'aws-cdk-lib/aws-ram';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface VpcLatticeCoreStackProps extends cdk.StackProps {
  orgId: string;
  devOuArn: string;
  stageOuArn: string;
  prodOuArn: string;
}

/**
 * Creates three VPC Lattice service networks (dev, stage, prod) and
 * shares them to the corresponding organizational units via AWS RAM.
 *
 * This is the foundational stack. All other stacks depend on it.
 */
export class VpcLatticeCoreStack extends cdk.Stack {
  public readonly serviceNetworkIds: { dev: string; stage: string; prod: string };

  constructor(scope: Construct, id: string, props: VpcLatticeCoreStackProps) {
    super(scope, id, props);

    // Service Network: Dev
    const snDev = new cdk.CfnResource(this, 'ServiceNetworkDev', {
      type: 'AWS::VpcLattice::ServiceNetwork',
      properties: {
        Name: 'sn-dev-shared',
        AuthType: 'AWS_IAM',
        Tags: [{ Key: 'Environment', Value: 'dev' }],
      },
    });

    // Service Network: Stage
    const snStage = new cdk.CfnResource(this, 'ServiceNetworkStage', {
      type: 'AWS::VpcLattice::ServiceNetwork',
      properties: {
        Name: 'sn-stage-shared',
        AuthType: 'AWS_IAM',
        Tags: [{ Key: 'Environment', Value: 'stage' }],
      },
    });

    // Service Network: Prod
    const snProd = new cdk.CfnResource(this, 'ServiceNetworkProd', {
      type: 'AWS::VpcLattice::ServiceNetwork',
      properties: {
        Name: 'sn-prod-shared',
        AuthType: 'AWS_IAM',
        Tags: [{ Key: 'Environment', Value: 'prod' }],
      },
    });

    // RAM Share: Dev service network to Dev OU
    new ram.CfnResourceShare(this, 'RamShareDev', {
      name: 'vpc-lattice-sn-dev-share',
      allowExternalPrincipals: false,
      principals: [props.devOuArn],
      resourceArns: [snDev.getAtt('Arn').toString()],
    });

    // RAM Share: Stage service network to Stage OU
    new ram.CfnResourceShare(this, 'RamShareStage', {
      name: 'vpc-lattice-sn-stage-share',
      allowExternalPrincipals: false,
      principals: [props.stageOuArn],
      resourceArns: [snStage.getAtt('Arn').toString()],
    });

    // RAM Share: Prod service network to Prod OU
    new ram.CfnResourceShare(this, 'RamShareProd', {
      name: 'vpc-lattice-sn-prod-share',
      allowExternalPrincipals: false,
      principals: [props.prodOuArn],
      resourceArns: [snProd.getAtt('Arn').toString()],
    });

    // ----------------------------------------------------------------
    // IAM Auth Policies (per service network)
    // ----------------------------------------------------------------
    // Each service network has AuthType=AWS_IAM. Without an explicit Allow,
    // SigV4-authenticated VPC Lattice calls would be denied by default.
    // We attach an auth policy that allows vpc-lattice-svcs:Invoke from any
    // principal inside the corresponding OU (matched via aws:PrincipalOrgPaths).
    //
    // The OU IDs are derived from the OU ARNs passed in via context.
    // ARN form: arn:aws:organizations::<mgmt-acct>:ou/<o-id>/<ou-id>
    // Splitting by "/" yields: ["arn:...:ou", "<o-id>", "<ou-id>"]; index 2 is the OU ID.
    const ouIdFromArn = (ouArn: string): string => cdk.Fn.select(2, cdk.Fn.split('/', ouArn));

    const authPolicy = (ouArn: string) => ({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: 'vpc-lattice-svcs:Invoke',
          Resource: '*',
          Condition: {
            'ForAnyValue:StringLike': {
              // PrincipalOrgPaths are of the form "<o-id>/r-xxxx/<ou-id>/*".
              // Using a wildcarded suffix matches any account in that OU subtree.
              'aws:PrincipalOrgPaths': [
                cdk.Fn.join('', [props.orgId, '/*/', ouIdFromArn(ouArn), '/*']),
              ],
            },
          },
        },
      ],
    });

    new cdk.CfnResource(this, 'AuthPolicyDev', {
      type: 'AWS::VpcLattice::AuthPolicy',
      properties: {
        ResourceIdentifier: snDev.getAtt('Id'),
        Policy: authPolicy(props.devOuArn),
      },
    });
    new cdk.CfnResource(this, 'AuthPolicyStage', {
      type: 'AWS::VpcLattice::AuthPolicy',
      properties: {
        ResourceIdentifier: snStage.getAtt('Id'),
        Policy: authPolicy(props.stageOuArn),
      },
    });
    new cdk.CfnResource(this, 'AuthPolicyProd', {
      type: 'AWS::VpcLattice::AuthPolicy',
      properties: {
        ResourceIdentifier: snProd.getAtt('Id'),
        Policy: authPolicy(props.prodOuArn),
      },
    });

    // Export service network IDs for dependent stacks
    this.serviceNetworkIds = {
      dev: snDev.getAtt('Id').toString(),
      stage: snStage.getAtt('Id').toString(),
      prod: snProd.getAtt('Id').toString(),
    };

    // Access logging: one CloudWatch log group per environment per log type
    // (SERVICE / RESOURCE). VPC Lattice access logs are the authoritative audit
    // trail for endpoint access and the egress chokepoint, and the observability
    // source for the internal egress NLB.
    const accessLogNetworks: { env: string; sn: cdk.CfnResource }[] = [
      { env: 'dev', sn: snDev },
      { env: 'stage', sn: snStage },
      { env: 'prod', sn: snProd },
    ];
    for (const { env, sn } of accessLogNetworks) {
      for (const logType of ['SERVICE', 'RESOURCE'] as const) {
        const lg = new logs.LogGroup(this, `AccessLog${env}${logType}`, {
          logGroupName: `/apg-lattice/${env}/${logType.toLowerCase()}-access-logs`,
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        new cdk.CfnResource(this, `AccessLogSub${env}${logType}`, {
          type: 'AWS::VpcLattice::AccessLogSubscription',
          properties: {
            ResourceIdentifier: sn.getAtt('Id'),
            DestinationArn: lg.logGroupArn,
            ServiceNetworkLogType: logType,
          },
        });
      }
    }

    // Outputs
    new cdk.CfnOutput(this, 'ServiceNetworkDevId', { value: this.serviceNetworkIds.dev });
    new cdk.CfnOutput(this, 'ServiceNetworkStageId', { value: this.serviceNetworkIds.stage });
    new cdk.CfnOutput(this, 'ServiceNetworkProdId', { value: this.serviceNetworkIds.prod });
  }
}
