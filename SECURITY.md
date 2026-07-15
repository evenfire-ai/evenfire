# Security Policy

evenfire treats agents that can take real actions as a security-sensitive
system. Please help us keep operators and end users safe.

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

Prefer, in order:

1. **GitHub Private Vulnerability Reporting** on this repository (Security →
   Advisories / “Report a vulnerability”), if enabled for the repo.
2. **Email:** `security@evenfire.ai`  
   Include a clear description, impact, affected components/versions, and
   reproduction steps when possible. Encrypt sensitive attachments if you can.

We aim to **acknowledge within 3 business days** and to keep you informed of
the fix timeline. Please give us a reasonable window before any public
disclosure.

If `security@evenfire.ai` is unreachable, reach the core maintainers / GitHub
org owners via a private channel (see [GOVERNANCE.md](GOVERNANCE.md)).

## Supported versions

The **latest tagged release** on the default branch is supported for security
fixes; until the first tagged release exists, the default-branch HEAD is the
supported target. Development snapshots may lag.

## Security model (product)

Platform enforcement layers (approvals, least privilege, default-deny
networking, authenticated internals) are summarized in the root
[README](README.md#security-model) and detailed in
[docs/architecture/overview.md](docs/architecture/overview.md) and
[docs/architecture/platform-topology.md](docs/architecture/platform-topology.md).

## Safe harbor for good-faith research

We welcome good-faith testing against **your own** deployments or explicitly
authorized environments. Do not access other tenants’ data, disrupt production
services you do not own, or exfiltrate secrets.
