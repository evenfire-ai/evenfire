# Codex LLM Proxy

Internal broker for the `codex-subscription` provider: ChatGPT/Codex
subscription sign-ins used as an LLM. It streams model calls from an agent to
the ChatGPT Codex endpoint. The OAuth tokens stay in control-api's database;
the proxy receives an access token for a single operation and does not store
it.

Off by default: `CODEX_LLM_PROXY_EXECUTION_ENABLED` is `"false"` in
`deploy/base`. To turn the feature on, follow
[Connect an LLM subscription](../docs/how-to/connect-llm-subscription.md).

## Where it runs

- Namespace `control-plane`, one replica.
- Manifest: [`deploy/base/control-plane/codex-llm-proxy.yaml`](../deploy/base/control-plane/codex-llm-proxy.yaml)
  (ServiceAccount without a token, ConfigMap `codex-llm-proxy-config`,
  Deployment, ClusterIP Service).
- Image: `clerum/codex-llm-proxy` (built from this directory, listed in
  [`deploy/images.json`](../deploy/images.json)).

## How it fits

1. `mcp-host` (or a recipe's workflow MCP host) asks control-api to authorize
   the attempt: `POST /api/v1/mcp-host/llm/provider-attempts/authorize`.
   control-api returns a short-lived, single-use execution ticket bound to the
   Host, model and request hash.
2. The caller sends the request and the ticket to the proxy, with a platform
   JWT as the bearer token.
3. The proxy verifies both, then redeems the ticket with control-api
   (`POST /internal/llm/provider-attempts/redeem`) through
   `control-api-rpc-gateway`. The redeem returns the access token for this
   one operation.
4. The proxy calls the ChatGPT Codex endpoint and streams the answer back as
   SSE. The model stream never passes through control-api.
5. When the stream ends, the proxy reports the outcome and token usage
   (`POST /internal/llm/provider-attempts/finalize`).

control-api also calls the admin port to list a connection's model catalog
and to test a connection (`control-api/src/services/codexSubscriptionCatalog.ts`).

The wire format, limits and error codes are frozen in the
[Codex subscription transport contract](../docs/architecture/codex-subscription-transport-contract.md).
The shared types and limits live in
[`packages/llm-provider-attempt-contract`](../packages/llm-provider-attempt-contract/).

## Endpoints

The proxy runs three HTTP servers.

| Port | Name    | Route                                         | Caller                          | Auth                                                                                                                                        |
| ---- | ------- | --------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 8080 | runtime | `POST /internal/runtime/v1/codex/completions` | mcp-host, workflow MCP host     | RS256 platform JWT (`scope` `workflow:approval:request`, `workflowControlScopes` has `llm:codex:execute`) plus execution ticket in the body |
| 8081 | admin   | `POST /internal/admin/v1/codex/models`        | control-api                     | `codex-admin-permit` JWT for `catalog_list`                                                                                                 |
| 8081 | admin   | `POST /internal/admin/v1/codex/test`          | control-api                     | `codex-admin-permit` JWT for `connection_test`                                                                                              |
| 9090 | metrics | `GET /healthz`, `GET /readyz`, `GET /metrics` | kubelet probes, `monitoring` ns | none                                                                                                                                        |

The runtime route refuses a platform JWT whose `hostRefs` contains `*` or does
not contain the ticket's Host. Admin permits are refused on the runtime port,
and execution tickets on the admin port. Errors are JSON `{"error": "<code>"}`.

Upstream origins are fixed in `src/originPolicy.ts`:
`https://chatgpt.com/backend-api/codex/responses` for completions and
`https://chatgpt.com/backend-api/codex/models?client_version=1.0.0` for the
catalog.

## Kill switch

`CODEX_LLM_PROXY_EXECUTION_ENABLED` accepts only the exact string `true`. Any
other value, including the `"false"` in `deploy/base`, makes the completions
route and both admin routes answer `404 {"error":"disabled"}` after
authentication. Probes and metrics keep working. The minikube overlay sets it
to `"true"` (`deploy/overlays/minikube/configmaps/codex-llm-proxy-config.yaml`).
Restart the Deployment after changing it.

## Configuration

All configuration is read from environment variables in `src/config.ts`. The
proxy refuses to start when a value is invalid.

| Variable                                   | Default           | Purpose                                                                                                                                                       |
| ------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CODEX_LLM_PROXY_RUNTIME_PORT`             | `8080`            | Runtime (completions) port                                                                                                                                    |
| `CODEX_LLM_PROXY_ADMIN_PORT`               | `8081`            | Admin (catalog, connection test) port                                                                                                                         |
| `CODEX_LLM_PROXY_PROBE_PORT`               | `9090`            | Health and metrics port                                                                                                                                       |
| `CODEX_LLM_PROXY_MAX_BODY_BYTES`           | `8404992`         | Ordinary request cap: the contract's 8 MiB `maxRequestBodyBytes` plus the 16 KiB envelope allowance. Lower values are refused. `deploy/base` leaves it unset. |
| `CODEX_LLM_PROXY_MAX_VISUAL_BODY_BYTES`    | `25165824`        | Cap for V2 requests with images. Must equal the contract's `maxVisualRequestBodyBytes` (24 MiB) and be above `CODEX_LLM_PROXY_MAX_BODY_BYTES`.                |
| `CODEX_LLM_PROXY_MAX_STREAM_DURATION_MS`   | `1800000`         | Longest a completion stream may run                                                                                                                           |
| `CODEX_LLM_PROXY_MAX_DEADLINE_MS`          | `1800000`         | Largest request deadline accepted                                                                                                                             |
| `CODEX_LLM_PROXY_UPSTREAM_IDLE_TIMEOUT_MS` | `300000`          | Abort when the upstream is silent this long. Can only lower the built-in 300000.                                                                              |
| `CODEX_LLM_PROXY_HEARTBEAT_INTERVAL_MS`    | `15000`           | SSE keepalive interval after a successful redeem. Values above `60000` are refused.                                                                           |
| `CODEX_LLM_PROXY_JWT_ISSUER`               | `control-api`     | Expected `iss` of platform JWTs, tickets and admin permits                                                                                                    |
| `CODEX_LLM_PROXY_JWT_PUBLIC_KEY`           | — (required)      | control-api's PEM public key. `deploy/base` reads it from ConfigMap `control-api-public-key`.                                                                 |
| `CODEX_LLM_PROXY_EXECUTION_ENABLED`        | off               | Kill switch, see above. Only `true` enables.                                                                                                                  |
| `CODEX_LLM_PROXY_CONTROL_API_URL`          | — (required)      | Absolute http(s) base URL for redeem/finalize. `deploy/base`: `http://control-api-rpc-gateway.control-plane.svc.cluster.local:8090/api/v1`                    |
| `CODEX_LLM_PROXY_CONTROL_API_SERVICE`      | `codex-llm-proxy` | Service name sent to control-api with the inter-service token                                                                                                 |
| `CODEX_LLM_PROXY_CONTROL_API_TOKEN`        | — (required)      | Inter-service token. `deploy/base` reads it from Secret `codex-llm-proxy-secrets`, created by `deploy/scripts/apply-inter-service-tokens.sh`.                 |

`deploy/base` also sets `NODE_OPTIONS=--max-old-space-size=768` under a
`2048Mi` memory limit, and `terminationGracePeriodSeconds: 1935` so a rollout
lets admitted streams finish. The manifest comments explain both numbers.

## Network policy

`control-plane` is deny-all. The proxy's own policies are in
[`deploy/base/control-plane/networkpolicies.yaml`](../deploy/base/control-plane/networkpolicies.yaml):

- `codex-llm-proxy-ingress`: port 8080 from Host pods in `mcp-host`
  (`clerum.io/managed-by: host-context-controller`) and workflow MCP host pods
  in `sandbox-recipes` (`clerum.io/component: workflow-mcp-host`); port 8081
  from `control-api`; port 9090 from the `monitoring` namespace.
- `codex-llm-proxy-egress`: port 8090 to `control-api-rpc-gateway` and TCP 443
  to `0.0.0.0/0`. The private and special-use ranges in `except` are filled at
  build time by the replacements in
  [`deploy/base/kustomization.yaml`](../deploy/base/kustomization.yaml) from
  `public-egress-exceptions.yaml`. DNS comes from
  `allow-dns-egress-control-plane`.
- `control-api-to-codex-llm-proxy` and `control-api-rpc-gateway` open the
  matching control-api and gateway sides.

## Development

```bash
npm ci
npm run build      # tsc -> dist/
npm test           # typecheck tests, then vitest
npm run typecheck
npm start          # node dist/main.js (needs the required env vars)
```

## Related

- [Connect an LLM subscription](../docs/how-to/connect-llm-subscription.md): enable flags, sign in, troubleshoot
- [Codex subscription transport contract](../docs/architecture/codex-subscription-transport-contract.md)
- [grok-llm-proxy](../grok-llm-proxy/README.md): the Grok sibling
