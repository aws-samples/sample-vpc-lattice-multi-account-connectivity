# Building Multi-Account AWS Connectivity with VPC Lattice as the Sole Network Fabric

> A prescriptive pattern for replacing Transit Gateway, NAT Gateway, and per-account VPC endpoints with a single, centrally managed Amazon VPC Lattice connectivity fabric across an AWS Organization.

## Introduction

As organizations grow from a handful of AWS accounts to 50, 150, or 500 or more, the connectivity layer that worked at small scale becomes the dominant source of cost, operational toil, and security sprawl. Each new account typically inherits a familiar pattern: a Transit Gateway attachment for east-west routing, one or more NAT Gateways for outbound internet access, and a dozen or more interface VPC endpoints so workloads can reach AWS services privately. Multiplied across hundreds of accounts, this pattern produces thousands of billable resources that are expensive to run, tedious to operate, and difficult to govern consistently.

This guide presents a prescriptive alternative: use Amazon VPC Lattice as the *sole* network connectivity fabric for AWS service access and centralized internet egress. Instead of replicating endpoints and gateways in every account, you deploy shared connectivity once in a central Network account, expose it through VPC Lattice Service Networks, and onboard each workload account with a single VPC association. Domain Name System (DNS) resolution becomes automatic, environment isolation is enforced by Identity and Access Management (IAM) policy, and onboarding a new account drops from a multi-resource deployment to one action.

This document is prescriptive by design. Where there is a clear best choice, we state it and explain why. Where Transit Gateway remains the better tool, we say so explicitly in the [decision framework](#decision-framework-when-to-use-vpc-lattice-as-the-sole-fabric) below.

## The problem: traditional connectivity does not scale economically

Traditional multi-account connectivity architectures combine three building blocks. Each is reasonable in isolation, but together they scale poorly in cost and operations as account counts climb.

### Transit Gateway as the connectivity hub

Transit Gateway (TGW) is the default hub-and-spoke router for inter-VPC and hybrid connectivity. It is powerful and protocol-agnostic, but it carries structural costs that grow with the estate:

- **Per-attachment hourly charges.** Every VPC attached to the TGW incurs an hourly fee. At 150 accounts with one VPC each, that is 150 attachments billed every hour, before a single byte is processed.
- **Per-gigabyte data processing.** All traffic that traverses the TGW is charged per GB processed, in addition to the attachment fee. Centralizing AWS service access or egress through a TGW means paying this processing charge on traffic that VPC Lattice can route without an equivalent hop.
- **Hub-and-spoke complexity.** Centralized inspection, shared services, and egress designs require careful route table and appliance design, often with multiple TGW route tables and appliance VPCs.
- **Route table sprawl.** Segmentation between environments (dev, stage, prod) is implemented through separate TGW route tables and association/propagation rules. As segmentation requirements grow, the route table matrix becomes hard to reason about and audit.

### NAT Gateways for outbound access

NAT Gateways provide outbound internet connectivity, but the cost model penalizes wide deployment:

- **Per-account, per-AZ deployment.** Highly available egress typically means one NAT Gateway per Availability Zone, per VPC, per account. The hourly charge is multiplied by AZ count and account count.
- **Per-gigabyte data processing.** Every gigabyte that egresses through a NAT Gateway is charged a processing fee on top of the hourly cost and the standard data transfer charge.
- **No native content filtering.** NAT Gateways forward traffic without fully qualified domain name (FQDN) allowlisting, so egress filtering for data-exfiltration prevention requires additional services in every account.

### Per-account interface VPC endpoints

To reach AWS services privately, each workload VPC commonly provisions its own interface endpoints (for example, AWS Systems Manager, AWS Security Token Service, Amazon Elastic Container Registry, Amazon ECS, Amazon CloudWatch Logs, and others). This is where sprawl is most visible:

- **Ten or more interface endpoints per VPC, per account.** A typical workload needs a long list of endpoints. Each endpoint is billed per endpoint-hour, per AZ.
- **Endpoint-hour cost multiplied across the estate.** Ten endpoints across three AZs across 150 accounts is 4,500 billable endpoint ENIs running continuously, regardless of utilization.
- **Operational duplication.** Every endpoint must be created, secured, monitored, and patched into the account's DNS and security group model. The same configuration is duplicated hundreds of times, and drift between accounts is nearly inevitable.

### The cumulative effect

Viewed together, these three building blocks turn connectivity into a tax that scales linearly (or worse) with account count. The cost grows, but so does the operational surface area and the security review burden: more endpoints, more NAT Gateways, and more route tables mean more places where a misconfiguration can expose data or break a workload. At 50 accounts the overhead is noticeable; at 500 accounts it is a strategic problem.

## The solution: VPC Lattice as the sole connectivity fabric

This pattern consolidates AWS service access and internet egress into a single, centrally managed VPC Lattice fabric. The connectivity resources are deployed once, in a central Network account, and consumed by every workload account through VPC Lattice Service Networks. The core elements are:

- **Three shared Service Networks, dev, stage, and prod.** A separate Service Network per environment provides hard isolation: each network carries its own IAM auth policy that restricts access by organizational unit (OU) path, so a dev workload cannot reach prod-shared connectivity. (In the reference implementation these appear with example names; the AWS Cloud Development Kit (CDK) stacks use names such as `sn-dev-shared`, while the CloudFormation templates use names such as `sn-dev-shared`. Throughout this guide we refer to them generically, for example, "the dev service network.")
- **Resource Gateways exposing shared connectivity.** In the Network account, Resource Gateways expose the shared interface VPC endpoints and a centralized egress proxy as VPC Lattice *Resource Configurations*. The endpoints and the proxy exist once and are reused by every account.
- **A centralized egress proxy as a Resource Configuration.** A Squid forward proxy on Amazon ECS Fargate, fronted by an internal Network Load Balancer (NLB), is exposed through Lattice as a Resource Configuration. It provides filtered outbound access with an FQDN allowlist, replacing per-account NAT Gateways for controlled egress.
- **RAM shares scoped to OUs.** AWS Resource Access Manager (RAM) shares each Service Network only to the organizational units that should consume it, with external principals disabled. Sharing is scoped to specific OUs rather than the entire Organization, so the environment isolation model is enforced at the share boundary as well as in the IAM auth policy.
- **A single VPC association per workload account, with private DNS enabled.** Onboarding a workload account is a single VPC association to the appropriate Service Network with `PrivateDnsEnabled` set. VPC Lattice then automatically creates Private Hosted Zones so that standard AWS service domains (for example, `ssm.us-east-2.amazonaws.com`) resolve to Lattice IP addresses with zero per-workload DNS configuration.

The reference architecture in this guide uses the `us-east-2` Region in all examples. Later sections cover the architecture and the five implementation phases in detail; this introduction focuses on the problem, the solution shape, the intended audience, and the decision framework.

### What changes for the better

- **Cost.** Shared endpoints and a shared egress proxy replace thousands of duplicated, per-account resources. You pay for connectivity infrastructure roughly once per environment instead of once per account.
- **Operations.** Onboarding becomes a single VPC association. There are no per-account endpoint fleets to create, secure, and keep in sync.
- **Security posture.** Access is governed centrally through Service Network IAM auth policies and OU-scoped RAM shares, and egress is filtered centrally through an FQDN allowlist, reducing both sprawl and the number of places a control can drift.

## Scope and target audience

### Who this guide is for

This guide is written for **IT decision makers, architects, and technical leads** who are evaluating or planning a multi-account connectivity strategy. It is intended to support architecture decisions, business cases, and rollout planning. It is *not* written as a step-by-step runbook for an individual implementer; the implementation phases describe the approach, the account context, and the supporting Infrastructure as Code (IaC), but the emphasis is on *what to do and why* rather than on click-by-click instructions.

Readers should be comfortable with core AWS networking concepts (VPCs, subnets, DNS, security groups) and with multi-account constructs (AWS Organizations, organizational units, and resource sharing). Deep prior experience with VPC Lattice is not assumed.

### What this guide covers

- The problem with traditional TGW, NAT Gateway, and per-account VPC endpoint architectures at scale.
- VPC Lattice as the sole fabric for **centralized AWS service access** and **centralized, filtered internet egress**.
- **Ingress to the shared fabric** from external, on-premises, and cross-Region consumers using **Service Network Endpoints (SN-E)**, with the DNS automation that pattern requires.
- A three-environment isolation model (dev, stage, prod) enforced by IAM auth policies and OU-scoped RAM shares.
- Automatic DNS resolution behavior using `PrivateDnsEnabled` VPC associations.
- A phased implementation approach (Foundation, Shared Endpoints, Centralized Egress, Workload Onboarding, and Ingress via Service Network Endpoints) with references to validated CDK and CloudFormation templates.
- Cost and operational comparisons, Well-Architected alignment, troubleshooting guidance, and a security findings summary.

### What this guide does not cover

- **East-west VPC Lattice Services in depth.** This pattern uses VPC Lattice for AWS service access and egress, not as a full application-to-application service mesh. Service-to-service connectivity using Lattice *Services* (target groups, listeners, and routing rules) is noted only as a possible future enhancement.
- **General-purpose Layer 3 routing between many VPCs.** Workloads that require broad IP-routed connectivity across a large mesh of VPCs are better served by Transit Gateway; see the decision framework below.
- **Hybrid (on-premises) transport design.** Designing the underlying connectivity to on-premises networks, Direct Connect circuits, Site-to-Site VPN tunnels, and their routing, is out of scope; this guide assumes those paths, where present, continue to be served by their existing TGW or VPN design. Reaching the shared fabric *over* an existing hybrid or cross-Region path is in scope and covered by [Phase 5: Ingress via Service Network Endpoints](08-phase5-ingress-service-network-endpoints.md).
- **Region-by-Region deployment mechanics.** Examples use a single Region (`us-east-2`). Multi-Region considerations are addressed at a high level in the FAQ.

## Decision framework: when to use VPC Lattice as the sole fabric

VPC Lattice as the sole connectivity fabric is a strong fit for the access patterns this guide targets, but it is not a universal replacement for Transit Gateway. Use the following framework to decide. The prescriptive guidance is: **adopt VPC Lattice as the sole fabric when your dominant connectivity need is centralized AWS service access and controlled egress at multi-account scale; retain Transit Gateway when your dominant need is general-purpose, high-volume, IP-routed east-west traffic.** Many organizations will run both, VPC Lattice for the patterns below and TGW for the remainder.

### Quick comparison

| Dimension | VPC Lattice as sole fabric | Transit Gateway remains better |
|-----------|----------------------------|--------------------------------|
| Primary traffic pattern | Workload-to-AWS-service access and controlled internet egress | High-volume, general-purpose east-west between many VPCs |
| Protocols | TCP to AWS service endpoints and HTTP/HTTPS egress | Any IP protocol requiring full Layer 3 routing |
| Isolation model | Environment isolation by Service Network + IAM auth policy + OU-scoped RAM | Network segmentation by route tables and attachments |
| Onboarding at scale | Single VPC association per account | Per-account attachment plus route table changes |
| Endpoint/egress sprawl | Eliminated via shared endpoints and shared egress proxy | Persists unless paired with centralized designs |
| Overlapping CIDRs | Not required; access is by DNS/service, not IP route | Supports designs that must tolerate overlapping CIDRs* |
| Existing investment | Greenfield or actively consolidating connectivity | Significant existing TGW topology and operational tooling |

\* Overlapping CIDR support in a TGW design still requires careful NAT and routing; the point is that VPC Lattice access does not depend on a globally unique IP routing plane at all.

### Choose VPC Lattice as the sole fabric when

- Your dominant connectivity requirement is **centralized access to AWS services** (Systems Manager, STS, ECR, ECS, CloudWatch Logs, and similar) from many accounts.
- You need **centralized, filtered internet egress** with FQDN allowlisting for data-exfiltration prevention, and want to eliminate per-account NAT Gateways.
- You want to **simplify onboarding at scale**, reducing each new account to a single VPC association rather than a fleet of endpoints and gateways.
- You require **environment isolation by OU** (dev, stage, prod) enforced centrally through IAM auth policies and scoped RAM shares.
- You are aiming to **reduce the cost and operational duplication** of per-account interface endpoints and NAT Gateways across 50, 150, 500, or more accounts.

### Keep Transit Gateway when

- You move **large volumes of east-west, IP-routed traffic between many VPCs** that is not AWS-service or HTTP egress traffic.
- You depend on **non-AWS or non-HTTP protocols that require full Layer 3 routing** (arbitrary TCP/UDP/ICMP between workloads, custom appliances, and similar).
- You have an **existing, heavily invested Transit Gateway topology** with mature route table design, inspection VPCs, and operational tooling that would be costly to unwind.
- You need to support **overlapping CIDR ranges** or other IP-plane requirements that are inherent to a routed network design.
- You require **hybrid routing to on-premises** networks as a primary, high-throughput path that is already integrated with TGW.

When both patterns apply, which is common in large estates, adopt VPC Lattice as the sole fabric for AWS service access and egress, and keep Transit Gateway for the specific east-west and hybrid routing workloads that genuinely require it. This guide focuses on the VPC Lattice portion of that hybrid reality.

## How this guide is organized

The remaining sections build from business context to implementation and validation:

1. **Targeted Business Outcomes**, quantified cost, operational, and security benefits.
2. **Prerequisites**, required services, subnet sizing, and account setup.
3. **Architecture**, the multi-account topology and data-flow diagrams.
4. **Implementation Phases**, Foundation, Shared Endpoints, Centralized Egress, Workload Onboarding, and Ingress via Service Network Endpoints, each with IaC references.
5. **Best Practices, Well-Architected Alignment, Cost Comparison, Troubleshooting/FAQ, Security Findings, and Next Steps.**

Continue to [Targeted Business Outcomes](01-business-outcomes.md) to see how this pattern translates into measurable cost and operational improvements.
