# VPC Lattice Multi-Account Connectivity - CDK (TypeScript)

This CDK project deploys the VPC Lattice multi-account connectivity architecture
described in the accompanying AWS Prescriptive Guidance document.

## Architecture

The project consists of four stacks deployed in sequence:

| Stack | Account | Purpose |
|-------|---------|---------|
| `VpcLatticeCoreStack` | Network | 3 service networks (dev/stage/prod) + IAM auth policies + RAM shares |
| `VpcLatticeEndpointsStack` | Network | Resource Gateway + 10 Resource Configurations for shared VPC endpoints |
| `SquidEgressStack` | Network | ECS Fargate Squid proxy + NLB + egress Resource Gateway + RC |
| `WorkloadAssociationStack` | Workload | VPC association with PrivateDnsEnabled (deploy per account) |

## Prerequisites

- AWS CDK CLI v2.150+
- Node.js 18+ and npm
- AWS credentials configured for the Network account
- Landing Zone Accelerator (or equivalent) deployed with SSM parameters for VPC/subnet/SG IDs
- VPC endpoints already deployed in the Endpoint VPC

## Configuration

All configuration is defined in `cdk.json` context values. Update these before deploying:

- `orgId`: Your AWS Organizations ID
- `environments`: OU ARNs for dev, stage, and prod
- `networking`: SSM parameter paths for VPC, subnet, and security group IDs
- `squid.allowedDomains`: Space-separated FQDN allowlist for egress filtering

## Deployment

```bash
# Install dependencies
npm install

# Synthesize CloudFormation templates (validates configuration)
npx cdk synth

# Deploy foundational service networks first
npx cdk deploy VpcLatticeCoreStack

# Deploy endpoint Resource Configurations
npx cdk deploy VpcLatticeEndpointsStack

# Deploy egress proxy
npx cdk deploy SquidEgressStack

# Deploy workload association (override context for each account/environment)
npx cdk deploy WorkloadAssociationStack \
  --context vpcSsmPath=/accelerator/network/vpc/Workload-DEV/id \
  --context serviceNetworkName=sn-dev-shared
```

## Workload Account Deployment at Scale

For deploying the `WorkloadAssociationStack` across hundreds of accounts,
use one of these approaches:

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
