# Codex subscription validation

Evidence lanes for `codex-subscription`. One lane does not stand in for another.

## Lanes

- **T0** — unit, schema, hash, contracts, typecheck, lint, build. Includes
  `make test-codex-subscription-t0` once that aggregator exists.
- **T1** — real PostgreSQL. `CONTROL_API_REAL_PG_REQUIRED=1`. A missing DSN,
  skipped suite, or zero tests is FAIL.
- **Manifest** — Kustomize, images, ServiceAccount/RBAC, secrets, gateways,
  NetworkPolicy. No cluster.
- **T2** — exact-HEAD on a branch-owned Minikube profile. Full reconcile for
  this change (CRDs, manifests, policies, image matrix).
- **Browser/Electron** — visible login and journeys. Node 24 and
  `npm run verify:electron` first.
- **Upstream real** — opt-in only with `CODEX_REAL_UPSTREAM_CONFIRM=1` and an
  approved account. Never satisfied by a mock.
- **Load/compromise** — limits, backpressure, cancel, and contained pivot probes.

## Freeze fixture

`tests/e2e/fixtures/codex-subscription/sanitized-upstream-contract.json` and
`docs/architecture/codex-subscription-transport-contract.md` are the Phase 0
contract. The freeze test is
`tests/e2e/integration/codex-subscription-contract-freeze.test.ts`.

## Commands

```bash
cd tests/e2e
npm test -- --run integration/codex-subscription-contract-freeze.test.ts
```

Live upstream (Task 25):

```bash
KUBECONTEXT="$KUBECONTEXT" CODEX_REAL_UPSTREAM_CONFIRM=1 \
  bash scripts/e2e/e2e-codex-subscription-real-upstream.sh
```
