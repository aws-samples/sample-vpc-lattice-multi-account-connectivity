# Troubleshooting and FAQ

The [Cost and Operational Comparison](11-cost-comparison.md) section closed the business case: connectivity becomes a per-environment platform cost that stays roughly flat as the estate grows, and onboarding collapses to a single VPC association. This section is the operational counterpart to that promise. When a deployment or an onboarding does not behave as expected, the symptoms tend to fall into a small number of well-understood categories, a RAM share that has not reached an account, a Service Network looked up by the wrong name, an existing Route 53 zone that shadows the Lattice-managed one, a Resource Gateway that cannot scale its network interfaces, an auth policy that denies a legitimate caller, or an egress proxy whose targets never go healthy. This section catalogs those scenarios with a consistent structure and gives the exact diagnostic command or console path to confirm each one, followed by the frequently asked questions that come up when teams evaluate the pattern against an existing Transit Gateway estate.

Each troubleshooting scenario follows the same shape so it is quick to scan under pressure: **Symptom** (what you observe), **Likely cause(s)** (what usually produces it), **Diagnosis** (the command or console navigation that confirms the cause), and **Resolution** (the steps that fix it). The diagnostic commands are real AWS CLI commands you can run as-is, substituting the placeholder identifiers for your own.

> **A note on conventions.** As elsewhere in this guide, examples use the `us-east-2` Region and placeholder identifiers (organization ID `o-EXAMPLE12345`, account `111111111111`). The reference IaC deploys **three Service Networks**, one each for dev, test, and prod, named `sn-{env}-shared` in both the AWS Cloud Development Kit (CDK) and AWS CloudFormation paths. This section refers to them generically (for example, "the dev service network"), but remember that the name you pass into the workload association **must match the actual Service Network name** created in [Phase 1: Foundation](04-phase1-foundation.md). No customer-identifying information is implied; substitute your own values.

## Troubleshooting

The scenarios below are ordered roughly by where they surface in the deployment sequence: the workload VPC association first (because it is the step run most often and by the most people), then DNS, then the shared components in the Network account, then access control, then egress.

### Failed VPC association, "Service network not found"

**Symptom.** A workload association deployment ([Phase 4](07-phase4-workload-onboarding.md)) fails to create the `ServiceNetworkVpcAssociation`. The most common reason is that the RAM-shared service network ID passed to the stack is not valid or visible in the target account, because the share has not reached the account's OU.

**Likely cause(s).** In order of frequency:

1. **The RAM share has not reached this account's organizational unit (OU).** The service network ID passed to the association is only valid in accounts that have received (and auto-accepted) the RAM share; until then, the association cannot attach to it. This is by far the most common cause.
2. **Organization-wide RAM sharing was never enabled.** If `aws ram enable-sharing-with-aws-organization` was not run once in the management account, shares cannot target OUs and accounts do not auto-accept them.
3. **The account is outside the OUs the share targets.** A dev account that lives in a test OU never receives the dev share.
4. **The wrong service network ID was passed.** The `serviceNetworkId` passed into the stack is not the environment's actual RAM-shared network ID (for example, a test ID was passed for a dev OU). The name is used only for the association tag, so a name typo does not by itself break the association; the ID is what must be correct.

**Diagnosis.** From the workload account, confirm whether the network is even visible, then check the share status:

```bash
# 1. Can this account see the Service Network at all? (Empty/short list = share not received)
aws vpc-lattice list-service-networks --region us-east-2 \
  --query "items[].{name:name,id:id,arn:arn}" --output table

# 2. What resource shares has this account received, and are they ASSOCIATED?
aws ram get-resource-shares --resource-owner OTHER-ACCOUNTS --region us-east-2 \
  --query "resourceShares[].{name:name,status:status}" --output table

# 3. From the Network account (share owner): confirm the share's principals are the expected OU ARNs
aws ram get-resource-shares --resource-owner SELF --region us-east-2 \
  --query "resourceShares[].{name:name,status:status}" --output table
aws ram list-principals --resource-owner SELF --region us-east-2 \
  --query "principals[].{id:id,resourceShareArn:resourceShareArn}" --output table
```

In the console: **RAM → Shared with me → Resource shares** in the workload account should list the environment's share with status *Associated*; **RAM → Shared by me** in the Network account should show the share's principals as the environment's OU ARNs with "Allow external accounts" off. **VPC Lattice → Service networks** in the workload account should list the shared network.

**Resolution.**

- If organization sharing was never enabled, run it once from the management account, then re-deploy the workload stack:

  ```bash
  aws ram enable-sharing-with-aws-organization
  ```

- If the account is in the wrong OU, move it into an OU that the environment's share targets (or add that OU as a principal on the share in [Phase 1](04-phase1-foundation.md)). With organization sharing enabled, accounts in a targeted OU **auto-accept** the share, there is no manual invitation to accept.
- If the wrong ID was passed, correct the `serviceNetworkId` (CDK prop) or `ServiceNetworkId` (CloudFormation parameter) to the environment's actual RAM-shared network ID, and re-deploy. List the visible networks and their IDs with the command above.
- After the share is in place, re-run the deployment. The shared service network ID is now valid in the account and the association proceeds.

### Failed VPC association, RAM share not accepted or stuck

**Symptom.** The association deployment fails or hangs, and the Service Network is not visible in the workload account even though Phase 1 created and shared it.

**Likely cause(s).** The share exists but its principal association has not propagated, the share was created without `enable-sharing-with-aws-organization` in effect (so it cannot auto-accept), or an OU ARN on the share is incorrect.

**Diagnosis.** Confirm the share is owned and scoped correctly from the Network account, and received in the workload account:

```bash
# Network account (owner): is the share status ACTIVE and are its principals the right OUs?
aws ram get-resource-shares --resource-owner SELF --region us-east-2 \
  --query "resourceShares[?contains(name,'shared')].{name:name,status:status}" --output table

# Workload account (receiver): has the share been associated to this account?
aws ram get-resource-shares --resource-owner OTHER-ACCOUNTS --region us-east-2 \
  --query "resourceShares[].{name:name,status:status}"
```

**Resolution.** Ensure `aws ram enable-sharing-with-aws-organization` was run in the management account (this is a [Prerequisite](02-prerequisites.md) and a Phase 1 step). Verify the share's `Principals` are the environment's OU ARNs and that the account belongs to one of them. Propagation is usually quick; if a share was just created, allow a short interval and re-deploy. Because external principals are disabled (`AllowExternalPrincipals: false`), there is never an external invitation to accept, auto-accept is the only path, and it depends on organization sharing being enabled.

### DNS does not resolve to a Lattice IP after association (CDK path)

**Symptom.** The `ServiceNetworkVpcAssociation` exists, but from inside the workload VPC a query such as `dig +short ssm.us-east-2.amazonaws.com` returns a normal/public address (or NXDOMAIN) rather than a VPC Lattice IP. AWS API calls do not route through Lattice.

**Likely cause(s).** `PrivateDnsEnabled` is not in effect on the association. This is **very common on the CDK path**, because the reference `WorkloadAssociationStack` creates the `CfnServiceNetworkVpcAssociation` but, as written, does **not** set `PrivateDnsEnabled` in the L1 props. Without it, Lattice never creates the Private Hosted Zones (PHZs) for the Resource Configuration custom domains, so the workload has nothing answering with a Lattice IP. (The CloudFormation path sets `PrivateDnsEnabled: true` with `DnsOptions: PrivateDnsPreference: ALL_DOMAINS` directly, so it is not subject to this.)

**Diagnosis.** Check whether private DNS is actually enabled on the association, then test resolution from inside the VPC:

```bash
# Is PrivateDnsEnabled true on the association?
aws vpc-lattice list-service-network-vpc-associations --region us-east-2 \
  --query "items[].{id:id,vpc:vpcId,status:status}" --output table

aws vpc-lattice get-service-network-vpc-association \
  --service-network-vpc-association-identifier <association-id> --region us-east-2 \
  --query "{status:status,privateDns:privateDnsEnabled}"

# From a host INSIDE the associated workload VPC, expect an IP managed by
# VPC Lattice (NOT part of the workload VPC CIDR, and not a public service IP):
dig +short ssm.us-east-2.amazonaws.com
dig +short sts.us-east-2.amazonaws.com
```

If `privateDnsEnabled` is `false` (or absent), that is the cause.

**Resolution.** Apply `PrivateDnsEnabled` on the CDK path, either add it to the `CfnServiceNetworkVpcAssociation` props if your `aws-cdk-lib` version supports the property (apply `DnsOptions.PrivateDnsPreference: ALL_DOMAINS` alongside it), or enable it post-deploy with the CLI:

```bash
aws vpc-lattice update-service-network-vpc-association \
  --service-network-vpc-association-identifier <association-id> \
  --private-dns-enabled --region us-east-2
```

After enabling, Lattice creates the PHZs for the associated Resource Configuration domains. Re-run `dig +short ssm.us-east-2.amazonaws.com` from inside the VPC; it should now return an IP managed by VPC Lattice (an address outside the workload VPC CIDR). This is the single most common "the association succeeded but nothing resolves through Lattice" issue on the CDK path.

### DNS resolves to the wrong target, conflicting Route 53 Private Hosted Zone

**Symptom.** `PrivateDnsEnabled` is in effect and the association is healthy, but a domain such as `ssm.us-east-2.amazonaws.com` (or a broader `amazonaws.com` name) still resolves to an old target, for example a pre-existing interface endpoint IP from a legacy per-account setup, instead of a VPC Lattice IP. This is the most common cause of "the association succeeded but DNS still goes to the wrong place," and it is the resolution target that [Architecture](03-architecture.md#privatednsenabled-behavior-and-automatic-private-hosted-zone-creation) and [Phase 4](07-phase4-workload-onboarding.md) forward-reference for requirement 8.4.

**Likely cause(s).** The workload VPC is already associated with its **own Route 53 Private Hosted Zone** for a domain that overlaps the Lattice-managed zone, for example a legacy `amazonaws.com` PHZ created when the account ran its own interface endpoints with private DNS. When two PHZs are associated to the same VPC, Route 53 applies a **resolution precedence**, and the pre-existing zone can win, shadowing the Lattice-managed zone.

How Route 53 chooses between overlapping private zones, the precedence you need to reason about:

- **Most specific name wins.** Route 53 resolves against the hosted zone with the **most specific (longest) matching name** for the queried record. A zone named `ssm.us-east-2.amazonaws.com` is more specific than one named `amazonaws.com`, and the more specific zone answers the query regardless of which zone was created first.
- **An exact-name conflict is the problem case.** When two zones associated to the same VPC have the **same name** covering the queried domain, they conflict directly, and resolution does not reliably fall through to the Lattice-managed zone. A broad legacy `amazonaws.com` zone that also covers `ssm.us-east-2.amazonaws.com` shadows the service domains the Lattice association is trying to manage.

**Diagnosis.** List every hosted zone associated with the workload VPC and look for one whose name overlaps the AWS service domains. Then confirm what the VPC actually resolves:

```bash
# List all hosted zones associated with the workload VPC (run with the workload VPC's ID/Region)
aws route53 list-hosted-zones-by-vpc \
  --vpc-id <workload-vpc-id> --vpc-region us-east-2 \
  --query "HostedZoneSummaries[].{name:Name,id:HostedZoneId,owner:Owner.OwningAccount}" \
  --output table

# Inspect a suspect zone's records (e.g., a legacy amazonaws.com zone)
aws route53 list-resource-record-sets --hosted-zone-id <suspect-zone-id> \
  --query "ResourceRecordSets[?contains(Name,'amazonaws.com')].{name:Name,type:Type}" \
  --output table

# From inside the workload VPC, confirm the wrong answer:
dig +short ssm.us-east-2.amazonaws.com
```

In the console: **Route 53 → Hosted zones** filtered to private zones, then check each zone's **VPC associations** for the workload VPC; a legacy `amazonaws.com` (or `*.amazonaws.com`) zone associated to the VPC is the conflict.

**Resolution.** Make the Lattice-managed zone the one that answers. Choose based on whether the legacy zone is still needed:

1. **If the legacy zone is no longer needed** (the account is moving entirely to the shared fabric), **disassociate it from the workload VPC** so only the Lattice-managed zone remains:

   ```bash
   aws route53 disassociate-vpc-from-hosted-zone \
     --hosted-zone-id <legacy-zone-id> \
     --vpc VPCRegion=us-east-2,VPCId=<workload-vpc-id>
   ```

   (A private hosted zone must keep at least one VPC association; if this is its last one, delete the zone or associate it to a VPC that still needs it instead.)
2. **If the legacy zone must stay** (other records in it are still in use), **narrow its scope** so it no longer covers the AWS service domains, remove the conflicting record sets (for example the `amazonaws.com` / `*.amazonaws.com` entries) from it, or replace the broad zone with narrowly named zones that do not overlap the service domains the fabric manages. The goal is that no zone on the VPC is as-specific-or-more-specific than the Lattice-managed service domains.
3. Re-test from inside the VPC: `dig +short ssm.us-east-2.amazonaws.com` should now return an IP managed by VPC Lattice (an address outside the workload VPC CIDR).

**Prevention.** Before onboarding an account that previously ran its own endpoints, audit its VPC for legacy private zones with `aws route53 list-hosted-zones-by-vpc` and plan to disassociate or scope them as part of the cutover, so the Lattice-managed zones created on association are the ones that resolve.

### Resource Gateway stuck, unhealthy, or deployment fails

**Symptom.** A Resource Gateway (endpoint or egress) never reaches `ACTIVE`, is reported unhealthy, or its CloudFormation/CDK deployment fails. Downstream symptoms include endpoints or the proxy not being reachable even though the Resource Configurations exist.

**Likely cause(s).**

1. **Subnet IP exhaustion.** A Resource Gateway provisions elastic network interfaces (ENIs) across its two subnets and scales them with connection volume. If the subnets are too small (or crowded by other resources), the gateway cannot allocate addresses and gets stuck or fails to deploy. This is the most common cause, which is why the prerequisites require **/24 minimum** Resource Gateway subnets ([Prerequisites](02-prerequisites.md#3-subnet-sizing-requirements)).
2. **Security group does not permit the expected port.** The gateway's security group must allow the traffic the Resource Configurations carry, **443** for the endpoint Resource Gateway, **3128** for the egress Resource Gateway. An over-restrictive SG produces connectivity failures that look like gateway health problems.
3. **Wrong subnets or AZs** resolved from SSM (for example, public subnets, or subnets in fewer than two AZs).

**Diagnosis.** Confirm gateway state, then check free IPs in the subnets and the security group rules:

```bash
# Resource Gateway state, expect ACTIVE
aws vpc-lattice list-resource-gateways --region us-east-2 \
  --query "items[].{name:name,id:id,status:status,vpc:vpcIdentifier}" --output table

# Free IP addresses remaining in each Resource Gateway subnet (low/zero = exhaustion)
aws ec2 describe-subnets --region us-east-2 \
  --subnet-ids <subnet-a-id> <subnet-b-id> \
  --query "Subnets[].{id:SubnetId,az:AvailabilityZone,cidr:CidrBlock,freeIps:AvailableIpAddressCount}" \
  --output table

# Security group rules on the gateway SG, confirm 443 (endpoint) or 3128 (egress) is permitted
aws ec2 describe-security-groups --region us-east-2 \
  --group-ids <resource-gateway-sg-id> \
  --query "SecurityGroups[].IpPermissions"
```

In the console: **VPC Lattice → Resource gateways** shows the gateway and its state; **VPC → Subnets** shows *Available IPv4 addresses* per subnet; **VPC → Security groups** shows the inbound rules.

**Resolution.**

- **IP exhaustion:** re-deploy the gateway into subnets of at least /24 (resize or replace undersized subnets). Confirm `AvailableIpAddressCount` has comfortable headroom; the gateway must be able to add ENIs as connection volume grows without contending for addresses.
- **Security group:** add the missing rule, inbound TCP 443 from the expected workload source ranges for the endpoint gateway SG, or inbound TCP 3128 from the NLB/Resource Gateway for the egress path. Use explicit port ranges and source restrictions (never `0.0.0.0/0`), consistent with the security model in this guide.
- **Wrong subnets/AZs:** correct the SSM parameter values (or the values passed to the stack) so the gateway lands in two private subnets across two AZs, and re-deploy.

### IAM auth policy denial, 403 from VPC Lattice

**Symptom.** A workload's call through a Service Network is rejected with a 403 (access denied) from VPC Lattice, even though the VPC association exists and DNS resolves to a Lattice IP. The request reaches Lattice but is denied at the auth-policy boundary.

**Likely cause(s).** The Service Network's IAM auth policy allows `vpc-lattice-svcs:Invoke` only when **both** `aws:PrincipalOrgID` matches the organization **and** `aws:PrincipalOrgPaths` matches one of that environment's permitted OU paths (a `ForAnyValue:StringLike` with a `/*` suffix). A 403 means one of those conditions failed:

1. **The caller's OU path is not in the policy's allowed paths**, for example the account is in the wrong environment, or it was moved to a different OU after onboarding so its org path no longer matches.
2. **An OU path typo or missing `/*` suffix** in the policy, so a legitimate path does not match.
3. **The `aws:PrincipalOrgID` condition is missing or wrong**, so even in-org principals are not matched as intended.
4. **(CDK path) the OU-path auth policy was never attached.** The CDK `VpcLatticeCoreStack` creates the networks with `AuthType: AWS_IAM` but does **not** attach an explicit `AWS::VpcLattice::AuthPolicy`. If you deployed the CDK path and never added the policy, the network has IAM auth enabled but no OU-path statement, depending on how access is evaluated this can deny legitimate callers, and it certainly does not enforce the intended isolation. The explicit OU-path policies are defined only in the CloudFormation template.

**Diagnosis.** Read the auth policy actually attached to the network, then determine the caller's real OU path from Organizations and compare:

```bash
# What auth policy is attached to the Service Network? (use the SN ARN)
aws vpc-lattice get-auth-policy \
  --resource-identifier <service-network-arn> --region us-east-2

# What is the caller account's actual OU path? Walk parents from the account up.
aws organizations list-parents --child-id 111111111111
aws organizations describe-organizational-unit --organizational-unit-id <ou-id>
# Build the full path: o-EXAMPLE12345/r-EXAMPLE/ou-.../ou-... and compare it
# against the aws:PrincipalOrgPaths values in the policy above (each should end with /*).
```

In the console: **VPC Lattice → Service networks → (network) → Access → Auth policy** shows the attached policy; **AWS Organizations → AWS accounts** shows where the account sits in the OU tree.

**Resolution.**

- If the caller's OU path is genuinely not permitted, either move the account into a correct OU for that environment, or (if it should be allowed) add its OU path to the network's auth policy `aws:PrincipalOrgPaths` list with the `/*` suffix.
- Fix any typo and ensure each permitted path ends with `/*` so the OU and everything beneath it match.
- Confirm the `aws:PrincipalOrgID` `StringEquals` value is the correct organization ID (`o-EXAMPLE12345`).
- **On the CDK path, attach the OU-path policy** if it is missing, add an equivalent `AWS::VpcLattice::AuthPolicy` to the stack (use the CloudFormation template as the reference), or apply it out of band:

  ```bash
  aws vpc-lattice put-auth-policy \
    --resource-identifier <service-network-arn> --region us-east-2 \
    --policy file://dev-auth-policy.json
  ```

  where `dev-auth-policy.json` is the OU-path-scoped policy shown in [Phase 1](04-phase1-foundation.md#the-iam-auth-policy-restrict-invoke-by-ou-path). After updating the policy, re-test the call; the 403 should clear for in-scope principals while remaining for out-of-scope ones.

### Egress proxy connectivity failure, NLB targets unhealthy

**Symptom.** Workloads cannot reach the internet through the proxy; requests to `HTTP_PROXY` time out. In the Network account, the Squid target group shows targets as *unhealthy*, or the ECS service never reaches its desired running count.

**Likely cause(s).**

1. **The egress security group does not permit TCP 3128** from the NLB / Resource Gateway to the Fargate tasks, so the target group health check on 3128 fails.
2. **The Squid container failed to start** (bad image pull, misconfiguration), so there is no healthy task behind the NLB.
3. **Fewer healthy tasks than `desiredCount`** (default 2) due to task crashes.

**Diagnosis.** Work from the load balancer health back to the container logs:

```bash
# Target group target health, expect "healthy"
aws elbv2 describe-target-health \
  --target-group-arn <squid-target-group-arn> --region us-east-2 \
  --query "TargetHealthDescriptions[].TargetHealth.State"

# ECS service desired vs running count
aws ecs describe-services \
  --cluster squid-egress-cluster --services <service-name> --region us-east-2 \
  --query "services[0].{desired:desiredCount,running:runningCount}"
aws ecs list-tasks --cluster squid-egress-cluster --region us-east-2

# Egress SG: is TCP 3128 permitted from the NLB / Resource Gateway?
aws ec2 describe-security-groups --region us-east-2 \
  --group-ids <egress-sg-id> --query "SecurityGroups[].IpPermissions"

# If targets are healthy but tasks misbehave, read the Squid logs
aws logs tail /ecs/squid-egress-proxy --region us-east-2 --since 15m
```

In the console: **EC2 → Target groups → (Squid TG) → Targets** for health state; **Amazon ECS → Clusters → `squid-egress-cluster`** for the service/task state; **CloudWatch → Log groups → `/ecs/squid-egress-proxy`** for container logs (Container Insights is enabled on the cluster).

**Resolution.**

- **SG fix:** add an inbound rule on the egress security group allowing TCP 3128 from the NLB / egress Resource Gateway source, so the 30-second TCP:3128 health check can succeed. This is the most common cause of targets never going healthy.
- **Container start failure:** inspect `/ecs/squid-egress-proxy` for the failure. If the public `ubuntu/squid:latest` pull is the issue, build and push a pinned Squid image to Amazon ECR and reference that immutable tag (the shared ECR endpoint from [Phase 2](05-phase2-shared-endpoints.md) lets Fargate pull it privately).
- **For live inspection,** open a shell into a running task with ECS Exec and check the Squid process and effective config:

  ```bash
  aws ecs execute-command \
    --cluster squid-egress-cluster --task <task-id> \
    --container squid --interactive --command "/bin/sh" \
    --region us-east-2
  ```

### Egress proxy, allowed domain is blocked, or proxy domain does not resolve

**Symptom.** Either (a) a request to a domain you expected to be permitted is refused by the proxy, or (b) the workload cannot resolve the `squid-proxy.egress.internal` proxy domain at all.

**Likely cause(s).**

1. **Domain not on the allowlist.** Squid enforces the `ALLOWED_DOMAINS` allowlist and **denies any domain not on it**. A blocked non-allowlisted domain is *expected behavior*, not a failure; this is the data-exfiltration control working as designed.
2. **Proxy domain does not resolve** because the workload VPC is not associated yet, or `PrivateDnsEnabled` is not in effect (see the CDK DNS scenario above). Until the association with private DNS exists, `squid-proxy.egress.internal` does not resolve in the workload VPC, which is intended until onboarding completes.
3. **`NO_PROXY` misconfiguration** sending AWS-service traffic through the proxy (or proxying traffic that should go direct).

**Diagnosis.**

```bash
# From the workload host: does the proxy domain resolve to a Lattice IP?
dig +short squid-proxy.egress.internal

# Confirm the proxy variables and exclusions are set as intended
env | grep -iE "http_proxy|https_proxy|no_proxy"

# Test an ALLOWED domain (should succeed) vs a non-allowlisted one (should be denied)
curl -sS -o /dev/null -w "%{http_code}\n" https://aws.amazon.com
curl -sS https://example-not-on-allowlist.com

# Inspect the effective allowlist on a running task
aws ecs execute-command --cluster squid-egress-cluster --task <task-id> \
  --container squid --interactive --command "/bin/sh" --region us-east-2
```

**Resolution.**

- **To permit a domain that should be allowed:** add it to the `ALLOWED_DOMAINS` value and redeploy the egress stack: the task definition is the source of truth, so `npx cdk deploy SquidEgressStack --context squidAllowedDomains="...new list..."` rolls out a new task revision and ECS replaces the running tasks. (If a non-allowlisted domain is being denied and that is correct, no action is needed; that is the filter doing its job.)
- **If the proxy domain does not resolve:** complete the workload VPC association ([Phase 4](07-phase4-workload-onboarding.md)) and ensure `PrivateDnsEnabled` is in effect (apply it on the CDK path as described above). After association with private DNS, `squid-proxy.egress.internal` resolves to a Lattice IP.
- **Set `NO_PROXY` correctly** so AWS service domains travel the direct Lattice-to-endpoint path and only genuine internet traffic uses the proxy:

  ```bash
  export HTTP_PROXY=http://squid-proxy.egress.internal:3128
  export HTTPS_PROXY=http://squid-proxy.egress.internal:3128
  export NO_PROXY=169.254.169.254,.amazonaws.com,.us-east-2.amazonaws.com
  ```

### Quick-reference diagnostic command index

| Symptom | First diagnostic | Most likely fix |
|---------|------------------|-----------------|
| "Service network not found" on association | `aws vpc-lattice list-service-networks` (in workload account) | Enable org RAM sharing / move account into shared OU / fix name |
| Share not received | `aws ram get-resource-shares --resource-owner OTHER-ACCOUNTS` | `aws ram enable-sharing-with-aws-organization` in management account |
| DNS not a Lattice IP (CDK) | `dig +short ssm.us-east-2.amazonaws.com` + `get-service-network-vpc-association` | `update-service-network-vpc-association --private-dns-enabled` |
| DNS to wrong target | `aws route53 list-hosted-zones-by-vpc` | Disassociate / scope the conflicting Route 53 PHZ |
| Resource Gateway stuck | `aws vpc-lattice list-resource-gateways` + subnet free-IP check | Use /24 subnets; permit 443/3128 in SG |
| 403 from Lattice | `aws vpc-lattice get-auth-policy` + Organizations OU path | Fix/attach OU-path auth policy (`put-auth-policy`) |
| Egress targets unhealthy | `aws elbv2 describe-target-health` + `/ecs/squid-egress-proxy` logs | Allow TCP 3128 in egress SG; fix container start |
| Allowed domain blocked | `curl` test + ECS Exec into task | Add domain to `ALLOWED_DOMAINS` and redeploy |

## Frequently asked questions

The questions below are the ones that come up most often when teams evaluate this pattern against an existing estate. The first three, Transit Gateway compatibility, the migration path, and multi-Region, are the ones decision makers ask first; the remainder cover practical extensions of the reference.

### Is this compatible with our existing Transit Gateway deployment?

**Yes, the pattern coexists with Transit Gateway (TGW); it does not require you to remove it.** VPC Lattice as the sole fabric handles two specific traffic patterns: **AWS-service access** (the shared interface endpoints) and **controlled internet egress** (the Squid proxy). Transit Gateway is retained for what it does best: **east-west, IP-routed traffic between VPCs and hybrid routing to on-premises networks.** The two are not mutually exclusive, a single VPC can have both a TGW attachment (for east-west/hybrid traffic) and a VPC Lattice association (for AWS-service access and egress) at the same time, because Lattice access is by DNS/service rather than by IP route and does not participate in the TGW routing plane.

In practice this means you adopt the sole fabric for the access-and-egress patterns and **keep TGW for the traffic that genuinely needs Layer 3 routing**. The savings described in [Cost and Operational Comparison](11-cost-comparison.md) apply only to the per-account endpoints and NAT Gateways the fabric replaces; TGW spend that carries real east-west or hybrid traffic is *not* eliminated, because that traffic still needs TGW. The [decision framework](00-introduction.md#decision-framework-when-to-use-vpc-lattice-as-the-sole-fabric) in the introduction is the tool for deciding which traffic moves to the fabric and which stays on TGW; many large estates run both.

### What is the migration path from a traditional architecture?

**Incremental and side-by-side, you never have to flip the whole estate at once.** The pattern is designed so the shared fabric can run alongside the existing per-account endpoints, NAT Gateways, and TGW design while you migrate account by account. A typical path:

1. **Stand up the fabric (Phases 1-3) in the Network account.** Create the three Service Networks and RAM shares ([Phase 1](04-phase1-foundation.md)), the shared endpoints ([Phase 2](05-phase2-shared-endpoints.md)), and the centralized egress proxy ([Phase 3](06-phase3-centralized-egress.md)). None of this affects workload accounts yet.
2. **Pilot with one OU first.** Onboard a small **pilot OU** (ideally a dev OU) by associating its workload VPCs ([Phase 4](07-phase4-workload-onboarding.md)) and validating end-to-end: `dig` resolves the service domains to Lattice IPs, `aws sts get-caller-identity` succeeds, and the egress proxy permits an allowlisted domain.
3. **Onboard the rest in waves**, OU by OU, using StackSets or CDK Pipelines so each new account is associated automatically. The association is additive and reversible, if anything looks wrong, the account still has its existing connectivity.
4. **Validate connectivity per wave** before decommissioning anything.
5. **Decommission the now-redundant per-account resources** for the migrated traffic, the per-account interface endpoints and the NAT Gateways that existed only for AWS-service access and egress, once the fabric is proven for those accounts.

Two cutover considerations matter while both paths run side by side:

- **DNS precedence.** During cutover an account may still have its legacy Route 53 Private Hosted Zones. As covered in the [conflicting PHZ scenario](#dns-resolves-to-the-wrong-target--conflicting-route-53-private-hosted-zone) above, the more specific (or same-name) legacy zone can shadow the Lattice-managed zone. Plan to disassociate or scope those zones as part of each account's cutover so traffic actually moves to the fabric.
- **`NO_PROXY` during egress cutover.** As you move egress to the Squid proxy, keep AWS service domains and the instance metadata address in `NO_PROXY` so service calls continue to take the direct Lattice-to-endpoint path rather than being tunneled through the proxy.

The result is a low-risk migration: the fabric proves itself on a pilot OU, expands in waves, and only then do you retire the duplicated per-account infrastructure.

### How does this work across multiple Regions?

**A VPC Lattice Service Network is a regional construct, so a multi-Region deployment replicates the pattern per Region.** This is the resolution target that [Well-Architected Framework Alignment](10-well-architected.md) forward-references for multi-Region considerations. There is no single global Service Network; each Region you operate in gets its own copy of the fabric:

- **Per-Region Service Networks.** Deploy the three Service Networks (dev/test/prod) in each Region.
- **Per-Region shared components.** Deploy a Resource Gateway, the interface endpoints, the Resource Configurations, and the egress proxy stack in each Region's Network-account VPCs. Endpoints and the proxy are regional resources.
- **Per-Region workload association.** Associate each workload VPC to the Service Network **in its own Region**, a VPC in `us-east-2` associates to the `us-east-2` Service Network, a VPC in `us-west-2` to the `us-west-2` one. The custom-resource lookup and `PrivateDnsEnabled` behavior are identical in each Region.
- **RAM shares and auth policies are regional.** Create the RAM shares and the OU-path IAM auth policies in each Region; they do not span Regions.

Operationally this means your IaC is parameterized by Region and instantiated once per Region, the same stacks, deployed into each Region's Network account VPCs, with workload accounts associating to the Service Network local to their Region. The single-fabric dependency and its mitigations (multi-AZ Resource Gateways, multi-task Fargate) apply within each Region; the trade-offs are discussed in [Well-Architected Framework Alignment](10-well-architected.md#trade-offs-and-design-tensions). Replace every `us-east-2` reference in this guide with the target Region when you extend the pattern.

### Can I add more AWS service endpoints to the shared set?

**Yes.** The reference exposes 10 endpoints on the CDK path (11 on the CloudFormation path, which adds `execute-api`). To add another AWS service:

1. Deploy the interface VPC endpoint for the new service in the Endpoint VPC (it is then referenced by its regional DNS name, read natively from `DnsEntries` on the CDK path, or discovered by the VPCE DNS lookup Lambda on the CloudFormation path).
2. Add the service to the `endpoints` array in `VpcLatticeEndpointsStack` (CDK) or to the endpoint list in the combined CloudFormation template. Each entry produces a Resource Configuration on `443/TCP` associated to all three Service Networks.
3. Redeploy. Workloads resolve the new domain automatically through the Lattice-managed PHZ, no per-account change is required. See [Phase 2](05-phase2-shared-endpoints.md#step-3--create-a-resource-configuration-per-endpoint-and-associate-to-all-three-service-networks) for the structure.

### Does this replace Transit Gateway entirely?

**No.** As covered above, this pattern targets AWS-service access and controlled egress. Transit Gateway is retained for general-purpose, high-volume, IP-routed east-west traffic and for hybrid (on-premises) routing. The prescriptive position of this guide is to use VPC Lattice as the sole fabric for the patterns it serves and keep TGW for the traffic that genuinely needs Layer 3 routing, see the [decision framework](00-introduction.md#decision-framework-when-to-use-vpc-lattice-as-the-sole-fabric).

### What IP ranges does VPC Lattice resolve to, and what about IPv6?

The managed IP range depends on **what** you are resolving, and this is the single most common source of "is my `dig` output correct?" confusion:

- **VPC resources** (Resource Configurations, which is what every endpoint and the Squid proxy in this guide are) resolve to the **public `129.224.0.0/17`** IPv4 range.
- **VPC Lattice services** (the HTTP/HTTPS service construct, not used in this guide's endpoint/egress pattern) resolve to the **`169.254.171.0/24`** link-local IPv4 range.
- **IPv6** for both uses the **`fd00:ec2:80::/64`** range.

This guide exposes everything as **VPC resources**, so a correct `dig +short ssm.{region}.amazonaws.com` from inside an associated workload VPC returns an address in the `129.224.0.0/17` range. (Earlier drafts of this guide cited `169.254.171.x` here; that is the *services* range and does not apply to the resource-based pattern.) The reliable signal in all cases is that the answer is **not** part of your workload VPC CIDR and **not** the service's public anycast IP. The reference Resource Configurations use `IpAddressType: IPV4`; if you require IPv6 resolution end to end, set the appropriate `IpAddressType` on the Resource Configurations and confirm your endpoints and subnets are dual-stack.

### What runtime does the Lambda custom resource use?

**Python 3.12.** The solution has a single Lambda, the VPCE DNS lookup ([Phase 2](05-phase2-shared-endpoints.md)) on the **CloudFormation path**, and it runs on the Python 3.12 runtime, which is the standard for this pattern. The CDK path has no Lambda (it reads endpoint DNS natively from the endpoint's `DnsEntries`), and the workload association uses no Lambda on either path (the VPC ID resolves via a native `AWS::SSM::Parameter::Value` and the service network ID is passed as a parameter).

### How do I update the egress allowlist without a full redeploy?

By default the allowlist is the `ALLOWED_DOMAINS` environment variable on the task definition, so updating it means redeploying the egress stack with a new value (ECS rolls out a new task revision). If you need to change the list frequently or it grows long, source it from SSM Parameter Store (or a small config file pulled at task start) and have the container read it at startup; this lets you change the allowlist out of band without a stack deploy. See [Phase 3](06-phase3-centralized-egress.md#step-2--manage-the-fqdn-allowlist-via-the-allowed_domains-environment-variable) for the trade-off.

---

With the common failure modes diagnosable from the command index above and the evaluation questions answered, the operational picture of the pattern is complete. The next section consolidates the security review: the threats identified during threat modeling, the mitigations applied in the IaC, and any accepted residual risks.

Continue to [Security Findings Summary](13-security-findings.md).

### Can a Lambda function bypass the centralized egress proxy?

Yes, if it has no VPC configuration. Centralized egress only filters traffic that leaves through your VPCs; a Lambda function with no VPC attachment runs on AWS-managed network and reaches the internet on a path the proxy never sees. A VPC Lattice Service that targets such a function can even turn it into a reusable egress shortcut. You cannot apply network rules to a function that is not in your VPC, so govern it: require VPC attachment with a Service Control Policy (the `lambda:VpcIds` / `lambda:SubnetIds` / `lambda:SecurityGroupIds` condition keys), detect drift with the AWS Config rule `lambda-inside-vpc`, and give teams a golden template that ships VPC config plus proxy settings. Once a function is attached to the isolated workload VPC, the only egress is Lattice to Squid. See [What centralized egress does not cover](06-phase3-centralized-egress.md#what-centralized-egress-does-not-cover-and-how-to-govern-it) for the full rationale and references.
