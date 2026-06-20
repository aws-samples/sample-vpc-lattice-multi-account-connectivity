# Best Practices

The five implementation phases, [Phase 1: Foundation](04-phase1-foundation.md), [Phase 2: Shared Endpoints](05-phase2-shared-endpoints.md), [Phase 3: Centralized Egress](06-phase3-centralized-egress.md), [Phase 4: Workload Onboarding](07-phase4-workload-onboarding.md), and [Phase 5: Ingress via Service Network Endpoints](08-phase5-ingress-service-network-endpoints.md), gave you a working pattern: three Service Networks, the shared endpoints and egress proxy behind Resource Gateways, a single VPC association that onboards a workload automatically, and SN-E ingress for consumers beyond the associated VPC. This section is about running that pattern well at scale. It collects the prescriptive recommendations (naming, tagging, monitoring, and quota planning) that keep a VPC Lattice fabric discoverable, attributable, observable, and able to grow from a handful of accounts to hundreds without surprises.

These are recommendations, not new resources. Most of them cost nothing to adopt on day one and a great deal to retrofit later, so apply them before you onboard your first wave of workload accounts rather than after.

> **A note on conventions.** As elsewhere in this guide, examples use the `us-east-2` Region and placeholder identifiers (organization ID `o-EXAMPLE12345`, account `111111111111`). The reference IaC names the three Service Networks `sn-dev-shared` / `sn-test-shared` / `sn-prod-shared` in both IaC paths; the recommendations below show why you should still pick a single org-wide prefix scheme rather than carrying the reference names into a real deployment.

## Naming conventions

Names are the primary handle your teams, your automation, and your auth policies use to find and reason about Lattice resources. Because Phase 4 resolves a Service Network **by name** at deploy time (the workload association looks the network up with `ListServiceNetworks` and matches on `name`), a name is not cosmetic; it is a contract that the onboarding automation depends on. We recommend you fix a naming scheme before Phase 1 and never improvise per-account names afterward.

### Standardize on one org-wide prefix

The two reference implementations in this guide both name service networks `sn-{env}-shared`, but that prefix is illustrative only. **Pick one prefix for your organization and use it everywhere**, across both IaC paths, all three environments, and every resource type. Mixing prefixes in the same org means the Phase 4 `serviceNetworkName` input has to track which prefix matches which network, which is exactly the kind of per-account special case the pattern is designed to eliminate.

Choose a short, lowercase, organization-meaningful prefix (for example `net-`), then keep the rest of the scheme below identical regardless of which prefix you land on.

### Recommended naming patterns

Build every name from the same ordered parts: **prefix → scope/service → environment → role**. The result is a name that sorts predictably, filters cleanly with a wildcard, and tells a reader what the resource is without opening it.

| Resource type | Recommended pattern | Example | Notes |
|---------------|---------------------|---------|-------|
| Service Network | `{prefix}-{env}-shared` | `net-dev-shared` | One per environment; this is the name Phase 4 resolves. Keep it stable, renaming breaks onboarding. |
| RAM share (for a Service Network) | `{prefix}-{env}-shared-ram` *(or)* `vpc-lattice-sn-{env}-share` | `net-dev-shared-ram` | Make the share name trace clearly back to the network it shares. |
| Endpoint Resource Gateway | `{prefix}-endpoint-resource-gw` | `net-endpoint-resource-gw` | One per Endpoint VPC; reference IaC uses `endpoint-resource-gateway` (CDK) / `endpoint-resource-gw` (CloudFormation). |
| Egress Resource Gateway | `{prefix}-egress-resource-gw` | `net-egress-resource-gw` | One per Egress VPC; reference IaC uses `egress-resource-gateway`. |
| Resource Configuration (AWS service endpoint) | `{service}-endpoint-rc` | `ssm-endpoint-rc`, `sts-endpoint-rc` | One per exposed endpoint; the `{service}` token should match the AWS service short name. |
| Resource Configuration (egress proxy) | `{purpose}-proxy-rc` | `squid-proxy-rc` | Names the function, not the implementation detail, so it survives a proxy swap. |
| Service Network ↔ Resource association | derived / tagged | `SquidRCAssoc-dev` | Associations are rarely named directly; rely on tags and the RC/network names instead. |
| VPC association (workload side) | `lattice-vpc-assoc-{serviceNetworkName}` | `lattice-vpc-assoc-net-dev-shared` | The reference stacks already tag the association `Name` this way. |

A few rules make the scheme hold up:

- **Encode the environment, never the account.** `net-dev-shared` is correct; `net-acct111111111111-shared` is not. Environment is the unit of isolation in this pattern, so it belongs in the name; account identity belongs in tags.
- **Use the AWS service short name for endpoint RCs** (`ssm`, `sts`, `ecr-api`, `ecr-dkr`, `logs`, `ecs`, and so on, matching the endpoints exposed in [Phase 2](05-phase2-shared-endpoints.md)) so an RC's purpose is obvious and so automation can map an RC to its service mechanically.
- **Keep names lowercase and hyphen-delimited.** It reads cleanly in the console, in CLI output, and in tag-based queries, and it avoids case-sensitivity surprises.

### Why consistent naming matters

Consistent names pay off in three concrete ways. They make resources **discoverable**, an operator scanning `aws vpc-lattice list-resource-configurations` can tell `ssm-endpoint-rc` from `squid-proxy-rc` at a glance. They make **automation** reliable, the Phase 4 lookup resolves a network by exact name, and StackSets/CDK Pipelines stamp out per-account stacks by passing that name, so an unpredictable name is a broken deployment. And they keep your **auth policies and RAM shares aligned**, when the dev network, its dev RAM share, and its dev OU paths all read `dev`, it is easy to verify by inspection that the three layers agree, and hard to accidentally share the prod network to a dev OU.

## Tagging strategy

Naming tells you *what* a resource is; tagging tells you *who owns it, what it belongs to, and what it costs*. The reference IaC already tags each Service Network with `Environment` (`dev`/`test`/`prod`), that single tag is the seed of a full strategy. We recommend you extend it into a small, mandatory tag set applied uniformly across every Lattice resource, the ECS/Fargate egress stack, and the workload associations, and that you enforce it through your IaC rather than by hand.

### Recommended tags

Keep the mandatory set small enough that every team will actually apply it. The following five tags cover environment identification, ownership, cost attribution, and provenance:

| Tag key | Purpose | Example values | Recommendation |
|---------|---------|----------------|----------------|
| `Environment` | Environment identification and isolation | `dev`, `test`, `prod` | **Mandatory.** Already applied to Service Networks in the reference IaC; apply it to every Lattice resource, the Squid stack, and the workload association. |
| `CostCenter` | Cost allocation to a budget owner | `cc-1234` | **Mandatory.** Drives chargeback/showback in Cost Explorer. |
| `Owner` | Accountable team or distribution list | `network-platform` | **Mandatory.** Who to contact; who owns the resource's lifecycle. |
| `ManagedBy` | Provenance / which IaC owns it | `cdk`, `cloudformation` | **Mandatory.** Signals the resource is IaC-managed and which path to change it through, discourages console drift. |
| `Project` *(or `Pattern`)* | Groups the fabric's resources together | `vpc-lattice-fabric` | **Recommended.** Lets you view the whole connectivity fabric as one logical unit across accounts. |

Apply tags at the construct or template level so they propagate automatically. In CDK, `cdk.Tags.of(scope).add('Environment', 'dev')` tags an entire stack and everything in it; in CloudFormation, set them on each resource's `Tags` property (as the reference templates already do for the Service Networks). Enforce the mandatory set with an AWS Organizations **tag policy** and, optionally, a Service Control Policy or `aws:RequestTag` condition so untagged resources cannot be created.

### Cost allocation and per-environment cost views

Tags do not appear in your billing data until you turn them on. After you adopt the tag set, **activate the keys as cost allocation tags** in the AWS Billing and Cost Management console (Billing → Cost allocation tags → activate `Environment`, `CostCenter`, `Owner`, `Project`). Activation is a one-time, account-level step in the management/payer account, and it is only forward-looking, tags appear in cost data from activation onward, not retroactively, which is another reason to tag from day one.

Once activated, the tags become grouping and filtering dimensions in Cost Explorer and AWS Budgets. The most useful view in this pattern is **cost by `Environment`**: because each Service Network is tagged `dev`/`test`/`prod` and the per-association and per-Resource-Configuration charges flow from those networks, grouping Lattice spend by `Environment` gives you a clean per-environment breakdown of the shared fabric without any per-account math. Layer `CostCenter` on top to attribute that spend to budget owners, and `Project` to see the fabric's total cost, networks, gateways, RCs, the Fargate egress service, and data processing, as a single line. Because the egress proxy is centralized, its ECS/Fargate and data-transfer costs land in the Network account; tagging it with the same keys lets you report it alongside the rest of the fabric rather than losing it in the Network account's bill.

## Monitoring and observability

A centralized fabric is only as operable as it is observable. Because all shared connectivity funnels through the Network account, you get the benefit of monitoring in **one place**, but you must enable that monitoring deliberately, because the most valuable signal (VPC Lattice access logs) is off by default. We recommend enabling access logs at the Service Network level on day one and building a small set of alarms around the components most likely to fail closed: Resource Gateway/RC health, NLB targets, and the Fargate proxy.

### VPC Lattice access logs

VPC Lattice access logs are configured **at the Service Network level** and can be delivered to **Amazon CloudWatch Logs, Amazon S3, or Amazon Data Firehose**. Enable them on all three Service Networks. The reference IaC already does this: the core stack (both the CDK `VpcLatticeCoreStack` and the CloudFormation `vpc-lattice-resource-gateways.yaml`) creates a CloudWatch log group per environment per log type and attaches an `AWS::VpcLattice::AccessLogSubscription` for both the `SERVICE` and `RESOURCE` log types to each network (log groups `/lattice/{env}/service-access-logs` and `/lattice/{env}/resource-access-logs`). They are the authoritative record of what traversed the fabric, which principal invoked which Resource Configuration, when, and with what result, which makes them the primary tool for two jobs in this pattern:

- **Auditing the egress chokepoint.** As noted in [Phase 3](06-phase3-centralized-egress.md), the internal NLB in front of Squid is reachable only through the Resource Gateway, and observability for it is provided by **VPC Lattice access logs at the Service Network level rather than NLB access logs** (the reference stack carries a documented `cdk-nag` suppression, `AwsSolutions-ELB2`, recording exactly this). The Lattice logs are where you see proxy access flowing through the fabric.
- **Auditing endpoint access.** The same logs show which workloads reached `ssm-endpoint-rc`, `sts-endpoint-rc`, and the other shared endpoints, giving you a per-environment access trail without instrumenting each workload.

Send the logs to CloudWatch Logs when you want to alarm and query them with Logs Insights; send them to S3 (optionally via Firehose) when you want cheap long-term retention for compliance. Many teams do both: CloudWatch for the recent operational window, S3 for the archive.

### CloudWatch metrics, Container Insights, and Squid logs

Beyond access logs, four signal sources cover the health of the fabric. Note that the Squid egress cluster already enables Container Insights and ships logs to a known log group, you inherit those for free from [Phase 3](06-phase3-centralized-egress.md).

| Component | What to watch (signal) | Where it lives |
|-----------|------------------------|----------------|
| Service Networks / Resource Configurations | Request counts, error/rejection rates, and *who accessed what* | VPC Lattice access logs (per Service Network) + the `AWS/VpcLattice` CloudWatch metrics namespace |
| Resource Gateway health | Gateway/RC reachability and state (`ACTIVE`); ENI scaling headroom in the subnet | VPC Lattice console + `describe`/`list` API state; subnet free-IP metrics |
| Egress Squid service (ECS/Fargate) | Running vs. desired task count, task CPU/memory, restarts | **Container Insights** (already enabled on `squid-egress-cluster`) → CloudWatch |
| Internal NLB (egress) | Target health, **unhealthy host count**, active flows | `AWS/NetworkELB` CloudWatch metrics + target group health |
| Squid proxy logs | Allowed vs. denied requests, FQDN allowlist hits/misses, errors | CloudWatch Logs group `/ecs/squid-egress-proxy` (1-month retention in the reference) |

### Recommended alarms

Alarm on the conditions that silently break connectivity for many accounts at once. At minimum, we recommend:

- **Resource Gateway / Resource Configuration not `ACTIVE`**, if a gateway or RC leaves the active state, every workload depending on it loses the affected endpoint or the proxy. Treat this as high severity.
- **NLB unhealthy host count > 0** (or healthy host count `< desiredCount`) on the egress target group, the leading indicator that the proxy is degrading before workloads see timeouts.
- **Fargate running task count `< desiredCount`** on `squid-egress-cluster`, catches tasks that fail to start or crash-loop (often a Squid config or image problem; inspect `/ecs/squid-egress-proxy`).
- **Spike in Squid denied requests**, either a misconfigured workload or a genuine attempt to reach a non-allowlisted domain; both are worth knowing about.
- **Lattice access-log rejection/4xx rate**, a rise in auth-policy denials usually means an OU/scoping mismatch (see the IAM auth-policy troubleshooting in the FAQ section).

Route these to the Network account's operations channel. Because the fabric is centralized, a single set of alarms in one account covers connectivity for the whole organization.

## Scaling considerations and quota management

The pattern is designed to scale by *repetition of one small action*, one VPC association per account, rather than by adding infrastructure per account. That makes scaling mostly a matter of (a) automating that one action and (b) staying ahead of the service quotas that bound how many associations, Resource Configurations, and networks a Region can hold. This subsection covers both, and the subnet and proxy sizing that scale underneath them.

### Onboarding at scale: automate the single association

The mechanics are covered in [Phase 4: Workload Onboarding](07-phase4-workload-onboarding.md); the best-practice summary is: **do not onboard accounts by hand.** Use one of the two automation approaches the pattern supports, both of which deploy the same workload association and rely on RAM auto-accept:

- **CloudFormation StackSets, service-managed, with auto-deployment enabled.** Target the OUs that make up an environment and pass that environment's `ServiceNetworkName`. New accounts vended into a target OU are onboarded **automatically**, with no manual step, the StackSet stamps out the association the moment the account joins the OU.
- **CDK Pipelines (or `cdk-stacksets`).** Instantiate `WorkloadAssociationStack` per target account from a pipeline, mapping each account to the correct `serviceNetworkName` for its environment.

In both cases the per-account configuration is just the environment-to-Service-Network-name mapping; the VPC ID and network ID are resolved at deploy time. This is what lets the fabric grow to 50, 150, 500, or more accounts without per-account networking work. Pair it with the RAM org-sharing prerequisite from [Phase 1](04-phase1-foundation.md) so shares auto-accept and the association can be created immediately.

### VPC Lattice service quotas to plan against

VPC Lattice enforces per-Region quotas that, in a large multi-account deployment, you can approach as you onboard accounts and expose endpoints. The table below lists the quotas most relevant to this pattern.

> **These are representative default quotas, not guarantees.** VPC Lattice quota values change over time and can differ by Region and account. **Verify the current values for your account in the Service Quotas console** (choose **AWS services → VPC Lattice**) and in the [Quotas for Amazon VPC Lattice](https://docs.aws.amazon.com/vpc-lattice/latest/ug/quotas.html) documentation before you size a large rollout. Use the numbers here for planning, not as fixed limits.

| Quota | Representative default (per Region) | Adjustable? | How to increase |
|-------|-------------------------------------|-------------|-----------------|
| Service networks per Region | 50 | Yes (soft) | Service Quotas console → VPC Lattice → request increase |
| VPC associations per service network | 500 | Yes (soft) | Service Quotas console → request increase; for large capacity also contact AWS Support |
| Resource Configurations per service network | 500 | Yes (soft) | Service Quotas console → request increase |
| Resource configurations per Region (account-wide) | 2,000 | Yes (soft) | Service Quotas console → request increase |
| Resource gateways per VPC | 500 | Yes (soft) | Service Quotas console → request increase |
| Service associations per service network | 500 | Yes (soft) | Service Quotas console → request increase |
| Services per Region | 2,000 | Yes (soft) | Service Quotas console → request increase |
| Auth policy size | 10 KB | **No** (hard) | Not adjustable, keep auth policies compact (see note below) |
| Security groups per VPC↔Service Network association | 5 | **No** (hard) | Not adjustable, design within the limit |

How these map to this pattern, and where to watch:

- **VPC associations per service network (≈500)** is the quota you are most likely to meet first, because onboarding adds one association per account *to a single environment's network*. With three environment networks, you have headroom for roughly 500 accounts **per environment** at the default, but if one environment's account count trends toward the limit, request an increase well ahead of time, since onboarding automation will otherwise start failing for that environment only.
- **Service networks per Region (≈50)** comfortably accommodates the three networks this pattern uses (dev/test/prod). You would approach it only if you fragment environments into many more networks, a reason to prefer OU-path scoping within three networks over proliferating networks.
- **Resource Configurations per service network (≈500)** bounds how many endpoints with the egress proxy you expose on one network. The reference exposes ~10-11 endpoints + `squid-proxy-rc`, far under the limit, but track it if you add many more shared endpoints.
- **Auth policy size (10 KB, not adjustable)** is the one hard limit to design around directly: it caps how many OU paths you can list in a Service Network's IAM auth policy. Keep policies compact, prefer broad OU-path prefixes with the `/*` suffix (as in [Phase 1](04-phase1-foundation.md)) over enumerating many narrow paths, so you never bump the ceiling.

Most VPC Lattice quotas are **soft (adjustable)**: raise them through the **Service Quotas console** (open the quota and choose *Request increase at account level*), or through **AWS Support** for large capacity increases that the console flags as requiring it. A small number, auth policy size and security groups per association above, are **hard limits** you must design within. Request soft-quota increases *proactively*, before a rollout reaches the limit, because increases are not always granted instantly and a denied association fails the onboarding stack for that account.

### Subnet sizing for Resource Gateway ENI scaling

Resource Gateways scale by adding elastic network interfaces (ENIs) in their subnets as connection volume grows, so the subnets must have IP headroom to scale into. As established in [Prerequisites](02-prerequisites.md#3-subnet-sizing-requirements), **provision every Resource Gateway subnet at /24 or larger.** Undersized subnets risk IP exhaustion as the gateway scales (or as other resources share the subnet), which surfaces as deployment failures and intermittent, hard-to-diagnose connectivity. This applies to both the endpoint Resource Gateway and the egress Resource Gateway, and it is a sizing decision you make once, up front, re-subnetting a live VPC later is disruptive.

### Scaling the Squid egress proxy

The centralized proxy is the one shared component that carries real data-plane load for every account's internet egress, so size it for aggregate demand rather than per-account. The Fargate service runs `desiredCount` tasks (default `2`, for two-AZ availability) with configurable `cpu`/`memory` (default `512`/`1024`). To scale it:

- **Raise `desiredCount`** as aggregate egress throughput grows, keeping at least two tasks across two AZs for availability. Drive this from the Container Insights CPU/memory signals and the NLB active-flow count.
- **Consider an Application Auto Scaling target-tracking policy** on the ECS service (for example, on average CPU) so the proxy fleet grows and shrinks with demand instead of being pinned to a static count.
- **Right-size `cpu`/`memory`** from observed task utilization rather than guessing, the proxy is lightweight, but a fleet serving hundreds of accounts may warrant larger tasks.

Because the proxy is exposed through a single Resource Configuration on an internal NLB, scaling the task count is transparent to workloads: the NLB load-balances across whatever healthy tasks exist, and no workload configuration changes when you add capacity.

---

With naming, tagging, monitoring, and quota planning in place, the fabric is ready to run as a managed, organization-wide service. The next section maps these practices and the architecture as a whole to the AWS Well-Architected Framework, so you can carry the pattern into a formal review.

Continue to [Well-Architected Framework Alignment](10-well-architected.md).
