# Prerequisites

The [Targeted Business Outcomes](01-business-outcomes.md) section established why VPC Lattice as the sole connectivity fabric reduces cost, operational toil, and security sprawl. Before you can deploy the pattern, several organization-level, account-level, and tooling prerequisites must be in place. This section is a checklist you can work through with your platform, networking, and security teams.

These prerequisites are global: every implementation phase in this guide (Foundation, Shared Endpoints, Centralized Egress, and Workload Onboarding) assumes they are satisfied. Confirm each item before starting Phase 1, because gaps here surface later as deployment failures that are harder to diagnose.

> **A note on conventions.** All examples use the `us-east-2` Region and placeholder identifiers (for example, organization ID `o-EXAMPLE12345` and OU ARNs of the form `arn:aws:organizations::111111111111:ou/o-EXAMPLE12345/ou-EXAMPLE`). Substitute your own values; no customer-identifying information is implied. The reference implementation deploys **three Service Networks**, one each for dev, test, and prod, and you should plan capacity and permissions for all three.

## 1. Required AWS services and features

The pattern depends on a small set of Organization-wide services being enabled and configured before deployment. Work through this checklist in the management account (or a delegated administrator account) first.

- [ ] **AWS Organizations with all features enabled.** The Organization must span the Network account and all workload accounts, and it must be in *all-features* mode (not consolidated-billing-only). All-features mode is required for the OU-scoped resource sharing and the IAM auth policy condition keys (`aws:PrincipalOrgID`, `aws:PrincipalOrgPaths`) that enforce environment isolation.
- [ ] **AWS Resource Access Manager (RAM) sharing enabled within the Organization.** Run the following once from the management account so that Service Networks can be shared to organizational units (OUs) and so that RAM share auto-accept works for workload accounts:

  ```bash
  aws ram enable-sharing-with-aws-organization
  ```

  Without this, the OU-scoped Service Network shares created in Phase 1 cannot target OUs, and workload accounts will not auto-accept the shares during onboarding.
- [ ] **Amazon VPC Lattice available in your chosen Region.** Confirm that VPC Lattice, including Service Networks, Resource Gateways, and Resource Configurations, is available in the Region you will deploy to. The examples in this guide use `us-east-2`. If you deploy elsewhere, verify feature availability and adjust all `us-east-2` references accordingly.
- [ ] **An SSM Parameter Store contract that publishes network IDs.** The Infrastructure as Code (IaC) in this guide does not hardcode VPC, subnet, or security group IDs. Instead, it resolves them at deployment time from AWS Systems Manager (SSM) Parameter Store. The CDK stacks use `ssm.StringParameter` lookups and the CloudFormation templates use SSM-typed parameters whose defaults follow these paths:

  | Resource | SSM parameter path convention |
  |----------|-------------------------------|
  | VPC ID | `/netfabric/network/{vpc-name}/id` |
  | Subnet ID | `/netfabric/network/{vpc-name}/subnet/{a\|b\|c}/id` |
  | Security group ID | `/netfabric/network/{vpc-name}/sg/rg/id` |

  For example, the CloudFormation template defaults to `/netfabric/network/endpoint-vpc/id` for the Endpoint VPC and `/netfabric/network/endpoint-vpc/subnet/a/id` for its first subnet. The two foundation templates (`cloudformation/network-foundation.yaml` and `cloudformation/workload-foundation.yaml`) and the CDK foundation stacks publish these parameters automatically.

  > **If you are using AWS Landing Zone Accelerator (LZA) or another framework that publishes network IDs under a different prefix** (for example, LZA's `/accelerator/network/vpc/{VpcName}/id`): you have two options. Either re-point the IaC's SSM parameter paths to your existing prefix (override `endpointVpcSsmPath`, `egressVpcSsmPath`, `workloadVpcSsmPath`, etc. as CDK context or CloudFormation parameter overrides), **or** skip the foundation templates entirely and rely on your existing parameters. The pattern itself is independent of any specific Landing Zone framework, the foundation templates are a self-contained reference implementation, not a requirement.

## 2. Network account topology prerequisites

The Network account is the central home for shared connectivity. The following VPC topology must exist before you deploy the endpoints and egress stacks. In the reference implementation these IDs are resolved from the SSM paths described above.

### Endpoint VPC

- [ ] **An Endpoint VPC** that will host the Resource Gateway for shared AWS service endpoints.
- [ ] **At least two subnets, one per Availability Zone**, for the Resource Gateway. (See [subnet sizing](#3-subnet-sizing-requirements) below, these must be a minimum of /24.)
- [ ] **A security group for the Resource Gateway ENIs**, with explicit ingress restricted to the expected source ranges and port 443. Do not use the default VPC security group.
- [ ] **Pre-deployed interface VPC endpoints in the Endpoint VPC.** The endpoints must already exist; each is wired into a Resource Configuration by its regional DNS name, read natively from the endpoint's `DnsEntries` on the CDK path, or read from the SSM parameters that `network-foundation.yaml` publishes from each endpoint's `DnsEntries` on the CloudFormation path. The implementation expects the following interface endpoints:

  | Endpoint (service) | Custom domain exposed through Lattice |
  |--------------------|----------------------------------------|
  | `ssm` | `ssm.us-east-2.amazonaws.com` |
  | `ssmmessages` | `ssmmessages.us-east-2.amazonaws.com` |
  | `ec2messages` | `ec2messages.us-east-2.amazonaws.com` |
  | `sts` | `sts.us-east-2.amazonaws.com` |
  | `ecr-api` (`api.ecr`) | `api.ecr.us-east-2.amazonaws.com` |
  | `ecr-dkr` (`dkr.ecr`) | `dkr.ecr.us-east-2.amazonaws.com` |
  | `logs` | `logs.us-east-2.amazonaws.com` |
  | `ecs` | `ecs.us-east-2.amazonaws.com` |
  | `ecs-agent` | `ecs-agent.us-east-2.amazonaws.com` |
  | `ecs-telemetry` | `ecs-telemetry.us-east-2.amazonaws.com` |

  The CDK implementation expects these **10 endpoints**. The CloudFormation implementation expects an **11th endpoint, `execute-api`** (`execute-api.us-east-2.amazonaws.com`), in addition to the ten above.

  > **Private DNS handling.** Because these endpoints are fronted by VPC Lattice, they are referenced by their VPCE regional DNS name (the per-endpoint regional record), resolved at deploy time (natively from `DnsEntries` on the CDK path, or from the SSM parameters that `network-foundation.yaml` publishes from `DnsEntries` on the CloudFormation path), not by the public service domain. Plan the endpoints' Private DNS configuration so it is appropriate for being fronted by Lattice: the workload-facing service domain (for example, `ssm.us-east-2.amazonaws.com`) is resolved through the Lattice-managed Private Hosted Zone created on the VPC association, while Lattice routes to the endpoint by its regional VPCE DNS name. DNS resolution behavior is covered in detail in the architecture and workload onboarding sections.

### Egress VPC

- [ ] **An Egress VPC** that will host the centralized Squid forward proxy and its path to the internet.
- [ ] **At least two subnets, one per Availability Zone**, for the egress workload.
- [ ] **A NAT Gateway path to the internet** so the Squid proxy can reach approved external destinations. This is the single, shared egress path that replaces per-account NAT Gateways.
- [ ] **A security group for the egress workload**, with explicit port and source restrictions. As with the Endpoint VPC, do not use the default VPC security group.

## 3. Subnet sizing requirements

This requirement applies specifically to the Resource Gateway subnets and is important enough to call out separately.

- [ ] **Resource Gateway subnets must be a minimum of /24.**

  A Resource Gateway consumes IP addresses for its elastic network interfaces (ENIs) and scales those ENIs to handle connection volume. Undersized subnets risk IP address exhaustion as the gateway scales or as other resources share the subnet, which causes deployment failures and intermittent connectivity that is difficult to diagnose. Provisioning each Resource Gateway subnet at /24 or larger leaves sufficient headroom for the gateway to scale without contending for addresses. (This is requirement 9.3.)

## 4. CLI and tooling version requirements

Choose one deployment path, CDK (TypeScript) or CloudFormation (YAML), and confirm the corresponding tooling. Neither path uses a Lambda; both resolve endpoint DNS natively (the CDK path from `DnsEntries`, the CloudFormation path from SSM parameters that `network-foundation.yaml` publishes from `DnsEntries`).

### CDK (TypeScript) path

The CDK project's tooling versions are defined in `cdk/package.json`. Match these to avoid synthesis and construct-compatibility issues:

- [ ] **Node.js 20.x** (the project targets `@types/node ^20`).
- [ ] **AWS CDK CLI `^2.150.0`** (`aws-cdk` dev dependency) and **`aws-cdk-lib ^2.150.0`**.
- [ ] **cdk-nag `^2.28.0`** (dev dependency), used for AWS Solutions security checks during synthesis.
- [ ] **TypeScript `~5.4`**.

### CloudFormation (YAML) path

- [ ] **AWS CLI v2** for deploying and managing the CloudFormation stacks and StackSets.

## 5. IAM permissions needed for deployment

Deployment touches the Network account and each workload account. The descriptions below are at the capability level, the principal performing the deployment needs permission to create and manage the listed resource types. Full least-privilege policy definitions and the auth policy model are covered in the security section; this checklist establishes what access the deploying principal requires.

### In the Network account

- [ ] Create and manage **VPC Lattice** resources: Service Networks, Resource Gateways, Resource Configurations, Service Network associations, and IAM auth policies.
- [ ] Create and manage **RAM resource shares** (and target OUs as principals).
- [ ] Create and manage **IAM roles** for the egress workload.
- [ ] Create and manage **Amazon ECS / AWS Fargate and Network Load Balancer (NLB) resources** for the centralized Squid egress.
- [ ] **Read SSM parameters** under the `/netfabric/network/...` paths (or your equivalent if you re-pointed the IaC to a different SSM prefix).
- [ ] Create and write to **Amazon CloudWatch Logs**.

### In each workload account

- [ ] Create the **VPC Lattice service-network VPC association** (with `PrivateDnsEnabled`).
- [ ] Create a **security group** in the workload VPC (egress to the VPC Lattice managed prefix list on TCP 443 and 3128, so traffic can reach the shared endpoints and the egress proxy).
- [ ] **`ssm:GetParameter`** on `/netfabric/*` (or your equivalent SSM prefix); CloudFormation resolves the workload VPC ID natively from this parameter (no Lambda). The service network ID is passed in as a stack parameter.

### Bootstrapping

- [ ] **Run `cdk bootstrap` in each target account and Region** before deploying CDK stacks:

  ```bash
  cdk bootstrap aws://111111111111/us-east-2
  ```

  Bootstrap the Network account and every workload account you intend to onboard with CDK. (If you deploy exclusively with CloudFormation, bootstrap is not required, but the workload association template is still deployed per account, typically via StackSets, covered in the workload onboarding section.)

## Prerequisites checklist summary

| Category | Item | Where |
|----------|------|-------|
| Organization | All-features Organizations spanning Network + workload accounts | Management account |
| Organization | RAM sharing enabled (`aws ram enable-sharing-with-aws-organization`) | Management account |
| Region | VPC Lattice available (examples use `us-east-2`) | Chosen Region |
| Tooling/IDs | Network IDs published to `/netfabric/network/...` (or your equivalent SSM prefix) | Network + workload accounts |
| Topology | Endpoint VPC: 2+ subnets (/24 min), Resource Gateway SG | Network account |
| Topology | Egress VPC: 2+ subnets, NAT Gateway path, SG | Network account |
| Topology | Pre-deployed interface endpoints (10 CDK / 11 CloudFormation) | Network account (Endpoint VPC) |
| Sizing | Resource Gateway subnets minimum /24 | Network account |
| Tooling | Node.js 20.x, CDK/`aws-cdk-lib` `^2.150.0`, cdk-nag `^2.28.0`, TypeScript `~5.4` | CDK path |
| Tooling | AWS CLI v2 | CloudFormation path |
| Access | Deployment IAM capabilities (Network + workload) | Both accounts |
| Access | `cdk bootstrap` per account/Region | CDK path |

With these prerequisites confirmed, you are ready to understand how the pieces fit together before deploying them.

Continue to [Architecture](03-architecture.md) to see the multi-account topology and the data-flow paths that these prerequisites support.
