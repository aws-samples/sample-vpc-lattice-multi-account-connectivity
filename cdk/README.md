# VPC Lattice Multi-Account Connectivity - CDK (TypeScript)

This CDK project deploys the VPC Lattice multi-account connectivity architecture
described in the accompanying AWS Prescriptive Guidance document.

## Architecture

The project consists of 14 stacks. The first eight cover Phases 1-4; the rest are optional Phase 5 ingress stacks and throwaway validators:

| Stack | Account | Purpose |
|-------|---------|---------|
| `NetworkFoundationStack` | Network | Endpoint + Egress + Ingress VPCs (3 AZ): subnets, NAT, security groups, flow logs |
| `WorkloadFoundationStack` | Workload | Isolated workload VPC (3 AZ); no NAT, IGW, or public subnets |
| `VpcLatticeCoreStack` | Network | 3 service networks (dev/test/prod) + IAM auth policies + RAM shares |
| `VpcLatticeEndpointsStack` | Network | Resource Gateway + 11 interface endpoints + Resource Configurations |
| `SquidImageBuildStack` | Network | CodeBuild project + ECR repo for the custom Squid image |
| `SquidEgressStack` | Network | ECS Fargate Squid proxy + NLB + egress Resource Gateway + RC |
| `WorkloadAssociationStackSetStack` | Management | Service-managed StackSet associating workload OU VPCs (auto-deploy) |
| `WorkloadValidatorStack` | Workload | Throwaway SSM-managed validator EC2 for in-VPC connectivity checks |
| `VpcLatticeIngressStackDev` | Network | Phase 5 ingress: per-environment Service Network VPC Endpoint (SN-E); also `...Test` / `...Prod` |
| `VpcLatticeIngressZoneStack` | Network | Phase 5 ingress: `ingress.internal` Route 53 private hosted zone |
| `VpcLatticeIngressDnsStack` | Network | Phase 5 ingress: Lambda-free DNS automation + optional cross-account bus |
| `WorkloadAppStack` | Workload | Phase 5 ingress producer: private app + Resource Gateway + RC on the service network |
| `WorkloadIngressDnsForwarderStack` | Workload | Phase 5 ingress: forwards RC tag changes to the Network DNS bus (cross-account) |
| `IngressConsumerValidatorStack` | Network | Throwaway consumer validator EC2 in the Ingress VPC (simulates an external consumer) |

## Prerequisites

- AWS CDK CLI v2.150+
- Node.js 18+ and npm
- AWS credentials for the Network, Workload, and Management accounts
- Either deploy `NetworkFoundationStack` / `WorkloadFoundationStack` to create the VPCs and interface endpoints, or supply your own VPC/subnet/SG IDs via the SSM parameter paths (for example from Landing Zone Accelerator)

## Configuration

All configuration is defined in `cdk.json` context values. Update these before deploying:

- `resourcePrefix`: single token that namespaces every resource name and SSM path (default `netfabric`)
- `orgId`: your AWS Organizations ID
- `devOuArn` / `testOuArn` / `prodOuArn`: OU ARNs each service network is RAM-shared to
- `networkAccountId` / `workloadAccountId` / `managementAccountId`: target accounts for the stacks
- `endpointVpcCidr` / `egressVpcCidr` / `workloadVpcCidr`: foundation VPC CIDRs (must not overlap)
- `latticePrefixListV4`: VPC Lattice managed prefix list ID for the Region
- `squidAllowedDomains`: space-separated FQDN allowlist for egress filtering
- `devServiceNetworkId`: set from the `VpcLatticeCoreStack` output before deploying the workload StackSet

## Deployment

```bash
# Install dependencies
npm install

# Synthesize all stacks (validates configuration)
npx cdk synth

# 1. Foundation VPCs (skip if you already have Endpoint/Egress/Workload VPCs)
npx cdk deploy NetworkFoundationStack     # Network account
npx cdk deploy WorkloadFoundationStack    # Workload account

# 2. Service networks + RAM shares, then endpoint Resource Configurations
npx cdk deploy VpcLatticeCoreStack        # Network account
npx cdk deploy VpcLatticeEndpointsStack   # Network account

# 3. Centralized Squid egress.
#    SquidImageBuildStack creates the CodeBuild project + ECR repo only; it does
#    not build the image. Trigger the build and wait for it to succeed before
#    deploying the Fargate service (otherwise it has no image to run).
npx cdk deploy SquidImageBuildStack       # Network account
PROJECT=$(aws cloudformation describe-stacks --stack-name SquidImageBuildStack \
  --query "Stacks[0].Outputs[?OutputKey=='CodeBuildProjectName'].OutputValue" --output text)
BID=$(aws codebuild start-build --project-name "$PROJECT" --query 'build.id' --output text)
while true; do
  STATUS=$(aws codebuild batch-get-builds --ids "$BID" --query 'builds[0].buildStatus' --output text)
  echo "build status: $STATUS"
  case "$STATUS" in
    SUCCEEDED) break ;;
    FAILED|FAULT|STOPPED|TIMED_OUT) echo "build did not succeed; check CodeBuild logs"; break ;;
  esac
  sleep 15
done
npx cdk deploy SquidEgressStack           # Network account once the build SUCCEEDED

# 4. Workload onboarding at scale: a service-managed StackSet from the
#    Management account auto-associates every account in the target OU.
#    Set devServiceNetworkId in cdk.json from the VpcLatticeCoreStack output first.
npx cdk deploy WorkloadAssociationStackSetStack  # Management account

# 5. Optional: throwaway validator EC2 for in-VPC connectivity checks
npx cdk deploy WorkloadValidatorStack     # Workload account
```

## One-command deployment

CDK stacks are bound to specific accounts, so a single `cdk deploy --all` cannot
span the Network, Management, and Workload accounts at once. The helper script
`deploy.sh` runs the full rollout in dependency order, using the right profile
per account and building the Squid image between the egress stacks:

```bash
NETWORK_PROFILE=net MGMT_PROFILE=mgmt WORKLOAD_PROFILE=wl ./deploy.sh
# Optional: ENVIRONMENT=test|prod (default dev), REGION=us-east-2, DEPLOY_INGRESS=true
```

## Multi-environment (dev / test / prod)

The shared Network-account stacks (core, endpoints, egress, ingress) serve all
environments. The workload-account example stacks (foundation, app, validator,
DNS forwarder) target one environment per deploy, selected with
`-c environment=dev|test|prod` (default `dev`):

```bash
npx cdk deploy WorkloadFoundationStack -c environment=test   # into the test workload account
```

Each environment maps to its own workload account, service network, and VPC CIDR
via the `testWorkloadAccountId` / `prodWorkloadAccountId`,
`testServiceNetworkId` / `prodServiceNetworkId`, and
`testWorkloadVpcCidr` / `prodWorkloadVpcCidr` context values in `cdk.json`. Unset
values fall back to the dev/single-account values. Roll out all environments by
running `deploy.sh` once per `ENVIRONMENT`.

## Workload Account Deployment at Scale

`WorkloadAssociationStackSetStack` already implements this with a service-managed
CloudFormation StackSet that targets the workload OU and auto-associates every
current and future account in it. Alternatives if you are not using StackSets:

1. **CloudFormation StackSet**: Synthesize the workload stack and deploy
   the resulting template via StackSet with organizational targeting.

2. **CDK Pipelines**: Create a pipeline stage per OU that deploys the
   workload association stack to all accounts in that OU.

3. **CDK with cross-account roles**: Use `--profile` or environment variables
   to target each workload account individually.

## Security

- All Lambda functions use least-privilege IAM policies
- Security groups are explicitly assigned (never relying on default SG)
- RAM shares are scoped to specific OUs (not the entire Organization)
- Service network IAM auth policies restrict access by Organization path
- cdk-nag is available for security posture validation:

```bash
npm install cdk-nag
# Add to bin/app.ts:
# import { AwsSolutionsChecks } from 'cdk-nag';
# Aspects.of(app).add(new AwsSolutionsChecks());
```

## Project Structure

```
cdk/
├── bin/app.ts                          Entry point (defines all 8 stacks)
├── lib/
│   ├── network-foundation-stack.ts     Endpoint + Egress VPCs (Network account)
│   ├── workload-foundation-stack.ts    Workload VPC (Workload account)
│   ├── vpc-lattice-core-stack.ts       Service networks + RAM shares
│   ├── vpc-lattice-endpoints-stack.ts  Resource Gateway + 10 endpoint RCs (DNS read natively from attrDnsEntries, no Lambda)
│   ├── squid-image-build-stack.ts      CodeBuild + ECR for the Squid image
│   ├── squid-egress-stack.ts           Fargate Squid + NLB + egress RC
│   ├── workload-association-stackset-stack.ts  Service-managed StackSet (org-wide assoc)
│   └── workload-validator-stack.ts     Throwaway SSM-managed validator EC2
├── squid/                              Custom Squid image (Dockerfile, allowlist, conf)
├── cdk.json                            Configuration and context values
├── package.json                        Dependencies
└── tsconfig.json                       TypeScript configuration
```

## Known Issues

- `PrivateDnsEnabled` on `CfnServiceNetworkVpcAssociation` may not be directly
  settable via CDK L1 constructs in all CDK versions. If the property is not
  available, use a post-deployment CLI command or custom resource.

- Setting both `PrivateDnsEnabled` and `DnsOptions.PrivateDnsPreference` causes
  a CloudFormation error. Use one or the other, not both.

- Subnets for Resource Gateways must be /24 or larger to avoid IP exhaustion
  when multiple Resource Configurations are associated.
