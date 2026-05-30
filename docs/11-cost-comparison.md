# Cost and Operational Comparison

The [Well-Architected Framework Alignment](10-well-architected.md) section mapped the pattern to all six pillars and made the cost claim in pillar terms: connectivity is billed roughly once per environment instead of once per account. This section turns that claim into a usable comparison. It sets out the **pricing dimensions** of VPC Lattice, Transit Gateway (TGW), and per-account VPC endpoints with NAT Gateways side by side, layers illustrative scaling math on top of the deterministic resource counts already established in [Targeted Business Outcomes](01-business-outcomes.md), and quantifies the operational-effort delta of onboarding. The objective is to give a finance-aware architect the structure of the cost model, what you are billed for and how it scales, so they can build a defensible business case with their own numbers.

This section deliberately leads with **cost structure**, not with dollar amounts. The dimensions (what you are billed for, and the unit) are stable and portable. The dollar figures are not: they change over time, vary by Region, and depend heavily on traffic. Where a dollar figure appears below, it is illustrative only and clearly labelled as such; the authoritative number for your estate comes from the [AWS Pricing Calculator](https://calculator.aws/) and the official pricing pages.

> **A note on conventions.** As elsewhere in this guide, examples use the `us-east-2` Region and placeholder identifiers (organization ID `o-EXAMPLE12345`, account `111111111111`). Scaling examples use generic account counts of **50, 150, and 500** to show how each approach behaves as an estate grows; substitute your own account count and Availability Zone (AZ) strategy. No customer-identifying information is implied, and no dollar figure here should be treated as a current AWS price.

## How to read this section

Three ideas make the comparison legible:

- **Resource counts are deterministic; dollars are not.** The number of endpoints, NAT Gateways, and TGW attachments each approach provisions is fixed by the architecture and was quantified in [Targeted Business Outcomes](01-business-outcomes.md#outcome-1-cost-reduction). This section reuses those counts and does not contradict them. Dollar amounts depend on Region, traffic volume, AZ count, account volume, and the pricing in effect when you deploy.
- **Fixed (hourly-driven) cost is where the structural difference lives.** Every approach also has a per-GB data-processing charge that scales with traffic and is workload-specific. The architectural story, linear-with-accounts versus flat-per-environment, is clearest in the *fixed* hourly-driven cost, so the scaling tables below isolate that. Per-GB charges are treated separately and apply to all approaches.
- **Illustrative dollars are clearly caveated.** Where dollars make the scaling math concrete, they use representative `us-east-2` list rates at the time of writing, rounded to round numbers, and are flagged "illustrative, verify with the AWS Pricing Calculator." Always validate against your own Region and traffic.

## Pricing dimensions: what each approach bills for

The first comparison is purely structural, the billable dimensions of each approach, independent of any dollar amount. This table satisfies the core of the cost model: it shows *what you pay for* and *the unit*, which is the part of the comparison that does not change over time.

| Approach | Billed for (dimension) | Unit |
|----------|------------------------|------|
| **VPC Lattice (sole fabric)** | Resource Configuration (a shared resource exposed through a Resource Gateway) | Per resource, per hour |
| | Data processed to and from shared resources | Per GB (tiered) |
| | VPC association to a Service Network | **No additional cost** |
| | Service Network endpoint | **No additional cost** |
| **Transit Gateway (centralized)** | VPC attachment | Per attachment, per hour |
| | Data processed through the gateway | Per GB |
| **Per-account VPC endpoints + NAT** | Interface VPC endpoint (PrivateLink) | Per endpoint, per AZ, per hour |
| | Data processed by each interface endpoint | Per GB (tiered) |
| | NAT Gateway | Per gateway, per hour |
| | Data processed by each NAT Gateway | Per GB |

Two structural points stand out before any dollar figure is applied:

1. **VPC Lattice in this pattern uses the VPC Resources pricing model**, Resource Gateways, Resource Configurations, and VPC associations, not the VPC Lattice *Services* (target groups/listeners) model. In the VPC Resources model, the VPC association itself and the Service Network endpoint carry **no additional charge**; you are billed for the shared resources you expose (per resource-hour) and the data processed (per GB). This matters because onboarding an account, a single VPC association, adds no incremental hourly connectivity charge.
2. **The traditional approaches bill per account.** Every interface endpoint, NAT Gateway, and TGW attachment dimension above is provisioned *inside each workload account*, so the unit count multiplies by account count (and, for endpoints and NAT, by AZ count). The Lattice dimensions are provisioned *once* in the Network account and shared.

> **Business impact.** The dimension table is the part of the business case that survives a Region change or a price change. The defensible structural argument, "traditional connectivity bills per account, the sole fabric bills per environment", rests on these units, not on any specific rate.

## Cost driver comparison

The next table contrasts the same cost drivers across the three approaches and, critically, shows the **multiplier** each driver carries. This is where the linear-versus-flat behavior becomes visible.

| Cost driver | VPC Lattice (sole fabric) | Transit Gateway (centralized) | Per-account VPC endpoints + NAT |
|-------------|---------------------------|-------------------------------|----------------------------------|
| Per-association hourly charge | None (VPC association at no additional cost) | n/a | n/a |
| Per-attachment hourly charge | n/a | 1 attachment × **accounts** | n/a |
| Per-endpoint-hour charge | n/a | n/a | 10+ endpoints × **AZs** × **accounts** |
| Per-NAT-Gateway hourly charge | None for workload accounts (1 shared egress path) | n/a (NAT still needed per account or centrally) | 1+ NAT × **AZs** × **accounts** |
| Per-Resource-Configuration hourly charge | ~10-11 shared resources (flat, per environment) | n/a | n/a |
| Per-GB data processing | Per GB, tiered (applies to traffic to/from shared resources) | Per GB (applies to all hub traffic) | Per GB per endpoint + per GB per NAT |
| **How the fixed cost scales** | **Flat, per environment, independent of account count** | **Linear, grows with every account** | **Linear (×AZ), grows with every account and AZ** |

The bolded multipliers are the whole argument. In the traditional approaches, the hourly-driven dimensions are multiplied by account count (and AZ count), so fixed connectivity cost rises with every account vended. In the sole-fabric pattern, the hourly-driven dimension is a small, fixed set of shared Resource Configurations in the Network account, and the per-account action (the VPC association) is free, so fixed connectivity cost is essentially flat regardless of whether the estate is 50 or 500 accounts.

> **Business impact.** Finance can model traditional connectivity as a per-account unit cost that scales with the account-vending rate. The sole fabric converts that into a near-fixed platform cost that scales with the number of environments (three), which is far easier to forecast and does not grow as teams onboard.

## Scaling examples at 50, 150, and 500 accounts

This subsection layers illustrative pricing onto the deterministic resource counts from [Targeted Business Outcomes](01-business-outcomes.md). The resource counts (ENIs, NAT Gateways, attachments) are reproduced exactly from that section; only the dollar layer is added here.

> **Illustrative rates, verify with the [AWS Pricing Calculator](https://calculator.aws/).** The dollar figures below use representative `us-east-2` list rates at the time of writing, rounded for clarity, and a month of **730 hours**. They are for relative-magnitude illustration only and are **not** current AWS prices. Representative hourly rates used: interface endpoint ≈ $0.01 per AZ-hour; NAT Gateway ≈ $0.045 per hour; TGW attachment ≈ $0.05 per hour; VPC Lattice resource ≈ $0.10 per resource-hour. Per-GB data-processing charges are excluded from these *fixed-cost* tables and treated separately below.

### Traditional: fixed connectivity cost (per-account endpoints + NAT + TGW)

Using the counts from [Targeted Business Outcomes](01-business-outcomes.md): 10 interface endpoints × 3 AZs per account; 2 NAT Gateways per account; 1 TGW attachment per account for this traffic.

| Estate size | Endpoint ENIs (10×3AZ×accts) → monthly | NAT Gateways (2×accts) → monthly | TGW attachments (1×accts) → monthly | Traditional fixed total (illustrative) |
|-------------|------------------------------------------|-----------------------------------|---------------------------------------|-----------------------------------------|
| 50 accounts | 1,500 ENIs → ~$10,950 | 100 → ~$3,285 | 50 → ~$1,825 | **~$16,000 / month** |
| 150 accounts | 4,500 ENIs → ~$32,850 | 300 → ~$9,855 | 150 → ~$5,475 | **~$48,000 / month** |
| 500 accounts | 15,000 ENIs → ~$109,500 | 1,000 → ~$32,850 | 500 → ~$18,250 | **~$161,000 / month** |

Each column is a per-account count multiplied by an illustrative hourly rate and 730 hours. The total rises roughly linearly with account count, tripling the estate roughly triples the fixed connectivity bill.

### VPC Lattice sole fabric: fixed connectivity cost

The sole fabric provisions the billable hourly resources **once** in the Network account: roughly 10-11 shared Resource Configurations exposing the interface endpoints, plus the shared centralized egress path (one shared NAT Gateway behind the Squid proxy). The per-account VPC associations are free. Because each Resource Configuration is associated to the three environment Service Networks, treat the resource count as up to ~30-33 resource-associations as an upper bound when estimating.

| Estate size | Shared Resource Configurations (flat) | Shared egress fixed components | Per-account associations | Lattice fixed total (illustrative) |
|-------------|----------------------------------------|--------------------------------|--------------------------|-------------------------------------|
| 50 accounts | ~10-11 resources (×3 networks) → ~$800-$2,400 | 1 shared egress path (NAT + Fargate + NLB) | $0 (no additional cost) | **~$2,500-$3,000 / month (flat)** |
| 150 accounts | ~10-11 resources (×3 networks) → ~$800-$2,400 | 1 shared egress path | $0 | **~$2,500-$3,000 / month (flat)** |
| 500 accounts | ~10-11 resources (×3 networks) → ~$800-$2,400 | 1 shared egress path | $0 | **~$2,500-$3,000 / month (flat)** |

The figure barely moves across the three estate sizes because nothing in the Lattice fixed cost is multiplied by account count. Onboarding the 51st, 151st, or 501st account adds one free VPC association and no incremental hourly charge.

### Side by side: linear versus flat

| Estate size | Traditional fixed (illustrative) | Lattice sole-fabric fixed (illustrative) | Structural difference |
|-------------|----------------------------------|-------------------------------------------|------------------------|
| 50 accounts | ~$16,000 / month | ~$2,500-$3,000 / month | Traditional cost scales with accounts; Lattice is flat |
| 150 accounts | ~$48,000 / month | ~$2,500-$3,000 / month | Gap widens as the estate grows |
| 500 accounts | ~$161,000 / month | ~$2,500-$3,000 / month | Lattice fixed cost is essentially unchanged |

The point of this table is **not** the specific dollar gap, which depends entirely on your rates and AZ strategy. It is the *shape*: the traditional line rises with account count while the Lattice line stays roughly flat. That shape holds regardless of Region or current pricing, because it follows from the dimension multipliers in the cost-driver table above.

> **Business impact.** The larger the estate, the larger the structural advantage. At 50 accounts the sole fabric is meaningfully cheaper on fixed connectivity cost; at 500 accounts the per-account multiplier makes the traditional approach's fixed cost an order of magnitude larger, while the sole fabric's fixed cost has not moved.

### Data processing (per-GB) applies to every approach

The tables above isolate fixed, hourly-driven cost. Every approach *also* incurs per-GB data-processing charges that scale with traffic:

- **VPC Lattice** charges per GB processed to and from shared resources, on a tiered scale, and in a shared (provider/consumer) model both sides of the exchange can carry a per-GB dimension.
- **Transit Gateway** charges per GB for all traffic that traverses the hub, on top of the attachment hourly charge.
- **Interface endpoints and NAT Gateways** each charge per GB processed, independently, in every account.

Per-GB cost is workload-specific and cannot be reduced to a deterministic count, so it must be modelled from your own traffic estimates. The structural observation still holds: consolidating traffic onto shared infrastructure means per-GB charges are paid against a smaller number of consolidated streams that the platform team can see and attribute, rather than fragmented across hundreds of per-account meters. Model your expected GB-per-month per environment in the [AWS Pricing Calculator](https://calculator.aws/) to add the variable layer to the fixed-cost figures above.

## Operational cost comparison

Cost is not only the bill from AWS, it is also the engineering effort to stand up and maintain connectivity. This dimension overlaps with [Targeted Business Outcomes](01-business-outcomes.md#outcome-2-operational-simplification); here it is framed as the operational-cost side of the comparison, contrasting the effort to onboard and operate one workload account.

| Onboarding / operational step | Per-account endpoints + NAT (traditional) | VPC Lattice (sole fabric) |
|-------------------------------|--------------------------------------------|----------------------------|
| Interface endpoints to deploy and maintain | 10+ per account | 0 (shared in Network account) |
| NAT Gateways to deploy and maintain | 1+ per AZ per account | 0 (shared egress path) |
| Route table changes | Multiple per account | 0 for this traffic |
| DNS configuration | Per-endpoint, per account | Automatic (`PrivateDnsEnabled`) |
| Egress filtering configuration | Per account (if present at all) | Centralized once (FQDN allowlist) |
| Net action to onboard an account | Full multi-resource deployment | **1 VPC association** |
| Effort to add the next account | Repeats the full stack each time | Single repeatable, automatable step |

Because onboarding collapses to a single VPC association, it is straightforward to automate across the organization. As described in [Phase 4: Workload Onboarding](07-phase4-workload-onboarding.md), service-managed CloudFormation StackSets (or CDK Pipelines) onboard every new account vended into a target organizational unit with no manual step, so operational effort no longer grows linearly with the estate.

> **Business impact.** Traditional onboarding consumes engineering hours per account, deploy, validate, secure, and then maintain a fleet of interdependent resources, repeated for every account. The sole fabric converts that into one automatable action, so the marginal operational cost of the next account trends toward zero. The platform team's effort tracks the number of *changes to shared infrastructure*, not the number of accounts.

## Caveats and validation

Cost comparisons are only as honest as their caveats. The following determine whether the illustrative figures above resemble your reality, and they are the reason every dollar in this section is labelled illustrative:

- **Traffic patterns drive per-GB cost.** Data-processing charges scale with how much data flows and are entirely workload-specific. Two estates with identical account counts can have very different per-GB bills. The fixed-cost tables above deliberately exclude this layer; model it separately from your own traffic.
- **AZ count multiplies per-AZ resources.** Interface endpoints and NAT Gateways are billed per AZ. Deploying across two AZs versus three changes the traditional figures proportionally.
- **Account volume multiplies everything per-account.** The larger the estate, the larger the multiplier on every eliminated per-account resource, and the larger the structural advantage of the flat Lattice fixed cost.
- **Region and pricing change.** Rates vary by Region and over time. The representative rates used here are `us-east-2` list rates at the time of writing; the VPC Lattice resource example on the pricing page is quoted in `us-east-1`. Negotiated or private pricing will differ again.
- **The pattern targets specific traffic.** These savings apply to **AWS-service access and controlled egress**, the traffic this fabric replaces. TGW spend that carries genuine east-west or hybrid traffic is *retained*, not eliminated. Only the attachments and processing that existed solely to centralize the access-and-egress patterns go away. See the [decision framework](00-introduction.md#decision-framework-when-to-use-vpc-lattice-as-the-sole-fabric) for which traffic stays on TGW.

To produce authoritative figures for a business case:

1. Take the deterministic resource counts from [Targeted Business Outcomes](01-business-outcomes.md) for your account count and AZ strategy.
2. Enter them into the [AWS Pricing Calculator](https://calculator.aws/) for your Region, using the official [VPC Lattice](https://aws.amazon.com/vpc/lattice/pricing/), [Transit Gateway](https://aws.amazon.com/transit-gateway/pricing/), and [VPC / PrivateLink](https://aws.amazon.com/vpc/pricing/) pricing pages.
3. Add your own traffic estimate for the per-GB layer.
4. Compare the fixed-plus-variable totals, not the fixed layer alone.

## Summary

| Dimension | Traditional (endpoints + NAT + TGW) | VPC Lattice sole fabric | Cost outcome |
|-----------|--------------------------------------|--------------------------|--------------|
| Primary billable units | Per endpoint-hour (×AZ), per NAT-hour (×AZ), per attachment-hour | Per Resource-Configuration-hour (shared); association free | Billing moves from per-account to per-environment |
| How fixed cost scales | Linear with accounts (and AZs) | Flat per environment | Cost stops tracking the account-vending rate |
| Fixed cost at 500 accounts (illustrative) | ~$161,000 / month | ~$2,500-$3,000 / month | Order-of-magnitude gap that widens with scale |
| Per-GB data processing | Per endpoint + per NAT, fragmented | Consolidated, tiered | Easier to forecast and attribute |
| Onboarding effort | Full multi-resource stack per account | 1 automatable VPC association | Marginal cost of the next account trends to zero |

The structural conclusion is the one to carry into a business case: traditional connectivity is a **per-account cost that scales with the size of the estate**, while VPC Lattice as the sole fabric is a **per-environment platform cost that stays roughly flat** as accounts are added, with the per-GB layer the only part that tracks actual usage. The resource-count reductions behind this are deterministic and portable; the dollar amounts depend on your traffic, AZ count, account volume, and Region, so validate them with the [AWS Pricing Calculator](https://calculator.aws/) before committing to figures.

Continue to [Troubleshooting and FAQ](12-troubleshooting-faq.md).
