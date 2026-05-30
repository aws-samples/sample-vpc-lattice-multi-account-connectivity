#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { NetworkFoundationStack } from '../lib/network-foundation-stack';
import { WorkloadFoundationStack } from '../lib/workload-foundation-stack';
import { VpcLatticeCoreStack } from '../lib/vpc-lattice-core-stack';
import { VpcLatticeEndpointsStack } from '../lib/vpc-lattice-endpoints-stack';
import { SquidImageBuildStack } from '../lib/squid-image-build-stack';
import { SquidEgressStack } from '../lib/squid-egress-stack';
import { WorkloadAssociationStackSetStack } from '../lib/workload-association-stackset-stack';
import { WorkloadValidatorStack } from '../lib/workload-validator-stack';

const app = new cdk.App();

// Add cdk-nag AwsSolutionsChecks for security posture validation
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

const region = app.node.tryGetContext('region') || 'us-east-2';

// ----------------------------------------------------------------
// Per-account env binding
//
// Each stack is pinned to its target account at synth time via context
// values (networkAccountId, managementAccountId, workloadAccountId). CDK
// refuses to deploy a stack into an account that does not match its bound
// env, so an accidental `--profile` mismatch fails fast instead of silently
// deploying the wrong resources to the wrong account.
//
// Override at the CLI:
//   npx cdk deploy <Stack> -c networkAccountId=111111111111
// or set the values in cdk.json / cdk.context.json.
// ----------------------------------------------------------------
const networkAccountId = app.node.tryGetContext('networkAccountId') || process.env.CDK_DEFAULT_ACCOUNT;
const managementAccountId = app.node.tryGetContext('managementAccountId') || process.env.CDK_DEFAULT_ACCOUNT;
const workloadAccountId = app.node.tryGetContext('workloadAccountId') || process.env.CDK_DEFAULT_ACCOUNT;

const networkEnv = { account: networkAccountId, region };
const managementEnv = { account: managementAccountId, region };
const workloadEnv = { account: workloadAccountId, region };

// SSM namespace for the dedicated APG foundation (NOT the LZA /accelerator paths)
const ssmPrefix = app.node.tryGetContext('ssmPrefix') || '/apg-lattice';

// ----------------------------------------------------------------
// Foundation stacks: dedicated VPCs (3 AZs) for the reference architecture
// ----------------------------------------------------------------

// Deployed to the Network account.
new NetworkFoundationStack(app, 'NetworkFoundationStack', {
  env: networkEnv,
  description: 'Dedicated Endpoint + Egress VPCs (3 AZ) for the VPC Lattice reference architecture',
  ssmPrefix,
});

// Deployed to the Workload Dev account.
new WorkloadFoundationStack(app, 'WorkloadFoundationStack', {
  env: workloadEnv,
  description: 'Dedicated workload VPC (3 AZ) for VPC Lattice onboarding',
  vpcSsmPath: `${ssmPrefix}/workload/dev-vpc/id`,
});

// ----------------------------------------------------------------
// Deliverable stacks
// ----------------------------------------------------------------

// Stack 1: Core service networks and RAM shares (Network Account)
const coreStack = new VpcLatticeCoreStack(app, 'VpcLatticeCoreStack', {
  env: networkEnv,
  description: 'VPC Lattice service networks and RAM shares for multi-account connectivity',
  orgId: app.node.tryGetContext('orgId'),
  devOuArn: app.node.tryGetContext('devOuArn'),
  stageOuArn: app.node.tryGetContext('stageOuArn'),
  prodOuArn: app.node.tryGetContext('prodOuArn'),
});

// Stack 2: Endpoint Resource Configurations (Network Account)
const endpointsStack = new VpcLatticeEndpointsStack(app, 'VpcLatticeEndpointsStack', {
  env: networkEnv,
  description: 'Resource Gateway and Resource Configurations for shared VPC endpoints',
  endpointVpcSsmPath: app.node.tryGetContext('endpointVpcSsmPath'),
  endpointSubnetASsmPath: app.node.tryGetContext('endpointSubnetASsmPath'),
  endpointSubnetBSsmPath: app.node.tryGetContext('endpointSubnetBSsmPath'),
  endpointSubnetCSsmPath: app.node.tryGetContext('endpointSubnetCSsmPath'),
  endpointSgSsmPath: app.node.tryGetContext('endpointSgSsmPath'),
  serviceNetworkIds: coreStack.serviceNetworkIds,
  orgId: app.node.tryGetContext('orgId'),
});
endpointsStack.addDependency(coreStack);

// Squid image build: CodeBuild project + ECR repo (Network account).
// Builds the custom Squid image (with FQDN allowlist) and publishes its URI to SSM.
const squidImageBuild = new SquidImageBuildStack(app, 'SquidImageBuildStack', {
  env: networkEnv,
  description: 'CodeBuild + ECR for the custom Squid proxy image with FQDN filtering',
});

// Stack 3: Squid Egress Proxy (Network Account, Egress VPC)
const egressStack = new SquidEgressStack(app, 'SquidEgressStack', {
  env: networkEnv,
  description: 'Centralized Squid egress proxy with FQDN filtering via VPC Lattice',
  egressVpcSsmPath: app.node.tryGetContext('egressVpcSsmPath'),
  egressSubnetASsmPath: app.node.tryGetContext('egressSubnetASsmPath'),
  egressSubnetBSsmPath: app.node.tryGetContext('egressSubnetBSsmPath'),
  egressSubnetCSsmPath: app.node.tryGetContext('egressSubnetCSsmPath'),
  egressSgSsmPath: app.node.tryGetContext('egressSgSsmPath'),
  serviceNetworkIds: coreStack.serviceNetworkIds,
  allowedDomains: app.node.tryGetContext('squidAllowedDomains'),
  desiredCount: app.node.tryGetContext('squidDesiredCount') || 2,
  cpu: app.node.tryGetContext('squidCpu') || 512,
  memory: app.node.tryGetContext('squidMemory') || 1024,
  squidImageUriSsmPath: app.node.tryGetContext('squidImageUriSsmPath') || `${ssmPrefix}/egress/squid-image-uri`,
});
egressStack.addDependency(coreStack);
egressStack.addDependency(squidImageBuild);

// Stack 4: Workload VPC Association — service-managed StackSet (Management account)
// Auto-associates every current and future account in the target OU(s) with the
// service network. No Lambda: VPC ID resolves natively from SSM per account, and
// the service network ID is the single RAM-shared resource passed as a parameter.
new WorkloadAssociationStackSetStack(app, 'WorkloadAssociationStackSetStack', {
  env: managementEnv,
  description: 'Service-managed StackSet associating workload OU VPCs with the VPC Lattice service network',
  targetOuIds: [app.node.tryGetContext('devOuId') || 'ou-EXAMPLE-dev0000'],
  serviceNetworkId: app.node.tryGetContext('devServiceNetworkId') || coreStack.serviceNetworkIds.dev,
  serviceNetworkName: 'sn-dev-shared',
  workloadVpcSsmPath: app.node.tryGetContext('workloadVpcSsmPath') || `${ssmPrefix}/workload/dev-vpc/id`,
  latticePrefixListId: app.node.tryGetContext('latticePrefixListV4'),
  regions: [region],
});

// Validation-only: small SSM-managed EC2 in the workload VPC for in-VPC checks
// (DNS resolution, AWS API connectivity, egress proxy). Destroyed during cleanup.
new WorkloadValidatorStack(app, 'WorkloadValidatorStack', {
  env: workloadEnv,
  description: 'Throwaway SSM-managed validator instance for in-VPC connectivity checks',
  vpcSsmPath: app.node.tryGetContext('workloadVpcSsmPath') || `${ssmPrefix}/workload/dev-vpc/id`,
  subnetSsmPath: app.node.tryGetContext('workloadSubnetSsmPath') || `${ssmPrefix}/workload/dev-vpc/subnet/a/id`,
});

app.synth();
