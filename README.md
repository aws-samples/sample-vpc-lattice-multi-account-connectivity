# Multi-Account AWS Connectivity with VPC Lattice as the Sole Network Fabric

Infrastructure-as-Code templates and a companion prescriptive guide
for deploying Amazon VPC Lattice as the **sole** network connectivity
fabric in a multi-account AWS environment. The repository pairs a 15-section
written guide (in `docs/`) with two reference implementations (AWS CDK
in TypeScript and AWS CloudFormation), plus rendered architecture diagrams
and a security review.

## Overview

This repository provides everything needed to replace per-account interface
VPC endpoints and NAT gateways with a single, centrally managed VPC Lattice
fabric. Workload accounts gain private access to AWS service endpoints and
filtered internet egress through a centralized Squid proxy with one VPC
association, and external, on-premises, or cross-Region consumers reach the
same fabric through Service Network Endpoints. No NAT gateways and no
per-account endpoints are required in workload accounts. Transit Gateway is
retained for the east-west and hybrid traffic that genuinely needs it.

## Documentation

The full prescriptive guide lives in [`docs/`](docs/). Start with
[`docs/00-introduction.md`](docs/00-introduction.md) and read the sections
in order; each one links to the next.

| # | Section | What it covers |
|---|---|---|
| 00 | [Introduction](docs/00-introduction.md) | The cost and operational case against traditional TGW + NAT + per-account endpoints, and a decision framework for when VPC Lattice is the right fabric. |
| 01 | [Targeted Business Outcomes](docs/01-business-outcomes.md) | Resource-count math, operational deltas, and security improvements that build the business case. |
| 02 | [Prerequisites](docs/02-prerequisites.md) | Organization, account, and tooling prerequisites (AWS Organizations, RAM, Landing Zone, IaC tooling). |
| 03 | [Architecture](docs/03-architecture.md) | Multi-account topology, three-environment isolation model, Resource Gateways, Resource Configurations, and DNS behavior. |
| 04 | [Phase 1: Foundation](docs/04-phase1-foundation.md) | Service networks, IAM auth policies, and RAM shares in the Network account. |
| 05 | [Phase 2: Shared Endpoints](docs/05-phase2-shared-endpoints.md) | Resource Gateway and the 10 endpoint Resource Configurations exposed through the service networks. |
| 06 | [Phase 3: Centralized Egress](docs/06-phase3-centralized-egress.md) | Squid forward proxy on ECS Fargate behind an internal NLB, exposed via VPC Lattice. |
| 07 | [Phase 4: Workload Onboarding](docs/07-phase4-workload-onboarding.md) | The single VPC association per workload account, deployed at scale via service-managed StackSet. |
| 08 | [Phase 5: Ingress via Service Network Endpoints](docs/08-phase5-ingress-service-network-endpoints.md) | Ingress from external, on-premises, and cross-Region consumers via SN-E, the SN-A vs SN-E decision, the CNAME/Alias rationale, and EventBridge + Step Functions + Route 53 DNS automation. |
| 09 | [Best Practices](docs/09-best-practices.md) | Naming, tagging, monitoring, and quota planning to keep the fabric runnable at scale. |
| 10 | [Well-Architected Alignment](docs/10-well-architected.md) | The pattern mapped to the six Well-Architected pillars, with explicit trade-offs. |
| 11 | [Cost and Operational Comparison](docs/11-cost-comparison.md) | Side-by-side cost and operational comparison against a TGW + NAT + per-account-endpoints baseline. |
| 12 | [Troubleshooting and FAQ](docs/12-troubleshooting-faq.md) | Symptom-to-diagnostic playbooks for the common failure modes plus frequently asked questions. |
| 13 | [Security Findings Summary](docs/13-security-findings.md) | The STRIDE threat model, its mitigations, and the security posture of the reference implementation. |
| 14 | [Next Steps and Resources](docs/14-next-steps.md) | What to evaluate after the reference implementation is in place, plus links to deeper material. |

The architecture diagrams referenced from the guide are in
[`diagrams/`](diagrams/) (draw.io source plus rendered PNG and SVG): the
high-level topology (Figure 1, which shows all three in-scope patterns, shared endpoints, centralized egress, and SN-E ingress, on one fabric), and
the endpoint, egress, and ingress data-flow diagrams (Figures 2, 3, and 4).
The threat model that backs section 13 is summarized inline in
[`docs/13-security-findings.md`](docs/13-security-findings.md).

## Repository Structure

```
.
├── docs/                                       APG guide (15 sections, 00-14)
│
├── diagrams/                                   Architecture diagrams
│   ├── 01-high-level-topology.{drawio,png,svg}
│   ├── 02-endpoint-data-flow.{drawio,png,svg}
│   ├── 03-egress-data-flow.{drawio,png,svg}
│   ├── 04-ingress-data-flow.{drawio,png,svg}
│   └── README.md
│
├── cloudformation/                             CloudFormation templates (YAML)
│   ├── network-foundation.yaml                 Endpoint + Egress VPCs + 11 interface VPCEs (Network account)
│   ├── workload-foundation.yaml                Workload VPC + SSM contract (Workload account)
│   ├── vpc-lattice-resource-gateways.yaml      Service networks + 11 endpoint RCs + RAM
│   ├── squid-egress-proxy.yaml                 Fargate Squid + NLB + egress RC
│   └── vpc-lattice-workload-vpc-association.yaml  Workload VPC association (StackSet)
│
├── cdk/                                        CDK TypeScript project
│   ├── bin/app.ts                              Entry point (8 stacks)
│   ├── lib/
│   │   ├── network-foundation-stack.ts         Endpoint + Egress VPCs (Network account)
│   │   ├── workload-foundation-stack.ts        Workload VPC (Workload account)
│   │   ├── vpc-lattice-core-stack.ts           Service networks + RAM shares
│   │   ├── vpc-lattice-endpoints-stack.ts      Resource Gateway + 10 endpoint RCs
│   │   ├── squid-image-build-stack.ts          CodeBuild + ECR for the Squid image
│   │   ├── squid-egress-stack.ts               Fargate Squid + NLB + egress RC
│   │   ├── workload-association-stackset-stack.ts  Service-managed StackSet (org-wide assoc)
│   │   └── workload-validator-stack.ts         Throwaway SSM-managed validator EC2
│   ├── squid/                                  Custom Squid image (Dockerfile, allowlist, conf)
│   ├── cdk.json                                Context (placeholder identifiers; see below)
│   └── README.md                               CDK-specific instructions
│
├── CONTRIBUTING.md                             How to contribute
├── CODE_OF_CONDUCT.md                          Code of conduct
├── LICENSE                                     MIT-0
└── README.md                                   This file
```

## Quick Start

Both paths assume you have read [Prerequisites](docs/02-prerequisites.md)
and have the Network account's Endpoint VPC, Egress VPC, and pre-deployed
interface VPC endpoints in place (or are using the foundation stacks below
to create them).

The placeholder identifiers used here (`o-EXAMPLE12345`, `pl-EXAMPLE0000000000`,
`sn-EXAMPLEdev0000000`, `ou-EXAMPLE-dev0000`, account ID `111111111111`, and so
on) follow the conventions in [`cdk/cdk.json`](cdk/cdk.json). Replace them with
real values from your AWS Organization, Region, and Landing Zone before
deploying.

### Option A: CDK (recommended)

The CDK app in `cdk/bin/app.ts` defines eight stacks. Deploy in this order:

```bash
cd cdk
npm install
npx cdk synth                                  # validates all 8 stacks

# 1. Foundation (only if you don't already have an Endpoint/Egress/Workload VPC)
npx cdk deploy NetworkFoundationStack          # Network account
npx cdk deploy WorkloadFoundationStack         # Workload account

# 2. Service networks, RAM shares, and endpoint Resource Configurations
npx cdk deploy VpcLatticeCoreStack             # Network account
npx cdk deploy VpcLatticeEndpointsStack        # Network account

# 3. Centralized Squid egress (image build first, then the Fargate service)
npx cdk deploy SquidImageBuildStack            # Network account, builds and pushes the image
npx cdk deploy SquidEgressStack                # Network account

# 4. Workload onboarding, service-managed StackSet from the Management account
#    auto-associates every current and future account in the target OU.
npx cdk deploy WorkloadAssociationStackSetStack  # Management account

# 5. Optional: throwaway validator EC2 for in-VPC connectivity checks
npx cdk deploy WorkloadValidatorStack          # Workload account
```

All configuration is passed via `cdk.json` context values. See
[`cdk/README.md`](cdk/README.md) for the full configuration reference and
deployment notes.

### Option B: CloudFormation

```bash
# 1. Service networks + endpoint Resource Configurations + RAM shares (Network account)
aws cloudformation deploy \
  --template-file cloudformation/vpc-lattice-resource-gateways.yaml \
  --stack-name vpc-lattice-core \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    OrgId=o-EXAMPLE12345 \
    DevOuArn=arn:aws:organizations::111111111111:ou/o-EXAMPLE12345/ou-EXAMPLE-dev0000 \
    DevOuPath=o-EXAMPLE12345/r-EXAM/ou-EXAMPLE-dev0000 \
    StageOuArn=arn:aws:organizations::111111111111:ou/o-EXAMPLE12345/ou-EXAMPLE-stage000 \
    StageOuPath=o-EXAMPLE12345/r-EXAM/ou-EXAMPLE-stage000 \
    ProdOuArn=arn:aws:organizations::111111111111:ou/o-EXAMPLE12345/ou-EXAMPLE-prod0000 \
    ProdOuPath=o-EXAMPLE12345/r-EXAM/ou-EXAMPLE-prod0000 \
  --region us-east-2

# 2. Centralized Squid egress proxy (Network account, Egress VPC)
aws cloudformation deploy \
  --template-file cloudformation/squid-egress-proxy.yaml \
  --stack-name squid-egress-proxy \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    LatticePrefixListId=pl-EXAMPLE0000000000 \
    DevServiceNetworkId=sn-EXAMPLEdev0000000 \
    StageServiceNetworkId=sn-EXAMPLEstage00000 \
    ProdServiceNetworkId=sn-EXAMPLEprod000000 \
    AllowedDomains=".amazonaws.com .your-domain.com" \
  --region us-east-2

# 3. Workload VPC association (deploy as a service-managed StackSet targeting workload OUs)
aws cloudformation deploy \
  --template-file cloudformation/vpc-lattice-workload-vpc-association.yaml \
  --stack-name vpc-lattice-workload-assoc \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    WorkloadVpcId=/apg-lattice/workload/dev-vpc/id \
    ServiceNetworkId=sn-EXAMPLEdev0000000 \
    ServiceNetworkName=sn-dev-shared
```

`WorkloadVpcId` is an SSM parameter path that resolves to the workload
VPC ID in each target account at deploy time, which is what makes
service-managed StackSet rollout work without a Lambda. See
[Phase 4: Workload Onboarding](docs/07-phase4-workload-onboarding.md) for
the full StackSet rollout commands.

## Architecture

Three shared service networks (one per environment: dev, stage, prod) are
deployed in a central Network account and shared to workload OUs via
AWS Resource Access Manager (RAM). Each workload VPC associates with its
environment's service network and automatically inherits:

- **AWS service endpoints** (SSM, SSM Messages, EC2 Messages, STS, ECR API,
  ECR DKR, CloudWatch Logs, ECS, ECS Agent, ECS Telemetry, Execute API)
  through Resource Configurations backed by the Endpoint VPC.
- **Filtered internet egress** through a centralized Squid forward proxy on
  ECS Fargate, exposed as a Resource Configuration with FQDN allowlisting.

For consumers that sit outside an associated VPC, external, on-premises, or
in another Region, the same fabric is reachable through **Service Network
Endpoints (SN-E)**, with DNS automation that keeps custom-domain records
current (see [Phase 5](docs/08-phase5-ingress-service-network-endpoints.md)).
East-west, application-to-application connectivity using VPC Lattice
**Services** is out of scope for this guide.

No Transit Gateway attachments, NAT Gateways, or interface VPC endpoints
are required in workload accounts.

See [Architecture](docs/03-architecture.md) for the full topology and
[`diagrams/`](diagrams/) for the rendered diagrams.

## Prerequisites

Summarized from [Prerequisites](docs/02-prerequisites.md):

- AWS Organizations with RAM resource sharing enabled at the org level
- Landing Zone Accelerator (or equivalent) deployed
- Network account with Endpoint VPC, Egress VPC, and pre-deployed interface
  VPC endpoints (or use `NetworkFoundationStack` to create them)
- Subnets sized /24 or larger in the Endpoint and Egress VPCs (Resource
  Gateways consume ENIs per AZ)
- AWS CDK CLI v2.150+ and Node.js 18+ (CDK path), or AWS CLI v2 and CFN
  permissions in each target account (CloudFormation path)

## Security

- Service network IAM auth policies restrict access by `aws:PrincipalOrgPaths`
  so each environment's service network is only callable from its own OU subtree.
- RAM shares are scoped to specific OUs (not the whole organization).
- The Squid proxy enforces FQDN-level egress filtering; only allowlisted
  domains can leave.
- All Lambda functions and ECS task roles use least-privilege IAM policies.
- Explicit security groups are assigned to every ENI-creating resource
  (no reliance on default SGs).
- A full threat model and security findings summary are documented in
  [`docs/13-security-findings.md`](docs/13-security-findings.md).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for how
to report issues and submit pull requests, and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations. For potential
security issues, follow responsible-disclosure practices and report them
privately rather than opening a public issue.

## License

This project is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.

## Related Resources

- [AWS Prescriptive Guidance: Network connectivity for multi-account architectures](https://docs.aws.amazon.com/prescriptive-guidance/latest/transitioning-to-multiple-aws-accounts/network-connectivity.html)
- [Amazon VPC Lattice Documentation](https://docs.aws.amazon.com/vpc-lattice/)
- [AWS re:Invent 2025: Advanced VPC Design and New Capabilities (NET340)](https://www.youtube.com/watch?v=40QfxdvDGsw)
