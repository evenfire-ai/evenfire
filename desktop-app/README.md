# Evenfire Desktop App (Electron + React)

Electron desktop client with a React renderer. The app authenticates through `external-rest-api`, obtains short-lived RPC access tokens, and invokes MCP servers and MCP hosts through `rpc-proxy`.

## Security Model

- User session token is obtained from `external-rest-api`.
- RPC access token is issued by `external-rest-api` via `control-api` and is scoped (`mcp:servers:list`, `mcp:server:invoke`, `host:health:read`, `host:status:read`, `host:activity:read`, `host:message:invoke`, `host:task:read`, `host:session:read`, `host:approval:write`, `desktop:view`, `sandbox:ui:view`) and short-lived.
- Desktop app calls only:
  - `external-rest-api` for user/session and token issuance.
  - `rpc-proxy` for agent discovery and invocation.
  - `member-registration-service` for the invitation/activation flow (invitation profile lookup and desktop setup completion).
- `control-api` internal service tokens are never stored in the desktop app.

> **`member-registration-service` is not in this repository.** It is an extracted
> sibling service, expected in-cluster at
> `member-registration-service.registration.svc.cluster.local:8092`
> (`deploy/base/control-plane/configmaps.yaml`). Everything else the desktop app
> needs is here; only the **invitation / activation flow** depends on it, so
> without that service you can still log in and drive agents, but you cannot
> complete an invitation-based signup. Point
> `MEMBER_REGISTRATION_SERVICE_BASE_URL` at your own deployment of it — the
> variable has no working default (see
> [Environment Variables](#environment-variables)).

## Implemented Flows

- Google login with direct `idToken` submit (`POST /api/v1/auth/google`)
- Invitation-token inspection and password setup after confirmation in `profile-ui`
- Session restore from OS keychain (or local fallback file if keychain is unavailable)
- Team listing and team switching
- Access catalog loading from `external-rest-api`:
  - `GET /api/v1/me/contexts`
  - `GET /api/v1/me/agents`
  - `GET /api/v1/team/contexts`
  - `GET /api/v1/team/agents`
- RPC token issuance and caching
- Allowed server listing (`GET /api/v1/rpc/servers`)
- JSON-RPC invocation (`POST /api/v1/rpc/:serverName`)
- Host message invocation (`POST /api/v1/rpc/hosts/:hostRef/messages`)

## Host Runtime Contract (via rpc-proxy)

Desktop uses dedicated host runtime routes through `rpc-proxy`:

| Endpoint                                     | Method | Required Scope        | Access Type | Transport |
| -------------------------------------------- | ------ | --------------------- | ----------- | --------- |
| `/api/v1/rpc/hosts/:hostRef/messages`        | `POST` | `host:message:invoke` | Write       | REST      |
| `/api/v1/rpc/hosts/:hostRef/activity`        | `GET`  | `host:activity:read`  | Read        | REST      |
| `/api/v1/rpc/hosts/:hostRef/activity/stream` | `GET`  | `host:activity:read`  | Read-only   | SSE       |
| `/api/v1/rpc/hosts/:hostRef/status`          | `GET`  | `host:status:read`    | Read        | REST      |
| `/api/v1/rpc/hosts/:hostRef/health`          | `GET`  | `host:health:read`    | Read        | REST      |
| `/api/v1/rpc/hosts/:hostRef/status/stream`   | `GET`  | `host:status:read`    | Read-only   | SSE       |

Desktop behavior:

- Message send uses `POST /messages`.
- Activity snapshot reads use `GET /activity`.
- Live activity timeline subscription uses `GET /activity/stream`.
- Status snapshot reads use `GET /status`.
- Live status subscription uses `GET /status/stream` only.
- The stream is read-only and is never used for message submission.
- Activity stream does not include internal reasoning/chain-of-thought content.

The app now auto-populates default RPC `hostRefs` from authorized agent names returned by the access catalog routes above. Manual host refs are still supported as an override.

## Environment Variables

- `EXTERNAL_REST_API_BASE_URL` (default: `http://127.0.0.1:8091`)
- `RPC_PROXY_BASE_URL` (default: `http://127.0.0.1:8094`)
- `MEMBER_REGISTRATION_SERVICE_BASE_URL` (no working default — falls back to the placeholder `https://example.com`, so set it explicitly; locally this is usually `http://127.0.0.1:8092`)
- `REQUEST_TIMEOUT_MS` (default: `60000`)

## Architecture

- `src/` (main/preload/services): privileged Electron process code and secure IPC handlers.
- `ui/` (React + Vite): renderer UI only (no direct Node/Electron APIs).
- `ui-dist/`: built renderer assets loaded by Electron in production mode.

Security posture:

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- Renderer-only API surface through `preload` (`window.clerum.*`)
- IPC sender validation in main process handlers

## Run

```bash
cd desktop-app
npm install
```

Then from the repository root:

1. Start the desktop app with:

```bash
npm run app
```

To start both frontends together:

```bash
npm run ui
```

These root commands reuse the existing `Makefile` port-forward targets, wait for the required local ports to become reachable, then start the frontend process and tear everything down together on exit.

The desktop frontend itself still uses `npm run dev`, which starts:

- Vite dev server for React renderer
- TypeScript watch for Electron main/preload
- Electron, pointed at local renderer URL

For production-like local run:

```bash
npm run build
npm run start
```

## Port-forward Remote Cluster Services

The root launcher already starts the required port-forwards for normal local development.

To start them manually (control-api `:8090`, external-rest-api `:8091`, rpc-proxy `:8094` — the set the desktop app and both E2E phases need), run from the repository root:

```bash
make minikube-pf-desktop
```

Individual targets, if you only need one:

```bash
make minikube-pf-control-api    # control-api    → localhost:8090
make minikube-pf-external-api   # external-rest-api → localhost:8091
make minikube-pf-rpc-proxy      # rpc-proxy      → localhost:8094
```

Optional, only for the invitation/activation flow against `profile-ui`:

```bash
kubectl -n profiles port-forward svc/profile-ui 3001:3001
```

## Testing

### Unit Tests

```bash
cd desktop-app
npm run test          # vitest — IPC handler unit tests
```

### E2E Tests (Phase 1 — IPC Harness)

Runs real IPC handlers against a live cluster via port-forwards. No Electron window needed.

**Prerequisites:**

1. Port-forwards for external-rest-api (`:8091`) and rpc-proxy (`:8094`) active — `make minikube-pf-desktop` from the repo root covers them (see [Port-forward Remote Cluster Services](#port-forward-remote-cluster-services))
2. Copy env template: `cp .env.e2e.example .env.e2e` and set `E2E_DEV_LOGIN_EMAIL` to an authorized user and `E2E_HOST_REF` to an accessible agent.

```bash
npm run test:e2e      # 33 tests — auth, teams, catalog, messages, sessions, streams, tokens
```

**What it tests:** Login round-trip, dependencies health, team listing, access catalog, RPC token lifecycle, direct MCP server invocation (JSON-RPC), host message delivery (LLM), host status/activity polling, SSE activity/status/progress streams, stream cleanup, token metadata/refresh, unauthenticated error path, logout.

**How it works:** A Vitest harness mocks only Electron's `ipcMain` and `app` APIs, then registers the real IPC handlers from `src/ipc.ts` backed by a real `AppService`. Test code calls `invoke(channel, payload)` — everything from AppService through rpc-proxy to mcp-host and the LLM is real.

### E2E Tests (Phase 2 — Playwright/Electron)

Launches the real Electron app, interacts with the UI, and sends real prompts to the agent.

**Prerequisites:**

1. Same as Phase 1 (`.env.e2e`), plus a control-api port-forward (`:8090`) — the Playwright global-setup health-checks control-api, external-rest-api and rpc-proxy before any test runs.
2. App must be built first (`npm run build`)
3. A kubectl context the global-setup allows. It defaults to `E2E_K8S_CONTEXT=clerum-test`, rejects anything outside the allow-list (`E2E_ALLOWED_CONTEXTS`, default `clerum-test` plus the GKE dev context), hard-blocks the production context, and **switches your current kubectl context** to the expected one if it differs.

The supported entry point wires all of this together (context guard → port-forwards → seed → Playwright):

```bash
make e2e-desktop-app          # from the repository root; override with E2E_CONTEXT=<ctx>
```

To run Playwright directly once port-forwards and context are already set up:

```bash
npm run test:e2e:playwright   # ~81 tests across 40 spec files — builds, then launches Electron
```

**What it tests:** Login flow (handles persisted sessions), sidebar navigation, agent list rendering, sending messages with real LLM responses, tool calls and multi-tool orchestration, progress stepper expand/collapse, approval flows, workflow recipes and runs, artifacts, GFS, sandbox-ui, Telegram, cross-device sessions, error resilience.

### Full Suite

```bash
npm run test:e2e:all          # Phase 1 + Phase 2
```

### Environment Configuration (`.env.e2e`)

| Variable                               | Default                                      | Description                                                                                                          |
| -------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `EXTERNAL_REST_API_BASE_URL`           | `http://localhost:8091`                      | external-rest-api URL                                                                                                |
| `RPC_PROXY_BASE_URL`                   | `http://localhost:8094`                      | rpc-proxy URL                                                                                                        |
| `MEMBER_REGISTRATION_SERVICE_BASE_URL` | `https://example.com` (placeholder — set it) | member-registration-service activation URL. There is no working default: unset, it silently points at `example.com`. |
| `E2E_DEV_LOGIN_EMAIL`                  | `test@clerum.io`                             | Test-only login email (must have agent access)                                                                       |
| `E2E_DEV_LOGIN_EMAIL_2`                | `test2@clerum.io`                            | Second user, required by the cross-device session tests                                                              |
| `E2E_DEV_LOGIN_NAME`                   | `Test User`                                  | Test-only login display name                                                                                         |
| `E2E_HOST_REF`                         | `chatllm`                                    | Agent hostRef to test against                                                                                        |
| `E2E_ALLOW_DEV_PORT_FORWARD`           | unset (off)                                  | Set to `1`/`true` to let the Playwright global-setup guard accept localhost port-forward URLs                        |

## Notes

- The Google path currently expects an already-issued `idToken` pasted in the app. Integrating full OAuth browser/redirect is a separate step.
- Renderer runs with:
  - `contextIsolation: true`
  - `nodeIntegration: false`
- API access is exposed via preload IPC only (`window.clerum.*`).
