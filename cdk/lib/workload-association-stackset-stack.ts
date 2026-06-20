import * as cdk from 'aws-cdk-lib';
import * as cfn from 'aws-cdk-lib/aws-cloudformation';
import { Construct } from 'constructs';

export interface WorkloadAssociationStackSetStackProps extends cdk.StackProps {
  /**
   * Organizational Unit ID(s) to target. Every current and future account in
   * these OUs is associated automatically (auto-deployment enabled).
   */
  targetOuIds: string[];

  /**
   * The RAM-shared service network ID for the environment. Identical across
   * every account in the target OU because it is a single shared resource.
   */
  serviceNetworkId: string;

  /** Service network name, used for the association Name tag. */
  serviceNetworkName: string;

  /** SSM parameter path (resolved natively, per-account) holding the workload VPC ID. */
  workloadVpcSsmPath: string;

  /** VPC Lattice managed prefix list ID (com.amazonaws.<region>.vpc-lattice). */
  latticePrefixListId: string;

  /** Region(s) to deploy stack instances into. */
  regions: string[];

  /** Single token that namespaces the StackSet name. */
  resourcePrefix?: string;
}

/**
 * WorkloadAssociationStackSetStack (Management / delegated-admin account)
 *
 * Defines a SERVICE_MANAGED CloudFormation StackSet that associates the
 * workload VPC in every account of the target OU(s) with its VPC Lattice
 * service network, with private DNS enabled for all domains.
 *
 * Auto-deployment is enabled, so accounts that join the OU later are
 * associated automatically and accounts that leave have their association
 * removed.
 *
 * No Lambda / custom resource is used:
 *  - the workload VPC ID resolves natively via an AWS::SSM::Parameter::Value
 *    parameter (per target account), and
 *  - the service network ID is passed as a parameter (single shared resource).
 */
export class WorkloadAssociationStackSetStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WorkloadAssociationStackSetStackProps) {
    super(scope, id, props);

    // Inline association template (kept in sync with
    // cloudformation/vpc-lattice-workload-vpc-association.yaml). Inlining keeps
    // the StackSet self-contained with no cross-account asset bucket dependency.
    const templateBody = {
      AWSTemplateFormatVersion: '2010-09-09',
      Description:
        'Associates a workload VPC with its RAM-shared VPC Lattice service network (private DNS, all domains). Deployed via service-managed StackSet.',
      Parameters: {
        WorkloadVpcId: {
          Type: 'AWS::SSM::Parameter::Value<AWS::EC2::VPC::Id>',
          Default: props.workloadVpcSsmPath,
          Description: 'SSM parameter path resolved (per account) to the workload VPC ID.',
        },
        ServiceNetworkId: {
          Type: 'String',
          AllowedPattern: '^sn-[0-9a-z]{17}$',
          Description: 'RAM-shared VPC Lattice service network ID for this environment.',
        },
        ServiceNetworkName: {
          Type: 'String',
          Description: 'Service network name, used for the association Name tag.',
        },
        LatticePrefixListId: {
          Type: 'String',
          AllowedPattern: '^pl-[a-z0-9]+$',
          Description: 'VPC Lattice managed prefix list ID (com.amazonaws.<region>.vpc-lattice).',
        },
      },
      Resources: {
        // SG attached to the VPC association: allows the workload VPC to send
        // traffic INTO the Lattice data plane (egress to the managed prefix
        // list) on 443 (endpoints) and 3128 (egress proxy). Without this,
        // traffic to Lattice IPs is dropped and connections time out.
        WorkloadLatticeSecurityGroup: {
          Type: 'AWS::EC2::SecurityGroup',
          Properties: {
            GroupDescription: { 'Fn::Sub': 'Lattice workload access - ${AWS::StackName}' },
            VpcId: { Ref: 'WorkloadVpcId' },
            SecurityGroupEgress: [
              {
                IpProtocol: 'tcp',
                FromPort: 443,
                ToPort: 443,
                DestinationPrefixListId: { Ref: 'LatticePrefixListId' },
                Description: 'HTTPS to VPC Lattice (shared endpoints)',
              },
              {
                IpProtocol: 'tcp',
                FromPort: 3128,
                ToPort: 3128,
                DestinationPrefixListId: { Ref: 'LatticePrefixListId' },
                Description: 'Proxy to VPC Lattice (centralized egress)',
              },
            ],
            Tags: [{ Key: 'Name', Value: { 'Fn::Sub': '${AWS::StackName}-lattice-sg' } }],
          },
        },
        VpcAssociation: {
          Type: 'AWS::VpcLattice::ServiceNetworkVpcAssociation',
          Properties: {
            ServiceNetworkIdentifier: { Ref: 'ServiceNetworkId' },
            VpcIdentifier: { Ref: 'WorkloadVpcId' },
            PrivateDnsEnabled: true,
            DnsOptions: { PrivateDnsPreference: 'ALL_DOMAINS' },
            Tags: [
              { Key: 'Name', Value: { 'Fn::Sub': 'lattice-vpc-assoc-${ServiceNetworkName}' } },
            ],
          },
        },
      },
      Outputs: {
        VpcAssociationId: { Value: { 'Fn::GetAtt': ['VpcAssociation', 'Id'] } },
        ResolvedVpcId: { Value: { Ref: 'WorkloadVpcId' } },
        ServiceNetworkId: { Value: { Ref: 'ServiceNetworkId' } },
        WorkloadLatticeSecurityGroupId: { Value: { Ref: 'WorkloadLatticeSecurityGroup' } },
      },
    };

    new cfn.CfnStackSet(this, 'WorkloadAssociationStackSet', {
      stackSetName: `${props.resourcePrefix ?? 'netfabric'}-workload-association`,
      description:
        'Associates workload VPCs in the target OU with the VPC Lattice service network (private DNS, all domains).',
      permissionModel: 'SERVICE_MANAGED',
      capabilities: ['CAPABILITY_NAMED_IAM'],
      autoDeployment: {
        enabled: true,
        retainStacksOnAccountRemoval: false,
      },
      operationPreferences: {
        failureToleranceCount: 0,
        maxConcurrentCount: 5,
      },
      parameters: [
        { parameterKey: 'WorkloadVpcId', parameterValue: props.workloadVpcSsmPath },
        { parameterKey: 'ServiceNetworkId', parameterValue: props.serviceNetworkId },
        { parameterKey: 'ServiceNetworkName', parameterValue: props.serviceNetworkName },
        { parameterKey: 'LatticePrefixListId', parameterValue: props.latticePrefixListId },
      ],
      stackInstancesGroup: [
        {
          deploymentTargets: {
            organizationalUnitIds: props.targetOuIds,
          },
          regions: props.regions,
        },
      ],
      templateBody: JSON.stringify(templateBody),
    });
  }
}
