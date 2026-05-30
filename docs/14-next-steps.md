# Next Steps and Resources

The [Security Findings Summary](13-security-findings.md) closed the analytical arc of this guide: it consolidated the threat model, mapped each threat to a mitigation implemented in the Infrastructure as Code (IaC), and recorded the accepted residual risks. With that, the guide has walked the full distance, from the [problem](00-introduction.md) of per-account connectivity sprawl, through the [architecture](03-architecture.md) and the five implementation phases ([Foundation](04-phase1-foundation.md), [Shared Endpoints](05-phase2-shared-endpoints.md), [Centralized Egress](06-phase3-centralized-egress.md), [Workload Onboarding](07-phase4-workload-onboarding.md), and [Ingress via Service Network Endpoints](08-phase5-ingress-service-network-endpoints.md)), and on through [best practices](09-best-practices.md), [Well-Architected alignment](10-well-architected.md), [cost](11-cost-comparison.md), [troubleshooting](12-troubleshooting-faq.md), and [security](13-security-findings.md). This final section is forward-looking. It lays out the concrete next actions to take the pattern from a read to a running pilot, describes the enhancements that extend it once the baseline is in place, and collects the documentation, pricing, framework, and community resources you will reach for along the way.

> **A note on conventions.** As elsewhere in this guide, examples assume the `us-east-2` Region and placeholder identifiers (organization ID `o-EXAMPLE12345`, account `111111111111`). Substitute your own values and target Region throughout.

## Next steps

The fastest way to validate this pattern for your organization is not to deploy it everywhere, it is to prove it on a small, contained scope and expand in waves. The four actions below are ordered so each de-risks the next: start small, validate the cost and architecture against your own numbers, and standardize the operating disciplines before the first wave of onboarding.

1. **Begin with a pilot OU.** Stand up the shared fabric (Phases 1-3) in the Network account, then onboard a single, low-risk organizational unit (OU), ideally a dev OU, by associating its workload VPCs. The migration is incremental and side-by-side by design: the fabric runs alongside your existing Transit Gateway, NAT Gateway, and per-account endpoints while you validate, so nothing is at risk if the pilot reveals a gap. The step-by-step pilot and wave-based migration path is in the [migration FAQ](12-troubleshooting-faq.md#what-is-the-migration-path-from-a-traditional-architecture), and the foundational deployment is [Phase 1: Foundation](04-phase1-foundation.md). Validate end to end before expanding: `dig` resolves the service domains to VPC Lattice IPs, `aws sts get-caller-identity` succeeds through the fabric, and the egress proxy permits an allowlisted domain while denying others.

2. **Validate the cost model with your own numbers.** The [Cost and Operational Comparison](11-cost-comparison.md) section deliberately leads with cost *structure* rather than dollar amounts, because the dollars depend on your Region, traffic, and Availability Zone (AZ) strategy. Take the deterministic resource counts for your account count and AZ strategy, enter them into the [AWS Pricing Calculator](https://calculator.aws/) for your Region, add your own per-GB traffic estimate, and compare the fixed-plus-variable totals, not the fixed layer alone. This turns the pattern's structural argument (per-environment cost rather than per-account) into a defensible business case.

3. **Run a Well-Architected Review using the pillar mapping.** The [Well-Architected Framework Alignment](10-well-architected.md) section maps every claim to a concrete design decision in the IaC, and it names the central trade-off honestly, the deliberate concentration of connectivity into a single fabric. Use that mapping, and especially the [trade-offs and design tensions](10-well-architected.md#trade-offs-and-design-tensions) discussion, as the input to a formal review of your own deployment with the [AWS Well-Architected Tool](https://aws.amazon.com/architecture/well-architected/).

4. **Establish naming, tagging, and monitoring standards before the first onboarding.** These cost nothing to adopt on day one and a great deal to retrofit later. Fix one org-wide naming prefix, the mandatory tag set (and activate the cost allocation tags), and the day-one observability, VPC Lattice access logs at the Service Network level plus alarms on gateway, Resource Configuration, NLB, and proxy health, before you onboard your first wave. All of this is prescribed in [Best Practices](09-best-practices.md), and the quota planning that scaling depends on is in [VPC Lattice service quotas to plan against](09-best-practices.md#vpc-lattice-service-quotas-to-plan-against).

## Future enhancements

The reference pattern is intentionally scoped to two traffic patterns, AWS-service access and controlled internet egress, so that the baseline is simple to reason about and prove. Once that baseline runs, the pattern extends naturally along several axes. The enhancements below are listed roughly in order of how commonly teams adopt them.

### Additional AWS service endpoints

The reference exposes 10 interface VPC endpoints on the AWS Cloud Development Kit (CDK) path (11 on the AWS CloudFormation path, which adds `execute-api`). Extending the shared set to another AWS service is a Network-account-only change with no per-account work: deploy the interface endpoint for the new service in the Endpoint VPC, add the service to the `endpoints` array in `VpcLatticeEndpointsStack` (or the endpoint list in the combined CloudFormation template), and redeploy. Each entry produces a Resource Configuration on `443/TCP` associated to all three Service Networks, and workloads resolve the new domain automatically through the Lattice-managed Private Hosted Zone. The mechanics are covered in [Phase 2](05-phase2-shared-endpoints.md) and the [add-endpoints FAQ](12-troubleshooting-faq.md#can-i-add-more-aws-service-endpoints-to-the-shared-set). Watch the Resource-Configurations-per-Service-Network quota as the set grows, though the reference is far below the limit.

### Service-to-service connectivity via VPC Lattice Services

This guide uses VPC Lattice in its **VPC Resources** model, Resource Gateways, Resource Configurations, and VPC associations, to provide AWS-service access and egress. The logical evolution is to use VPC Lattice **Services** (target groups, listeners, and routing rules) for **east-west, application-to-application connectivity** between workloads, turning the same fabric into an application service mesh in addition to a connectivity layer. This is **explicitly out of scope of this guide** (see [What this guide does not cover](00-introduction.md#what-this-guide-does-not-cover)), and it is a different pricing and operational model, VPC Lattice Services are billed per service-hour, per request or connection, and per GB, unlike the VPC Resources model where the VPC association itself carries no additional cost. The idea, briefly: where you today run HTTP/HTTPS or gRPC calls between microservices across accounts over IP routes, you could instead register those applications as VPC Lattice Services, gaining identity-based authorization (auth policies), built-in load balancing, and observability without an IP-routing plane. Treat it as a separate evaluation with its own design rather than a switch to flip on this pattern.

### Scaling SN-E ingress DNS automation across the fleet

Ingress for external, on-premises, and cross-Region consumers is built in [Phase 5: Ingress via Service Network Endpoints](08-phase5-ingress-service-network-endpoints.md), which deploys the SN-E and the EventBridge → Step Functions → Route 53 automation that keeps the custom-domain records current. The maturity step here is operational rather than architectural: as the number of SN-Es and consumers grows, move from the single-account automation shape to the cross-account form (a central networking-account state machine fed by spoke-account event buses, with dead-letter queues at each hop), and fold the SN-E records into the same naming, tagging, and monitoring disciplines you apply to the rest of the fabric. Phase 5 documents both the single-account and cross-account automation shapes, the SN-A-versus-SN-E decision, and why SN-E needs a CNAME (or an Alias for apex names).

### Multi-Region expansion

A VPC Lattice Service Network is a **regional** construct, so a multi-Region deployment replicates the pattern per Region rather than spanning a single global fabric. Your IaC is parameterized by Region and instantiated once per Region: per-Region Service Networks (dev/stage/prod), per-Region Resource Gateways, endpoints, Resource Configurations, and egress proxy, and a per-Region workload association so a VPC associates to the Service Network in its own Region. The RAM shares and IAM auth policies are regional too. The end-to-end approach, and the per-Region replication of the single-fabric dependency and its mitigations, is detailed in the [multi-Region FAQ](12-troubleshooting-faq.md#how-does-this-work-across-multiple-regions).

### Egress hardening with a managed or pinned firewall

The reference egress proxy is a Squid forward proxy on Amazon ECS Fargate, chosen for being lightweight, license-free, and capable of FQDN allowlisting. Two hardening evolutions are natural once it is in production. First, **pin and harden the proxy image**: build an immutable Squid image and push it to Amazon ECR (pulled privately through the shared ECR endpoint) instead of pulling a public `latest` tag, which also removes a deployment-time dependency on a public registry. Second, where requirements grow beyond FQDN allowlisting toward managed, stateful inspection, **evaluate AWS Network Firewall** (or a third-party appliance) as the egress control point. The trade-offs that led to Squid for this pattern, and the alternatives, are discussed in [Phase 3: Centralized Egress](06-phase3-centralized-egress.md); revisit that analysis against your own filtering, throughput, and operational requirements.

### Automation maturity for fleet onboarding

Onboarding is a single VPC association, which makes it trivially automatable. The maturity step is to move from manual or piecemeal onboarding to **fully automated, organization-wide fleet onboarding**: service-managed CloudFormation StackSets with auto-deployment, which onboard every new account vended into a target OU with no manual step, or CDK Pipelines that instantiate the workload association per account from a pipeline. Both rely on the RAM org-sharing prerequisite so shares auto-accept. The approaches, prerequisites, and end-to-end flow are in [Phase 4: Workload Onboarding](07-phase4-workload-onboarding.md).

## Resources

The links below are grouped by purpose. Prefer the official `docs.aws.amazon.com` and `aws.amazon.com` sources; deep links change over time, so where a specific page moves, navigate from the parent page listed here.

### AWS service documentation

| Resource | Link | What it covers |
|----------|------|----------------|
| Amazon VPC Lattice (product) | [aws.amazon.com/vpc/lattice](https://aws.amazon.com/vpc/lattice/) | Product overview, features, and entry point to the service |
| Amazon VPC Lattice User Guide | [What is Amazon VPC Lattice?](https://docs.aws.amazon.com/vpc-lattice/latest/ug/what-is-vpc-lattice.html) | The authoritative guide; key components, roles, and concepts |
| Resource gateways | [Resource gateways in VPC Lattice](https://docs.aws.amazon.com/vpc-lattice/latest/ug/resource-gateway.html) | The ingress point this pattern deploys in the Endpoint and Egress VPCs; security groups, IP address types, subnet/AZ behavior |
| Resource configurations | [Resource configurations for VPC resources](https://docs.aws.amazon.com/vpc-lattice/latest/ug/resource-configuration.html) | The construct that exposes endpoints and the proxy; custom domains, RAM sharing, association types |
| Service networks | [Service networks in VPC Lattice](https://docs.aws.amazon.com/vpc-lattice/latest/ug/service-networks.html) | The per-environment isolation boundary, VPC associations, and auth |
| AWS Resource Access Manager (RAM) | [What is AWS RAM?](https://docs.aws.amazon.com/ram/latest/userguide/what-is.html) | OU-scoped sharing of Service Networks and Resource Configurations, and org auto-accept |
| AWS Organizations | [What is AWS Organizations?](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_introduction.html) | OUs, organization ID, and org paths that the IAM auth policies and RAM shares are scoped to |
| Route 53 private hosted zones | [Working with private hosted zones](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/hosted-zones-private.html) | The PHZ behavior behind `PrivateDnsEnabled` and the conflicting-zone troubleshooting scenario |
| Amazon ECS on AWS Fargate | [Architect for AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html) | The serverless compute that runs the Squid egress proxy |
| Network Load Balancer | [What is a Network Load Balancer?](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/introduction.html) | The internal NLB fronting the proxy; target groups and health checks |
| CloudFormation StackSets | [Managing stacks across accounts and Regions](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/what-is-cfnstacksets.html) | Service-managed, auto-deploying onboarding across an OU |
| CDK Pipelines | [aws-cdk-lib.pipelines](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.pipelines-readme.html) | The CDK path for per-account onboarding automation |

### Pricing and quotas

| Resource | Link | What it covers |
|----------|------|----------------|
| VPC Lattice pricing | [aws.amazon.com/vpc/lattice/pricing](https://aws.amazon.com/vpc/lattice/pricing/) | The VPC Resources model (per-resource-hour, per-GB; VPC association at no additional cost) and the Services model |
| VPC Lattice quotas | [Quotas for Amazon VPC Lattice](https://docs.aws.amazon.com/vpc-lattice/latest/ug/quotas.html) | The per-Region limits to plan against, associations per Service Network, Resource Configurations, auth policy size |
| AWS Pricing Calculator | [calculator.aws](https://calculator.aws/) | Build the authoritative cost estimate for your Region, account count, and traffic |
| Service Quotas console | AWS Management Console → **Service Quotas** → **AWS services** → **VPC Lattice** | View current values for *your* account and request increases on adjustable (soft) quotas |

> **Verify quotas for your account.** The representative quota values in [Best Practices](09-best-practices.md#vpc-lattice-service-quotas-to-plan-against) are for planning only. Quota values change over time and can differ by Region and account, confirm the current numbers in the Service Quotas console and the quotas page before sizing a large rollout.

### Architecture and framework guidance

| Resource | Link | What it covers |
|----------|------|----------------|
| AWS Well-Architected Framework | [aws.amazon.com/architecture/well-architected](https://aws.amazon.com/architecture/well-architected/) | The six pillars and the Well-Architected Tool used in the review described above |
| AWS Prescriptive Guidance | [aws.amazon.com/prescriptive-guidance](https://aws.amazon.com/prescriptive-guidance/) | Patterns, strategies, and guides, the home of documents in this format |
| AWS Architecture Icons | [aws.amazon.com/architecture/icons](https://aws.amazon.com/architecture/icons/) | The official icon set used for the diagrams in this guide; for extending or rebuilding them |

### Talks and blog posts

| Resource | Link | What it covers |
|----------|------|----------------|
| re:Invent, VPC Lattice architecture patterns and best practices | [VPC Lattice Architecture Patterns Best Practices](https://aws.amazon.com/awstv/watch/77f54e7df76/) | A session-level walkthrough of VPC Lattice patterns; for the broader context behind this pattern |
| AWS re:Invent sessions (general) | Search the [AWS Events YouTube channel](https://www.youtube.com/@AWSEventsChannel) for "VPC Lattice" | Additional and newer re:Invent talks; session IDs and URLs change year to year, so search rather than rely on a fixed link |
| Networking & Content Delivery blog, VPC Lattice | [Amazon VPC Lattice category](https://aws.amazon.com/blogs/networking-and-content-delivery/category/networking-content-delivery/amazon-vpc-lattice/) | The primary, continually updated home for VPC Lattice deep-dives and launch posts |
| Blog, sharing AWS resources with PrivateLink and VPC Lattice | [Securely share AWS resources across VPC and account boundaries](https://aws.amazon.com/blogs/aws/securely-share-aws-resources-across-vpc-and-account-boundaries-with-privatelink-vpc-lattice-eventbridge-and-step-functions/) | The launch of the Resource Gateway / Resource Configuration model this pattern is built on |
| Blog, shared services and resources with VPC Lattice | [Streamline and secure access to shared services and resources](https://aws.amazon.com/blogs/networking-and-content-delivery/streamline-and-secure-access-to-shared-services-and-resources-with-amazon-vpc-lattice/) | Architecture concepts, security best practices, and production considerations for shared access |

### This guide's related sections

| Section | Link | What it covers |
|---------|------|----------------|
| Introduction | [00, Introduction](00-introduction.md) | The problem, the solution shape, scope, and the [decision framework](00-introduction.md#decision-framework-when-to-use-vpc-lattice-as-the-sole-fabric) |
| Architecture | [03, Architecture](03-architecture.md) | The multi-account topology, the three-Service-Network model, and the data-flow diagrams |
| Phase 1: Foundation | [04, Phase 1](04-phase1-foundation.md) | Service Networks, IAM auth policies, and OU-scoped RAM shares |
| Phase 2: Shared Endpoints | [05, Phase 2](05-phase2-shared-endpoints.md) | Resource Gateway and the shared interface-endpoint Resource Configurations |
| Phase 3: Centralized Egress | [06, Phase 3](06-phase3-centralized-egress.md) | The Squid-on-Fargate egress proxy, FQDN filtering, and alternatives |
| Phase 4: Workload Onboarding | [07, Phase 4](07-phase4-workload-onboarding.md) | The single VPC association, `PrivateDnsEnabled`, and onboarding automation |
| Phase 5: Ingress via Service Network Endpoints | [08, Phase 5](08-phase5-ingress-service-network-endpoints.md) | SN-A vs SN-E, the CNAME/Alias rationale, and cross-Region / hybrid DNS automation for ingress |
| Best Practices | [09, Best Practices](09-best-practices.md) | Naming, tagging, monitoring, and quota planning |
| Well-Architected Alignment | [10, Well-Architected](10-well-architected.md) | The six-pillar mapping and the trade-offs of the single-fabric dependency |
| Cost and Operational Comparison | [11, Cost Comparison](11-cost-comparison.md) | Pricing structure and the per-account-versus-per-environment cost story |
| Troubleshooting and FAQ | [12, Troubleshooting & FAQ](12-troubleshooting-faq.md) | Diagnostic commands, common failure modes, and evaluation questions |
| Security Findings Summary | [13, Security Findings](13-security-findings.md) | The threat model, mitigations, and residual risks |

---

You now have the full pattern in hand, the architecture, five phases of validated IaC, the operating disciplines that keep it running at scale, the business case, and the security review, along with the resources to go deeper on any of them. The most valuable next move is the smallest one: stand up the fabric in your Network account and onboard a single pilot OU, prove the end-to-end path, and expand in waves from there. Start with [Phase 1: Foundation](04-phase1-foundation.md), and let the pilot, not a big-bang migration, make the case for the rest of the estate.
