# Phase 2: Shared Endpoints

[Phase 1: Foundation](04-phase1-foundation.md) created the three Service Networks, attached their OU-scoped IAM auth policies, and configured the RAM shares, the bottom of the stack that everything else attaches to. This phase builds the first thing that attaches to those networks: the shared AWS service endpoints. It deploys a **Resource Gateway** into the Endpoint VPC and a **Resource Configuration** for each interface VPC endpoint, then associates every Resource Configuration to all three Service Networks so dev, test, and prod workloads reach the same shared endpoints.

This is the phase that turns "a handful of interface endpoints in one VPC" into "every workload account can resolve and reach `ssm.us-east-2.amazonaws.com` privately, with no per-account endpoint." The mechanism that makes it self-healing, resolving each endpoint's regional DNS name at deploy time rather than hardcoding it, is also introduced here; both IaC paths do this natively, with no Lambda.

> **A note on conventions.** As elsewhere in this guide, examples use the `us-east-2` Region and placeholder identifiers (organization ID `o-EXAMPLE12345`, account `111111111111`). The reference IaC names the endpoint Resource Gateway `endpoint-resource-gateway` in the CDK path and `endpoint-resource-gw` in the CloudFormation path; this section refers to it generically as the endpoint Resource Gateway.

## Why Shared Endpoints comes after Foundation

This phase depends on Phase 1 for one concrete reason: **every Resource Configuration it creates is associated to all three Service Networks, and that association needs the Service Network IDs as inputs.** Those IDs do not exist until the Foundation phase has run. (This satisfies the dependency rationale in requirements 4.4 and 4.1.)

In the CDK path the dependency is explicit and enforced by the framework:

- `VpcLatticeCoreStack` (Phase 1) exports `serviceNetworkIds` for dev, test, and prod.
- `VpcLatticeEndpointsStack` (this phase) consumes those IDs through its `serviceNetworkIds` prop and declares `addDependency(coreStack)`, so CloudFormation will not deploy the endpoints stack until the core stack is complete.

In the CloudFormation path the two phases live in the **same combined template** (`vpc-lattice-resource-gateways.yaml`), so the Service Networks and the endpoint resources are created in a single deployment, with intra-template `!GetAtt` references handling the ordering. If you want a strict phase-by-phase rollout that mirrors this guide, the CDK split maps more cleanly; the combined template is the convenient single-deploy alternative.

## Account context

| Item | Value |
|------|-------|
| Deployment target | **Network account**, into the **Endpoint VPC** |
| Region | `us-east-2` (adjust if you deploy elsewhere) |
| Depends on | [Phase 1: Foundation](04-phase1-foundation.md), needs the three Service Network IDs |
| Resources created | 1 endpoint Resource Gateway, 10 Resource Configurations (CDK) / 11 (CloudFormation), one `ServiceNetworkResourceAssociation` per RC per Service Network |
| Stack outputs consumed by | Phase 4 (workloads resolve these endpoints after association) |

Everything in this phase deploys to the Network account, specifically into the Endpoint VPC that holds the pre-deployed interface VPC endpoints. No deployment touches the management account or any workload account in this phase.

## Prerequisites

The global prerequisites in [Prerequisites](02-prerequisites.md) must be satisfied. The items below are the ones this phase depends on directly:

- [ ] **Phase 1 is complete**, and the three Service Network IDs are available, as CDK stack outputs (`ServiceNetworkDevId`, `ServiceNetworkTestId`, `ServiceNetworkProdId`) on the CDK path, or created in the same template on the CloudFormation path.
- [ ] **The Endpoint VPC, two Resource Gateway subnets, and the Resource Gateway security group exist**, and their IDs are published to the `/netfabric/network/...` SSM paths (or your equivalent if you re-pointed the IaC to a different prefix such as LZA's `/accelerator/network/...`). The IaC resolves these at deploy time rather than hardcoding them.
- [ ] **Resource Gateway subnets are a minimum of /24.** The Resource Gateway provisions elastic network interfaces (ENIs) in these subnets and scales them with connection volume; undersized subnets risk IP exhaustion and intermittent failures. (See [subnet sizing](02-prerequisites.md#3-subnet-sizing-requirements); this is requirement 9.3.)
- [ ] **The interface VPC endpoints already exist in the Endpoint VPC.** This phase wires them in by their regional DNS name; it does not create them. The implementation expects the 10 endpoints listed below (11 on the CloudFormation path).
- [ ] **Deployment IAM capability in the Network account** to create VPC Lattice Resource Gateways, Resource Configurations, and Service Network associations; and to read the `/netfabric/network/...` SSM parameters (or your equivalent SSM prefix). (CDK path additionally requires `cdk bootstrap`.)

## Step 1, Deploy the Resource Gateway in the Endpoint VPC

The Resource Gateway is the ingress point that lets Resource Configurations route traffic to the interface endpoints inside the Endpoint VPC. It is an `AWS::VpcLattice::ResourceGateway` deployed across **two subnets** (one per Availability Zone) with **one security group**, and its `VpcIdentifier` is the Endpoint VPC. The VPC, subnet, and security group IDs are all resolved from LZA SSM parameters, not hardcoded.

In the CDK, the IDs are resolved with `ssm.StringParameter.valueForStringParameter`, then passed into a low-level `CfnResource`:

```typescript
// cdk/lib/vpc-lattice-endpoints-stack.ts
const endpointVpcId = ssm.StringParameter.valueForStringParameter(this, props.endpointVpcSsmPath);
const subnetAId = ssm.StringParameter.valueForStringParameter(this, props.endpointSubnetASsmPath);
const subnetBId = ssm.StringParameter.valueForStringParameter(this, props.endpointSubnetBSsmPath);
const sgId = ssm.StringParameter.valueForStringParameter(this, props.endpointSgSsmPath);

const resourceGateway = new cdk.CfnResource(this, 'EndpointResourceGateway', {
  type: 'AWS::VpcLattice::ResourceGateway',
  properties: {
    Name: 'endpoint-resource-gateway',
    VpcIdentifier: endpointVpcId,
    SubnetIds: [subnetAId, subnetBId],
    SecurityGroupIds: [sgId],
  },
});
```

The CloudFormation template declares the same resource type, resolving the IDs from SSM-typed parameters and setting `IpAddressType: IPV4` explicitly:

```yaml
# cloudformation/vpc-lattice-resource-gateways.yaml
EndpointResourceGateway:
  Type: AWS::VpcLattice::ResourceGateway
  Properties:
    Name: endpoint-resource-gw
    VpcIdentifier: !Ref EndpointVpcId
    SubnetIds:
      - !Ref EndpointSubnetAId
      - !Ref EndpointSubnetBId
    SecurityGroupIds:
      - !Ref EndpointSecurityGroupId
    IpAddressType: IPV4
    Tags:
      - Key: Name
        Value: endpoint-resource-gw
```

> **A small but honest difference.** The CloudFormation Resource Gateway sets `IpAddressType: IPV4` explicitly; the CDK `CfnResource` omits it and relies on the service default. Both result in an IPv4 gateway in this reference. The `/24` subnet sizing from the prerequisites matters most here; this is the resource that consumes and scales ENIs in those subnets.

## Step 2, Provision interface VPC endpoints and wire their regional DNS into the Resource Configurations

A Resource Configuration's target is the *actual* DNS name of the interface endpoint behind the gateway, the endpoint's regional VPCE DNS name (for example, `vpce-0abc123.ssm.us-east-2.vpce.amazonaws.com`). Those names are generated by AWS when the endpoints are created and **change if an endpoint is replaced**. Hardcoding them would make the template brittle. The two IaC paths solve this differently, but they arrive at the same self-healing behavior.

### CDK path: read each VPCE's regional DNS natively from `attrDnsEntries`

The CDK stack creates each interface VPC endpoint with `PrivateDnsEnabled: false` (so the endpoint keeps its own regional DNS name and does not hijack the public service domain), then reads the endpoint's regional DNS name directly from its own `attrDnsEntries` attribute and passes that into the matching Resource Configuration. There is **no Lambda custom resource** in this path, `attrDnsEntries[0]` is a CloudFormation intrinsic of the form `<hostedZoneId>:<dnsName>`, and the CDK splits it natively with `Fn::Split`:

```typescript
// cdk/lib/vpc-lattice-endpoints-stack.ts (excerpt)
const vpce = new ec2.CfnVPCEndpoint(this, `Vpce-${ep.key}`, {
  vpcEndpointType: 'Interface',
  serviceName: `com.amazonaws.${this.region}.${ep.service}`,
  vpcId: endpointVpcId,
  subnetIds,
  securityGroupIds: [sgId],
  privateDnsEnabled: false,            // keep the endpoint's own regional DNS
  policyDocument: orgScopedPolicy,
});

// attrDnsEntries[0] is "<hostedZoneId>:<dnsName>"; take the dnsName half.
const vpceDnsName = cdk.Fn.select(1, cdk.Fn.split(':', cdk.Fn.select(0, vpce.attrDnsEntries)));

const rc = new cdk.CfnResource(this, `RC-${ep.key}`, {
  type: 'AWS::VpcLattice::ResourceConfiguration',
  properties: {
    Name: `${ep.key}-endpoint-rc`,
    ResourceConfigurationType: 'SINGLE',
    ProtocolType: 'TCP',
    ResourceGatewayId: resourceGateway.getAtt('Id'),
    CustomDomainName: `${ep.customDomain}.${this.region}.amazonaws.com`,  // workload-facing public domain
    ResourceConfigurationDefinition: {
      DnsResource: {
        DomainName: vpceDnsName,                                          // the VPCE's own regional DNS (the target)
        IpAddressType: 'IPV4',
      },
    },
    PortRanges: ['443'],
  },
});
```

The CDK path then associates each Resource Configuration with all three Service Networks with `PrivateDnsEnabled: true`, which is what triggers VPC Lattice to provision the managed Private Hosted Zone for `CustomDomainName` in associated workload VPCs.

### CloudFormation path: read VPCE DNS from SSM published by network-foundation

The CloudFormation template cannot split `attrDnsEntries` natively in a Resource Configuration property, so the work is split across the two templates and still stays fully native, with no Lambda. `cloudformation/network-foundation.yaml` (which owns the interface endpoints) publishes each endpoint's regional DNS name to SSM Parameter Store, computing the value from the endpoint's own `DnsEntries`:

```yaml
# cloudformation/network-foundation.yaml (excerpt)
SsmVpceDnsParam:
  Type: AWS::SSM::Parameter
  Properties:
    Name: /netfabric/network/endpoint-vpc/vpce/ssm/dns
    Type: String
    # DnsEntries[0] is "<hostedZoneId>:<dnsName>"; take the dnsName half.
    Value: !Select [1, !Split [":", !Select [0, !GetAtt SsmVpceEndpoint.DnsEntries]]]
```

`cloudformation/vpc-lattice-resource-gateways.yaml` then declares one `AWS::SSM::Parameter::Value<String>` parameter per endpoint (for example `SsmVpceDns`, `StsVpceDns`, `EcrApiVpceDns`), each defaulting to the matching `/netfabric/network/endpoint-vpc/vpce/<key>/dns` path, and each Resource Configuration's `DnsResource.DomainName` is a plain `!Ref` to that parameter:

```yaml
# cloudformation/vpc-lattice-resource-gateways.yaml (excerpt)
Parameters:
  SsmVpceDns:
    Type: AWS::SSM::Parameter::Value<String>
    Default: /netfabric/network/endpoint-vpc/vpce/ssm/dns

# ...

SsmResourceConfig:
  Type: AWS::VpcLattice::ResourceConfiguration
  Properties:
    Name: ssm-endpoint-rc
    CustomDomainName: ssm.us-east-2.amazonaws.com        # workload-facing public domain
    ResourceConfigurationType: SINGLE
    ResourceGatewayId: !GetAtt EndpointResourceGateway.Id
    PortRanges:
      - '443'
    ProtocolType: TCP
    ResourceConfigurationDefinition:
      DnsResource:
        DomainName: !Ref SsmVpceDns                      # VPCE regional DNS from SSM (the target)
        IpAddressType: IPV4
```

At deploy time CloudFormation resolves each `AWS::SSM::Parameter::Value<String>` parameter to the current value `network-foundation.yaml` published from `DnsEntries`, so the Resource Configuration always points at the endpoint's live regional DNS name. There is no `ec2:DescribeVpcEndpoints` call, no IAM role, and no custom resource: the value is computed once from `DnsEntries` in the foundation template and read by reference in the gateways template.

### Why both approaches self-heal

In both paths, the VPCE regional DNS name is **resolved at deploy time rather than written down**. If an interface endpoint is deleted and recreated and its regional DNS changes, simply redeploying the stacks re-resolves the correct target, through `attrDnsEntries` in the CDK path or the SSM parameter that `network-foundation.yaml` recomputes from `DnsEntries` in the CloudFormation path, and re-wires it. There is nothing to update by hand and no stale value to drift. This is the design rationale behind preferring dynamic resolution over a static list of DNS names. (This addresses requirement 8.3 and the design's self-healing rationale.)

## Step 3, Create a Resource Configuration per endpoint and associate to all three Service Networks

With the gateway in place and the DNS names discovered, the stack iterates a list of endpoints and, for each one, creates an `AWS::VpcLattice::ResourceConfiguration` and then a `ServiceNetworkResourceAssociation` to **each of the three Service Networks**. Each RC is a `SINGLE`-type configuration with `PortRanges: ['443']`, `Protocol: TCP`, and a `DnsResource` whose `IpAddressType` is `IPV4`.

The CDK defines the endpoint list as an array of `{ name, domain }` and loops over it:

```typescript
// cdk/lib/vpc-lattice-endpoints-stack.ts
const endpoints = [
  { name: 'ssm',           domain: 'ssm' },
  { name: 'ssmmessages',   domain: 'ssmmessages' },
  { name: 'ec2messages',   domain: 'ec2messages' },
  { name: 'sts',           domain: 'sts' },
  { name: 'ecr-api',       domain: 'api.ecr' },
  { name: 'ecr-dkr',       domain: 'dkr.ecr' },
  { name: 'logs',          domain: 'logs' },
  { name: 'ecs',           domain: 'ecs' },
  { name: 'ecs-agent',     domain: 'ecs-agent' },
  { name: 'ecs-telemetry', domain: 'ecs-telemetry' },
];

for (const ep of endpoints) {
  const rc = new cdk.CfnResource(this, `RC-${ep.name}`, {
    type: 'AWS::VpcLattice::ResourceConfiguration',
    properties: {
      Name: `${ep.name}-endpoint-rc`,
      ResourceGatewayIdentifier: resourceGateway.getAtt('Id'),
      ResourceConfigurationDefinition: {
        DnsResource: {
          DomainName: `${ep.domain}.${this.region}.amazonaws.com`,
          IpAddressType: 'IPV4',
        },
      },
      PortRanges: ['443'],
      Protocol: 'TCP',
    },
  });

  for (const [envName, snId] of Object.entries(props.serviceNetworkIds)) {
    new cdk.CfnResource(this, `RCAssoc-${ep.name}-${envName}`, {
      type: 'AWS::VpcLattice::ServiceNetworkResourceAssociation',
      properties: {
        ServiceNetworkIdentifier: snId,
        ResourceConfigurationIdentifier: rc.getAtt('Id'),
      },
    });
  }
}
```

### The 10 endpoints (CDK), with an 11th in CloudFormation

| # | Endpoint (`name`) | Service domain pattern (`{domain}.us-east-2.amazonaws.com`) | Normalized service key (CFN SSM parameter) |
|---|-------------------|-------------------------------------------------------------|------------------------|
| 1 | `ssm` | `ssm.us-east-2.amazonaws.com` | `ssm` |
| 2 | `ssmmessages` | `ssmmessages.us-east-2.amazonaws.com` | `ssmmessages` |
| 3 | `ec2messages` | `ec2messages.us-east-2.amazonaws.com` | `ec2messages` |
| 4 | `sts` | `sts.us-east-2.amazonaws.com` | `sts` |
| 5 | `ecr-api` | `api.ecr.us-east-2.amazonaws.com` | `ecr_api` |
| 6 | `ecr-dkr` | `dkr.ecr.us-east-2.amazonaws.com` | `ecr_dkr` |
| 7 | `logs` | `logs.us-east-2.amazonaws.com` | `logs` |
| 8 | `ecs` | `ecs.us-east-2.amazonaws.com` | `ecs` |
| 9 | `ecs-agent` | `ecs-agent.us-east-2.amazonaws.com` | `ecs_agent` |
| 10 | `ecs-telemetry` | `ecs-telemetry.us-east-2.amazonaws.com` | `ecs_telemetry` |
| 11 | `execute-api` *(CloudFormation only)* | `execute-api.us-east-2.amazonaws.com` | `execute_api` |

The CDK path exposes the **10** endpoints above. The CloudFormation template adds an **11th**, `execute-api`, for workloads that call API Gateway privately. If you need `execute-api` on the CDK path, add it to the `endpoints` array.

### An important accuracy nuance: where the VPCE DNS name actually gets wired in

The two IaC paths arrive at the same wiring through different mechanisms, but the end result is identical: each Resource Configuration's `DnsResource.DomainName` is the interface VPC endpoint's **regional DNS name**, while `CustomDomainName` is the **public service domain** that workloads resolve. Each `ServiceNetworkResourceAssociation` sets `PrivateDnsEnabled: true` so VPC Lattice provisions the managed Private Hosted Zone for `CustomDomainName` in associated workload VPCs.

| Attribute | CDK (`VpcLatticeEndpointsStack`) | CloudFormation (`vpc-lattice-resource-gateways.yaml`) |
|-----------|----------------------------------|--------------------------------------------------------|
| `DnsResource.DomainName` (RC target) | VPCE regional DNS read natively from `attrDnsEntries` | VPCE regional DNS read from SSM: `!Ref SsmVpceDns` (published by `network-foundation.yaml` from `DnsEntries`) |
| `CustomDomainName` | Public service domain: `${customDomain}.${region}.amazonaws.com` | Public service domain: `!Sub <service>.${AWS::Region}.amazonaws.com` |
| `ResourceConfigurationType` | Explicit `SINGLE` | Explicit `SINGLE` |
| Port / protocol | `PortRanges: ['443']`, `ProtocolType: TCP` | `PortRanges: ['443']`, `ProtocolType: TCP` |
| Association `PrivateDnsEnabled` | `true` | `true` |
| Endpoints exposed | 10 | 11 (adds `execute-api`) |
| VPCE DNS discovery mechanism | Native `attrDnsEntries` split with `Fn::Split` | Native SSM: `network-foundation.yaml` publishes `DnsEntries` to SSM, read via `AWS::SSM::Parameter::Value<String>` |

**Both paths are functionally equivalent for the workload-facing behavior.** Neither path requires a Lambda; each resolves the VPCE regional DNS natively (the CDK path splits `attrDnsEntries`, the CloudFormation path reads an SSM parameter that `network-foundation.yaml` computed from `DnsEntries`). Choose the path that fits your IaC tooling, the runtime DNS resolution behavior, the `PrivateDnsEnabled` semantics, and the self-healing properties are the same.

The CloudFormation RC + association shape, for one endpoint:

```yaml
# cloudformation/vpc-lattice-resource-gateways.yaml
SsmResourceConfig:
  Type: AWS::VpcLattice::ResourceConfiguration
  Properties:
    Name: ssm-endpoint-rc
    CustomDomainName: ssm.us-east-2.amazonaws.com        # workload-facing public domain
    ResourceConfigurationType: SINGLE
    ResourceGatewayId: !GetAtt EndpointResourceGateway.Id
    PortRanges:
      - '443'
    ProtocolType: TCP
    ResourceConfigurationDefinition:
      DnsResource:
        DomainName: !Ref SsmVpceDns                      # VPCE regional DNS from SSM (the target)
        IpAddressType: IPV4

SsmSNAssocDev:
  Type: AWS::VpcLattice::ServiceNetworkResourceAssociation
  Properties:
    ServiceNetworkId: !GetAtt DevServiceNetwork.Id
    ResourceConfigurationId: !GetAtt SsmResourceConfig.Id
    PrivateDnsEnabled: true
# ...SsmSNAssocTest and SsmSNAssocProd repeat for the test and prod Service Networks
```

### How this ties into the DNS resolution path

The VPCE regional DNS name read from SSM is the **target at the far end of the resolution path** described in [Architecture](03-architecture.md#privatednsenabled-behavior-and-automatic-private-hosted-zone-creation) (requirement 8.3). When a workload later resolves a public service domain such as `ssm.us-east-2.amazonaws.com`, the Lattice-managed Private Hosted Zone returns a VPC Lattice IP; the workload connects to that IP; traffic routes through the endpoint Resource Gateway ENI in the Endpoint VPC; and the gateway forwards to the RC's `DnsResource` target, the **interface VPC endpoint's regional DNS name that `network-foundation.yaml` published to SSM from `DnsEntries`**. In other words, the value this phase wires into each RC is the last hop before the AWS service itself. (`PrivateDnsEnabled: true` on the association, present on the CloudFormation path, is what causes Lattice to create that Private Hosted Zone for the RC's custom domain.)

## IaC reference

This phase corresponds to the endpoints stack (CDK) or the endpoint portion of the combined template (CloudFormation). (This addresses requirement 4.3.)

### CDK path

The relevant stack is `VpcLatticeEndpointsStack` in `cdk/lib/vpc-lattice-endpoints-stack.ts`. Its props supply the four SSM paths and the Service Network IDs from the core stack:

```typescript
// props consumed by VpcLatticeEndpointsStack
endpointVpcSsmPath: string;       // SSM path to the Endpoint VPC ID
endpointSubnetASsmPath: string;   // SSM path to Resource Gateway subnet A
endpointSubnetBSsmPath: string;   // SSM path to Resource Gateway subnet B
endpointSgSsmPath: string;        // SSM path to the Resource Gateway security group
serviceNetworkIds: { dev: string; test: string; prod: string };  // from VpcLatticeCoreStack
```

The stack declares `addDependency(coreStack)`, so the core stack (Phase 1) must deploy first. Deploy this phase with:

```bash
cd cdk
npx cdk deploy VpcLatticeEndpointsStack
```

It outputs `ResourceGatewayId` for use in verification and downstream references.

### CloudFormation path

The endpoint Resource Gateway, the 11 Resource Configurations, and the Service Network associations (`PrivateDnsEnabled: true`) all live in the combined `cloudformation/vpc-lattice-resource-gateways.yaml`, the same template that creates the Service Networks in Phase 1. Deploying that template (see the [Phase 1 CloudFormation deployment command](04-phase1-foundation.md#cloudformation-path)) creates the foundation and the shared endpoints together. Each Resource Configuration's `DnsResource.DomainName` is an `AWS::SSM::Parameter::Value<String>` parameter that resolves to the regional DNS name `cloudformation/network-foundation.yaml` published from the endpoint's `DnsEntries`, so the targets are read fresh on every deployment with no value to hardcode.

## Expected outcome

After this phase completes, the Network account's Endpoint VPC contains: (this addresses the expected-outcome requirement 4.2)

- **One endpoint Resource Gateway** (`endpoint-resource-gateway` in CDK / `endpoint-resource-gw` in CloudFormation), healthy and active, with ENIs in the two Resource Gateway subnets.
- **10 Resource Configurations** on the CDK path (`11` on the CloudFormation path, including `execute-api`), each of type `SINGLE`, on port `443`/`TCP`.
- **A `ServiceNetworkResourceAssociation` for every RC to each of the three Service Networks**, with `PrivateDnsEnabled: true`, so dev, test, and prod all reach the same shared endpoints.
- **Each RC's `DnsResource.DomainName` is the interface endpoint's regional VPCE DNS name**, resolved natively from `attrDnsEntries` (CDK) or from the SSM parameter that `network-foundation.yaml` published from `DnsEntries` (CloudFormation).

### Verification

Confirm the gateway, the configurations, and the DNS wiring before moving on:

```bash
# The endpoint Resource Gateway exists and is ACTIVE
aws vpc-lattice list-resource-gateways --region us-east-2

# The Resource Configurations exist (expect 10 on CDK, 11 on CloudFormation)
aws vpc-lattice list-resource-configurations --region us-east-2

# For a given RC, confirm it is associated to all three Service Networks
aws vpc-lattice list-service-network-resource-associations \
  --resource-configuration-identifier <rc-id> --region us-east-2

# Confirm the VPCE regional DNS is wired into each RC's DnsResource.DomainName
aws vpc-lattice get-resource-configuration \
  --resource-configuration-identifier <rc-id> --region us-east-2 \
  --query 'ResourceConfigurationDefinition.DnsResource'

# CloudFormation path only, confirm network-foundation published the VPCE DNS to SSM
aws ssm get-parameter --name /netfabric/network/endpoint-vpc/vpce/ssm/dns \
  --region us-east-2 --query 'Parameter.Value' --output text
```

Also check, in the console:

- **VPC Lattice → Resource gateways**: the endpoint Resource Gateway listed as **Active**, in the Endpoint VPC, across two subnets.
- **VPC Lattice → Resource configurations**: 10 (CDK) or 11 (CloudFormation) configurations, each on port 443/TCP, each associated to the dev, test, and prod Service Networks with `PrivateDnsEnabled: true`.
- **CloudFormation path only, Systems Manager → Parameter Store**: the parameters `/netfabric/network/endpoint-vpc/vpce/<key>/dns` exist (one per endpoint) and each holds the matching interface endpoint's regional VPCE DNS name.

If the Resource Gateway is stuck or unhealthy, the most common cause is subnet IP exhaustion, confirm the Resource Gateway subnets are /24 or larger, as the prerequisites require. On the CloudFormation path, if a Resource Configuration has the wrong or an empty DNS target, confirm the `/netfabric/network/endpoint-vpc/vpce/<key>/dns` SSM parameters exist and that the corresponding interface endpoints exist in the Endpoint VPC and are healthy (each parameter value is computed by `network-foundation.yaml` from the endpoint's `DnsEntries`). On the CDK path, each Resource Configuration is wired directly to its endpoint's `attrDnsEntries`, so the same diagnosis is "is the endpoint healthy in the Endpoint VPC?"

Continue to [Phase 3: Centralized Egress](06-phase3-centralized-egress.md).
