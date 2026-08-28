# CodeQL clear-text storage — Kubernetes Secret rollback proof disposition

This document records the audited disposition for CodeQL alert
[#1198](https://github.com/evenfire-ai/evenfire/security/code-scanning/1198),
reported by `js/clear-text-storage-of-sensitive-data` in PR #252.

## Disposition

**False positive.** In this flow, “Secret” is the Kubernetes resource kind; it
does not describe secret values stored in the browser. The finding's two
reported sources are the `createMcpSecretDeleteProof` function name and the
public `MCP_SECRET_DELETE_PROOF_TTL_SECONDS = 120` constant.

The cookie value contains only:

1. an expiry timestamp;
2. a SHA-256 binding of the resource UID and resourceVersion; and
3. a SHA-256 binding of the authenticated session JTI, resource name,
   namespace, identity digest, and expiry.

It never contains Kubernetes `data` or `stringData`, credentials, the admin
JWT, the session JTI, UID, or resourceVersion in clear text.

## Security controls

- The route is behind verified Control UI admin authentication.
- The proof is bound to the creating admin session, resource name, namespace,
  UID, and resourceVersion.
- The cookie is `HttpOnly`, `SameSite=Lax`, secure in production or HTTPS,
  scoped to `/`, and expires after 120 seconds.
- The legacy bodyless rollback re-reads the live resource and verifies the
  proof against its current identity.
- Deletion still uses Kubernetes UID/resourceVersion preconditions and retains
  the existing reference and ownership guards.
- Current clients continue to send explicit UID/resourceVersion preconditions;
  the proof exists only for a short rolling-deployment compatibility window
  with an older cached UI.

## Why production code is unchanged

The proof is already one-way protected and contains no confidential payload.
Moving the binding to PostgreSQL would add a migration, cleanup lifecycle, and
runtime dependency to solve an analyzer naming ambiguity without improving the
stated confidentiality boundary. Removing the compatibility path would break
the supported old-UI/new-API deployment sequence.

The CodeQL query remains enabled globally. Only alert #1198 is eligible for
false-positive dismissal.

## Re-open triggers

Re-open and redesign this flow if any of the following changes:

- the proof input begins to include Secret `data`, `stringData`, credentials,
  or other confidential values;
- the cookie begins to carry the session JTI, UID, resourceVersion, or other
  stable identifiers in clear text;
- the 120-second TTL or cookie security flags are weakened;
- admin-session binding, live identity verification, reference checks, or
  Kubernetes delete preconditions are removed; or
- CodeQL gains modeling that distinguishes the Kubernetes resource-kind name
  from confidential values and still reports a real clear-text flow.

## Dismissal comment

```text
False positive documented in docs/how-to/codeql-js-cleartext-storage-kubernetes-secret-proof.md (alert #1198). “Secret” is the Kubernetes resource kind; the cookie contains only a 120-second expiry and SHA-256 bindings, never Secret data/stringData, credentials, JWT/JTI, UID, or resourceVersion in clear text. The route remains admin-authenticated and delete remains fenced by live UID/resourceVersion preconditions. The query stays enabled globally.
```
