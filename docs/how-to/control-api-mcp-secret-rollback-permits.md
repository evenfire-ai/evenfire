# Control API MCP Secret rollback permits

This runbook covers the short-lived PostgreSQL permits used only by the legacy
bodyless rollback path of `POST /admin/mcp-secrets` followed by
`DELETE /admin/mcp-secrets/:name`.

## Deployment contract

1. Run the Control API schema migration job before changing the pod image.
2. Verify migration `0116_mcp_secret_rollback_permits` and the runtime-access
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

## Deploy order

Run the database-migration job **before** rolling the Control API image. The
Control API deployment is `strategy: Recreate` with a single replica
(`deploy/base/control-plane/control-api.yaml`), so the old pod is terminated
before the new one starts. A new image deployed against a database that has not
yet applied `0116` fails `assertDbReady` on startup with
`missing migrations 0116_mcp_secret_rollback_permits` — and because the previous
pod is already gone, that is a full control-plane outage, not a stalled
rollout. The CRD apply is independent of this ordering: control-api reads the
Secret-reference contract from a compiled-in constant, not from the CRD
annotation, so the charts may be applied before or after the image.

## Image rollback after migration 0116

Rollback is **image-only**:

1. Keep migration `0116`, the new table, and the current runtime-access profile.
2. Use the current checkout's deployment and database-migration tooling.
3. Change only the Control API image to the previously verified image.
4. Re-run the current runtime-access reconciliation and exact privilege check.

The previous Control API binary ignores the additive table. Do not run an old
checkout's exact-schema verifier after `0116`; it does not know the new public
relation and will correctly refuse to certify it. Never drop the table as part
of an application-image rollback.

Rolling the **checkout** back is not a supported rollback path. The privilege
verifier is a full outer join between the repository's runtime-access profile
list and live `pg_class`; an older checkout's list omits
`mcp_secret_rollback_permits`, which the forward-only migration leaves in place,
so the verifier reports a relation-coverage violation and aborts the deploy. If
a runbook says "redeploy the previous tag", amend it before this ships.

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
