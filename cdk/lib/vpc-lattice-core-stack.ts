import * as cdk from 'aws-cdk-lib';
import * as ram from 'aws-cdk-lib/aws-ram';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface VpcLatticeCoreStackProps extends cdk.StackProps {
  orgId: string;
  devOuArn: string;
  testOuArn: string;
  prodOuArn: string;
  /** Single token that namespaces access-log group paths. */
  resourcePrefix?: string;
}

/**
 * Creates three VPC Lattice service networks (dev, test, prod) and
 * shares them to the corresponding organizational units via AWS RAM.
 *
 * This is the foundational stack. All other stacks depend on it.
 */
export class VpcLatticeCoreStack extends cdk.Stack {
  public readonly serviceNetworkIds: { dev: string; test: string; prod: string };

  constructor(scope: Construct, id: string, props: VpcLatticeCoreStackProps) {
    super(scope, id, props);

    const resourcePrefix = props.resourcePrefix ?? 'netfabric';

    // Service Network: Dev
    const snDev = new cdk.CfnResource(this, 'ServiceNetworkDev', {
      type: 'AWS::VpcLattice::ServiceNetwork',
      properties: {
        Name: 'sn-dev-shared',
        AuthType: 'AWS_IAM',
        Tags: [
          { Key: 'Name', Value: 'sn-dev-shared' },
          { Key: 'Environment', Value: 'dev' },
          { Key: 'Description', Value: 'Shared VPC Lattice service network for the dev environment: AWS service endpoint access and centralized egress for dev OU workload VPCs.' },
        ],
      },
    });

    // Service Network: Test
    const snTest = new cdk.CfnResource(this, 'ServiceNetworkTest', {
      type: 'AWS::VpcLattice::ServiceNetwork',
      properties: {
        Name: 'sn-test-shared',
        AuthType: 'AWS_IAM',
        Tags: [
          { Key: 'Name', Value: 'sn-test-shared' },
          { Key: 'Environment', Value: 'test' },
          { Key: 'Description', Value: 'Shared VPC Lattice service network for the test environment: AWS service endpoint access and centralized egress for test OU workload VPCs.' },
        ],
      },
    });

    // Service Network: Prod
    const snProd = new cdk.CfnResource(this, 'ServiceNetworkProd', {
      type: 'AWS::VpcLattice::ServiceNetwork',
      properties: {
        Name: 'sn-prod-shared',
        AuthType: 'AWS_IAM',
        Tags: [
          { Key: 'Name', Value: 'sn-prod-shared' },
          { Key: 'Environment', Value: 'prod' },
          { Key: 'Description', Value: 'Shared VPC Lattice service network for the prod environment: AWS service endpoint access and centralized egress for prod OU workload VPCs.' },
        ],
      },
    });

    // RAM Share: Dev service network to Dev OU
    new ram.CfnResourceShare(this, 'RamShareDev', {
      name: `${resourcePrefix}-sn-dev-share`,
      allowExternalPrincipals: false,
      principals: [props.devOuArn],
      resourceArns: [snDev.getAtt('Arn').toString()],
    });

    // RAM Share: Test service network to Test OU
    new ram.CfnResourceShare(this, 'RamShareTest', {
      name: `${resourcePrefix}-sn-test-share`,
      allowExternalPrincipals: false,
      principals: [props.testOuArn],
      resourceArns: [snTest.getAtt('Arn').toString()],
    });

    // RAM Share: Prod service network to Prod OU
    new ram.CfnResourceShare(this, 'RamShareProd', {
      name: `${resourcePrefix}-sn-prod-share`,
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
    new cdk.CfnResource(this, 'AuthPolicyTest', {
      type: 'AWS::VpcLattice::AuthPolicy',
      properties: {
        ResourceIdentifier: snTest.getAtt('Id'),
        Policy: authPolicy(props.testOuArn),
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
      test: snTest.getAtt('Id').toString(),
      prod: snProd.getAtt('Id').toString(),
    };

    // Access logging: one CloudWatch log group per environment per log type
    // (SERVICE / RESOURCE). VPC Lattice access logs are the authoritative audit
    // trail for endpoint access and the egress chokepoint, and the observability
    // source for the internal egress NLB.
    const accessLogNetworks: { env: string; sn: cdk.CfnResource }[] = [
      { env: 'dev', sn: snDev },
      { env: 'test', sn: snTest },
      { env: 'prod', sn: snProd },
    ];
    for (const { env, sn } of accessLogNetworks) {
      for (const logType of ['SERVICE', 'RESOURCE'] as const) {
        const lg = new logs.LogGroup(this, `AccessLog${env}${logType}`, {
          logGroupName: `/${resourcePrefix}/${env}/${logType.toLowerCase()}-access-logs`,
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
    new cdk.CfnOutput(this, 'ServiceNetworkTestId', { value: this.serviceNetworkIds.test });
    new cdk.CfnOutput(this, 'ServiceNetworkProdId', { value: this.serviceNetworkIds.prod });
  }
}
