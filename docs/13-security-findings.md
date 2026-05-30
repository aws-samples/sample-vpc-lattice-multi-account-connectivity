# Security Findings Summary

The [Troubleshooting and FAQ](12-troubleshooting-faq.md) section closed the operational picture of the pattern: how to diagnose the handful of failure modes that surface during deployment and onboarding. This section consolidates the **security review** performed against the Infrastructure as Code (IaC). It is the capstone of that review: it lists every threat identified during threat modeling, maps each one to the mitigation implemented in the IaC, cross-references the automated `cdk-nag` findings and their resolutions, and records the residual risks that are accepted or pending with the justification for each. The goal is a single, auditable place where a security architect can see what was examined, what was fixed, what was suppressed and why, and what remains open.

The review was deliberately multi-layered, because no single technique catches everything. A structured **STRIDE threat model** finds design-level risks an automated scanner cannot reason about; **`cdk-nag` at synthesis** catches resource-level misconfiguration the moment a stack is built; a manual **IAM least-privilege review** confirms that policies enumerate only the actions and resources they need; a **security group review** confirms no port is open to the world; and a **secrets scan** confirms nothing sensitive was committed alongside the guide. Each layer is summarized below, and each maps to a requirement in the security-review acceptance criteria.

> **A note on conventions.** As elsewhere in this guide, examples use the `us-east-2` Region and placeholder identifiers (organization ID `o-EXAMPLE12345`, account `111111111111`). The reference IaC deploys **three Service Networks**, one each for dev, stage, and prod, named `sn-{env}-shared` in both the AWS Cloud Development Kit (CDK) and AWS CloudFormation paths. No customer-identifying information is implied; substitute your own values. The threat model summarized here uses these same placeholders.

## Review methodology

The security review comprised five activities, performed in this order:

1. **Threat modeling (STRIDE).** A formal threat model was built against all CloudFormation templates and CDK stacks using the threat-modeling tooling, enumerating threats across all six STRIDE categories (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege), with at least one documented mitigation per threat.
2. **Threat Composer export.** The completed model was exported in AWS Threat Composer JSON format (see [The threat model](#the-threat-model)).
3. **IAM least-privilege review.** Every IAM policy in the IaC was inspected for wildcard actions and overly broad resource scopes (see [IAM least-privilege review](#iam-least-privilege-review)).
4. **Security group review.** Every security group authored or referenced by the IaC was checked for unrestricted ingress and for explicit, minimal ports (see [Security group review](#security-group-review)).
5. **Secrets scan.** All IaC files, Lambda source, and documentation were scanned for hardcoded credentials, keys, tokens, and real account or resource identifiers (see [Secrets scan](#secrets-scan)).

Running underneath all of this, the CDK application has the `cdk-nag` `AwsSolutionsChecks` aspect enabled at synthesis (`cdk.Aspects.of(app).add(new AwsSolutionsChecks(...))` in `cdk/bin/app.ts`), so every `cdk synth` and `cdk deploy` re-evaluates the stacks against the AWS Solutions rule pack and fails on any unaddressed finding. The findings it raised were either remediated in the resource definitions or suppressed with a written justification; those suppressions are catalogued in [cdk-nag findings and resolutions](#cdk-nag-findings-and-resolutions).

## The threat model

The threat model treats the shared connectivity fabric as a single system whose compromise could affect every connected workload account, and it focuses on **customer-controlled** risks (misconfiguration, isolation evasion, egress bypass, supply chain, least privilege) rather than AWS service-internal compromise, which is out of scope per the shared-responsibility assumption (see [Assumptions](#assumptions-that-scope-the-threat-model)).

The model was authored in **AWS Threat Composer**, an open-source tool available as a [hosted static site and a browser extension](https://github.com/awslabs/threat-composer). To reproduce or extend it, build an equivalent STRIDE model in Threat Composer against the IaC in this repository: enumerate the threats across the six STRIDE categories, link a mitigation to each, and record the scoping assumptions. The full set of threats, mitigations, and assumptions is reproduced in the tables below, so this section stands on its own.

The model contains **15 threats (T1 to T15)**, **13 mitigations (M1 to M13)**, and **5 assumptions (A001 to A005)**. Every threat has at least one linked mitigation; this was verified during the review so that no threat is left without a documented mitigation.

### Threats and applied mitigations

The table below lists all 15 threats with their STRIDE category, a one-line summary, a qualitative severity, the mitigation(s) applied, and the implementation status of those mitigations. Severity is a qualitative assessment derived from impact and blast radius, the model records threat-actor priorities and per-asset risk levels rather than per-threat CVSS scores, so the severity column reflects the review's judgement of business impact, not a calculated score. Mitigation IDs link to the [mitigation detail](#mitigation-detail-and-status) below.

| ID | STRIDE | Threat (summary) | Severity | Mitigation(s) | Status |
|----|--------|------------------|----------|---------------|--------|
| T1 | Elevation of Privilege | Workload insider in one OU invokes another environment's Service Network, crossing dev/stage/prod isolation | High | M1, M2, M7 | Resolved |
| T2 | Elevation of Privilege | In-org principal outside the authorized OU paths invokes a Service Network relying on org membership alone | High | M1, M2 | Resolved |
| T3 | Information Disclosure | Compromised workload exfiltrates data to a domain not on the Squid FQDN allowlist (C2/exfil) | High | M3, M10 | Resolved |
| T4 | Information Disclosure | Insider or compromised workload bypasses the Squid proxy to reach the internet without FQDN filtering | High | M4, M13 | In Progress |
| T5 | Spoofing | Conflicting Route 53 Private Hosted Zone spoofs AWS service DNS to redirect API calls and capture credentials | High | M5 | Resolved |
| T6 | Tampering | Compromised Network-account operator weakens an auth policy or broadens a RAM share (high blast radius) | Critical | M6, M10 | In Progress |
| T7 | Tampering | Negligent operator sets an overly broad `PrincipalOrgPaths` wildcard, granting more accounts than intended | Medium-High | M1, M6 | Resolved / In Progress |
| T8 | Tampering | Actor enables `AllowExternalPrincipals` or adds out-of-org principals to a Service Network RAM share | High | M6, M7 | In Progress / Resolved |
| T9 | Spoofing | Rogue Interface VPC endpoint planted in the Endpoint VPC causes the lookup Lambda to map a service domain to an attacker endpoint | High | M9 | In Progress |
| T10 | Tampering | Supply-chain attacker publishes a malicious/vulnerable Squid image pulled via the unpinned `ubuntu/squid:latest` tag | High | M8 | Identified (open) |
| T11 | Information Disclosure | Network attacker on the egress data path intercepts proxied traffic in transit | Medium | M4, M13 | In Progress |
| T12 | Repudiation | Insider performs unauthorized invocations and denies them due to insufficient access logging | Medium | M10 | Resolved |
| T13 | Denial of Service | High-volume actor floods the shared Resource Gateway, NLB, or Squid Fargate service, affecting all tenants | Medium-High | M12 | In Progress |
| T14 | Information Disclosure | Compromised VPCE DNS Lookup Lambda role (`ec2:DescribeVpcEndpoints` on `*`) enumerates endpoint inventory for recon | Low-Medium | M11 | Resolved |
| T15 | Information Disclosure | Compromised Workload Lookup Lambda role reads LZA SSM parameters to enumerate VPC/subnet/SG identifiers | Low-Medium | M11 | Resolved |

STRIDE coverage spans all six categories: Spoofing (T5, T9), Tampering (T6, T7, T8, T10), Repudiation (T12), Information Disclosure (T3, T4, T11, T14, T15), Denial of Service (T13), and Elevation of Privilege (T1, T2).

### Mitigation detail and status

The 13 mitigations and the threats they address are listed below, grouped by implementation status. **Resolved** means the control is implemented in the IaC as reviewed; **In Progress** means the control is partially implemented or depends on a control that lives outside these stacks (and is therefore also captured under [Residual risks](#residual-risks)); **Identified** means the control is recommended but not yet implemented.

#### Resolved

- **M1**, Per-environment Service Networks with `AWS_IAM` auth policies that restrict invocation by `aws:PrincipalOrgPaths` to the specific dev/stage/prod OU paths, enforcing cross-environment isolation. *Addresses T1, T2, T7.*
- **M2**, Auth policies require **both** `aws:PrincipalOrgID` equality **and** an OU-path match, so org membership alone is insufficient and out-of-scope OUs are denied. *Addresses T1, T2.*
- **M3**, Centralized Squid forward proxy enforces an FQDN allowlist (`ALLOWED_DOMAINS`), default-deny for non-allowlisted destinations, as the only sanctioned egress path. *Addresses T3.*
- **M5**, `PrivateDnsEnabled` on the VPC association lets Lattice manage Private Hosted Zones for service domains; the guide documents PHZ precedence and prohibits conflicting Route 53 PHZs in workload VPCs. *Addresses T5.*
- **M7**, RAM shares set `AllowExternalPrincipals=false` and target explicit OU ARNs only, preventing sharing outside the AWS Organization. *Addresses T1, T8.*
- **M11**, Least-privilege IAM on custom-resource Lambdas: scoped actions, documented wildcard justifications, and short timeouts limit the recon value of a compromised role. *Addresses T14, T15.*
- **M10**, VPC Lattice access logs are enabled at the Service Network level by the core IaC: both the CDK `VpcLatticeCoreStack` and the CloudFormation `vpc-lattice-resource-gateways.yaml` create a CloudWatch log group per environment per log type and attach an `AWS::VpcLattice::AccessLogSubscription` for the `SERVICE` and `RESOURCE` log types to each of the three Service Networks (`/lattice/{env}/service-access-logs` and `/lattice/{env}/resource-access-logs`); Container Insights on the Squid cluster adds proxy-side visibility. This provides the authoritative audit trail for invocations and non-repudiation. *Addresses T3, T6, T12.*

#### In Progress

- **M4**, Centralized egress architecture: workload VPCs have no direct IGW/NAT path, so internet-bound traffic must traverse the Lattice-exposed proxy. Enforced via workload-account route tables and service control policies (SCPs) denying IGW/NAT creation, controls that live **outside** these stacks. *Addresses T4, T11.*
- **M6**, Least-privilege separation of duties: only Network-account operators/pipeline can change central Lattice/RAM config; protect with strong IAM, multi-factor authentication (MFA), change control, and `cdk-nag` review. *Addresses T6, T7, T8.*
- **M9**, Restrict who can create Interface VPC endpoints in the Endpoint VPC and validate discovered DNS entries; the lookup filters to Interface endpoints in the specific VPC only. *Addresses T9.*
- **M12**, Multi-AZ Resource Gateways, cross-zone NLB, and Fargate auto-recovery provide resilience; service quotas, autoscaling, and per-tenant limits contain denial-of-service on the shared fabric. *Addresses T13.*
- **M13**, Explicit security groups (no `0.0.0.0/0`) on Resource Gateways, Squid tasks, and the NLB; only required ports (443 to endpoints, 3128 to Squid) permitted, sourced from SSM-managed SGs. *Addresses T4, T11.*

#### Identified (not yet implemented)

- **M8**, Pin the Squid container image to an immutable digest from a trusted/private Amazon ECR repository with image scanning, instead of the mutable `ubuntu/squid:latest` tag. *Addresses T10.* This is the open item tracked in [Residual risks](#residual-risks).

## cdk-nag findings and resolutions

The CDK application runs the `cdk-nag` `AwsSolutionsChecks` aspect at synthesis, so the AWS Solutions rule pack is evaluated on every build. Findings were resolved either by **changing the resource definition** (the preferred path, for example, attaching explicit security groups, disabling public IPs, and scoping IAM actions) or, where a finding reflects a deliberate and justified design choice, by a **scoped suppression carrying a written rationale**. No finding was left unaddressed. The suppressions below are the complete set in the IaC; each is applied narrowly to a specific resource path (not stack-wide) and each names the rule and the reason.

| Rule | Resource (CDK path) | Resolution / suppression rationale |
|------|---------------------|------------------------------------|
| `AwsSolutions-IAM5` | `VpceDnsLookup` role default policy (endpoints stack) | `ec2:DescribeVpcEndpoints` does not support resource-level permissions; `Resource: *` is required per AWS IAM documentation. Relates to **T14**. |
| `AwsSolutions-IAM5` | `LookupRole` policy (workload-association stack) | `vpc-lattice:ListServiceNetworks` does not support resource-level permissions; `Resource: *` is required per AWS IAM documentation. Relates to **T15**. |
| `AwsSolutions-IAM5` | `SquidTaskDef` task-role default policy (egress stack) | ECS Exec (`enableExecuteCommand`) requires `ssmmessages:*` with a wildcard resource per AWS documentation; scoped to the task role only. |
| `AwsSolutions-IAM5` | `LookupProvider` framework `onEvent` role default policy (workload-association stack) | The CDK Provider framework requires `lambda:InvokeFunction` with a `:*` suffix to invoke function versions/aliases; pinned to the single lookup function ARN. |
| `AwsSolutions-IAM4` | `VpceDnsLookup` service role; `AwsCustomResource` framework role (endpoints stack); `LookupRole` and `LookupProvider` framework role (workload-association stack) | `AWSLambdaBasicExecutionRole` is the appropriate managed policy for custom-resource Lambdas that only need CloudWatch Logs write access. |
| `AwsSolutions-L1` | `AwsCustomResource` framework Lambda (endpoints stack); `LookupProvider` framework Lambda (workload-association stack) | The framework Lambda runtime is managed by CDK and updated with CDK releases; it cannot be overridden directly. |
| `AwsSolutions-ECS2` | `SquidTaskDef` (egress stack) | `ALLOWED_DOMAINS` is a non-sensitive configuration value (a public FQDN allowlist); it contains no secrets or credentials, so Secrets Manager / SSM SecureString is not warranted. |
| `AwsSolutions-ELB2` | `SquidNlb` (egress stack) | The NLB is internal and reachable only via the VPC Lattice Resource Gateway; observability is provided by VPC Lattice access logs at the Service Network level rather than S3 access logs (M10). |

The `VpcLatticeCoreStack` carries **no** suppressions, its Service Networks, RAM shares, and (CloudFormation-path) auth policies synthesized cleanly against the rule pack. The two `IAM5` suppressions on `DescribeVpcEndpoints` and `ListServiceNetworks` are the same three justified `Resource: '*'` uses examined in the [IAM least-privilege review](#iam-least-privilege-review) below; the cross-reference is intentional, so the threat model (T14, T15), the IAM review, and the `cdk-nag` suppression all point at the same three places.

## IAM least-privilege review

**Result: pass.** Every IAM policy in the IaC enumerates explicit actions; there are no wildcard actions (`*` or `service:*`) anywhere.

- **No wildcard actions.** No policy grants `*` or a service-level `service:*` action.
- **Three justified `Resource: '*'` uses**, each on an action that AWS does not allow to be resource-scoped, and each carrying the `AwsSolutions-IAM5` suppression noted above:
  1. `ec2:DescribeVpcEndpoints` on the VPCE DNS Lookup Lambda, `Describe*` has no resource-level support (relates to **T14**).
  2. `vpc-lattice:ListServiceNetworks` on the Workload Lookup Lambda, `List*` has no resource-level support (relates to **T15**).
  3. `ssmmessages:*` channel actions plus `logs:DescribeLogGroups` on the Squid ECS task role, required by ECS Exec per AWS documentation.
- **Narrow scopes where AWS supports them.** `ssm:GetParameter` is pinned to a single parameter ARN; `lambda:InvokeFunction` is pinned to a single function ARN; the Squid execution-role logging permission is pinned to a single log-group ARN.
- **Managed-policy usage is minimal and appropriate.** Only `AWSLambdaBasicExecutionRole` is attached, and only to custom-resource Lambdas that need CloudWatch Logs write access (the `AwsSolutions-IAM4` suppressions above).
- **Service Network auth policies are resource-based, not least-privilege findings.** The VPC Lattice Service Network auth policies use `Principal: '*'` and `Resource: '*'`, but they are **resource-based authorization policies** constrained by `Condition` (`aws:PrincipalOrgID` plus `aws:PrincipalOrgPaths`). This is the prescribed isolation pattern described in [Phase 1](04-phase1-foundation.md) and [Security and Access Control](06-phase3-centralized-egress.md), the broad principal is intentional because the `Condition` is what scopes access to the right OUs (M1, M2). It is not an over-permissive identity policy.

## Security group review

**Result: pass.** No security group in the IaC permits unrestricted **ingress**, and every port declared is explicit and minimal. The two IaC paths differ in *where* their security groups come from, so both are covered below.

- **CDK path imports SGs from the Landing Zone Accelerator (LZA).** The CDK stacks author **zero** security groups inline, there are no `addIngressRule` calls and no `0.0.0.0/0`/`::/0` rules. Every SG attached to an ENI-creating resource (the Endpoint Resource Gateway, the Egress Resource Gateway, and the Squid Fargate tasks) is **imported by ID from LZA-managed SSM parameters** (for example `endpoint-rg-sg` and the egress SG); their rules live in LZA, not in this repository (assumption A004, residual risk 3).
- **The CloudFormation egress template authors its SGs inline, reviewed and sound.** `cloudformation/squid-egress-proxy.yaml` is self-contained and defines two security groups directly. Their **ingress is tightly scoped**: TCP 3128 only, sourced from the **VPC Lattice managed prefix list** and the **Egress VPC CIDR** (for NLB health checks), there is **no `0.0.0.0/0` ingress on any port**. Their **egress** intentionally permits TCP 443/80 to `0.0.0.0/0`: a forward proxy must be able to reach arbitrary internet destinations, and destination control is enforced by the **Squid FQDN allowlist**, not by the security group. This is a deliberate, documented design choice (the same rationale as the egress architecture in [Phase 3](06-phase3-centralized-egress.md)), not an open-ingress finding. The other CloudFormation templates (`vpc-lattice-resource-gateways.yaml`, `vpc-lattice-workload-vpc-association.yaml`) author no security groups.
- **Ports are explicit and minimal across both paths.** Every port declared is stated explicitly: **TCP 443** for the endpoint Resource Configurations and **TCP 3128** for the Squid Resource Configuration, NLB listener, and target group. The egress NLB is internal (`internetFacing: false` / `Scheme: internal`) with no public IP, so it is reachable only via the Resource Gateway.
- **Outbound internet is via the NAT path after filtering.** Squid reaches the internet through the NAT Gateway only after the FQDN allowlist is applied; the `0.0.0.0/0` egress on the proxy SG is the mechanism that lets allowlisted traffic leave, gated upstream by Squid.

**External control to confirm (assumption A004).** On the **CDK path**, because the attached SGs are imported, their rules cannot be validated from this repository, operators must confirm in LZA that the imported security groups restrict ingress as intended: the `endpoint-rg-sg` to **TCP 443**, and the Squid/egress SG to **TCP 3128**, each sourced from the Resource Gateway / Lattice CIDR ranges, with **no `0.0.0.0/0` ingress**. On the **CloudFormation path**, the equivalent rules are defined in `squid-egress-proxy.yaml` itself and were reviewed here. This is captured as a residual risk below and as assumption A004 in the threat model.

## Secrets scan

**Result: pass (one finding, remediated).** All IaC files, Lambda source, and documentation deliverables were scanned for hardcoded secrets and real identifiers.

- **Method.** Dedicated secret scanners (`git-secrets`, `trufflehog`, `gitleaks`, `detect-secrets`) were not installed in the review environment, so the scan used **regular-expression pattern matching** for the common secret and identifier formats. This is stated honestly so the method can be reproduced or strengthened: running one of the dedicated scanners in CI is a recommended follow-up.
- **Clean for credentials and real identifiers.** No AWS access keys (`AKIA`/`ASIA` prefixes), no secret access keys, no passwords, tokens, or API keys, no private keys, and no credentials embedded in connection strings. No real VPC, subnet, security group, or VPC endpoint resource IDs appear in the deliverables.
- **One finding, now remediated.** `docs/09-best-practices.md` contained a **real 12-digit AWS account ID** in an example string. It was replaced with the placeholder `111111111111`, consistent with the rest of the guide, and a re-scan confirmed the deliverables are clean of real account IDs. (The real value is deliberately not reproduced here, so this summary does not re-introduce the finding.)
- **Known, accepted exception (not a deliverable).** Real account IDs appeared only in local project tooling (deploy CLI `--profile` flags in the spec task list), which is not part of this repository's deliverables and is excluded from it. It is therefore out of scope for the deliverable scan.

## Residual risks

Per the security-review requirement to document any finding without a fully implemented mitigation, the following risks are **accepted or pending**. Each entry states the risk, why it is accepted or still open, and the recommended remediation and owner. These correspond to the **In Progress** and **Identified** mitigations above and to the threat model's assumptions.

### 1. Unpinned Squid container image (T10 / M8, open)

- **Risk.** `cdk/lib/squid-egress-stack.ts` pulls `ubuntu/squid:latest`, a **mutable, unpinned** public image. A supply-chain attacker who controls the upstream registry or tag could publish a malicious or vulnerable image that the Fargate task pulls at deploy or scale-out time, compromising the central egress proxy and, through it, the egress of every connected workload.
- **Why it is open.** The reference prioritizes a runnable example; pinning requires standing up a private ECR repository and a build/push pipeline, which is environment-specific.
- **Recommended remediation.** Pin the image to an **immutable digest** (`@sha256:...`) in a private Amazon ECR repository with image scanning enabled, and pull it privately through the shared ECR endpoints from [Phase 2](05-phase2-shared-endpoints.md). **Owner:** the platform/Network-account team, before production use.

### 2. Egress-bypass prevention depends on external SCPs and route tables (T4 / M4, pending)

- **Risk.** The FQDN allowlist only constrains traffic that actually goes **through** the Squid proxy. If a workload account can create its own Internet Gateway or NAT Gateway, or set its own `HTTP_PROXY`, it can bypass the proxy entirely and exfiltrate data without FQDN filtering.
- **Why it is pending.** The controls that prevent this, workload-account **route tables** with no direct internet path and **SCPs denying IGW/NAT creation**, live in the AWS Organization and Landing Zone Accelerator, **outside** these stacks, so they cannot be enforced or validated from this repository.
- **Recommended remediation.** Enforce, in the organization, route tables that provide no direct internet path for workload VPCs and SCPs that deny IGW/NAT creation in workload OUs, so the Lattice-exposed proxy is the only egress. See [Phase 3: Centralized Egress](06-phase3-centralized-egress.md). **Owner:** the cloud platform / governance team.

### 3. Imported LZA security group rules are an external dependency (A004, external)

- **Risk.** The security groups attached to the Resource Gateways and Squid tasks are imported from LZA by ID. If those LZA-managed rules are authored too broadly (for example, an over-wide source CIDR or an unintended `0.0.0.0/0` ingress), the network controls this pattern relies on would be weaker than intended, and this repository cannot detect it.
- **Why it is accepted.** Importing SGs from LZA is the correct division of responsibility for an LZA-based landing zone, the network team owns SG rules centrally. The trade-off is that SG correctness becomes an external assumption (A004).
- **Recommended remediation.** Confirm in LZA that `endpoint-rg-sg` permits only TCP 443 and the Squid/egress SG only TCP 3128, sourced from the Resource Gateway / Lattice CIDRs with no `0.0.0.0/0` ingress, and periodically audit those rules. **Owner:** the network / LZA team.

### 4. Lambda runtime-version drift (IaC consistency item)

- **Risk.** The inline Lambda in the endpoints stack references the `PYTHON_3_14` runtime enum, while the CloudFormation template uses `python3.12` and the design specifies **Python 3.12**. The inconsistency is a maintainability and supportability concern rather than an exploitable vulnerability, but divergent runtimes across the two IaC paths can produce subtly different behavior and complicate support.
- **Why it is open.** It is a small consistency defect not caught until this review.
- **Recommended remediation.** Align the inline CDK function to **Python 3.12** to match the documented standard and the CloudFormation path (see the [runtime FAQ](12-troubleshooting-faq.md#what-runtime-do-the-lambda-custom-resources-use)). **Owner:** the IaC maintainer, as a routine fix.

## Assumptions that scope the threat model

The threat model is bounded by five assumptions. They are not findings; they are the preconditions under which the threats and mitigations above hold. Stating them keeps the analysis honest about what is in scope and what is delegated to the surrounding environment.

| ID | Area | Assumption |
|----|------|------------|
| A001 | Foundation | AWS Organizations, the OU structure, and the Landing Zone Accelerator are correctly configured, and the LZA-managed SSM parameters under `/accelerator/*` contain accurate, trustworthy VPC/subnet/SG IDs. |
| A002 | AWS services | AWS-managed control-plane services (VPC Lattice, RAM, Organizations, IAM, ECS, NLB) operate correctly and enforce their documented semantics, including `PrincipalOrgID`/`PrincipalOrgPaths` evaluation and RAM `AllowExternalPrincipals=false`. Threats focus on customer misconfiguration, not AWS service-internal compromise (the shared-responsibility boundary). |
| A003 | Egress | The Squid image and its configuration enforce the `ALLOWED_DOMAINS` allowlist for both HTTP and HTTPS (CONNECT) traffic and deny by default. Image provenance is tracked separately as T10. |
| A004 | Network | The security groups referenced from SSM permit only the required ports (443 to endpoints, 3128 to Squid/NLB) with restricted CIDR sources and no `0.0.0.0/0` ingress. Validated externally because the SGs are imported from LZA (residual risk 3 above). |
| A005 | Authorization | Workload accounts cannot modify the Network account's Lattice resources, auth policies, RAM shares, or Squid configuration; they can only associate their own VPC to a RAM-shared Service Network, enforced by cross-account IAM and SCPs. |

---

With the threat model exported, every threat mapped to a mitigation, the `cdk-nag` suppressions justified, the IAM, security group, and secrets reviews passed, and the residual risks recorded with owners, the security review is complete and auditable. The next section turns from analysis to action, the concrete steps to take the pattern from a read to a running pilot, the enhancements that extend it, and the reference material to reach for along the way.

Continue to [Next Steps and Resources](14-next-steps.md).
