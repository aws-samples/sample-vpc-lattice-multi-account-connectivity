# Security

## Reporting a Vulnerability

If you discover a potential security issue in this project, we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/).

Please do **not** create a public GitHub issue for security vulnerabilities.

## Security Considerations

This repository provides reference Infrastructure-as-Code and prescriptive guidance. Before deploying in a production environment:

1. Review the [Security Findings](docs/13-security-findings.md) document, which contains the full STRIDE threat model, mitigations, and residual risks.
2. Address the security-debt items listed in the PCSR review before production use.
3. Conduct your own security review against your organization's requirements.
4. Pin all container image tags to immutable digests in your private ECR repository.
5. Scope KMS key policies to specific deployment role ARNs rather than account root.

## Security Features

- IAM auth policies on service networks restrict access by `aws:PrincipalOrgPaths`
- RAM shares scoped to specific OUs (not the entire organization)
- FQDN-level egress filtering via Squid forward proxy with explicit allowlist
- Least-privilege IAM for all Lambda functions and ECS task roles
- KMS encryption with key rotation enabled
- ECR scan-on-push with IMMUTABLE image tags
- No hardcoded secrets or real account identifiers in the repository
