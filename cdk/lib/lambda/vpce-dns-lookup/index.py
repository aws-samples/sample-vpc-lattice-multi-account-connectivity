"""
VPCE DNS Lookup - Custom Resource Handler

Discovers all Interface VPC Endpoints in a given VPC and returns their
regional DNS names as a key-value map. Used by CloudFormation/CDK to
dynamically resolve VPCE DNS targets for Resource Configurations.

Example output:
  { "ssm": "vpce-xxx.ssm.us-east-2.vpce.amazonaws.com", ... }
"""

import boto3
import json
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event, context):
    """
    CloudFormation Custom Resource handler (CDK Provider pattern).
    On Create/Update: looks up all Interface VPC Endpoints in the specified VPC
    and returns their DNS names keyed by service name.
    On Delete: no-op (returns success immediately).

    Error handling: Exceptions are caught, logged, and re-raised so the CDK
    Provider framework sends a FAILED response to CloudFormation.
    """
    request_type = event.get('RequestType', 'Create')

    if request_type == 'Delete':
        logger.info('Delete event received — returning success (no-op)')
        return {'Data': {}}

    try:
        vpc_id = event['ResourceProperties']['VpcId']
        logger.info(f'Looking up VPC endpoints in VPC: {vpc_id}')

        ec2 = boto3.client('ec2')
        paginator = ec2.get_paginator('describe_vpc_endpoints')

        result = {}
        for page in paginator.paginate(
            Filters=[
                {'Name': 'vpc-id', 'Values': [vpc_id]},
                {'Name': 'vpc-endpoint-type', 'Values': ['Interface']},
            ]
        ):
            for ep in page['VpcEndpoints']:
                service_name = ep['ServiceName']
                parts = service_name.split('.')

                # Extract the service key (e.g., 'ssm', 'sts', 'ecr.api')
                # Service names follow: com.amazonaws.<region>.<service>
                region_idx = None
                for i, part in enumerate(parts):
                    if any(part.startswith(prefix) for prefix in
                           ['us-', 'eu-', 'ap-', 'sa-', 'ca-', 'me-', 'af-']):
                        region_idx = i
                        break

                if region_idx is not None:
                    svc_key = '.'.join(parts[region_idx + 1:])
                else:
                    svc_key = parts[-1]

                # Get the first DNS entry (regional DNS name)
                dns_entries = ep.get('DnsEntries', [])
                if dns_entries:
                    dns_name = dns_entries[0]['DnsName']
                    # Normalize key for CloudFormation attribute access
                    cfn_key = svc_key.replace('.', '_').replace('-', '_')
                    result[cfn_key] = dns_name
                    logger.info(f'Found endpoint: {svc_key} -> {dns_name}')

        logger.info(f'Total endpoints discovered: {len(result)}')
        return {'Data': result}

    except Exception as e:
        logger.error(f'Failed to look up VPC endpoints: {e}')
        raise
