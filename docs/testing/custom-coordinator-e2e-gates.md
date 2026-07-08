# Custom Coordinator E2E Gates

This runbook documents the local minikube gates for custom coordinator snippets
and custom coordinator images. It is intentionally separate from the developer
guides under `docs/features/` because these commands validate the local
branch-scoped minikube cluster, not the public developer contract.

Run these gates only after the normal minikube pre-gate sync has rebuilt and
loaded the current worktree images, CRDs, manifests, secrets, and config.
Use the branch-scoped minikube profile/context resolved for the active worktree;
do not assume the shared `clerum-test` profile unless the operator explicitly
selects it.

## Snippet Runtime

Runtime gate:

```bash
KUBECONTEXT=<profile-context> bash scripts/e2e/e2e-snippet-runtime.sh
```

Product gate:

```bash
KUBECONTEXT=<profile-context> ADMIN_PASSWORD=<local-admin-password> \
  bash scripts/e2e/playwright-dev.sh workflow-snippet-runtime-happy-path.test.ts
```

What this validates:

| Area | Coverage |
|---|---|
| Direct DB | Snippet runner pod/service, pod hardening, direct MongoDB/PostgreSQL SDK calls, artifact-reader, and JSON/Markdown artifacts in `status.artifacts[]`. |
| Public HTTP | Public HTTP works only when `runtimeEgress.http.allowedHosts` and step `capabilities.http.allowedHosts` are declared. |
| Manual MCP | A snippet can call a declared MCP server/tool directly through the SDK without creating a child `mcp-host`. |
| Manual MCP timeout | A hanging declared MCP tool fails within the snippet step budget and does not use the runner fallback when `timeoutSeconds` is declared. |
| Hybrid agentic | Snippet steps can be combined with a separate agentic step; only the agentic step creates the WRC-managed child `mcp-host`. |
| Negative fixtures | Platform-managed Secret references, undeclared HTTP hosts, HTTP hosts missing from `runtimeEgress`, MCP wildcard tools, undeclared PostgreSQL workloads, and unsafe artifact names fail closed. |
| Product path | Control UI installs/grants, Desktop App triggers as `test@clerum.io`, artifacts are listed and downloaded by exact `runId`, and raw artifact `path` is not exposed to product surfaces. |

## Custom Image Runtime

NetworkPolicy enforcement must be proven before trusting custom image E2E
results:

```bash
MINIKUBE_PROFILE=<profile-context> make minikube-verify-network-policy
```

Runtime gate:

```bash
KUBECONTEXT=<profile-context> E2E_K8S_CONTEXT=<profile-context> \
  bash scripts/e2e/e2e-custom-coordinator-sdk.sh
```

Product gate:

```bash
KUBECONTEXT=<profile-context> ADMIN_PASSWORD=<local-admin-password> \
  bash scripts/e2e/playwright-dev.sh workflow-custom-coordinator-sdk-happy-path.test.ts
```

What this validates:

| Area | Coverage |
|---|---|
| Feature flag and image policy | Disabled custom coordinator policy rejects before pod creation; enabled policy accepts the fixture image; an adjacent disallowed image is rejected before pod creation. |
| Pod identity | The coordinator pod uses `spec.coordinatorImage` and has labels that match generated NetworkPolicy selectors. |
| Custom-only flow | Id-only custom workflow runs without a child `mcp-host`, does not mint an `mcp-host` runtime token Secret, and does not receive broker/channel env vars. |
| Pod hardening | The pod uses the expected hardened runtime profile and dedicated `/output` mount. |
| Network boundaries | The custom coordinator can reach WRC and declared public HTTP egress, while approval gateway, Kubernetes API, link-local metadata, HCC, and undeclared recipe `mcp-host` paths are blocked in the custom-only fixture. |
| Output storage | The workflow output PVC uses recipe `storageSize`; the custom coordinator writes the expected business artifact under `/output`. |
| Runtime token | The custom coordinator receives only reduced WRC scopes. |
| Config and status | The mounted workflow config includes `coordinatorImage`, `runtimeEgress`, `inputContract`, and id-only steps; `WorkflowRecipe.status` records custom executor steps and artifact metadata. |
| Product custom-only path | Control UI installs/grants, Desktop App triggers, two consecutive runs stay isolated, and Desktop/Control UI download artifacts by exact `runId`. |
| Product broker-backed path | WRC creates the child `mcp-host`, the custom coordinator receives the scoped channel, calls the declared MCP server/tool through WRC-managed model injection, and downloads JSON/Markdown artifacts by `runId`. |
| Broker-backed timeout | A hanging broker-backed MCP tool is bounded by the recipe-local `mcp-host` MCP SDK timeout and the custom coordinator SDK SSE wait timeout. |

Reference fixtures:

- `tests/e2e/fixtures/layer3a-snippet-direct-db.yaml`
- `tests/e2e/fixtures/layer3a-snippet-http-egress.yaml`
- `tests/e2e/fixtures/layer3a-snippet-manual-mcp.yaml`
- `tests/e2e/fixtures/layer3a-snippet-manual-mcp-timeout.yaml`
- `tests/e2e/fixtures/layer3a-snippet-hybrid-agentic.yaml`
- `tests/e2e/fixtures/custom-coordinator-sdk.yaml`
- `tests/e2e/fixtures/custom-coordinator-sdk-broker-backed.yaml`
- `tests/e2e/fixtures/custom-coordinator-sdk-broker-backed-timeout.yaml`
- `tests/e2e/fixtures/custom-workflow-coordinator/`
