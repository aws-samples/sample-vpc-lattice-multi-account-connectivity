# Phase 1: Foundation

The [Architecture](03-architecture.md) section established the mental model: three Service Networks, OU-scoped isolation enforced in two layers, Resource Gateways and Resource Configurations, and automatic DNS on association. This is the first of the five implementation phases, and it builds the bottom of that stack, the three Service Networks, their IAM auth policies, and the AWS Resource Access Manager (RAM) shares that distribute them to the right organizational units (OUs).

> **A note on conventions.** As elsewhere in this guide, examples use the `us-east-2` Region and placeholder identifiers: organization ID `o-EXAMPLE12345`, account `111111111111`, and OU ARNs of the form `arn:aws:organizations::111111111111:ou/o-EXAMPLE12345/ou-EXAMPLE`. The reference IaC names the three networks `sn-dev-shared` / `sn-stage-shared` / `sn-prod-shared` in both the CDK and CloudFormation paths; this section refers to them generically as the dev, stage, and prod Service Networks.

## Why Foundation comes first

Foundation is sequenced first because **every other resource in the pattern attaches to a Service Network that does not yet exist until this phase runs**. The dependency is concrete, not conceptual:

- **Phase 2 (Shared Endpoints)** and **Phase 3 (Centralized Egress)** create Resource Configurations and associate each one to all three Service Networks through a `ServiceNetworkResourceAssociation`. That association needs the Service Network IDs as inputs. In the CDK, this is explicit: `VpcLatticeCoreStack` exports `serviceNetworkIds` (dev/stage/prod), and both the endpoints stack and the egress stack consume those IDs and declare `addDependency(coreStack)`.
- **Phase 4 (Workload Onboarding)** associates each workload VPC to the Service Network for its environment. A workload account cannot associate to, or even discover, a network that has not been created and shared to its OU.

Because of this, the Service Networks and their RAM shares must exist before any endpoint, proxy, or workload association can be deployed. (This satisfies the deployment-order rationale in requirement 4.4.) The RAM shares are created here as well, in the same phase, so that by the time you reach Phase 4 the share already exists and is waiting to be auto-accepted by onboarding accounts.

## Account context

| Item | Value |
|------|-------|
| Deployment target | **Network account** |
| Region | `us-east-2` (adjust if you deploy elsewhere) |
| Resources created | 3 Service Networks, 3 IAM auth policies (CloudFormation path), 3 RAM shares |
| Stack outputs consumed by | Phase 2 (endpoints), Phase 3 (egress), Phase 4 (workload onboarding) |

This phase deploys entirely to the Network account. The OUs that the RAM shares and auth policies reference are defined in the management account, but you do not deploy anything to the management account in this phase, you only need the OU ARNs and OU paths as input values.

## Prerequisites

The global prerequisites in [Prerequisites](02-prerequisites.md) must all be satisfied. The items below are the ones this phase depends on directly. Confirm them before you deploy:

- [ ] **AWS Organizations in all-features mode**, spanning the Network account and all workload accounts. All-features mode is required for the OU-scoped RAM sharing and for the IAM auth policy condition keys (`aws:PrincipalOrgID`, `aws:PrincipalOrgPaths`) that enforce environment isolation.
- [ ] **RAM sharing with AWS Organizations enabled.** Run this once from the management account if you have not already:

  ```bash
  aws ram enable-sharing-with-aws-organization
  ```

  Without it, a RAM share cannot target an OU as a principal, and workload accounts will not auto-accept the share during Phase 4.
- [ ] **The OU ARNs and OU paths for each environment are known.** You need the OU ARN for each environment (for the RAM share principal) and, for the CloudFormation path, the OU path for each environment (for the auth policy condition). An OU path looks like `o-EXAMPLE12345/r-EXAMPLE/ou-EXAMPLE-root/ou-EXAMPLE-env`.
- [ ] **Deployment IAM capability in the Network account** to create VPC Lattice Service Networks and auth policies, and to create RAM resource shares. (CDK path additionally requires `cdk bootstrap` in the Network account and Region.)

## Step 1, Create the three Service Networks with IAM auth

Create one Service Network per environment, each with `AuthType: AWS_IAM`. The auth type is what makes the network evaluate an IAM auth policy on every invoke; without it, the OU-path restriction described below would have nothing to attach to. Each network is tagged with its `Environment` so cost allocation and inventory tooling can distinguish dev, stage, and prod. (This addresses requirement 6.1.)

In the CDK, the three networks are created as low-level `CfnResource`s of type `AWS::VpcLattice::ServiceNetwork`:

```typescript
// cdk/lib/vpc-lattice-core-stack.ts
const snDev = new cdk.CfnResource(this, 'ServiceNetworkDev', {
  type: 'AWS::VpcLattice::ServiceNetwork',
  properties: {
    Name: 'sn-dev-shared',
    AuthType: 'AWS_IAM',
    Tags: [{ Key: 'Environment', Value: 'dev' }],
  },
});
// snStage ('sn-stage-shared') and snProd ('sn-prod-shared') follow the same shape
```

The CloudFormation template declares the same resource type with the equivalent properties:

```yaml
# cloudformation/vpc-lattice-resource-gateways.yaml
DevServiceNetwork:
  Type: AWS::VpcLattice::ServiceNetwork
  Properties:
    Name: sn-dev-shared
    AuthType: AWS_IAM
    Tags:
      - Key: Name
        Value: sn-dev-shared
      - Key: Environment
        Value: dev
```

### The IAM auth policy: restrict invoke by OU path

`AuthType: AWS_IAM` enables policy evaluation, but the actual restriction lives in the auth policy attached to the network. The policy allows the VPC Lattice invoke action **only when the calling principal satisfies two conditions at once**:

- `aws:PrincipalOrgID` (a `StringEquals` match) confirms the principal belongs to *this* Organization at all, and
- `aws:PrincipalOrgPaths` (a `ForAnyValue:StringLike` match) confirms the principal lives in *one of this environment's OU paths*.

The representative policy below is the dev network's auth policy from the CloudFormation `DevServiceNetworkAuthPolicy`. Note that it permits **three OU paths** per environment, the Program, Supporter, and Corporate dev OUs, so a single environment can span multiple OUs in the org tree. The `/*` suffix on each path matches the OU and everything nested beneath it.

```json
{
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": "*",
      "Action": "vpc-lattice-svcs:Invoke",
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:PrincipalOrgID": "o-EXAMPLE12345"
        },
        "ForAnyValue:StringLike": {
          "aws:PrincipalOrgPaths": [
            "o-EXAMPLE12345/r-EXAMPLE/ou-EXAMPLE-root/ou-program-dev/*",
            "o-EXAMPLE12345/r-EXAMPLE/ou-EXAMPLE-root/ou-supporter-dev/*",
            "o-EXAMPLE12345/r-EXAMPLE/ou-EXAMPLE-root/ou-corporate-dev/*"
          ]
        }
      }
    }
  ]
}
```

In CloudFormation this is an `AWS::VpcLattice::AuthPolicy` resource that references the Service Network and substitutes the OU-path parameters:

```yaml
# cloudformation/vpc-lattice-resource-gateways.yaml
DevServiceNetworkAuthPolicy:
  Type: AWS::VpcLattice::AuthPolicy
  Properties:
    ResourceIdentifier: !Ref DevServiceNetwork
    Policy:
      Statement:
        - Effect: Allow
          Principal: '*'
          Action: vpc-lattice-svcs:Invoke
          Resource: '*'
          Condition:
            StringEquals:
              aws:PrincipalOrgID: !Ref OrgId
            ForAnyValue:StringLike:
              aws:PrincipalOrgPaths:
                - !Sub '${ProgramDevOuPath}/*'
                - !Sub '${SupporterDevOuPath}/*'
                - !Sub '${CorporateDevOuPath}/*'
```

The stage and prod networks carry the same policy shape, differing only in the OU paths they permit (`ProgramStageOuPath`/`SupporterStageOuPath`/`CorporateStageOuPath` and the corresponding prod paths). The practical effect: a principal in a dev OU is allowed by the dev network and denied by the prod network, because its org path matches no prod OU path.

> **Important difference between the two IaC paths.** The CDK `VpcLatticeCoreStack` creates the three Service Networks with `AuthType: AWS_IAM` and creates the RAM shares, but it does **not** attach explicit `AWS::VpcLattice::AuthPolicy` resources. The explicit, OU-path auth policies shown above are defined only in the CloudFormation template (`vpc-lattice-resource-gateways.yaml`). If you deploy the CDK path, the networks will exist with IAM auth enabled but **without** the OU-path restriction until you add it. Treat the CloudFormation template as the more complete reference for the auth policies, and either add equivalent `AWS::VpcLattice::AuthPolicy` resources to the CDK stack or apply the policies out of band (for example, with `aws vpc-lattice put-auth-policy`) before relying on environment isolation. Do not assume the CDK stack enforces the OU-path restriction on its own.

## Step 2, Share each Service Network to its OUs with RAM

Each Service Network is shared with `AWS::RAM::ResourceShare`, and every share sets **`AllowExternalPrincipals: false`** so a network can never be shared outside the Organization. The principal of each share is an OU ARN (or several), not the Organization root; this is what scopes connectivity to a specific environment rather than to the whole org. (This addresses requirement 6.2.)

The two IaC paths differ in how many OUs they target per environment:

| Aspect | CDK (`VpcLatticeCoreStack`) | CloudFormation (`vpc-lattice-resource-gateways.yaml`) |
|--------|------------------------------|--------------------------------------------------------|
| Share resource | `ram.CfnResourceShare` per env | `AWS::RAM::ResourceShare` per env |
| External principals | `allowExternalPrincipals: false` | `AllowExternalPrincipals: false` |
| Principals per env | **One OU ARN** (`devOuArn` / `stageOuArn` / `prodOuArn`) | **Three OU ARNs** (Program / Supporter / Corporate per env) |
| Example share name | `vpc-lattice-sn-dev-share` | `sn-dev-shared-ram` |

The CDK shares each network to a single OU ARN supplied as a stack prop:

```typescript
// cdk/lib/vpc-lattice-core-stack.ts
new ram.CfnResourceShare(this, 'RamShareDev', {
  name: 'vpc-lattice-sn-dev-share',
  allowExternalPrincipals: false,
  principals: [props.devOuArn],
  resourceArns: [snDev.getAtt('Arn').toString()],
});
// RamShareStage -> props.stageOuArn, RamShareProd -> props.prodOuArn
```

The CloudFormation template shares each environment's network to **three** OU ARNs, matching the three OU paths in the auth policy:

```yaml
# cloudformation/vpc-lattice-resource-gateways.yaml
DevRAMShare:
  Type: AWS::RAM::ResourceShare
  Properties:
    Name: sn-dev-shared-ram
    AllowExternalPrincipals: false
    ResourceArns:
      - !Ref DevServiceNetwork
    Principals:
      - !Ref ProgramDevOuArn
      - !Ref SupporterDevOuArn
      - !Ref CorporateDevOuArn
```

Both approaches are correct; they reflect a difference in how many OUs make up an "environment" in each reference deployment. If your environments map to a single OU each, the CDK shape is sufficient; if an environment spans multiple OUs, follow the CloudFormation shape and list every OU ARN for that environment, keeping the auth policy's OU paths in sync with the share's OU principals.

**Auto-accept depends on RAM org sharing.** Because `aws ram enable-sharing-with-aws-organization` was run as a prerequisite, accounts that belong to a targeted OU auto-accept the share rather than receiving a manual invitation. That is why a workload account in Phase 4 can associate its VPC immediately, with no human in the loop on the share acceptance. The workload side of this flow, discovery, association, and auto-accept behavior, is covered in [Phase 4: Workload Onboarding](07-phase4-workload-onboarding.md).

## IaC reference

This phase corresponds to the core stack (CDK) or the service-network portion of the combined template (CloudFormation). Choose one path.

### CDK path

The relevant stack is `VpcLatticeCoreStack` in `cdk/lib/vpc-lattice-core-stack.ts`, instantiated in `cdk/bin/app.ts` with context props `orgId`, `devOuArn`, `stageOuArn`, and `prodOuArn`. Supply those values as CDK context, either inline with `-c` or in `cdk.json`, then deploy:

```bash
cd cdk
npx cdk deploy VpcLatticeCoreStack \
  -c orgId=o-EXAMPLE12345 \
  -c devOuArn=arn:aws:organizations::111111111111:ou/o-EXAMPLE12345/ou-EXAMPLE-dev \
  -c stageOuArn=arn:aws:organizations::111111111111:ou/o-EXAMPLE12345/ou-EXAMPLE-stage \
  -c prodOuArn=arn:aws:organizations::111111111111:ou/o-EXAMPLE12345/ou-EXAMPLE-prod
```

The stack exports `serviceNetworkIds` (dev/stage/prod) as both a TypeScript property and CloudFormation outputs (`ServiceNetworkDevId`, `ServiceNetworkStageId`, `ServiceNetworkProdId`). The endpoints stack and the egress stack consume these IDs and depend on this stack, so deploy it first. Remember that the CDK path does not attach the OU-path auth policies, add them as described in Step 1.

### CloudFormation path

`cloudformation/vpc-lattice-resource-gateways.yaml` is a **combined, single-template** alternative. Unlike the CDK, which splits core (Phase 1) and endpoints (Phase 2) into separate stacks, this one template includes the Service Networks, the OU-path auth policies, the RAM shares, **and** the endpoint Resource Gateway and Resource Configurations. Deploying it creates the foundation and the shared endpoints together; if you want a strict phase-by-phase rollout, the CDK split maps more cleanly to the per-phase boundaries.

A representative deployment passes the OrgId plus the per-environment OU ARN and OU path parameters:

```bash
aws cloudformation deploy \
  --region us-east-2 \
  --stack-name vpc-lattice-foundation \
  --template-file cloudformation/vpc-lattice-resource-gateways.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    OrgId=o-EXAMPLE12345 \
    ProgramDevOuArn=arn:aws:organizations::111111111111:ou/o-EXAMPLE12345/ou-program-dev \
    ProgramDevOuPath=o-EXAMPLE12345/r-EXAMPLE/ou-EXAMPLE-root/ou-program-dev \
    SupporterDevOuArn=arn:aws:organizations::111111111111:ou/o-EXAMPLE12345/ou-supporter-dev \
    SupporterDevOuPath=o-EXAMPLE12345/r-EXAMPLE/ou-EXAMPLE-root/ou-supporter-dev \
    CorporateDevOuArn=arn:aws:organizations::111111111111:ou/o-EXAMPLE12345/ou-corporate-dev \
    CorporateDevOuPath=o-EXAMPLE12345/r-EXAMPLE/ou-EXAMPLE-root/ou-corporate-dev \
    ProgramStageOuArn=... ProgramStageOuPath=... \
    SupporterStageOuArn=... SupporterStageOuPath=... \
    CorporateStageOuArn=... CorporateStageOuPath=... \
    ProgramProdOuArn=... ProgramProdOuPath=... \
    SupporterProdOuArn=... SupporterProdOuPath=... \
    CorporateProdOuArn=... CorporateProdOuPath=...
```

The template also defaults its VPC, subnet, and security group parameters to LZA `/accelerator/network/...` SSM paths (used by the endpoint portion); see [Prerequisites](02-prerequisites.md) if you are not using LZA.

## Expected outcome

After this phase completes, the Network account contains:

- **Three Service Networks** (dev, stage, prod), each with `AuthType: AWS_IAM` and an `Environment` tag.
- **OU-scoped IAM auth policies** attached to each network restricting `vpc-lattice-svcs:Invoke` to principals in the matching org and OU paths, present automatically on the **CloudFormation** path; on the **CDK** path, present only after you add the equivalent `AWS::VpcLattice::AuthPolicy` resources or apply them out of band.
- **Three RAM shares**, each with `AllowExternalPrincipals: false`, targeting the correct OU(s) per environment (one OU ARN per env in CDK; three per env in CloudFormation).
- **Service Network IDs available as stack outputs**, ready to be consumed by the Phase 2 endpoints stack and the Phase 3 egress stack.

(This satisfies the expected-outcome requirement 4.2.)

### Verification

Confirm the foundation before moving on:

```bash
# Three networks exist, each AuthType AWS_IAM
aws vpc-lattice list-service-networks --region us-east-2

# Inspect the auth policy on a network (use an ARN/ID from the list above)
aws vpc-lattice get-auth-policy \
  --resource-identifier <service-network-arn> --region us-east-2

# Three RAM shares exist, scoped to OUs, external principals disabled
aws ram get-resource-shares \
  --resource-owner SELF --region us-east-2

# Confirm each share's principals are the expected OU ARNs
aws ram list-principals \
  --resource-owner SELF --region us-east-2
```

Also check, in the console:

- **VPC Lattice → Service networks**: three networks listed with IAM auth.
- **RAM → Shared by me**: three resource shares, each listing OU ARNs as principals and "Allow external accounts" set to off.
- On the CDK path, **CloudFormation → VpcLatticeCoreStack → Outputs**: the three Service Network IDs.

If the auth policy is missing on the CDK path, that is expected; revisit Step 1 and attach it before workloads begin invoking through the networks.

Continue to [Phase 2: Shared Endpoints](05-phase2-shared-endpoints.md).
