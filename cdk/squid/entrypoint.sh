#!/bin/bash
# Based on: https://github.com/aws-samples/centralised-egress-proxy
set -euo pipefail

# Initialize cache if needed
if [[ ! -d ${SQUID_CACHE_DIR}/00 ]]; then
  echo "Initializing cache..."
  squid -N -f /etc/squid/squid.conf -z
fi

# Start squid
echo "Starting squid..."
exec squid -f /etc/squid/squid.conf -NYCd 1
