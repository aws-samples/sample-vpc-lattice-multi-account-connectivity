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
import { VpcLatticeIngressStack } from '../lib/vpc-lattice-ingress-stack';
import { VpcLatticeIngressZoneStack } from '../lib/vpc-lattice-ingress-zone-stack';
import { VpcLatticeIngressDnsStack } from '../lib/vpc-lattice-ingress-dns-stack';
import { WorkloadAppStack } from '../lib/workload-app-stack';
import { WorkloadIngressDnsForwarderStack } from '../lib/workload-ingress-dns-forwarder-stack';
import { IngressConsumerValidatorStack } from '../lib/ingress-consumer-validator-stack';

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

// SSM namespace for the dedicated foundation (NOT the LZA /accelerator paths).
// Everything is namespaced by a single resourcePrefix so names, SSM paths, and
// tags can never drift apart. Override the prefix in cdk.json; do not hardcode it.
const resourcePrefix = app.node.tryGetContext('resourcePrefix') || 'netfabric';
const ssmPrefix = app.node.tryGetContext('ssmPrefix') || `/${resourcePrefix}`;

// VPC CIDRs for the dedicated foundation VPCs. Overridable in cdk.json; when
// unset, each stack falls back to its documented default. These mirror the
// CloudFormation EndpointVpcCidr / EgressVpcCidr / VpcCidr parameters.
const endpointVpcCidr = app.node.tryGetContext('endpointVpcCidr');
const egressVpcCidr = app.node.tryGetContext('egressVpcCidr');
const workloadVpcCidr = app.node.tryGetContext('workloadVpcCidr');
const ingressVpcCidr = app.node.tryGetContext('ingressVpcCidr');

// ----------------------------------------------------------------
// Workload environment selector (variablization for dev/test/prod)
//
// The shared Network-account stacks (core, endpoints, egress, ingress) serve
// ALL environments. The workload-account example stacks (foundation, app,
// validator, DNS forwarder) target ONE environment per deploy, chosen with
// `-c environment=dev|test|prod` (default dev). Each environment maps to its
// own workload account and VPC CIDR via context, so the same stack definitions
// deploy to test and prod by changing context; CloudFormation stacks are
// per-account, so the stack names stay stable. cdk/deploy.sh wraps the full
// multi-account, multi-environment rollout into one command.
// ----------------------------------------------------------------
const workloadEnvironment = app.node.tryGetContext('environment') || 'dev';
const selectedWorkloadAccountId =
  (workloadEnvironment === 'test' && app.node.tryGetContext('testWorkloadAccountId')) ||
  (workloadEnvironment === 'prod' && app.node.tryGetContext('prodWorkloadAccountId')) ||
  workloadAccountId;
const selectedWorkloadEnv = { account: selectedWorkloadAccountId, region };
const selectedWorkloadVpcCidr =
  workloadEnvironment === 'test' ? app.node.tryGetContext('testWorkloadVpcCidr')
    : workloadEnvironment === 'prod' ? app.node.tryGetContext('prodWorkloadVpcCidr')
      : workloadVpcCidr;
const workloadVpcSsmPath = `${ssmPrefix}/workload/${workloadEnvironment}-vpc/id`;
const workloadSubnetSsmPath = `${ssmPrefix}/workload/${workloadEnvironment}-vpc/subnet/a/id`;

// ----------------------------------------------------------------
// Foundation stacks: dedicated VPCs (3 AZs) for the reference architecture
// ----------------------------------------------------------------

// Deployed to the Network account.
new NetworkFoundationStack(app, 'NetworkFoundationStack', {
  env: networkEnv,
  description: 'Dedicated Endpoint + Egress VPCs (3 AZ) for the VPC Lattice reference architecture',
  ssmPrefix,
  resourcePrefix,
  endpointVpcCidr,
  egressVpcCidr,
  ingressVpcCidr,
});

// Deployed to the Workload Dev account.
new WorkloadFoundationStack(app, 'WorkloadFoundationStack', {
  env: selectedWorkloadEnv,
  description: 'Dedicated workload VPC (3 AZ) for VPC Lattice onboarding',
  vpcSsmPath: workloadVpcSsmPath,
  vpcName: `${resourcePrefix}-workload-${workloadEnvironment}-vpc`,
  ssmPrefix,
  vpcCidr: selectedWorkloadVpcCidr,
});

// ----------------------------------------------------------------
// Deliverable stacks
// ----------------------------------------------------------------

// Stack 1: Core service networks and RAM shares (Network Account)
const coreStack = new VpcLatticeCoreStack(app, 'VpcLatticeCoreStack', {
  env: networkEnv,
  description: 'VPC Lattice service networks and RAM shares for multi-account connectivity',
  resourcePrefix,
  orgId: app.node.tryGetContext('orgId'),
  devOuArn: app.node.tryGetContext('devOuArn'),
  testOuArn: app.node.tryGetContext('testOuArn'),
  prodOuArn: app.node.tryGetContext('prodOuArn'),
});

// Stack 2: Endpoint Resource Configurations (Network Account)
const endpointsStack = new VpcLatticeEndpointsStack(app, 'VpcLatticeEndpointsStack', {
  env: networkEnv,
  description: 'Resource Gateway and Resource Configurations for shared VPC endpoints',
  resourcePrefix,
  endpointVpcSsmPath: app.node.tryGetContext('endpointVpcSsmPath') || `${ssmPrefix}/network/endpoint-vpc/id`,
  endpointSubnetASsmPath: app.node.tryGetContext('endpointSubnetASsmPath') || `${ssmPrefix}/network/endpoint-vpc/subnet/a/id`,
  endpointSubnetBSsmPath: app.node.tryGetContext('endpointSubnetBSsmPath') || `${ssmPrefix}/network/endpoint-vpc/subnet/b/id`,
  endpointSubnetCSsmPath: app.node.tryGetContext('endpointSubnetCSsmPath') || `${ssmPrefix}/network/endpoint-vpc/subnet/c/id`,
  endpointSgSsmPath: app.node.tryGetContext('endpointSgSsmPath') || `${ssmPrefix}/network/endpoint-vpc/sg/rg/id`,
  serviceNetworkIds: coreStack.serviceNetworkIds,
  orgId: app.node.tryGetContext('orgId'),
});
endpointsStack.addDependency(coreStack);

// Squid image build: CodeBuild project + ECR repo (Network account).
// Builds the custom Squid image (with FQDN allowlist) and publishes its URI to SSM.
const squidImageBuild = new SquidImageBuildStack(app, 'SquidImageBuildStack', {
  env: networkEnv,
  description: 'CodeBuild + ECR for the custom Squid proxy image with FQDN filtering',
  resourcePrefix,
});

// Stack 3: Squid Egress Proxy (Network Account, Egress VPC)
const egressStack = new SquidEgressStack(app, 'SquidEgressStack', {
  env: networkEnv,
  description: 'Centralized Squid egress proxy with FQDN filtering via VPC Lattice',
  resourcePrefix,
  egressVpcSsmPath: app.node.tryGetContext('egressVpcSsmPath') || `${ssmPrefix}/network/egress-vpc/id`,
  egressSubnetASsmPath: app.node.tryGetContext('egressSubnetASsmPath') || `${ssmPrefix}/network/egress-vpc/subnet/a/id`,
  egressSubnetBSsmPath: app.node.tryGetContext('egressSubnetBSsmPath') || `${ssmPrefix}/network/egress-vpc/subnet/b/id`,
  egressSubnetCSsmPath: app.node.tryGetContext('egressSubnetCSsmPath') || `${ssmPrefix}/network/egress-vpc/subnet/c/id`,
  egressSgSsmPath: app.node.tryGetContext('egressSgSsmPath') || `${ssmPrefix}/network/egress-vpc/sg/rg/id`,
  serviceNetworkIds: coreStack.serviceNetworkIds,
  allowedDomains: app.node.tryGetContext('squidAllowedDomains'),
  desiredCount: app.node.tryGetContext('squidDesiredCount') || 2,
  cpu: app.node.tryGetContext('squidCpu') || 512,
  memory: app.node.tryGetContext('squidMemory') || 1024,
  squidImageUriSsmPath: app.node.tryGetContext('squidImageUriSsmPath') || `${ssmPrefix}/egress/squid-image-uri`,
});
egressStack.addDependency(coreStack);
egressStack.addDependency(squidImageBuild);

// Stack 4: Workload VPC Association, service-managed StackSet (Management account)
// Auto-associates every current and future account in the target OU(s) with the
// service network. No Lambda: VPC ID resolves natively from SSM per account, and
// the service network ID is the single RAM-shared resource passed as a parameter.
new WorkloadAssociationStackSetStack(app, 'WorkloadAssociationStackSetStack', {
  env: managementEnv,
  description: 'Service-managed StackSet associating workload OU VPCs with the VPC Lattice service network',
  resourcePrefix,
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
  env: selectedWorkloadEnv,
  description: 'Throwaway SSM-managed validator instance for in-VPC connectivity checks',
  vpcSsmPath: app.node.tryGetContext('workloadVpcSsmPath') || workloadVpcSsmPath,
  subnetSsmPath: app.node.tryGetContext('workloadSubnetSsmPath') || workloadSubnetSsmPath,
  latticePrefixListId: app.node.tryGetContext('latticePrefixListV4'),
});

// Phase 5 ingress (OPTIONAL, on-demand): minimal Service Network VPC Endpoint
// (SN-E) exposing the dev service network to external/on-premises/cross-Region
// consumers. Deployed on demand (it needs an ingress VPC and consumer CIDR);
// not part of the default Phase 1-4 flow. The DNS record automation is deferred
// to the maintained AWS Guidance solution. Kept at parity with
// cloudformation/vpc-lattice-ingress-sne.yaml.
const ingressSubnetsCtx = app.node.tryGetContext('ingressSubnetIds');
const ingressSubnetIds = ingressSubnetsCtx
  ? ingressSubnetsCtx.split(',').map((s: string) => s.trim())
  : undefined;
const ingressAppPortsCtx = app.node.tryGetContext('ingressAppPorts');
const ingressAppPorts = ingressAppPortsCtx
  ? String(ingressAppPortsCtx).split(',').map((s: string) => parseInt(s.trim(), 10))
  : undefined;

// One Service Network VPC Endpoint (SN-E) per environment whose service network
// is configured. The dev SN-E keeps the original stack id for backward
// compatibility; test/prod get suffixed ids. Each SN-E lives in the shared
// Ingress VPC, fronts its environment's service network, and publishes its ID to
// SSM at <ssmPrefix>/ingress/<env>/sne/id for the DNS automation to query.
const networkAcct = networkAccountId || '111111111111';
const ingressSnIdByEnv: Record<string, string | undefined> = {
  dev: app.node.tryGetContext('devServiceNetworkId') || 'sn-EXAMPLEdev0000000',
  test: app.node.tryGetContext('testServiceNetworkId'),
  prod: app.node.tryGetContext('prodServiceNetworkId'),
};
const ingressEnvNames = ['dev', 'test', 'prod'].filter((e) => ingressSnIdByEnv[e]);
// Serialize SN-E creation across environments. Multiple Service Network VPC
// Endpoints in the SAME VPC provision faster one at a time; creating them
// concurrently can push an endpoint past CloudFormation's fixed stabilization
// window for AWS::EC2::VPCEndpoint and fail with NotStabilized. Chaining the
// stacks (dev -> test -> prod) guarantees ordered, non-concurrent creation when
// they are deployed together (cdk deploy --all / deploy.sh).
let previousIngressStack: VpcLatticeIngressStack | undefined;
for (const envName of ingressEnvNames) {
  // Consistent naming across environments: VpcLatticeIngressStackDev / ...Test / ...Prod.
  const stackId = `VpcLatticeIngressStack${envName.charAt(0).toUpperCase()}${envName.slice(1)}`;
  const sneStack = new VpcLatticeIngressStack(app, stackId, {
    env: networkEnv,
    description: `Phase 5 ingress: Service Network VPC Endpoint (SN-E) for the ${envName} service network`,
    resourcePrefix,
    serviceNetworkArn: `arn:aws:vpc-lattice:${region}:${networkAcct}:servicenetwork/${ingressSnIdByEnv[envName]}`,
    ingressVpcId: app.node.tryGetContext('ingressVpcId'),
    ingressSubnetIds,
    consumerSourceCidr: app.node.tryGetContext('ingressConsumerCidr') || '203.0.113.0/24',
    appPorts: ingressAppPorts,
    latticePrefixListId: app.node.tryGetContext('latticePrefixListV4') || 'pl-EXAMPLE0000000000',
    // Only the dev SN-E creates the singleton inbound Route 53 Resolver endpoint
    // (its name is not environment-scoped, so one per Ingress VPC).
    createInboundResolver: envName === 'dev' && (app.node.tryGetContext('ingressCreateInboundResolver') === true || app.node.tryGetContext('ingressCreateInboundResolver') === 'true'),
    resolverQuerySourceCidr: app.node.tryGetContext('ingressResolverQueryCidr') || '192.0.2.0/24',
    environment: envName,
    ssmPrefix,
  });
  if (previousIngressStack) {
    sneStack.addDependency(previousIngressStack);
  }
  previousIngressStack = sneStack;
}

// Phase 5 ingress hosted zone: Route 53 private hosted zone (ingress.internal)
// for ingress custom domains, associated to the Ingress VPC. Publishes its zone
// ID to SSM for the DNS automation. Parity with cloudformation/vpc-lattice-ingress-zone.yaml.
new VpcLatticeIngressZoneStack(app, 'VpcLatticeIngressZoneStack', {
  env: networkEnv,
  description: 'Phase 5 ingress: Route 53 private hosted zone for ingress custom domains',
  resourcePrefix,
  ssmPrefix,
  zoneName: app.node.tryGetContext('ingressZoneName') || 'ingress.internal',
});

// Phase 5 ingress DNS automation (OPTIONAL, on-demand): event-driven, Lambda-free
// Step Functions flow that keeps custom-domain CNAMEs current for Resource
// Configurations exposed via the SN-E. Deployed on demand. Kept at parity with
// cloudformation/vpc-lattice-ingress-dns-automation.yaml.
new VpcLatticeIngressDnsStack(app, 'VpcLatticeIngressDnsStack', {
  env: networkEnv,
  description: 'Phase 5 ingress DNS automation (EventBridge to Step Functions to Route 53) for SN-E custom domains',
  resourcePrefix,
  ssmPrefix,
  privateHostedZoneId: app.node.tryGetContext('ingressPrivateHostedZoneId'),
  publishTagKey: app.node.tryGetContext('ingressPublishTagKey') || 'PublishIngressDns',
  sneEnvironments: ingressEnvNames,
  orgId: app.node.tryGetContext('orgId'),
});

// Phase 5 ingress PRODUCER (OPTIONAL, on-demand): a workload account exposes an
// internal application to the shared Service Network as a Resource Configuration
// (workload Resource Gateway + RC + SN association), reachable from outside via
// the SN-E. Demonstrates consumer -> SN-E -> Service Network -> workload app.
// Targets the selected environment (dev/test/prod) via `-c environment=`.
const selectedServiceNetworkId =
  workloadEnvironment === 'test'
    ? (app.node.tryGetContext('testServiceNetworkId') || coreStack.serviceNetworkIds.test)
    : workloadEnvironment === 'prod'
      ? (app.node.tryGetContext('prodServiceNetworkId') || coreStack.serviceNetworkIds.prod)
      : (app.node.tryGetContext('devServiceNetworkId') || 'sn-EXAMPLEdev0000000');
const selectedAppDomain =
  app.node.tryGetContext('ingressAppDomain') ||
  (workloadEnvironment === 'dev' ? 'app.ingress.internal' : `app-${workloadEnvironment}.ingress.internal`);

new WorkloadAppStack(app, 'WorkloadAppStack', {
  env: selectedWorkloadEnv,
  description: 'Phase 5 ingress producer: workload application exposed to the Service Network via a Resource Configuration',
  resourcePrefix,
  ssmPrefix,
  workloadEnvironment,
  workloadVpcCidr: selectedWorkloadVpcCidr,
  serviceNetworkId: selectedServiceNetworkId,
  latticePrefixListId: app.node.tryGetContext('latticePrefixListV4') || 'pl-EXAMPLE0000000000',
  customDomainName: selectedAppDomain,
});

// Phase 5 ingress DNS FORWARDER (OPTIONAL, on-demand): the workload-account half
// of the cross-account ingress DNS automation. Forwards this workload account's
// Resource Configuration publish-tag changes to the Network account's ingress
// DNS bus, so the friendly custom domain auto-publishes for cross-account apps.
new WorkloadIngressDnsForwarderStack(app, 'WorkloadIngressDnsForwarderStack', {
  env: selectedWorkloadEnv,
  description: 'Phase 5 ingress DNS forwarder: workload-account EventBridge rule forwarding RC tag changes to the Network ingress DNS bus',
  resourcePrefix,
  networkAccountId: networkAccountId || '111111111111',
  ingressDnsBusName: app.node.tryGetContext('ingressDnsBusName') || `${resourcePrefix}-ingress-dns-bus`,
  publishTagKey: app.node.tryGetContext('ingressPublishTagKey') || 'PublishIngressDns',
});

// Phase 5 ingress CONSUMER VALIDATOR (OPTIONAL, on-demand): a throwaway,
// SSM-managed instance in the Ingress VPC that simulates an external consumer
// which has already reached the Ingress VPC over its own backbone. It exercises
// consumer -> SN-E -> Service Network -> workload app and is destroyed after
// validating. CDK-only, matching the WorkloadValidatorStack pattern.
new IngressConsumerValidatorStack(app, 'IngressConsumerValidatorStack', {
  env: networkEnv,
  description: 'Phase 5 ingress consumer validator: in-Ingress-VPC client exercising consumer -> SN-E -> Service Network -> workload app',
  resourcePrefix,
  ssmPrefix,
  appPort: app.node.tryGetContext('ingressAppPort') || 80,
  ingressVpcCidr: app.node.tryGetContext('ingressVpcCidr') || '10.8.0.0/16',
});

app.synth();
