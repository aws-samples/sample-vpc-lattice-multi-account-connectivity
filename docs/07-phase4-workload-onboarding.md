# Phase 4: Workload Onboarding

The first three phases built and exposed shared connectivity entirely inside the Network account: [Phase 1: Foundation](04-phase1-foundation.md) created the three Service Networks and their RAM shares, [Phase 2: Shared Endpoints](05-phase2-shared-endpoints.md) exposed the AWS service endpoints, and [Phase 3: Centralized Egress](06-phase3-centralized-egress.md) exposed the Squid proxy. None of that connectivity is reachable from a workload yet. This phase is where workloads come online, and it is deliberately the smallest phase in the guide. Onboarding a workload account is **a single VPC association**, deployed into **each workload account**, that ties the account's VPC to its environment's Service Network and switches on private DNS.

That one association is the whole onboarding action. With `PrivateDnsEnabled` set, VPC Lattice does the rest: it creates the Private Hosted Zones (PHZs) so the workload VPC automatically resolves `ssm.us-east-2.amazonaws.com`, the other AWS service domains, and the egress proxy domain to VPC Lattice IPs, with no per-workload DNS configuration, no endpoints to create, and no proxy to stand up. The bulk of this phase, then, is not the association itself but **how to deploy it across tens, hundreds, or thousands of accounts automatically** as new accounts are vended.

> **A note on conventions.** As elsewhere in this guide, examples use the `us-east-2` Region and placeholder identifiers (organization ID `o-EXAMPLE12345`, account `111111111111`). The reference IaC associates each workload VPC to a named Service Network: the CDK path uses names such as `sn-dev-shared`, and the CloudFormation path uses names such as `sn-dev-shared`. This section refers to "the dev service network" generically, but the **name you pass in must match the actual Service Network name created in Phase 1** for that environment, because the association resolves the network *by name*.

## Why Workload Onboarding comes last

This phase depends on Phase 1 directly and benefits from Phases 2 and 3. The dependency is concrete (this satisfies the deployment-order rationale in requirements 4.4 and 4.2):

- **It requires Phase 1.** The association attaches the workload VPC to a Service Network that must already exist *and* must already be RAM-shared to the workload account's OU. The service network ID is passed in as a parameter; if Phase 1 has not run, or the RAM share has not reached this account's OU, that ID is not valid in the account and the association fails. A workload account cannot associate to, or even discover, a network that has not been created and shared to its OU.
- **It benefits from Phases 2 and 3.** The association is what makes the shared endpoints and the egress proxy *usable* from the workload. Once associated with private DNS, the workload resolves the endpoint domains (Phase 2) and the `squid-proxy.egress.internal` proxy domain (Phase 3) to Lattice IPs. If you associate before Phases 2 and 3 have run, the association still succeeds, but there is nothing yet behind those domains to resolve. In practice you complete Phases 2 and 3 first so that the moment a workload onboards, the connectivity it resolves is already live.

Unlike the earlier phases, **this phase deploys to the workload account, not the Network account.** It is the only phase that runs outside the Network account, and it is the phase you run repeatedly, once per workload account (or, with the automation in [Step 4](#step-4--automate-onboarding-across-many-accounts), once per fleet, applied automatically to every account in scope).

## Account context

| Item | Value |
|------|-------|
| Deployment target | **Each workload account**, into the **workload VPC** |
| Region | `us-east-2` (adjust if you deploy elsewhere) |
| Depends on | [Phase 1: Foundation](04-phase1-foundation.md), the Service Network must exist and be RAM-shared to this account's OU |
| Benefits from | [Phase 2: Shared Endpoints](05-phase2-shared-endpoints.md) and [Phase 3: Centralized Egress](06-phase3-centralized-egress.md), the domains the workload resolves after association |
| Resources created | 1 `ServiceNetworkVpcAssociation` (with `PrivateDnsEnabled`) and, on the CDK StackSet path, 1 workload egress security group (to the Lattice prefix list). No Lambda. |
| Created automatically by Lattice | Private Hosted Zones for every associated Resource Configuration domain |
| Deployed how | Once per account, manually for a single account, or via **StackSets / CDK Pipelines** at fleet scale |

Everything in this phase deploys into a workload account. The management account's only involvement is having enabled organization-wide RAM sharing (a Phase 1 prerequisite) so the share auto-accepts here; you do not deploy anything to the management or Network accounts in this phase.

## Prerequisites

The global prerequisites in [Prerequisites](02-prerequisites.md) must be satisfied. The items below are the ones this phase depends on directly. Confirm them before you deploy into a workload account:

- [ ] **Phase 1 is complete**, and the Service Network for this account's environment exists in the Network account with a known **ID** (and a name, used for the association tag). You pass the **ID** in as a parameter; it is identical in every account that received the RAM share.
- [ ] **The RAM share has reached this account's OU.** Because `aws ram enable-sharing-with-aws-organization` was enabled in Phase 1, accounts in a targeted OU **auto-accept** the Service Network share, there is no manual invitation to accept (see [Step 4](#ram-share-auto-accept-with-aws-organizations)). The account must be in an OU that the environment's share targets.
- [ ] **The workload VPC exists and its ID is published to an SSM parameter** (the foundation stack publishes it at `/netfabric/workload/dev-vpc/id`; an existing landing zone can publish it under its own prefix, for example LZA's `/accelerator/network/vpc/Workload-Dev/id`). The template resolves the VPC ID natively from this path via `AWS::SSM::Parameter::Value` rather than hardcoding it.
- [ ] **Deployment IAM capability in the workload account** to create a VPC Lattice `ServiceNetworkVpcAssociation` and a security group, and to read the workload VPC ID SSM parameter (`ssm:GetParameter`). No Lambda or `vpc-lattice:ListServiceNetworks` permission is needed. (Service-managed StackSets use the managed StackSet execution role; the CDK path additionally requires `cdk bootstrap` where applicable.)
- [ ] **Phases 2 and 3 are deployed** in the Network account if you want the workload to resolve endpoints and the proxy immediately on association (recommended, but not required for the association itself to succeed).

## Step 1, Resolve the identifiers natively (no Lambda)

The association needs two identifiers that are not known until deploy time and differ per account: the **workload VPC ID** and the **Service Network ID**. Hardcoding either would break the parameterization the pattern depends on (requirement 5.4). The reference resolves both **without any Lambda or custom resource**:

- **Workload VPC ID, native SSM resolution.** The template declares the VPC ID parameter as `AWS::SSM::Parameter::Value<AWS::EC2::VPC::Id>` with the SSM path as its default. CloudFormation reads that parameter in each target account at deploy time and substitutes the account's own VPC ID, so the same template works unchanged across every account in an OU.
- **Service Network ID, passed as a parameter.** Because each environment maps to exactly one RAM-shared Service Network, and a shared resource has the **same ID in every account that receives the share**, the Service Network ID is passed directly as a stack parameter rather than looked up. There is no need to enumerate networks or resolve a name at deploy time.

This is why there is no lookup Lambda on either path: the two values are either resolved by CloudFormation natively (`AWS::SSM::Parameter::Value`) or supplied as a parameter, so there is no `ssm:GetParameter` Lambda, no `vpc-lattice:ListServiceNetworks` call, and no custom-resource role to secure. The two preconditions on the operator are simply that the **RAM share has reached the account's OU** (so the Service Network ID is valid in that account) and that the **VPC ID is published to the SSM path** (the foundation stack does this; an existing landing zone can publish it under its own prefix, in which case you point the parameter at that path).

## Step 2, Create the VPC association with PrivateDnsEnabled

With the VPC ID and Service Network ID resolved, the core resource is a single **`AWS::VpcLattice::ServiceNetworkVpcAssociation`**. It binds the workload VPC to the Service Network and is tagged with a `Name` of the form `lattice-vpc-assoc-<serviceNetworkName>`.

The property that makes onboarding "one action" is **`PrivateDnsEnabled: true`**. When set, VPC Lattice automatically creates the PHZs for every Resource Configuration custom domain on that network, so the workload VPC resolves those domains to Lattice IPs without any further DNS work (requirement 8.1). The CloudFormation template pairs it with **`DnsOptions: PrivateDnsPreference: ALL_DOMAINS`**:

```yaml
# cloudformation/vpc-lattice-workload-vpc-association.yaml
VpcAssociation:
  Type: AWS::VpcLattice::ServiceNetworkVpcAssociation
  Properties:
    ServiceNetworkIdentifier: !Ref ServiceNetworkId
    VpcIdentifier: !Ref WorkloadVpcId
    PrivateDnsEnabled: true
    DnsOptions:
      PrivateDnsPreference: ALL_DOMAINS
    Tags:
      - Key: Name
        Value: !Sub 'lattice-vpc-assoc-${ServiceNetworkName}'
```

**`PrivateDnsPreference: ALL_DOMAINS`** instructs Lattice to manage private DNS resolution for *all* of the custom domains associated with the network, every endpoint RC with the egress proxy RC, rather than a narrower subset. For this pattern that is exactly what you want: a workload should resolve the full set of shared endpoints and the proxy through Lattice the moment it associates, so `ALL_DOMAINS` is the correct preference.

### Both IaC paths enable private DNS the same way

The CDK and CloudFormation paths are equivalent on this property. Both set **`PrivateDnsEnabled: true`** together with **`DnsOptions: PrivateDnsPreference: ALL_DOMAINS`** directly on the association resource. On the CDK path the association is defined inside the StackSet's inline template (the CDK stack is a `CfnStackSet`, not a per-account `CfnServiceNetworkVpcAssociation`), so the same property set reaches every target account. There is no post-deployment CLI step and no version-dependent caveat: deploy either path and private DNS is on.

The CDK StackSet template also creates a small **workload security group** whose only rules are egress to the VPC Lattice managed prefix list on TCP 443 (shared endpoints) and TCP 3128 (egress proxy). Without that egress rule, traffic to the Lattice-managed IPs is dropped and connections time out, so it is part of the association unit. (On the standalone CloudFormation template the workload VPC must already permit that egress, or you add an equivalent rule.)

| Aspect | CloudFormation (`vpc-lattice-workload-vpc-association.yaml`) | CDK (`WorkloadAssociationStackSetStack`) |
|--------|--------------------------------------------------------------|------------------------------------------|
| Deployment unit | Standalone template (deploy directly or wrap in a StackSet) | A `CfnStackSet` that carries the association template inline |
| Association resource | `AWS::VpcLattice::ServiceNetworkVpcAssociation` | Same, in the inline StackSet template |
| `PrivateDnsEnabled` | `true`, set directly on the resource | `true`, set directly on the resource |
| `DnsOptions` | `PrivateDnsPreference: ALL_DOMAINS` | `PrivateDnsPreference: ALL_DOMAINS` |
| Workload egress SG | Not created (workload VPC must already permit egress to the Lattice prefix list) | Created inline (egress to the Lattice prefix list on 443/3128) |

## Step 3, DNS resolution behavior after association

Once the VPC association exists **with `PrivateDnsEnabled` in effect**, the workload VPC resolves the shared domains automatically, there is no per-workload DNS configuration to author (requirement 8.2). Concretely, a host in the associated dev VPC can immediately resolve:

- `ssm.us-east-2.amazonaws.com`, `sts.us-east-2.amazonaws.com`, the ECR domains, CloudWatch Logs, and the rest of the endpoints exposed in [Phase 2](05-phase2-shared-endpoints.md), each to a **VPC Lattice IP**, and
- the **`squid-proxy.egress.internal` proxy domain** exposed in [Phase 3](06-phase3-centralized-egress.md), which workloads point `HTTP_PROXY`/`HTTPS_PROXY` at on port 3128.

This works because, on association, Lattice creates a **Private Hosted Zone for each Resource Configuration's custom domain** and attaches it to the workload VPC. A DNS query for `ssm.us-east-2.amazonaws.com` is answered by that Lattice-managed PHZ with a Lattice IP; the workload connects to it; Lattice routes through the Resource Gateway ENI in the Network account to the RC's real target (the interface endpoint, or the internal NLB and Squid). This is the same managed resolution path described in the [Architecture](03-architecture.md#privatednsenabled-behavior-and-automatic-private-hosted-zone-creation) section (requirements 8.2 and 8.3); the only thing the workload account did to earn it was create the association.

> **Conflict case: an existing Route 53 PHZ for the same domain.** If the workload VPC is *already* associated with its own Route 53 Private Hosted Zone for one of these domains (for example a pre-existing `amazonaws.com` PHZ from a legacy per-account endpoint setup), that zone can take precedence over the Lattice-managed zone and the domain may resolve to the old target instead of the Lattice IP. This is the most common cause of "the association succeeded but DNS still resolves to the wrong place." The resolution precedence and the steps to remove or scope the conflicting zone are covered in [Troubleshooting and FAQ](12-troubleshooting-faq.md) (this is the forward reference for requirement 8.4).

## Step 4, Automate onboarding across many accounts

For a single account you deploy the stack once. At fleet scale, 50, 150, 500, or more accounts, you want onboarding to be **automatic**: when a new account is vended into the right OU, it should get connectivity without anyone touching it. The pattern supports at least two automation approaches (requirement 14.1), and both rely on the same RAM auto-accept behavior described below.

### Approach A, CloudFormation StackSets

Deploy `cloudformation/vpc-lattice-workload-vpc-association.yaml` as a **StackSet with service-managed permissions**, targeting the OUs that make up an environment. Service-managed StackSets integrate with AWS Organizations and support **automatic deployment to new accounts** added to the target OUs, so a freshly vended dev account automatically receives the association stack, with no manual step. Each account instance is parameterized with that environment's `WorkloadVpcId` SSM path, `ServiceNetworkId`, and `ServiceNetworkName`.

Because one environment maps to one Service Network name, you create **one StackSet (or one set of stack instances) per environment**, each targeting that environment's OUs and passing the matching `ServiceNetworkName` (for example `sn-dev-shared` for the dev OUs, `sn-test-shared` for test, `sn-prod-shared` for prod).

### Approach B, CDK Pipelines / cdk-stacksets

Deploy `WorkloadAssociationStack` across accounts from a **CDK Pipelines** pipeline (or with the `cdk-stacksets` library, which wraps StackSets in CDK constructs). The pipeline instantiates the stack per target account with the right props. As shown in `cdk/bin/app.ts`, a single instantiation looks like this:

```typescript
// cdk/bin/app.ts, service-managed StackSet targeting the dev OU (from the management account)
new WorkloadAssociationStackSetStack(app, 'WorkloadAssociationStackSetStack', {
  env: managementEnv,
  description: 'Associates workload OU VPCs with the VPC Lattice service network',
  targetOuIds: ['ou-EXAMPLE-dev0000'],
  serviceNetworkId: 'sn-EXAMPLEdev0000000',
  serviceNetworkName: 'sn-dev-shared',
  workloadVpcSsmPath: '/netfabric/workload/dev-vpc/id',
  latticePrefixListId: 'pl-EXAMPLE0000000000',
  regions: ['us-east-2'],
});
```

To onboard a fleet, point the StackSet at each environment's OUs and pass the matching `serviceNetworkId`, the dev service network for the dev OUs, test for test, prod for prod. The mapping of OU to environment to Service Network is the one piece of configuration you must get right; the workload VPC ID is resolved at deploy time by CloudFormation from the SSM parameter.

| Dimension | CloudFormation StackSets | CDK Pipelines / cdk-stacksets |
|-----------|--------------------------|-------------------------------|
| Template / stack | `vpc-lattice-workload-vpc-association.yaml` | `WorkloadAssociationStackSetStack` (a `CfnStackSet`) |
| Org integration | Service-managed permissions + Organizations | Via pipeline accounts or `cdk-stacksets` |
| Auto-onboard new accounts | **Yes**, automatic deployment to new accounts in target OUs | Via pipeline trigger or StackSet auto-deployment |
| Inputs | `WorkloadVpcId`, `ServiceNetworkId`, `ServiceNetworkName` parameters | `targetOuIds`, `serviceNetworkId`, `serviceNetworkName`, `workloadVpcSsmPath` props |
| Environment mapping | One StackSet (or instance set) per environment's OUs | One StackSet per environment's OUs, with that environment's `serviceNetworkId` |
| Best when | You standardize on CloudFormation and want native Organizations auto-deploy | You standardize on CDK and want type-safe, composable pipelines |

### RAM share auto-accept with AWS Organizations

Both approaches depend on the workload account already being able to *see* the Service Network, which is what RAM auto-accept provides (requirement 14.2). In Phase 1 you ran, once, from the management account:

```bash
aws ram enable-sharing-with-aws-organization
```

With organization-wide RAM sharing enabled, any account in an OU that a Service Network share targets **auto-accepts** that share, there is no manual RAM invitation to accept in each workload account. The practical effect for onboarding: the association can be created the moment the stack runs, because the network is already visible (its RAM-shared ID is valid in the account). The two prerequisites for auto-accept are therefore: **(1)** organization sharing is enabled (Phase 1), and **(2)** the account lives in an OU that the environment's share targets. If a deployment fails to create the association, check those two conditions first, it almost always means the account is outside the shared OU or the share has not propagated yet.

## End-to-end onboarding flow

Putting the pieces together, here is the full flow from a brand-new account to working connectivity, with no manual networking steps along the way (requirement 14.3):

1. **A new account is vended** into the correct OU, for example by AWS Control Tower / Landing Zone Accelerator (LZA) Account Factory placing it in a dev OU.
2. **The RAM share auto-accepts.** Because organization sharing is enabled and the account is in a targeted OU, the dev Service Network share is accepted automatically; the network becomes visible in the account.
3. **The workload VPC ID is published to SSM.** The foundation stack (or your existing landing zone) publishes the account's workload VPC ID under the agreed path, for example `/netfabric/workload/dev-vpc/id`.
4. **The StackSet or pipeline deploys the association stack** into the account, automatically, because the account joined a target OU (StackSet auto-deploy) or because the pipeline stamps it out.
5. **CloudFormation resolves the identifiers natively.** It reads the workload VPC ID from the SSM parameter (`AWS::SSM::Parameter::Value`); the service network ID is supplied as a stack parameter. No Lambda runs.
6. **The `ServiceNetworkVpcAssociation` is created with `PrivateDnsEnabled`** (set directly on both paths), along with the workload egress security group to the Lattice prefix list.
7. **Lattice creates the Private Hosted Zones** for every Resource Configuration domain on the network and attaches them to the workload VPC.
8. **The workload has full connectivity.** It resolves the AWS service endpoints (Phase 2) and the egress proxy (Phase 3) to Lattice IPs and can call AWS services privately and reach the internet through the filtered proxy, with no per-account endpoints, NAT Gateways, or DNS zones to manage.

```mermaid
flowchart TD
    A["New account vended into target OU<br/>(Control Tower / LZA Account Factory)"] --> B["RAM share auto-accepted<br/>(org sharing enabled + account in shared OU)"]
    B --> C["Workload VPC ID published<br/>to /netfabric/.../id SSM param"]
    C --> D["StackSet / CDK Pipeline deploys<br/>the association stack into the account"]
    D --> E["CloudFormation resolves natively:<br/>VPC ID (SSM param) + Service Network ID (stack param)"]
    E --> F["ServiceNetworkVpcAssociation created<br/>with PrivateDnsEnabled"]
    F --> G["Lattice creates Private Hosted Zones<br/>for all RC domains"]
    G --> H["Workload resolves endpoints + proxy<br/>to Lattice IPs, full connectivity"]
```

## IaC reference

This phase corresponds to one CDK stack and one CloudFormation template, each deployable per workload account. (This addresses requirements 4.3 and 14.4.)

### CDK path

The stack is `WorkloadAssociationStackSetStack` in `cdk/lib/workload-association-stackset-stack.ts`. It is a **service-managed `CfnStackSet`**, deployed from the management (or delegated-admin) account, that carries the association template inline and rolls it out to the target OUs with auto-deployment to new accounts. There is no Lambda. Its props are:

```typescript
// props consumed by WorkloadAssociationStackSetStack
targetOuIds: string[];        // OUs to associate (and auto-deploy to new accounts in them)
serviceNetworkId: string;     // the RAM-shared service network ID (identical in every account)
serviceNetworkName: string;   // used for the association Name tag
workloadVpcSsmPath: string;   // e.g. /netfabric/workload/dev-vpc/id (resolved natively per account)
latticePrefixListId: string;  // com.amazonaws.<region>.vpc-lattice managed prefix list
regions: string[];
```

The inline template resolves the workload VPC ID natively (`AWS::SSM::Parameter::Value<AWS::EC2::VPC::Id>`), takes the service network ID as a parameter, and creates the association plus a workload egress security group. `PrivateDnsEnabled: true` and `DnsOptions: PrivateDnsPreference: ALL_DOMAINS` are set directly on the association, no Lambda, no post-deploy CLI:

```typescript
// cdk/lib/workload-association-stackset-stack.ts, the association (inside the inline StackSet template)
VpcAssociation: {
  Type: 'AWS::VpcLattice::ServiceNetworkVpcAssociation',
  Properties: {
    ServiceNetworkIdentifier: { Ref: 'ServiceNetworkId' },
    VpcIdentifier: { Ref: 'WorkloadVpcId' },          // AWS::SSM::Parameter::Value, resolved per account
    PrivateDnsEnabled: true,
    DnsOptions: { PrivateDnsPreference: 'ALL_DOMAINS' },
    Tags: [{ Key: 'Name', Value: { 'Fn::Sub': 'lattice-vpc-assoc-${ServiceNetworkName}' } }],
  },
},
```

The stack instances output `VpcAssociationId`, `ResolvedVpcId`, `ServiceNetworkId`, and `WorkloadLatticeSecurityGroupId`. Deploy the StackSet from the management account with:

```bash
cd cdk
npx cdk deploy WorkloadAssociationStackSetStack
# targetOuIds, serviceNetworkId, serviceNetworkName, workloadVpcSsmPath, latticePrefixListId,
# and regions are set in app.ts. The service-managed StackSet rolls out to the target OUs and
# auto-deploys to new accounts. Private DNS is enabled by the template; there is no post-deploy step.
```

### CloudFormation path

`cloudformation/vpc-lattice-workload-vpc-association.yaml` is the StackSet-deployable template, and it uses no Lambda. Its parameters are `WorkloadVpcId` (typed `AWS::SSM::Parameter::Value<AWS::EC2::VPC::Id>`, resolved natively per account), `ServiceNetworkId`, and `ServiceNetworkName`. There is no lookup function or custom resource. It creates the `VpcAssociation` shown in [Step 2](#step-2-create-the-vpc-association-with-privatednsenabled), which sets `PrivateDnsEnabled: true` and `DnsOptions: PrivateDnsPreference: ALL_DOMAINS` directly. It outputs `VpcAssociationId`, `ResolvedVpcId`, and `ServiceNetworkId`.

Deploy to a **single** workload account:

```bash
aws cloudformation deploy \
  --region us-east-2 \
  --stack-name vpc-lattice-workload-assoc \
  --template-file cloudformation/vpc-lattice-workload-vpc-association.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    WorkloadVpcId=/netfabric/workload/dev-vpc/id \
    ServiceNetworkId=sn-EXAMPLEdev0000000 \
    ServiceNetworkName=sn-dev-shared \
    LatticePrefixListId=pl-EXAMPLE0000000000
```

Deploy to **many** accounts with a service-managed StackSet that auto-deploys to new accounts in the dev OUs:

```bash
# 1. Create the StackSet (service-managed, auto-deploy to new accounts in target OUs)
aws cloudformation create-stack-set \
  --stack-set-name vpc-lattice-workload-assoc-dev \
  --template-body file://cloudformation/vpc-lattice-workload-vpc-association.yaml \
  --permission-model SERVICE_MANAGED \
  --auto-deployment Enabled=true,RetainStacksOnAccountRemoval=false \
  --capabilities CAPABILITY_IAM \
  --parameters \
    ParameterKey=WorkloadVpcId,ParameterValue=/netfabric/workload/dev-vpc/id \
    ParameterKey=ServiceNetworkId,ParameterValue=sn-EXAMPLEdev0000000 \
    ParameterKey=ServiceNetworkName,ParameterValue=sn-dev-shared \
    ParameterKey=LatticePrefixListId,ParameterValue=pl-EXAMPLE0000000000 \
  --region us-east-2

# 2. Roll out to the dev OUs (replace with your dev OU IDs)
aws cloudformation create-stack-instances \
  --stack-set-name vpc-lattice-workload-assoc-dev \
  --deployment-targets OrganizationalUnitIds=ou-EXAMPLE-dev1,ou-EXAMPLE-dev2 \
  --regions us-east-2 \
  --region us-east-2
```

Repeat the StackSet per environment, substituting the matching `ServiceNetworkName` (`sn-test-shared` for test, `sn-prod-shared` for prod) and that environment's OU IDs. New accounts later vended into those OUs are onboarded automatically by the StackSet's auto-deployment.

## Expected outcome

After this phase runs in a workload account, that account has:

- **One `ServiceNetworkVpcAssociation`** binding its workload VPC to the correct environment's Service Network, tagged `lattice-vpc-assoc-<serviceNetworkName>`, with **`PrivateDnsEnabled` in effect** (set directly on the CloudFormation path; explicitly applied on the CDK path).
- **Lattice-managed Private Hosted Zones** created automatically for every associated Resource Configuration domain, the Phase 2 endpoints and the Phase 3 `squid-proxy.egress.internal` proxy domain.
- **Automatic DNS resolution** of the AWS service domains and the proxy domain to **VPC Lattice IPs**, with no per-workload DNS configuration, no per-account endpoints, and no per-account NAT Gateway.

At fleet scale, the same outcome is produced automatically for every account in the targeted OUs, and for every new account vended into them, which is the operational payoff of the whole pattern: onboarding a workload account is a single association, applied automatically. (This satisfies the expected-outcome requirement 4.2.)

### Verification

From an instance, container, or Lambda **inside the associated workload VPC**, confirm DNS resolution and end-to-end connectivity:

```bash
# 1. AWS service domains resolve to an IP managed by VPC Lattice, an address
#    that is NOT part of the workload VPC CIDR and not a public service IP
dig +short ssm.us-east-2.amazonaws.com
dig +short sts.us-east-2.amazonaws.com

# 2. The association exists with private DNS enabled
aws vpc-lattice list-service-network-vpc-associations --region us-east-2
aws vpc-lattice get-service-network-vpc-association \
  --service-network-vpc-association-identifier <association-id> --region us-east-2 \
  --query "{state:status,privateDns:privateDnsEnabled}"

# 3. A real AWS API call succeeds through the Lattice-routed endpoint
aws sts get-caller-identity --region us-east-2

# 4. Internet egress works through the Phase 3 proxy (allowed domain succeeds)
export HTTP_PROXY=http://squid-proxy.egress.internal:3128
export HTTPS_PROXY=http://squid-proxy.egress.internal:3128
curl -sS -o /dev/null -w "%{http_code}\n" https://aws.amazon.com
```

The decisive check is the first one: `dig ssm.us-east-2.amazonaws.com` should return an **IP address managed by VPC Lattice**, for the resource-based pattern in this guide, an address in the public `129.224.0.0/17` range (not the workload VPC CIDR, and not the service's public anycast IP), confirming the Lattice-managed PHZ is answering. (See [What IP ranges does VPC Lattice resolve to](12-troubleshooting-faq.md#what-ip-ranges-does-vpc-lattice-resolve-to-and-what-about-ipv6) for why this is the resource range, not the `169.254.171.x` services range.) A normal private VPC address there means private DNS is not in effect; on the CDK path, that is the signal to apply `PrivateDnsEnabled` as described in [Step 2](#a-real-difference-between-the-two-iac-paths-for-privatednsenabled); if it persists, suspect a conflicting Route 53 PHZ and see [Troubleshooting and FAQ](12-troubleshooting-faq.md).

Also check, in the console:

- **VPC Lattice → Service networks → VPC associations**: the workload VPC listed, association **Active**, private DNS enabled.
- **Route 53 → Hosted zones**: the Lattice-managed Private Hosted Zones for the endpoint domains and the `squid-proxy.egress.internal` domain, associated with the workload VPC.
- **CloudFormation → the association stack → Outputs**: `VpcAssociationId`, `ResolvedVpcId`, and `ServiceNetworkId` populated with the expected values.

If the association fails to create because the service network is not visible in this account, confirm the account is in an OU that the environment's RAM share targets and that organization sharing is enabled (see [Step 4](#ram-share-auto-accept-with-aws-organizations)).

With workloads onboarding through a single automated association, in-Region service access and egress are fully in place. The next phase opens the same shared fabric to consumers that live outside an associated VPC, external, on-premises, and cross-Region, through Service Network Endpoints.

Continue to [Phase 5: Ingress via Service Network Endpoints](08-phase5-ingress-service-network-endpoints.md).
