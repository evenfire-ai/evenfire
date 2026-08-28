# Control API MCP Secret rollback permits

This runbook covers the short-lived PostgreSQL permits used only by the legacy
bodyless rollback path of `POST /admin/mcp-secrets` followed by
`DELETE /admin/mcp-secrets/:name`.

## Deployment contract

1. Run the Control API schema migration job before changing the pod image.
2. Verify migration `0101_mcp_secret_rollback_permits` and the runtime-access
   profile before starting Control API.
3. Deploy Control API with its repository-owned `Recreate` strategy and one
   replica. Old and new API writers must not overlap.
4. Verify a current client can create and explicitly delete with
   UID/resourceVersion, and that a bodyless legacy rollback consumes a
   server-side permit.

The migration is additive and forward-only. It creates no foreign keys and
does not alter existing rows or tables.

## Runtime invariants

- The browser receives no rollback proof or nonce cookie.
- PostgreSQL stores a domain-separated SHA-256 digest of the admin session JTI,
  never the raw JTI.
- Permits bind namespace, name, UID, and resourceVersion and expire after at
  most 120 seconds according to the PostgreSQL clock.
- A 15-second claim lease serializes replicas. Transient failures release the
  claim; a crashed process becomes retryable after the lease expires.
- Terminal absence or identity change finalizes the permit. Kubernetes deletion
  always carries UID and resourceVersion preconditions.
- Expired rows are authorization-inert even before bounded physical cleanup.

## Image rollback after migration 0101

Rollback is **image-only**:

1. Keep migration `0101`, the new table, and the current runtime-access profile.
2. Use the current checkout's deployment and database-migration tooling.
3. Change only the Control API image to the previously verified image.
4. Re-run the current runtime-access reconciliation and exact privilege check.

The previous Control API binary ignores the additive table. Do not run an old
checkout's exact-schema verifier after `0101`; it does not know the new public
relation and will correctly refuse to certify it. Never drop the table as part
of an application-image rollback.

## Failure outcomes

- Permit persistence failure after Kubernetes create: `503 repair_required`
  includes the created UID/resourceVersion so the current UI can perform an
  explicit CAS cleanup. The API never deletes by name as compensation.
- Missing, expired, already claimed, or wrong-session permit: `428` and no
  Kubernetes read or mutation.
- PostgreSQL claim failure: `503 repair_required` and no Kubernetes read or
  mutation.
- Live identity change or Kubernetes CAS conflict: `409 repair_required`.
- Reference graph unavailable: `503 repair_required`; the claim is released so
  the legacy caller can retry within the original 120-second permit window.

## Re-open triggers

Re-audit this design if Control API changes from one replica plus `Recreate`,
the permit or claim TTL changes, a caller can bypass admin-session binding, or
any delete path stops carrying both UID and resourceVersion.
