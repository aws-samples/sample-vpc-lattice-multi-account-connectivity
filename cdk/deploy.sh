#!/usr/bin/env bash
#
# One-command rollout of the VPC Lattice multi-account reference architecture.
#
# CDK stacks are bound to specific accounts, so a single `cdk deploy --all`
# cannot span the Network, Management, and Workload accounts with one set of
# credentials. This script deploys each group with the right profile, in
# dependency order, and builds the Squid image between the egress stacks.
#
# Usage:
#   NETWORK_PROFILE=net MGMT_PROFILE=mgmt WORKLOAD_PROFILE=wl ./deploy.sh
#
# Optional environment variables:
#   ENVIRONMENT      Workload environment to deploy: dev (default), test, or prod.
#   REGION           AWS region (default us-east-2).
#   DEPLOY_INGRESS   Set to "true" to also deploy the optional Phase 5 ingress.
#
set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:-dev}"
REGION="${REGION:-us-east-2}"
: "${NETWORK_PROFILE:?set NETWORK_PROFILE to the Network account profile}"
: "${MGMT_PROFILE:?set MGMT_PROFILE to the Management account profile}"
: "${WORKLOAD_PROFILE:?set WORKLOAD_PROFILE to the Workload account profile}"

cd "$(dirname "$0")"
echo "== Installing and building =="
npm install
npm run build

echo "== Network account: foundation, service networks, endpoints, image build =="
AWS_PROFILE="$NETWORK_PROFILE" npx cdk deploy \
  NetworkFoundationStack VpcLatticeCoreStack VpcLatticeEndpointsStack SquidImageBuildStack \
  --require-approval never

echo "== Building the Squid image and waiting for it to finish =="
PROJECT=$(AWS_PROFILE="$NETWORK_PROFILE" aws cloudformation describe-stacks \
  --stack-name SquidImageBuildStack --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CodeBuildProjectName'].OutputValue" --output text)
BID=$(AWS_PROFILE="$NETWORK_PROFILE" aws codebuild start-build \
  --project-name "$PROJECT" --region "$REGION" --query 'build.id' --output text)
while true; do
  STATUS=$(AWS_PROFILE="$NETWORK_PROFILE" aws codebuild batch-get-builds \
    --ids "$BID" --region "$REGION" --query 'builds[0].buildStatus' --output text)
  echo "  squid image build: $STATUS"
  case "$STATUS" in
    SUCCEEDED) break ;;
    FAILED|FAULT|STOPPED|TIMED_OUT) echo "squid image build did not succeed"; exit 1 ;;
  esac
  sleep 15
done

echo "== Network account: Squid egress service =="
AWS_PROFILE="$NETWORK_PROFILE" npx cdk deploy SquidEgressStack --require-approval never

echo "== Workload account: foundation VPC (environment=$ENVIRONMENT) =="
AWS_PROFILE="$WORKLOAD_PROFILE" npx cdk deploy WorkloadFoundationStack \
  -c environment="$ENVIRONMENT" --require-approval never

echo "== Management account: service-managed StackSet (org-wide onboarding) =="
AWS_PROFILE="$MGMT_PROFILE" npx cdk deploy WorkloadAssociationStackSetStack --require-approval never

if [ "${DEPLOY_INGRESS:-false}" = "true" ]; then
  echo "== Network account: Phase 5 ingress (SN-E, hosted zone, DNS automation) =="
  AWS_PROFILE="$NETWORK_PROFILE" npx cdk deploy \
    VpcLatticeIngressStackDev VpcLatticeIngressZoneStack VpcLatticeIngressDnsStack \
    --require-approval never

  echo "== Workload account: Phase 5 ingress producer + DNS forwarder (environment=$ENVIRONMENT) =="
  AWS_PROFILE="$WORKLOAD_PROFILE" npx cdk deploy \
    WorkloadAppStack WorkloadIngressDnsForwarderStack \
    -c environment="$ENVIRONMENT" --require-approval never
fi

echo "Done. Environment '$ENVIRONMENT' deployed in region $REGION."
echo "Re-run with ENVIRONMENT=test or ENVIRONMENT=prod to roll out additional workload environments."
