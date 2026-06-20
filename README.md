# Multi-Account AWS Connectivity with VPC Lattice as the Sole Network Fabric

> **Disclaimer**: This repository provides reference Infrastructure-as-Code and
> prescriptive guidance for educational purposes. It is NOT intended for production
> deployment without additional security hardening, testing, and review against your
> own organization's requirements. See [Security Findings](docs/13-security-findings.md)
> for the threat model, residual risks, and production-hardening recommendations.

Infrastructure-as-Code templates and a companion prescriptive guide
for deploying Amazon VPC Lattice as the **sole** network connectivity
fabric in a multi-account AWS environment. The repository pairs a 15-section
written guide (in `docs/`) with two reference implementations (AWS CDK
in TypeScript and AWS CloudFormation), along with rendered architecture diagrams
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
| 12 | [Troubleshooting and FAQ](docs/12-troubleshooting-faq.md) | Symptom-to-diagnostic playbooks for the common failure modes and frequently asked questions. |
| 13 | [Security Findings Summary](docs/13-security-findings.md) | The STRIDE threat model, its mitigations, and the security posture of the reference implementation. |
| 14 | [Next Steps and Resources](docs/14-next-steps.md) | What to evaluate after the reference implementation is in place, along with links to deeper material. |

The architecture diagrams referenced from the guide are in
[`diagrams/`](diagrams/) (draw.io source with rendered PNG and SVG): the
high-level topology (Figure 1, which shows all three in-scope patterns, shared endpoints, centralized egress, and SN-E ingress, on one fabric), and
the endpoint, egress, and ingress data-flow diagrams (Figures 2, 3, and 4).
The threat model that backs section 13 is summarized inline in
[`docs/13-security-findings.md`](docs/13-security-findings.md).

## Repository Structure

```
.
├── docs/                                       Implementation guide (15 sections, 00-14)
│
├── diagrams/                                   Architecture diagrams
│   ├── 01-high-level-topology.{drawio,png,svg}
│   ├── 02-endpoint-data-flow.{drawio,png,svg}
│   ├── 03-egress-data-flow.{drawio,png,svg}
│   ├── 04-ingress-data-flow.{drawio,png,svg}
│   └── README.md
│
├── cloudformation/                             CloudFormation templates (YAML)
│   ├── network-foundation.yaml                 Endpoint + Egress + Ingress VPCs + interface VPCEs (Network account)
│   ├── workload-foundation.yaml                Workload VPC + SSM contract (Workload account)
│   ├── vpc-lattice-resource-gateways.yaml      Service networks + endpoint RCs + RAM
│   ├── squid-image-build.yaml                  CodeBuild + ECR for the Squid image (Network account)
│   ├── squid-egress-proxy.yaml                 Fargate Squid + NLB + egress RC
│   ├── vpc-lattice-workload-vpc-association.yaml  Workload VPC association (StackSet)
│   ├── vpc-lattice-ingress-sne.yaml            Phase 5 ingress: Service Network VPC Endpoint (SN-E)
│   ├── vpc-lattice-ingress-zone.yaml           Phase 5 ingress: Route 53 private hosted zone
│   ├── vpc-lattice-ingress-dns-automation.yaml Phase 5 ingress: EventBridge to Step Functions to Route 53 (Lambda-free), with optional cross-account bus
│   ├── workload-app.yaml                        Phase 5 ingress producer: workload app + Resource Gateway + RC (Workload account)
│   └── workload-ingress-dns-forwarder.yaml      Phase 5 ingress: workload-account event forwarder to the Network DNS bus
│
├── cdk/                                        CDK TypeScript project
│   ├── bin/app.ts                              Entry point (14 stacks)
│   ├── lib/
│   │   ├── network-foundation-stack.ts         Endpoint + Egress + Ingress VPCs (Network account)
│   │   ├── workload-foundation-stack.ts        Workload VPC (Workload account)
│   │   ├── vpc-lattice-core-stack.ts           Service networks + RAM shares
│   │   ├── vpc-lattice-endpoints-stack.ts      Resource Gateway + endpoint RCs
│   │   ├── squid-image-build-stack.ts          CodeBuild + ECR for the Squid image
│   │   ├── squid-egress-stack.ts               Fargate Squid + NLB + egress RC
│   │   ├── workload-association-stackset-stack.ts  Service-managed StackSet (org-wide assoc)
│   │   ├── workload-validator-stack.ts         Throwaway SSM-managed validator EC2 (Workload account)
│   │   ├── vpc-lattice-ingress-stack.ts        Phase 5 ingress: Service Network VPC Endpoint (SN-E)
│   │   ├── vpc-lattice-ingress-zone-stack.ts   Phase 5 ingress: Route 53 private hosted zone
│   │   ├── vpc-lattice-ingress-dns-stack.ts    Phase 5 ingress: Lambda-free DNS automation (+ cross-account bus)
│   │   ├── workload-app-stack.ts               Phase 5 ingress producer: workload app + Resource Gateway + RC
│   │   ├── workload-ingress-dns-forwarder-stack.ts  Phase 5 ingress: workload-account event forwarder
│   │   └── ingress-consumer-validator-stack.ts Throwaway consumer validator EC2 in the Ingress VPC
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

The CDK app in `cdk/bin/app.ts` defines 14 stacks (eight for Phases 1-4, plus optional Phase 5 ingress stacks and throwaway validators). Deploy in this order:

```bash
cd cdk
npm install
npx cdk synth                                  # validates all stacks

# 1. Foundation (only if you don't already have an Endpoint/Egress/Workload VPC)
npx cdk deploy NetworkFoundationStack          # Network account
npx cdk deploy WorkloadFoundationStack         # Workload account

# 2. Service networks, RAM shares, and endpoint Resource Configurations
npx cdk deploy VpcLatticeCoreStack             # Network account
npx cdk deploy VpcLatticeEndpointsStack        # Network account

# 3. Centralized Squid egress.
#    3a. Create the CodeBuild project and ECR repo (this stack does NOT build
#        the image; SquidEgressStack has no image to run until you build it).
npx cdk deploy SquidImageBuildStack            # Network account
#    3b. Build and push the Squid image, then WAIT for the build to succeed
#        before deploying SquidEgressStack (the Fargate tasks have no image to
#        run until the build finishes). The project name is the SquidImageBuildStack
#        CodeBuildProjectName output (it is <resourcePrefix>-squid-proxy-build):
PROJECT=$(aws cloudformation describe-stacks --stack-name SquidImageBuildStack \
  --query "Stacks[0].Outputs[?OutputKey=='CodeBuildProjectName'].OutputValue" --output text)
BID=$(aws codebuild start-build --project-name "$PROJECT" --query 'build.id' --output text)
echo "BUILD_ID=$BID"
# Poll until the build reaches a terminal state (about 2-5 minutes).
while true; do
  STATUS=$(aws codebuild batch-get-builds --ids "$BID" --query 'builds[0].buildStatus' --output text)
  echo "build status: $STATUS"
  case "$STATUS" in
    SUCCEEDED) echo "image built and pushed"; break ;;
    FAILED|FAULT|STOPPED|TIMED_OUT) echo "build did not succeed; check the CodeBuild logs"; break ;;
  esac
  sleep 15
done
#    3c. Deploy the Fargate service once the image is in ECR.
npx cdk deploy SquidEgressStack                # Network account

# 4. Workload onboarding, service-managed StackSet from the stack Set admin account
#    auto-associates every current and future account in the target OU.
npx cdk deploy WorkloadAssociationStackSetStack  # stack Set admin account

# 5. Optional: throwaway validator EC2 for in-VPC connectivity checks
npx cdk deploy WorkloadValidatorStack          # Workload account

# 6. Optional (Phase 5): ingress for external, on-premises, and cross-Region
#    consumers, reaching a private workload app through the fabric with no
#    internet exposure. consumer -> SN-E -> Service Network -> workload app.
npx cdk deploy VpcLatticeIngressStackDev         # Network account (SN-E + optional inbound resolver)
npx cdk deploy VpcLatticeIngressZoneStack        # Network account (ingress.internal private hosted zone)
npx cdk deploy VpcLatticeIngressDnsStack         # Network account (Lambda-free DNS automation + cross-account bus)
npx cdk deploy WorkloadAppStack                  # Workload account (private app exposed as a Resource Configuration)
npx cdk deploy WorkloadIngressDnsForwarderStack  # Workload account (forwards RC tag changes to the Network DNS bus)
#    Optional: a throwaway consumer in the Ingress VPC that validates the path.
npx cdk deploy IngressConsumerValidatorStack     # Network account
```

All configuration is passed via `cdk.json` context values. See
[`cdk/README.md`](cdk/README.md) for the full configuration reference and
deployment notes.

> **One command:** to run the whole cross-account rollout in order (it uses the
> right profile per account and builds the Squid image between the egress
> stacks), use the helper script:
> ```bash
> cd cdk
> NETWORK_PROFILE=net MGMT_PROFILE=mgmt WORKLOAD_PROFILE=wl ./deploy.sh
> # Optional: ENVIRONMENT=test|prod (default dev), DEPLOY_INGRESS=true
> ```
> The workload-side stacks target one environment per deploy via
> `-c environment=dev|test|prod`; see [`cdk/README.md`](cdk/README.md#multi-environment-dev--test--prod).

### Option B: CloudFormation

Deploy in this order. Replace placeholder values (`o-EXAMPLE12345`,
`pl-EXAMPLE0000000000`, `sn-EXAMPLEdev0000000`, `ou-EXAMPLE-*`,
`111111111111`) with real values from your AWS Organization and Region.

```bash
# ──────────────────────────────────────────────────────────────────────
# 1. Network Foundation (Network account)
#    Creates Endpoint VPC, Egress VPC, Ingress VPC, interface VPC endpoints,
#    security groups, and publishes all identifiers to SSM under /netfabric/.
# ──────────────────────────────────────────────────────────────────────
aws cloudformation deploy \
  --template-file cloudformation/network-foundation.yaml \
  --stack-name netfabric-network-foundation \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    LatticePrefixListId=pl-EXAMPLE0000000000 \
  --region us-east-2

# ──────────────────────────────────────────────────────────────────────
# 2. Squid Image Build (Network account)
#    Creates ECR repo + CodeBuild project. After deploying, trigger the
#    build and wait for it to finish before deploying the egress proxy.
# ──────────────────────────────────────────────────────────────────────
aws cloudformation deploy \
  --template-file cloudformation/squid-image-build.yaml \
  --stack-name netfabric-squid-image-build \
  --capabilities CAPABILITY_IAM \
  --region us-east-2

# Trigger the build and wait for completion (~2-5 minutes):
PROJECT=$(aws cloudformation describe-stacks --stack-name netfabric-squid-image-build \
  --query "Stacks[0].Outputs[?OutputKey=='CodeBuildProjectName'].OutputValue" --output text \
  --region us-east-2)
BID=$(aws codebuild start-build --project-name "$PROJECT" --region us-east-2 \
  --query 'build.id' --output text)
echo "BUILD_ID=$BID"
while true; do
  STATUS=$(aws codebuild batch-get-builds --ids "$BID" --region us-east-2 \
    --query 'builds[0].buildStatus' --output text)
  echo "build status: $STATUS"
  case "$STATUS" in
    SUCCEEDED) echo "image built and pushed"; break ;;
    FAILED|FAULT|STOPPED|TIMED_OUT) echo "build did not succeed; check CodeBuild logs"; exit 1 ;;
  esac
  sleep 15
done

# ──────────────────────────────────────────────────────────────────────
# 3. Service Networks + Resource Gateways + Resource Configurations + RAM
#    (Network account). Reads VPC/subnet/SG IDs from SSM (published by step 1).
# ──────────────────────────────────────────────────────────────────────
aws cloudformation deploy \
  --template-file cloudformation/vpc-lattice-resource-gateways.yaml \
  --stack-name netfabric-vpc-lattice-core \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    OrgId=o-EXAMPLE12345 \
    DevOuArn=arn:aws:organizations::111111111111:ou/o-EXAMPLE12345/ou-EXAMPLE-dev0000 \
    DevOuPath=o-EXAMPLE12345/r-EXAM/ou-EXAMPLE-dev0000 \
    TestOuArn=arn:aws:organizations::111111111111:ou/o-EXAMPLE12345/ou-EXAMPLE-test000 \
    TestOuPath=o-EXAMPLE12345/r-EXAM/ou-EXAMPLE-test000 \
    ProdOuArn=arn:aws:organizations::111111111111:ou/o-EXAMPLE12345/ou-EXAMPLE-prod0000 \
    ProdOuPath=o-EXAMPLE12345/r-EXAM/ou-EXAMPLE-prod0000 \
  --region us-east-2

# ──────────────────────────────────────────────────────────────────────
# 4. Squid Egress Proxy (Network account, Egress VPC)
#    Reads the Squid image URI from SSM (published by the CodeBuild in step 2).
# ──────────────────────────────────────────────────────────────────────
aws cloudformation deploy \
  --template-file cloudformation/squid-egress-proxy.yaml \
  --stack-name netfabric-squid-egress-proxy \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    LatticePrefixListId=pl-EXAMPLE0000000000 \
    DevServiceNetworkId=sn-EXAMPLEdev0000000 \
    TestServiceNetworkId=sn-EXAMPLEtest000000 \
    ProdServiceNetworkId=sn-EXAMPLEprod000000 \
    AllowedDomains=".amazonaws.com .aws.amazon.com .amazonlinux.com" \
  --region us-east-2

# ──────────────────────────────────────────────────────────────────────
# 5. Workload Foundation (per workload account)
#    Creates the isolated workload VPC and publishes the VPC ID to SSM.
#    Repeat for each environment with the appropriate CIDR and SSM path.
# ──────────────────────────────────────────────────────────────────────
# Dev:
aws cloudformation deploy \
  --template-file cloudformation/workload-foundation.yaml \
  --stack-name netfabric-workload-foundation \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcCidr=10.7.0.0/16 \
    VpcSsmPath=/netfabric/workload/dev-vpc/id \
  --region us-east-2
# Stage: (in Stage account)
#   VpcCidr=10.17.0.0/16 VpcSsmPath=/netfabric/workload/stage-vpc/id
# Prod: (in Prod account)
#   VpcCidr=10.27.0.0/16 VpcSsmPath=/netfabric/workload/prod-vpc/id

# ──────────────────────────────────────────────────────────────────────
# 6. Workload VPC Association (per workload account, or via StackSet)
#    Associates the workload VPC with its RAM-shared service network.
# ──────────────────────────────────────────────────────────────────────
aws cloudformation deploy \
  --template-file cloudformation/vpc-lattice-workload-vpc-association.yaml \
  --stack-name netfabric-workload-assoc \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    WorkloadVpcId=/netfabric/workload/dev-vpc/id \
    ServiceNetworkId=sn-EXAMPLEdev0000000 \
    ServiceNetworkName=sn-dev-shared \
    LatticePrefixListId=pl-EXAMPLE0000000000 \
  --region us-east-2
```

`WorkloadVpcId` is an SSM parameter path that resolves to the workload
VPC ID in each target account at deploy time, which is what makes
service-managed StackSet rollout work without a Lambda. See
[Phase 4: Workload Onboarding](docs/07-phase4-workload-onboarding.md) for
the full StackSet rollout commands.

#### Optional: Phase 5 ingress (SN-E)

```bash
# ──────────────────────────────────────────────────────────────────────
# 7. Service Network VPC Endpoint (Network account, per environment)
#    Exposes the service network to consumers in the Ingress VPC.
# ──────────────────────────────────────────────────────────────────────
aws cloudformation deploy \
  --template-file cloudformation/vpc-lattice-ingress-sne.yaml \
  --stack-name netfabric-ingress-sne-dev \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ServiceNetworkArn=arn:aws:vpc-lattice:us-east-2:111111111111:servicenetwork/sn-EXAMPLEdev0000000 \
    Environment=dev \
    ConsumerSourceCidr=10.8.0.0/16 \
    LatticePrefixListId=pl-EXAMPLE0000000000 \
  --region us-east-2
# Repeat with Environment=test and Environment=prod for the other service networks.

# ──────────────────────────────────────────────────────────────────────
# 8. Ingress hosted zone + DNS automation (Network account)
# ──────────────────────────────────────────────────────────────────────
aws cloudformation deploy \
  --template-file cloudformation/vpc-lattice-ingress-zone.yaml \
  --stack-name netfabric-ingress-zone \
  --capabilities CAPABILITY_IAM \
  --region us-east-2

aws cloudformation deploy \
  --template-file cloudformation/vpc-lattice-ingress-dns-automation.yaml \
  --stack-name netfabric-ingress-dns \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    OrgId=o-EXAMPLE12345 \
  --region us-east-2

# ──────────────────────────────────────────────────────────────────────
# 9. Workload app + DNS forwarder (per workload account)
#    Deploys a demo app behind an NLB, exposed as a Resource Configuration
#    on the service network. The DNS forwarder sends tag-change events to
#    the Network account so the automation publishes the custom domain.
# ──────────────────────────────────────────────────────────────────────
aws cloudformation deploy \
  --template-file cloudformation/workload-app.yaml \
  --stack-name netfabric-workload-app \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ServiceNetworkId=sn-EXAMPLEdev0000000 \
    LatticePrefixListId=pl-EXAMPLE0000000000 \
    WorkloadVpcCidr=10.7.0.0/16 \
    CustomDomainName=app.ingress.internal \
  --region us-east-2

aws cloudformation deploy \
  --template-file cloudformation/workload-ingress-dns-forwarder.yaml \
  --stack-name netfabric-ingress-dns-forwarder \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    NetworkAccountId=111111111111 \
  --region us-east-2
```

## Architecture

Three shared service networks (one per environment: dev, test, prod) are
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
