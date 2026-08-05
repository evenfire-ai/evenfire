# Plugin Workload SDK upgrade and policy migration

This runbook applies to releases that include the target-aware promptBridge
attempt ledger or the provider-free `clientNotifications` readiness contract.
The SDK is fail-closed during an upgrade: an old writer or an old mcp-host must
not run beside the new policy/ledger contract.

## Required order

1. Keep `PLUGIN_WORKLOAD_SDK_ENABLED=false` while the schema and binaries are
   upgraded.
2. Back up the database and record `schema_migrations`, the SDK grant inventory,
   and the target policy hashes. Do not copy secret values into the backup
   report.
3. Apply the compatible CRDs and deploy the new Control API migration image.
4. Stop old SDK writers before allowing the new Control API to accept writes.
5. Run the migrations, including the forward-only legacy policy repair. The
   repair preserves a complete ordered policy and leaves malformed or legacy
   rows in `legacy_unreviewed`.
6. Start the new Control API and verify the read-only
   `/api/v1/admin/plugin-workload-sdk/legacy-inventory` endpoint. A recipe can
   be enabled only when its inventory is `activationReady=true`.
7. Deploy the matching gateway, Control UI, WRC, and mcp-host images. The
   capabilities probe must report readiness independently for promptBridge and
   clientNotifications.
8. Have an operator review every `legacy_unreviewed` row in Control UI and
   explicitly save its ordered targets. The UI never activates a legacy row on
   page load.
9. Enable the feature for a canary recipe, reconcile it, and verify:
   - the eager host is Ready with a stable pod UID;
   - every declared family has an active grant;
   - a pre-provider credential/configuration failure closes both logical and
     physical attempts as `failed` and can revive the same idempotency key;
   - an ambiguous provider outcome remains `provider_unavailable` and is not
     revivable;
   - a real client notification reaches its authorized target.

## Rollback

Disable the SDK feature and stop new reconciles. Do not roll back the database
or deploy old binaries that cannot understand the attempt ledger. Keep the new
Control API and repair policy rows forward; after the inventory is clean,
re-enable a canary and repeat the readiness and ledger checks.

## Minikube gate

Use the branch-owned profile and generated random ports, then run:

```bash
make minikube-pre-gate-sync GATE=plugin-workload-sdk-review
```

The pre-gate fails when a `legacy_unreviewed` promptBridge policy remains. It
does not fail merely because an operator intentionally disabled or revoked a
grant; those states are fenced at authorization time and are reported by the
inventory for operational review.
