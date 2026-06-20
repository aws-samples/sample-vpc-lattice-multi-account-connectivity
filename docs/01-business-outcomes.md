# Targeted Business Outcomes

The [introduction](00-introduction.md) made the case that traditional Transit Gateway (TGW), NAT Gateway, and per-account VPC endpoint architectures turn connectivity into a tax that scales with account count. This section quantifies what changes when you adopt VPC Lattice as the sole connectivity fabric. The goal is to give decision makers the resource-count math, the operational deltas, and the security improvements needed to build a business case, and, for every technical fact, to state plainly what it means for the business.

The numbers below are expressed in **resource counts and cost drivers** (per-hour, per-GB, per-endpoint-hour), not in dollars. Resource counts are deterministic and portable across organizations; dollar amounts depend on Region, traffic volume, and the specific pricing in effect when you deploy. A detailed pricing table appears later in the [Cost and Operational Comparison](11-cost-comparison.md) section. Wherever you need actual figures for a business case, validate them with the [AWS Pricing Calculator](https://calculator.aws/) against your own traffic profile.

> **A note on scale.** The examples use generic account counts of 50, 150, and 500 to illustrate how the pattern behaves as an estate grows. Substitute your own account count and Availability Zone (AZ) strategy. All examples use the `us-east-2` Region and placeholder identifiers; no customer-identifying information is implied.

## Outcome 1: Cost reduction

The traditional pattern bills connectivity infrastructure roughly **once per account**. The VPC Lattice sole-fabric pattern bills it roughly **once per environment** (dev, test, prod), regardless of how many accounts consume it. The savings come from eliminating or consolidating three categories of duplicated resource.

### Eliminated per-account interface VPC endpoints

This is where sprawl is most visible and where consolidation is most dramatic. In the traditional pattern, each workload VPC provisions its own fleet of interface endpoints, each billed per endpoint-hour, per AZ, whether or not it is used. The reference implementation exposes a single shared set in the Network account instead:

- **10 shared endpoints** in the AWS Cloud Development Kit (CDK) implementation: `ssm`, `ssmmessages`, `ec2messages`, `sts`, `ecr-api`, `ecr-dkr`, `logs`, `ecs`, `ecs-agent`, and `ecs-telemetry`.
- **11 shared endpoints** in the AWS CloudFormation implementation, which adds `execute-api`.

Because the endpoints live once in the Network account and are exposed to every workload account through Resource Configurations on the three Service Networks, the per-account endpoint fleet drops to zero.

The before/after math, using 10 endpoints across 3 AZs:

| Estate size | Traditional: endpoint ENIs (10 × 3 AZ × accounts) | Sole fabric: shared Resource Configurations | Reduction |
|-------------|----------------------------------------------------|---------------------------------------------|-----------|
| 50 accounts | 1,500 billable endpoint ENIs | 10-11 (one shared set in the Network account) | ~99% |
| 150 accounts | 4,500 billable endpoint ENIs | 10-11 | ~99% |
| 500 accounts | 15,000 billable endpoint ENIs | 10-11 | ~99% |

The cost driver eliminated here is the **per-endpoint-hour charge multiplied by AZ count and account count**. Each of those thousands of ENIs runs continuously, billed by the hour regardless of utilization. Consolidating to one shared set means you pay that endpoint-hour charge roughly 10-11 times for the whole organization rather than 1,500, 4,500, or 15,000 times.

> **Business impact.** Connectivity-to-AWS-services cost stops scaling with account count and starts scaling with environment count (three). Finance sees this line item grow when you add an *environment*, not when you add an *account*. A platform team can onboard the 151st or 501st account with no incremental endpoint spend at all.

### Eliminated per-account NAT Gateways

Highly available outbound access in the traditional pattern means one NAT Gateway per AZ, per VPC, per account. NAT Gateways carry two cost drivers: an **hourly charge per gateway** and a **per-GB data-processing charge** on everything that egresses through them, on top of standard data-transfer charges.

In the sole-fabric pattern, controlled egress is consolidated into a single centralized proxy (a Squid forward proxy on Amazon ECS Fargate, fronted by an internal Network Load Balancer and exposed through VPC Lattice). Workload accounts no longer deploy their own NAT Gateways for this traffic.

The before/after math, using 2 NAT Gateways per account for AZ-level resilience:

| Estate size | Traditional: NAT Gateways (2 per account) | Sole fabric: centralized egress | Reduction |
|-------------|--------------------------------------------|---------------------------------|-----------|
| 50 accounts | 100 NAT Gateways | 1 shared egress path (per Network account) | ~99% |
| 150 accounts | 300 NAT Gateways | 1 shared egress path | ~99% |
| 500 accounts | 1,000 NAT Gateways | 1 shared egress path | ~99% |

The cost drivers eliminated are the **per-NAT-Gateway hourly charge multiplied by AZ count and account count**, and the **per-GB processing charge** that was previously paid independently in every account. Centralizing egress collapses hundreds of always-on gateways into one shared, filtered path.

> **Business impact.** Egress cost consolidates into one managed service line that the platform team owns and can right-size centrally, rather than hundreds of small, independently provisioned gateways that no single team has visibility into. The per-GB processing charge is also paid against one consolidated traffic stream instead of being fragmented across the estate, which makes egress spend far easier to forecast and attribute.

### Eliminated or reduced Transit Gateway attachments

For the specific access patterns this pattern replaces, workload-to-AWS-service access and centralized egress, VPC Lattice routes traffic without an equivalent TGW hop. Where TGW was being used to centralize AWS service access or egress through shared services or inspection VPCs, those attachments and their data-processing charges are removed for this traffic.

TGW carries two cost drivers: a **per-attachment hourly charge** (billed for every attached VPC, before any traffic flows) and a **per-GB data-processing charge** on everything that traverses the gateway.

| Estate size | Traditional: TGW attachments for this traffic (1 per account) | Sole fabric: attachments for this traffic | Reduction |
|-------------|----------------------------------------------------------------|-------------------------------------------|-----------|
| 50 accounts | 50 attachments | 0 (Lattice routes this traffic directly) | 100% for this pattern |
| 150 accounts | 150 attachments | 0 | 100% for this pattern |
| 500 accounts | 500 attachments | 0 | 100% for this pattern |

This is a targeted reduction, not a blanket one. As the introduction's [decision framework](00-introduction.md#decision-framework-when-to-use-vpc-lattice-as-the-sole-fabric) states, Transit Gateway remains the right tool for general-purpose, high-volume, IP-routed east-west traffic and hybrid routing. The attachments you remove are the ones that existed *only* to centralize the AWS-service-access and egress patterns that VPC Lattice now handles. If your estate runs TGW solely for those patterns, the reduction approaches 100%; if TGW also carries genuine east-west or hybrid traffic, you keep those attachments and remove only the rest.

> **Business impact.** You stop paying per-attachment hourly charges and per-GB processing on traffic that no longer needs to traverse the hub. The TGW investment narrows to the workloads that genuinely require Layer 3 routing, which makes the remaining TGW spend defensible and clearly tied to a real requirement rather than to connectivity overhead.

### How to validate the dollar figures

Resource-count reductions are deterministic; dollar savings are not. Actual savings depend on:

- **Traffic patterns**, per-GB processing charges scale with how much data flows, which varies widely by workload.
- **AZ count**, every per-AZ resource (endpoints, NAT Gateways) multiplies by the number of AZs you deploy across.
- **Account volume**, the larger the estate, the larger the multiplier on every eliminated per-account resource.

Use the [AWS Pricing Calculator](https://calculator.aws/) with your own account count, AZ strategy, and traffic estimates to convert the resource-count deltas above into a dollar figure for your business case. The [Cost and Operational Comparison](11-cost-comparison.md) section provides the per-unit pricing structure to plug in.

## Outcome 2: Operational simplification

Cost is only part of the story. The traditional pattern duplicates not just resources but *operational work*, every endpoint, gateway, and route table must be created, secured, monitored, patched, and kept consistent across hundreds of accounts. The sole-fabric pattern removes that duplication.

### Onboarding collapses to a single action

In the traditional pattern, bringing a new workload account online means deploying and maintaining a full per-account connectivity stack:

- 10 or more interface VPC endpoints
- NAT Gateways (one per AZ)
- Route table entries for egress and endpoint routing
- DNS configuration (Private Hosted Zones or endpoint DNS settings) for each endpoint
- Security groups governing endpoint and gateway access

In the sole-fabric pattern, onboarding is a **single VPC association** to the appropriate Service Network with `PrivateDnsEnabled`. VPC Lattice then creates the Private Hosted Zones automatically, so standard AWS service domains resolve to Lattice addresses with zero per-workload DNS configuration.

| Onboarding step | Traditional per-account stack | Sole fabric |
|-----------------|-------------------------------|-------------|
| Interface endpoints to deploy | 10+ | 0 (shared) |
| NAT Gateways to deploy | 1 per AZ | 0 (shared) |
| Route table changes | Multiple | 0 for this traffic |
| DNS configuration | Per-endpoint | Automatic (`PrivateDnsEnabled`) |
| Net action to onboard | Full multi-resource deployment | 1 VPC association |

> **Business impact.** Time-to-onboard drops from days of multi-resource deployment and validation to minutes for a single association. New teams and new accounts become productive faster, and the platform team's onboarding effort no longer grows linearly with the size of the estate. Onboarding can be fully automated (StackSets or CDK Pipelines) because it is now one repeatable step rather than a fleet of interdependent resources.

### Reduced configuration drift

When the same 10+ endpoints, NAT Gateways, route tables, and security groups are deployed independently in every account, they inevitably diverge, a security group rule tightened in one account but not another, an endpoint policy updated here but missed there. This drift is one of the hardest problems to detect and the easiest way for a control to silently weaken.

In the sole-fabric pattern, the shared resources are configured **once** in the Network account and consumed identically by every workload account. There is one endpoint fleet to configure, one egress filter to maintain, and one set of Service Network policies to govern.

> **Business impact.** A configuration change (a new allowed FQDN, an updated endpoint policy, a tightened security group) is made once and applies everywhere instantly. There is no fleet of hundreds of copies to reconcile, so the risk of an inconsistent or stale control across accounts is largely eliminated. Compliance teams can verify a control in one place rather than sampling across hundreds of accounts.

### Reduced operational surface area

Every billable resource is also a resource someone must monitor, patch, secure, and troubleshoot. Reducing the resource count by ~99% (Outcome 1) reduces the operational surface area by a comparable margin.

| Surface area | Traditional (150 accounts) | Sole fabric |
|--------------|----------------------------|-------------|
| Endpoint ENIs to monitor | ~4,500 | 10-11 |
| NAT Gateways to monitor | ~300 | 1 shared path |
| Places egress filtering is configured | Up to 150 (if present at all) | 1 |
| Service Network access policies | N/A (per-account controls) | 3 (one per environment) |

> **Business impact.** Fewer resources mean fewer alarms, fewer patch targets, fewer things that can fail, and a smaller blast radius for operational mistakes. The platform team monitors and reasons about a handful of shared components instead of thousands of duplicated ones, which directly reduces operational cost and on-call burden.

## Outcome 3: Security posture improvements

The sole-fabric pattern does not just move resources around, it centralizes the *controls* that govern access and egress. Centralization means controls are defined in one authoritative place, enforced consistently, and reviewed once rather than audited across hundreds of accounts.

### Centralized access control by OU path

Each of the three Service Networks (dev, test, prod) carries its own Identity and Access Management (IAM) auth policy that restricts access by organizational unit (OU) path, using condition keys such as `aws:PrincipalOrgID` and `aws:PrincipalOrgPaths`. A dev workload cannot reach prod-shared connectivity, and the boundary is enforced by policy rather than by hoping every account's local configuration is correct.

> **Business impact.** Environment isolation becomes a property of the fabric itself, defined in three policies and enforced uniformly, rather than a property that each of hundreds of accounts must independently get right. This is a control a security architect can read, validate, and attest to in minutes during a Well-Architected or compliance review.

### OU-scoped resource sharing with external principals disabled

Each Service Network is shared through AWS Resource Access Manager (RAM) only to the specific OUs that should consume it, with external principals disabled. Sharing is scoped to OUs rather than to the entire Organization, so the isolation model is enforced at the share boundary as well as in the IAM auth policy, a defense-in-depth pairing.

> **Business impact.** Connectivity can only be consumed by accounts inside the intended OUs, and never by an account outside the Organization. The risk of an over-broad share exposing connectivity to the wrong environment (or outside the company) is structurally removed, not merely discouraged by convention.

### Centralized FQDN allowlist egress filtering

Per-account NAT Gateways forward outbound traffic without fully qualified domain name (FQDN) filtering, so each account is an independent, unfiltered path to the internet, and a potential data-exfiltration channel. The centralized egress proxy enforces an FQDN allowlist in one place: outbound traffic is permitted only to approved domains.

> **Business impact.** Data-exfiltration prevention moves from "absent or inconsistently applied across hundreds of accounts" to "enforced centrally on every egress flow." The allowlist is maintained once and applies to the whole estate, so closing or opening an outbound destination is a single, auditable change rather than a fleet-wide reconfiguration. This is a materially stronger and more defensible egress control than unfiltered per-account NAT.

### Fewer places for misconfiguration

Security review burden scales with the number of places a control can be defined and the number of places it can drift. Collapsing thousands of per-account resources into a handful of shared, centrally governed components shrinks the audit surface proportionally.

> **Business impact.** Auditors and security reviewers examine three Service Network policies, one egress filter, and one shared endpoint configuration, not hundreds of per-account copies. The review burden, and the probability that some account holds a weakened or stale control, both fall sharply. A smaller, centralized control set is easier to certify against compliance frameworks and faster to re-validate after any change.

## Summary

| Dimension | Traditional pattern | VPC Lattice sole fabric | Business outcome |
|-----------|---------------------|-------------------------|------------------|
| Cost basis | Per account | Per environment (×3) | Connectivity cost grows with environments, not accounts |
| Interface endpoints (150 accts, 3 AZ) | ~4,500 ENIs | 10-11 shared | ~99% fewer billable endpoint-hours |
| NAT Gateways (150 accts, 2/acct) | ~300 | 1 shared egress path | Egress consolidated and right-sized centrally |
| TGW attachments for this traffic | 1 per account | 0 | TGW spend narrows to genuine L3/hybrid needs |
| Onboarding a new account | Full multi-resource stack | 1 VPC association | Time-to-onboard drops from days to minutes |
| Egress filtering | Per-account or absent | Centralized FQDN allowlist | Stronger, auditable data-exfiltration prevention |
| Access control | Per-account configuration | 3 Service Network IAM policies + OU-scoped RAM | Isolation enforced by the fabric, smaller audit surface |

The resource-count reductions above are deterministic and portable. The dollar savings depend on your traffic patterns, AZ count, and account volume, validate them against your own profile with the [AWS Pricing Calculator](https://calculator.aws/), using the per-unit pricing structure in the [Cost and Operational Comparison](11-cost-comparison.md) section.

Continue to [Prerequisites](02-prerequisites.md) to confirm the AWS services, account setup, and subnet sizing required before implementation.
