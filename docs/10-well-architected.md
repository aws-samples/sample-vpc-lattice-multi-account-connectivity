# Well-Architected Framework Alignment

The [Best Practices](09-best-practices.md) section turned the five implementation phases into a set of operating disciplines (naming, tagging, monitoring, and quota planning) that keep the fabric runnable at scale. This section steps back and evaluates the whole pattern against the **AWS Well-Architected Framework**, mapping its six pillars to the specific design decisions this architecture makes. The goal is twofold: to give a solutions architect the material to carry this pattern into a formal Well-Architected Review, and to be honest about the trade-offs the approach introduces, chief among them a deliberate concentration of connectivity into a single managed fabric.

This is not a generic restatement of Well-Architected guidance. Every claim below points to a concrete decision already described in this guide, a Service Network IAM auth policy, a `PrivateDnsEnabled` association, a multi-AZ Resource Gateway, an eliminated per-account resource, so that the mapping is auditable against the IaC rather than aspirational.

> **A note on conventions.** As elsewhere in this guide, examples use the `us-east-2` Region and placeholder identifiers (organization ID `o-EXAMPLE12345`, account `111111111111`). The reference IaC deploys **three Service Networks**, one each for dev, test, and prod, named `sn-{env}-shared` in both the AWS Cloud Development Kit (CDK) and AWS CloudFormation paths. This section refers to them generically (for example, "the prod service network").

## Summary: pillars to headline decisions

The table below is the executive view, each pillar mapped to the design decisions that most distinguish this pattern. The sections that follow expand each row with best-practice-level detail.

| Pillar | Headline design decisions in this architecture |
|--------|------------------------------------------------|
| Operational Excellence | Onboarding is a single VPC association per account; everything is Infrastructure as Code (CDK + CloudFormation) with `cdk-nag` at synth; shared connectivity is configured once centrally, eliminating per-account drift |
| Security | Defense in depth across two boundaries, Service Network IAM auth policies (OU-path scoped) and OU-scoped RAM shares with external principals disabled, with centralized FQDN-allowlist egress filtering and least-privilege IAM |
| Reliability | Multi-AZ Resource Gateways across two subnets; Squid on Fargate at `desiredCount` 2 with ECS auto-recovery and NLB health checks; self-healing VPCE DNS discovery on redeploy (native `attrDnsEntries` on the CDK path, Lambda on the CloudFormation path) |
| Performance Efficiency | Direct Lattice routing from workload to endpoint/proxy with no Transit Gateway hop; managed, horizontally scaling service; automatic DNS via `PrivateDnsEnabled` |
| Cost Optimization | Eliminates per-account interface endpoints (~99% fewer), per-account NAT Gateways, and TGW attachments for this traffic; cost scales per environment, not per account |
| Sustainability | Collapses thousands of always-on per-account ENIs and NAT Gateways into a small, high-utilization shared set, minimizing provisioned-but-idle capacity |

## Operational Excellence

The Operational Excellence pillar is about running and evolving systems with as little undifferentiated toil as possible, performing operations as code, making frequent small reversible changes, and anticipating failure. This pattern's central operational claim is that **connectivity stops being per-account work**: the shared fabric is built once, expressed entirely in code, and onboarding a new account collapses to one repeatable action.

| Well-Architected best practice | How this architecture satisfies it |
|--------------------------------|-------------------------------------|
| Perform operations as code | All infrastructure is IaC, CDK (TypeScript) for the four stacks and CloudFormation (YAML) for the StackSet-deployable paths. There is no console-driven connectivity setup to reproduce by hand. |
| Make frequent, small, reversible changes | Onboarding is a single `ServiceNetworkVpcAssociation` per account ([Phase 4](07-phase4-workload-onboarding.md)); the egress allowlist is one task-definition change; each is small and rolls back cleanly. |
| Reduce defects and improve flow with automated checks | `cdk-nag` `AwsSolutionsChecks` runs at synth time, so security-posture regressions surface during the build rather than after deployment. |
| Anticipate and recover from failure automatically | VPCE DNS discovery re-resolves endpoint DNS names on every redeploy, natively from `attrDnsEntries` on the CDK path, or via the discovery Lambda on the CloudFormation path, so the fabric self-heals if an interface endpoint is replaced; ECS auto-recovers failed Squid tasks. |
| Make systems observable | VPC Lattice access logs at the Service Network level, Container Insights on the egress cluster, and ECS Exec for live troubleshooting are all enabled by the reference IaC ([Best Practices](09-best-practices.md#monitoring-and-observability)). |

### Onboarding as a single, automatable action

In the traditional pattern, bringing an account online means deploying and then maintaining a per-account fleet of endpoints, NAT Gateways, route tables, and DNS zones. Here it is one VPC association with `PrivateDnsEnabled`, after which VPC Lattice creates the Private Hosted Zones automatically. Because that action is a single resource, it is trivially automatable: **service-managed CloudFormation StackSets with auto-deployment** onboard every new account vended into a target organizational unit (OU) with no manual step, and **CDK Pipelines** offer the same outcome on the CDK path. Operational effort no longer grows linearly with the size of the estate.

### Configure once, consume everywhere

The shared endpoints, the egress proxy, and the Service Network policies are configured **once** in the Network account and consumed identically by every workload account. A change to an endpoint policy, an FQDN allowlist entry, or a Service Network auth policy is made in one authoritative place and applies everywhere immediately. This eliminates the configuration drift that is endemic to fleets of independently deployed per-account resources, and it gives operators a small, comprehensible set of components to reason about rather than thousands of duplicated copies.

## Security

> This pillar mapping satisfies requirement 6.5: mapping the architecture to the Well-Architected **Security** pillar best practices.

The Security pillar is about protecting information and systems through a strong identity foundation, traceability, defense in depth, protection of data in transit, and least privilege. This pattern's defining security property is that **isolation and access control are properties of the fabric itself**, defined in a handful of central policies rather than re-implemented (and potentially weakened) in every account. The [Architecture](03-architecture.md#the-three-service-network-model-and-environment-isolation) section establishes the two-boundary isolation model in detail; the mapping below ties each Security pillar best practice to a concrete decision.

| Security pillar best practice | How this architecture satisfies it |
|-------------------------------|-------------------------------------|
| Strong identity foundation; rely on a centralized identity provider | Each Service Network is created with `AuthType: AWS_IAM`; access is authorized by IAM using `aws:PrincipalOrgID` (the caller must belong to this Organization) and `aws:PrincipalOrgPaths` (the caller must live in the environment's OU path). Identity, not IP, is the control plane. |
| Apply security at all layers (defense in depth) | Two independent boundaries: the Service Network IAM auth policy **and** the RAM share scoped to OU ARNs with `AllowExternalPrincipals: false`. A misconfiguration in one layer is still caught by the other. |
| Implement least privilege | IAM is tightly scoped: VPC endpoint policies allow only principals in the organization (`aws:PrincipalOrgID`), and the Squid proxy's ECS task and execution roles grant only what ECS Exec and ECR pull require (the unavoidable wildcards, `ssmmessages:*` and `ecr:GetAuthorizationToken`, do not support resource-level permissions and carry documented `cdk-nag` `AwsSolutions-IAM5` suppressions). The workload association uses no Lambda or lookup role: the VPC ID resolves via a native `AWS::SSM::Parameter::Value` and the service network ID is passed as a parameter. Security groups are explicit, no default VPC security group, no `0.0.0.0/0`. |
| Protect networks and resources; reduce exposure | The egress NLB is internal (`internetFacing: false`); the Squid proxy has no public surface and is reachable only through the egress Resource Gateway. AWS service calls travel a private path to interface endpoints with no public internet route. |
| Enable traceability | VPC Lattice access logs at the Service Network level record which principal invoked which Resource Configuration and with what result, the authoritative audit trail for both endpoint access and the egress chokepoint. |
| Prevent data exfiltration | The centralized Squid proxy enforces an FQDN allowlist (`ALLOWED_DOMAINS`); outbound traffic is permitted only to explicitly approved domains, in one place, instead of through hundreds of unfiltered per-account NAT Gateways. |

### Environment isolation enforced by identity and sharing

Three environment-isolated Service Networks (dev, test, prod) carry auth policies that differ only in the OU paths they permit. A dev principal can invoke through the dev network but is denied by the prod network's policy because its org path does not match any prod OU path. The RAM share reinforces this: each network is shared only to its environment's OUs, so an account outside those OUs cannot even discover the network, let alone associate to it. A security reviewer can attest to environment isolation by reading three policies and three share scopes, not by sampling configuration across hundreds of accounts.

### A smaller, centralized audit surface

Collapsing thousands of per-account endpoints, NAT Gateways, and route tables into a handful of shared, centrally governed components shrinks the audit surface proportionally. There are three Service Network policies, one egress filter, and one shared endpoint configuration to certify, rather than per-account copies that can each drift. The formal threat model and the findings-by-mitigation mapping are documented separately in the [Security Findings Summary](13-security-findings.md).

## Reliability

The Reliability pillar is about a workload performing its intended function correctly and consistently, and recovering automatically from failure. Because this fabric is shared, its reliability characteristics matter for the whole organization, which is precisely why every shared component in the reference is deployed for **Availability Zone (AZ) redundancy and automatic recovery**.

| Reliability pillar best practice | How this architecture satisfies it |
|----------------------------------|-------------------------------------|
| Withstand the loss of a single Availability Zone | Both Resource Gateways (endpoint and egress) are deployed across **two subnets in two AZs**; the egress NLB has cross-zone load balancing enabled. |
| Automatically recover from failure | The Squid service runs at `desiredCount` 2 on ECS Fargate; ECS replaces failed tasks automatically, and the NLB target group health-checks each task on TCP:3128 every 30 seconds, removing unhealthy tasks from rotation. |
| Manage change in automation; self-heal | VPCE DNS discovery re-resolves endpoint DNS names on redeploy (natively via `attrDnsEntries` on the CDK path, via the discovery Lambda on the CloudFormation path), so an endpoint replacement does not require manual reconfiguration of the Resource Configurations. |
| Provision adequate capacity (avoid resource exhaustion) | Resource Gateway subnets are sized at a minimum of /24 so the gateways can scale elastic network interfaces (ENIs) with connection volume without IP exhaustion ([Prerequisites](02-prerequisites.md#3-subnet-sizing-requirements)). |
| Plan for and monitor service quotas | Quota planning, especially VPC associations per Service Network, is covered as an explicit operating discipline ([Best Practices](09-best-practices.md#vpc-lattice-service-quotas-to-plan-against)), with proactive increase requests before a rollout approaches a limit. |

### Multi-AZ by construction, with a candid dependency

Each shared component is built to survive the loss of one AZ: two-AZ Resource Gateways, two Fargate tasks across two AZs, a cross-zone-enabled internal NLB. Environment isolation across three separate Service Networks also limits the blast radius of a network-level misconfiguration to a single environment. The honest counterweight is that the pattern makes VPC Lattice (and the Network account that hosts the shared components) a dependency for the entire organization's AWS-service access and egress. That trade-off, and its mitigations, is treated directly in [Trade-offs and design tensions](#trade-offs-and-design-tensions) below; it is called out here so the Reliability picture is complete rather than one-sided.

## Performance Efficiency

The Performance Efficiency pillar is about using computing resources efficiently as demand and technology change. This pattern's performance argument is structural: by routing AWS-service and egress traffic **directly through VPC Lattice rather than centralizing it through a Transit Gateway hub**, it removes a hop and the latency and processing that come with it, while leaning on a managed service to scale.

| Performance Efficiency best practice | How this architecture satisfies it |
|--------------------------------------|-------------------------------------|
| Reduce latency; minimize the network distance traffic travels | For the AWS-service-access and egress patterns this fabric serves, traffic goes workload → Lattice → endpoint/proxy with **no Transit Gateway hop**, reducing hops and latency compared with centralizing the same traffic through a TGW. |
| Use managed services to reduce operational and scaling burden | VPC Lattice is a managed, horizontally scaling service; Resource Gateways scale their ENIs with connection volume, and Fargate scales the proxy fleet, none of which the team operates directly. |
| Adopt the technology approach that best fits the workload | Lattice access is by DNS/service rather than by IP route, so this pattern fits service-access and egress workloads without imposing the routing-plane overhead a general-purpose L3 mesh would. |
| Remove configuration that adds no value | `PrivateDnsEnabled` gives workloads automatic resolution of the shared domains with no per-workload DNS lookups to author or maintain. |

### Direct routing, not a hub hop

When AWS-service access or egress is centralized through a Transit Gateway, that traffic crosses the hub, incurring an extra hop and per-GB processing on every byte. This pattern routes the same traffic directly through Lattice to the Resource Gateway and on to the endpoint or proxy, so the request takes a shorter path. This is a targeted efficiency gain for the specific patterns the fabric serves; as the [decision framework](00-introduction.md#decision-framework-when-to-use-vpc-lattice-as-the-sole-fabric) notes, genuine high-volume east-west IP traffic is still best served by Transit Gateway, which is retained for that purpose.

## Cost Optimization

The Cost Optimization pillar is about avoiding unnecessary cost and matching spend to value. The pattern's cost story is the inverse of the traditional one: connectivity infrastructure is billed roughly **once per environment instead of once per account**, because the duplicated per-account resources are eliminated outright. The resource-count math and its business impact are quantified in detail in [Targeted Business Outcomes](01-business-outcomes.md) and priced in [Cost and Operational Comparison](11-cost-comparison.md); the mapping below ties those reductions to the pillar's best practices.

| Cost Optimization best practice | How this architecture satisfies it |
|---------------------------------|-------------------------------------|
| Eliminate unneeded and duplicated resources | Per-account interface endpoints collapse to a single shared set (~10-11 Resource Configurations versus thousands of per-account endpoint ENIs, roughly a 99% reduction); per-account NAT Gateways collapse to one shared egress path; TGW attachments created solely to centralize this traffic are removed. |
| Match supply to demand; right-size | The Squid fleet is right-sized centrally (`cpu`/`memory`/`desiredCount`) against aggregate demand, with optional Application Auto Scaling, far more efficient than idle per-account copies. |
| Adopt a consumption model; scale cost with value | Connectivity cost scales with the number of environments (three), not with account count; onboarding the 151st or 501st account adds no incremental endpoint spend. |
| Increase utilization of shared resources | A small set of shared endpoints and one proxy fleet run at high utilization, replacing thousands of always-on per-account resources that were billed continuously regardless of use. |
| Attribute and monitor cost | The tagging strategy and cost-allocation tags ([Best Practices](09-best-practices.md#tagging-strategy)) let the fabric's spend be grouped by `Environment` and `CostCenter`, including the centralized egress costs that land in the Network account. |

For the per-unit pricing structure (per-association, per-Resource-Configuration, per-GB) and side-by-side comparisons against Transit Gateway and per-account endpoints, see [Cost and Operational Comparison](11-cost-comparison.md). The resource-count reductions are deterministic; the dollar savings depend on traffic patterns, AZ count, and account volume.

## Sustainability

The Sustainability pillar is about minimizing the environmental impact of running cloud workloads, primarily by maximizing utilization and minimizing provisioned-but-idle capacity. This pattern aligns with that pillar almost as a side effect of its cost and operational design: **eliminating duplicated per-account infrastructure removes a large amount of always-on, under-utilized capacity.**

| Sustainability best practice | How this architecture satisfies it |
|------------------------------|-------------------------------------|
| Maximize utilization of provisioned resources | Thousands of per-account interface-endpoint ENIs and per-account NAT Gateways, each provisioned and billed continuously regardless of use, are replaced by a small shared set that runs at far higher utilization. |
| Eliminate or minimize idle resources | The shared fabric removes the "provisioned but mostly idle" per-account copies entirely; the egress proxy fleet can scale down with demand rather than being statically over-provisioned in every account. |
| Scale infrastructure with user load, not with account count | Because connectivity is shared, capacity grows with actual aggregate traffic rather than multiplying with every new account that joins the estate. |

The net effect is that the organization provisions and powers materially less infrastructure to deliver the same connectivity. Reducing thousands of idle ENIs and NAT Gateways to a high-utilization shared set is exactly the "maximize utilization, minimize idle capacity" guidance the Sustainability pillar calls for, and it scales with the size of the estate, the larger the account count, the greater the avoided idle capacity.

## Trade-offs and design tensions

> This section satisfies requirement 11.3: identifying the Well-Architected trade-offs the VPC Lattice approach introduces.

No architecture is free of tension, and the most important discipline in a Well-Architected Review is naming the trade-offs honestly. Centralizing connectivity into a single fabric delivers the cost, operational, and security benefits mapped above **by concentrating dependency**, and that concentration is the source of every trade-off below. Each is paired with the mitigations this pattern already builds in.

| Trade-off | Pillar tension | Mitigations built into this pattern |
|-----------|----------------|-------------------------------------|
| Single-fabric dependency: the organization's AWS-service access and egress depend on VPC Lattice availability and on the Network account | Reliability vs. Cost/Operational Excellence | Multi-AZ Resource Gateways; multi-task Fargate with auto-recovery and health checks; monitoring and alarms on gateway/RC/NLB/proxy health; environment isolation across three independent Service Networks limits blast radius; Transit Gateway retained for traffic that needs it |
| Concentrated blast radius in the Network account | Reliability vs. Security/Cost | Strong change control and IaC-only changes; `cdk-nag` at synth; centralized monitoring; least-privilege roles so a single compromised principal has narrow reach |
| A Service Network is a **regional** construct | Reliability/Performance vs. Operational Excellence | Multi-Region deployments replicate the pattern per Region; multi-Region considerations are addressed in the [Troubleshooting and FAQ](12-troubleshooting-faq.md) |
| Relatively new service and operational learning curve versus mature TGW tooling | Operational Excellence | IaC-first delivery, prescriptive naming/tagging/monitoring practices ([Best Practices](09-best-practices.md)), and a phased rollout reduce the ramp; teams keep existing TGW tooling for the workloads that remain on TGW |
| Auth policy 10 KB hard limit constrains how many OU paths can be enumerated | Security vs. Operational Excellence | Keep auth policies compact, prefer broad OU-path prefixes with the `/*` suffix over enumerating many narrow paths ([Best Practices](09-best-practices.md#vpc-lattice-service-quotas-to-plan-against)) |

### The central trade-off: dependency concentration

The single most important trade-off is that this pattern makes VPC Lattice, and the shared components in the Network account, a dependency for the whole organization's AWS-service access and controlled egress. This is the deliberate inverse of the traditional pattern's tension: the traditional design spreads dependency across thousands of independent (and independently failing, drifting, and costing) resources, while this design concentrates it into a small, highly available, centrally governed fabric.

The pattern manages that concentration rather than ignoring it. Availability is defended at every shared component (two-AZ Resource Gateways, multi-task Fargate, cross-zone NLB, health checks). Blast radius is bounded by the three-network environment split, so a network-level problem affects one environment, not all three. And the design does not claim to replace Transit Gateway wholesale: **TGW is retained for the east-west and hybrid traffic that genuinely needs Layer 3 routing**, so the organization is not betting every connectivity pattern on a single service. The right way to read this section in a Well-Architected Review is as a conscious exchange, accepting a concentrated, well-defended dependency in return for large reductions in cost, operational toil, idle capacity, and audit surface.

### When the trade-off argues against this pattern

If a workload's dominant need is high-volume, general-purpose, IP-routed east-west traffic, or hybrid routing to on-premises networks, the Performance and Reliability tensions tilt the other way and Transit Gateway remains the better fabric for that traffic. The [decision framework](00-introduction.md#decision-framework-when-to-use-vpc-lattice-as-the-sole-fabric) in the introduction is the tool for making that call; this section's role is to ensure the trade-offs are explicit when you do.

---

Mapped across all six pillars, the pattern's strengths cluster in Cost Optimization, Operational Excellence, Security, and Sustainability, with deliberate, mitigated trade-offs in Reliability and Performance Efficiency stemming from the single-fabric dependency. With that alignment understood, the next section quantifies the cost side of the story in detail, the per-unit pricing and side-by-side comparisons that turn the resource-count reductions above into a business case.

Continue to [Cost and Operational Comparison](11-cost-comparison.md).
