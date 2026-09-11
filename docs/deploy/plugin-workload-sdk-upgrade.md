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
   `pre-gate-sync` fences both `workflow-recipes` and `control-api` at zero
   replicas, and the Control API Deployment uses `strategy: Recreate`; this is
   an enforced no-overlap invariant, not a runbook-only coordination hint.
5. Run the migrations, including the no-op legacy repair and the forward-only
   policy-review-provenance migration. A complete-looking JSON row is not
   provenance: every active promptBridge row without a durable operator review
   is re-fenced as `legacy_unreviewed` and remains unusable.
6. Start the new Control API and verify the read-only
   `/api/v1/admin/plugin-workload-sdk/legacy-inventory` endpoint. A recipe can
   be enabled only when its inventory is `activationReady=true` and every
   declared policy has review provenance.
7. Deploy the matching gateway, Control UI, WRC, and mcp-host images. The
   capabilities probe must report readiness independently for promptBridge and
   clientNotifications.
8. Have an operator review every `legacy_unreviewed` row in Control UI and
   explicitly save its ordered targets. The UI never activates a legacy row on
   page load, and no migration infers provider, model, slot, default, or order.
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

## Platform rate limits (issue #348)

The SDK enforces platform-level per-minute rate limits configured through the
`control-api-config` ConfigMap. The per-run grant quotas `maxRequestsPerRun`
and `maxNotificationsPerRun` are deprecated: they are still accepted in grant
payloads for backward compatibility but are ignored by the authorizer. Each
per-minute limit is enforced over a **trailing (rolling) 60-second window**
computed from the invocation audit trail — there is no fixed reset tick.
Denied attempts are recorded and count toward the window, so traffic that
stays above the limit remains throttled while it keeps arriving; once the
caller slows below the limit the trailing window drains within ~60 seconds.
Unlike the deprecated per-run counters, a stepless recipe is never
permanently trapped.

| ENV variable | Default | Limits |
|---|---|---|
| `CONTROL_API_PLUGIN_SDK_NOTIFICATIONS_PER_MIN` | `150` | clientNotifications invocations per minute |
| `CONTROL_API_PLUGIN_SDK_PROMPTBRIDGE_PER_MIN` | `120` | promptBridge invocations per minute |
| `CONTROL_API_PLUGIN_SDK_REQUEST_BUCKET_PER_MIN` | `600` | shared SDK request bucket per minute |
| `CONTROL_API_PLUGIN_SDK_PREAUTH_PER_MIN` | `600` | pre-authorization checks per minute |

The defaults above equal the code defaults in `control-api/src/config.ts` and
are registered in both `deploy/base/control-plane/configmaps.yaml` and the
minikube overlay patch (strategic-merge over the base ConfigMap; omitted keys
inherit base values)
`deploy/overlays/minikube/configmaps/control-api-config.yaml`; a drift between
code and manifests fails the config deploy-mirror test.

### Tuning

Limits are tunable without a code deploy. Edit the key in the
`control-api-config` ConfigMap for the target environment, then restart the
Control API so the new environment is picked up:

```bash
# Preflight: confirm you are pointed at the intended cluster before mutating it.
kubectl config current-context   # must print the target environment's context ("$K8S_CONTEXT")
kubectl --context "$K8S_CONTEXT" -n control-plane rollout restart deployment/control-api
kubectl --context "$K8S_CONTEXT" -n control-plane rollout status deployment/control-api --timeout=240s
```

Values must be positive integers; the Control API fails loudly at startup on
an invalid value. See also [production.md](production.md) and
[minikube.md](minikube.md) for environment-specific deployment procedures.

## Minikube gate

Use the branch-owned profile and generated random ports, then run:

```bash
make minikube-pre-gate-sync GATE=plugin-workload-sdk-review
```

The pre-gate fences the workflow reconciler and Control API before database
migration, restores their prior replica counts on success or failure, and
restores the Control API only after the schema-first deployment has converged.
It fails when a
`legacy_unreviewed` promptBridge policy remains. It does not fail merely
because an operator intentionally disabled or revoked a grant; those states
are fenced at authorization time and are reported by the inventory for
operational review.
