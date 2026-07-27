# Security Policy

evenfire treats agents that can take real actions as a security-sensitive
system. Please help us keep operators and end users safe.

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

Use either channel. Both reach the core maintainers.

1. **GitHub Private Vulnerability Reporting** (preferred):
   [open a private report](https://github.com/evenfire-ai/evenfire/security/advisories/new).
   It is enabled on this repository, keeps the report private until we publish
   an advisory, and gives you a thread to track the fix.
2. **Email:** `security@evenfire.ai`

Include a clear description, impact, affected components/versions, and
reproduction steps when possible. Encrypt sensitive attachments if you can.

We aim to **acknowledge within 3 business days** and to keep you informed of
the fix timeline. Please give us a reasonable window before any public
disclosure. If you have had no acknowledgement after 3 business days, follow up
on the other channel before considering public disclosure.

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
