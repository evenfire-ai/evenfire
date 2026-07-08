# Platform E2E Test Suite

End-to-end tests covering cross-service scenarios across the entire Clerum platform.

## Structure

Per-service **unit tests** live inside each service's own `test/` directory. This directory contains **platform-level integration and E2E tests** that exercise multiple services together.

### Subdirectories

| Directory            | Scope            | Description                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp-host/`          | Service-specific | 16 test files covering mcp-host endpoints: approval flow, context compaction, CRD reconciliation, cron scheduling, extension config, health, legacy removal, MCP compaction, message flow, native tools, resilience, software creation (generic + specialized), Telegram channel E2E, and tool discovery.                                                                   |
| `rpc-proxy/`         | Service-specific | Security-focused E2E suite for the internet-facing `rpc-proxy`. Tests JWT hardening, auth header enforcement, route authorization, JSON-RPC validation, upstream error mapping, and MCP session bootstrap. Starts a real rpc-proxy process with local stubs. See `rpc-proxy/README.md`.                                                                                     |
| `external-rest-api/` | Service-specific | Security-focused E2E suite for `external-rest-api`. Covers password/google login, session token hardening, claim binding, RPC token brokerage, and upstream failure handling. Starts a real external-rest-api process with local stubs. See `external-rest-api/README.md`.                                                                                                  |
| `integration/`       | Cross-service    | Tests that span multiple services on a live cluster: API contract validation (`contracts`), channel-reader to mcp-host forwarding, control-api K8s reconciliation (HostOverview, WorkflowRecipe CRUD), MCP proxy routing, profiles chain (external-rest-api -> control-api -> rpc-proxy -> mcp-host), and full WorkflowRecipe lifecycle (coordinator + mcp_host Pod model). |
| `playwright/`        | UI               | Playwright browser tests for **control-ui** (auth, channels, contexts, CRD config validation, hosts, MCP servers, recipes, users/teams) and **desktop** app (agents, auth, navigation). Includes global setup, auth fixtures, API client helpers, and CSS selectors.                                                                                                        |
| `benchmark/`         | Performance      | LLM provider benchmark suite. Sends identical prompts at three difficulty levels to each configured provider, measuring response quality, latency, and tool-use accuracy. Results are stored as JSON in `benchmark/results/` for post-hoc analysis via `report.ts`.                                                                                                         |
| `fixtures/`          | Shared           | Test infrastructure: Kubernetes secret manager (`secret-manager.ts`), mock HTTP MCP server, mock stdio MCP server, mock secrets server, K8s manifests (`mailpit.yaml`, `mcpserver-mock.yaml`), and seed scripts for MongoDB and Airtable. See `fixtures/README.md`.                                                                                                         |

### Top-level files

| File               | Purpose                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `helpers.ts`       | Shared utilities for all Vitest suites: `fetchJson`, `sendMessage`, `healthCheck`, `waitForIdle`, `waitForAgentState`, `kubectl` wrapper, `getPodLogs`, approval/deny helpers, and `getTaskResult` poller. |
| `vitest.config.ts` | Vitest configuration: 360-second timeout (workflow tests wait for LLM execution), no file parallelism, sequential execution, verbose reporter.                                                             |
| `package.json`     | Dependencies (`vitest`, `jsonwebtoken`) and npm scripts for running suites.                                                                                                                                |
| `tsconfig.json`    | TypeScript config targeting ES2022 with Node16 module resolution.                                                                                                                                          |

## Test Runners

This suite uses **two** test runners:

1. **Vitest** -- runs everything under `mcp-host/`, `rpc-proxy/`, `external-rest-api/`, `integration/`, and `benchmark/`.
2. **Playwright** -- runs everything under `playwright/` (separate `package.json` and `playwright.config.ts`).

Additionally, **bash E2E scripts** in `scripts/e2e/` exercise full WorkflowRecipe composite scenarios (MongoDB stack, PostgreSQL, Redis cache, webhook relay, stdio calculator, multi-tool) against a live cluster.

## Prerequisites

### Vitest suites (mcp-host, integration, benchmark)

- Minikube cluster running (`minikube -p clerum-test status`)
- All services deployed (`kubectl get pods --all-namespaces`)
- Port-forwards active. `make test-e2e-vitest`/`make test-e2e-all` manage
  held port-forwards automatically; direct `npx vitest` runs need
  `make minikube-pf-all` or `scripts/minikube/pf-all-stack.sh --hold`.
- `make test-e2e-vitest`/`make test-e2e-all` mint `MCP_HOST_AUTH_TOKEN` for
  legacy direct `mcp-host` suites. Direct `npx vitest` runs must provide that
  token when runtime auth is enabled.
- `make test-e2e-vitest`/`make test-e2e-all` run the deterministic Vitest
  suites by default. Pass explicit spec paths to `scripts/e2e/run-vitest-e2e.sh`
  for ad-hoc suites.
- LLM/external-service suites are opt-in because they require dedicated model,
  credential, and runtime-policy profiles:
  `E2E_RUN_SOFTWARE_CREATION=1`, `E2E_RUN_NATIVE_TOOLS=1`,
  `E2E_RUN_CONTEXT_COMPACTION=1`, `E2E_RUN_MCP_COMPACTION=1`,
  `E2E_RUN_CRON_SCHEDULER=1`, or `E2E_RUN_TELEGRAM_HTTP_DIRECT=1`.

### Canonical Seeded Identity

Cluster-backed E2E must use the same login identity as the seed scripts.
The canonical default is:

- `E2E_DEV_LOGIN_EMAIL=test@clerum.io`
- `E2E_DEV_LOGIN_NAME="Test User"`
- `E2E_HOST_REF=chatllm`
- `E2E_CONTEXT_ID=context1`

Do not hardcode alternate defaults such as `test@clerum.local` or `test@evenfire.local`
inside specs. Import and reuse `tests/e2e/testUser.ts` instead so the test harness
stays aligned with:

- `scripts/e2e/seed-e2e-data.sh`
- `scripts/minikube/seed-test-data.sh`
- `scripts/minikube/full-setup.sh`

Identity rules:

- `test@clerum.io` is the default for normal Desktop, `chatllm`, workflow trigger/process,
  and approval E2E.
- A different email is only valid when a spec is explicitly testing `unauthorized / no grants`
  or an intentional multi-user approval flow.
- If a workflow approval targets a specific user, the Desktop login identity, the approval
  `target.userId`, and the seed data must all describe the same seeded user. A successful
  login alone is not enough.

### Auth-Chain Invariant For `mcp-host` E2E

The real `mcp-host` suites validate the production auth path:

1. `external-rest-api` password-login
2. `external-rest-api` RPC token issuance
3. `rpc-proxy` host routing
4. `mcp-host` JWT verification

If `rpc-proxy` and `mcp-host` drift on the RPC JWT public key, tests will fail
with `401 Invalid token` upstream and often surface as a `500` from `rpc-proxy`.

The harness now enforces this preflight in `tests/e2e/mcp-host/runtimeAuth.ts`
before trying to exercise the host. The expected repair flow is:

```bash
make minikube-sync-auth-key
CONTEXT=clerum-test E2E_DEV_LOGIN_EMAIL=test@clerum.io scripts/minikube/seed-test-data.sh
```

### Workflow Trigger / Control UI / Desktop Sync Contract

For PR 146-style cluster-backed E2E, the cluster must be synchronized to the branch before running
`workflow-triggers`, `control-ui`, or `desktop-app` suites:

```bash
scripts/minikube/pre-gate-sync.sh --gate pr146-workflow-triggers
CONTEXT=clerum-test scripts/minikube/seed-workflow-triggers-test-data.sh
```

Important invariants:

- `WorkflowRecipe` CRDs are seeded in `sandbox-recipes`.
- Non-transport workflow runtime resources stay in `sandbox-recipes`.
- `mcp-server` is reserved for rendered `McpServer` transport children.
- Trigger/auth endpoints enforce recipe namespace equality, so tests must use `sandbox-recipes/<recipe>`.
- If auth starts failing after a redeploy, repair the shared JWT chain before rerunning UI/E2E:

```bash
make minikube-sync-auth-key
CONTEXT=clerum-test E2E_DEV_LOGIN_EMAIL=test@clerum.io scripts/minikube/seed-test-data.sh
```

- Port-forwards must stay alive for the whole run. If a helper script backgrounds them and the shell exits,
  relaunch dedicated forwards in a persistent shell:

```bash
kubectl --context=clerum-test -n control-plane port-forward svc/control-ui 3000:3000
kubectl --context=clerum-test -n control-plane port-forward svc/control-api 8090:8090
kubectl --context=clerum-test -n profiles port-forward svc/external-rest-api 8091:8091
kubectl --context=clerum-test -n rpc-proxy port-forward svc/rpc-proxy 8094:8094
```

### Required Execution Order

Run the preconditions in this order. This matches the actual runtime dependencies of the code:

1. Synchronize CRDs and deployments to the branch.

```bash
scripts/minikube/pre-gate-sync.sh --gate pr146-workflow-triggers
```

Reason:

- `control-api`, `workflow-recipes`, `control-ui`, and `desktop-app` E2E must run against the same branch image set.
- `WorkflowRecipe` trigger fields are validated by the live CRD, so stale CRDs produce false negatives before the request even reaches application logic.

2. Repair the shared auth chain if keys drifted during redeploy.

```bash
make minikube-sync-auth-key
```

Reason:

- `external-rest-api` issues the user/session side tokens.
- `rpc-proxy` and `mcp-host` must verify against the same JWT key material.
- If those keys drift, UI/E2E failures surface as auth noise (`401`/`500`) unrelated to the feature under test.

3. Seed the canonical login identity and recipe data.

```bash
CONTEXT=clerum-test E2E_DEV_LOGIN_EMAIL=test@clerum.io scripts/minikube/seed-test-data.sh
CONTEXT=clerum-test scripts/minikube/seed-workflow-triggers-test-data.sh
```

Reason:

- Desktop and browser tests log in as `test@clerum.io` unless overridden.
- Workflow-trigger suites expect allowlist users plus the seeded trigger recipes.
- The seeded `WorkflowRecipe` CRDs live in `sandbox-recipes`; only rendered transport `McpServer` children land in `mcp-server`.
- For Desktop workflow E2E, keep the same seeded user across the whole chain:
  `chatllm` session, workflow trigger grants, and user-targeted approval requests.
  Mixing identities causes auth to succeed while workflow permissions still fail.

4. Start persistent port-forwards and keep them alive for the whole run.

```bash
kubectl --context=clerum-test -n control-plane port-forward svc/control-ui 3000:3000
kubectl --context=clerum-test -n control-plane port-forward svc/control-api 8090:8090
kubectl --context=clerum-test -n profiles port-forward svc/external-rest-api 8091:8091
kubectl --context=clerum-test -n rpc-proxy port-forward svc/rpc-proxy 8094:8094
```

Reason:

- `control-ui` Playwright hits `http://localhost:3000` and `http://localhost:8090`.
- `desktop-app` Playwright hits `external-rest-api` and `rpc-proxy` via localhost env vars.
- If a helper backgrounds these forwards and the parent shell exits, later tests fail with connection errors that are not product regressions.

5. Verify health before running any E2E.

```bash
curl -sS http://127.0.0.1:3000 >/dev/null
curl -sS http://127.0.0.1:8090/health
curl -sS http://127.0.0.1:8091/health
curl -sS http://127.0.0.1:8094/health
```

Reason:

- This is the earliest point where the entire local execution chain can be proven reachable.

6. Run backend E2E before UI/Electron E2E.

Recommended order:

```bash
bash scripts/e2e/e2e-workflow-triggers.sh --verbose
bash scripts/e2e/e2e-workflow-schedules.sh --verbose
bash scripts/e2e/e2e-workflow-approvals-recovery.sh --verbose
```

Reason:

- These scripts validate cluster state, DB writes, trigger authorization, schedules, idempotency, and mcp-host-runtime-token recovery without the extra failure surface of Playwright/Electron.
- If these fail, fixing UI tests first is usually wasted effort.

7. Run browser/Electron E2E only after backend contracts are green.

Suggested order:

```bash
./node_modules/.bin/playwright test --config control-ui/playwright.config.ts control-ui/e2e/workflow-endpoints.spec.ts control-ui/e2e/crd-trigger-schema.spec.ts control-ui/e2e/workflow-auth-hostRefs.spec.ts control-ui/e2e/trigger-grants-ui.spec.ts control-ui/e2e/trigger-grants-audit.spec.ts
npm --prefix desktop-app run test:e2e:playwright -- --grep "workflows|crd-fields|approval"
```

Reason:

- These suites assert presentation and interaction on top of already-proven backend behavior.
- Keeping them last makes failures easier to classify as real UI regressions vs. lower-layer drift.

### Desktop Airtable E2E Contract

Desktop Airtable checks are stricter than ordinary chat smoke tests: they must
exercise a real Airtable MCP tool call, not a fallback answer and not a
placeholder deployment.

Use the wrapper script instead of calling `npm run test:e2e:playwright`
directly:

```bash
KUBECONTEXT=clerum-test bash scripts/e2e/playwright-dev.sh desktop-app/test/e2e-playwright/chat.test.ts --grep "Airtable|list bases"
```

Rules:

- The selected cluster context must match the URLs passed to Playwright. `clerum-test`
  expects localhost port-forwards; GKE/dev contexts expect ingress URLs.
- `mcp-airtable-credentials` must exist with a real `api-key`. Placeholder values
  such as `placeholder-airtable-api-key-for-e2e`, `e2e-placeholder-*`, or
  `pattest*` are rejected on purpose because they only create false negatives.
- `airtable-server` must become `Available` before the Electron test starts, and
  `chatllm` is restarted after the preflight so it re-discovers the updated context.

If the preflight fails, treat it as an environment prerequisite failure, not as a
Desktop App regression.

### Vitest suites (rpc-proxy, external-rest-api)

- Node.js 22+
- Dependencies installed for `tests/e2e` and the target service
- **No cluster required** -- these suites use local deterministic stubs

### Playwright suites

- Node.js 22+
- Browsers installed (`npx playwright install chromium`)
- Cluster running with control-ui accessible (default `http://localhost:3000`)

### Bash E2E scripts

- Minikube cluster with Calico CNI (`kubectl get pods -n kube-system | grep calico`)
- All CRDs applied (`kubectl apply -f charts/clerum-crds/crds/`)
- Source the shared library: `source scripts/e2e/e2e-lib.sh`

## Running

### All Vitest suites

```bash
cd tests/e2e
npm install
npm test
```

### Individual Vitest suites

```bash
# rpc-proxy security
npm --prefix tests/e2e run test:rpc-proxy-e2e

# external-rest-api security
npm --prefix tests/e2e run test:external-rest-api-e2e

# single file
cd tests/e2e && npx vitest run integration/workflow-lifecycle.test.ts

# benchmark
cd tests/e2e && npx vitest run benchmark/benchmark.test.ts
```

### Playwright suites

```bash
cd tests/e2e/playwright
npm install
npx playwright test                        # all projects
npx playwright test --project=control-ui   # control-ui only
npx playwright test --project=desktop      # desktop only
npx playwright test --headed               # headed mode
```

### Bash E2E scripts

```bash
# Run the workflow runtime gate
bash scripts/e2e/e2e-workflow-runtime-gate.sh

# Run a single scenario
bash scripts/e2e/workflow-backend-compat/http-mongodb-stack.sh
bash scripts/e2e/e2e-agentic-stdio-baseline.sh
```

## Note

The integration, mcp-host, benchmark, and bash E2E tests require a running Kubernetes cluster. They are **not** unit tests and cannot run in CI without a cluster. The rpc-proxy and external-rest-api suites are self-contained and CI-safe.
