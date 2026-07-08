# Clerum Desktop App (Electron + React)

Electron desktop client with a React renderer. The app authenticates through `external-rest-api`, obtains short-lived RPC access tokens, and invokes MCP servers and MCP hosts through `rpc-proxy`.

## Security Model

- User session token is obtained from `external-rest-api`.
- RPC access token is issued by `external-rest-api` via `control-api` and is scoped (`mcp:servers:list`, `mcp:server:invoke`, `host:health:read`, `host:status:read`, `host:activity:read`, `host:message:invoke`) and short-lived.
- Desktop app calls only:
  - `external-rest-api` for user/session and token issuance.
  - `rpc-proxy` for agent discovery and invocation.
- `control-api` internal service tokens are never stored in the desktop app.

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
- `MEMBER_REGISTRATION_SERVICE_BASE_URL` (default: `http://127.0.0.1:8092`)
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

The root launcher already starts the required port-forwards for normal local development. Optional manual debugging commands:

```bash
kubectl -n profiles port-forward svc/profile-ui 3001:3001
kubectl -n control-plane port-forward svc/control-api 8090:8090
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

1. Port-forwards active (see [Port-forward Remote Cluster Services](#port-forward-remote-cluster-services))
2. Copy env template: `cp .env.e2e.example .env.e2e` and set `E2E_DEV_LOGIN_EMAIL` to an authorized user and `E2E_HOST_REF` to an accessible agent.

```bash
npm run test:e2e      # 19 tests — auth, teams, catalog, messages, streams, tokens (~45s)
```

**What it tests:** Login round-trip, dependencies health, team listing, access catalog, RPC token lifecycle, direct MCP server invocation (JSON-RPC), host message delivery (LLM), host status/activity polling, SSE activity/status/progress streams, stream cleanup, token metadata/refresh, unauthenticated error path, logout.

**How it works:** A Vitest harness mocks only Electron's `ipcMain` and `app` APIs, then registers the real IPC handlers from `src/ipc.ts` backed by a real `AppService`. Test code calls `invoke(channel, payload)` — everything from AppService through rpc-proxy to mcp-host and the LLM is real.

### E2E Tests (Phase 2 — Playwright/Electron)

Launches the real Electron app, interacts with the UI, and sends real prompts to the agent.

**Prerequisites:**

1. Same as Phase 1 (port-forwards + `.env.e2e`)
2. App must be built first (`npm run build`)

```bash
npm run test:e2e:playwright   # 9 tests — builds, then launches Electron (~2-3min)
```

**What it tests:** Login flow (handles persisted sessions), sidebar navigation (all 4 pages), agent list rendering, sending messages with real LLM responses, MongoDB tool calls (`list-databases`), Airtable tool calls (`list_bases`), multi-tool orchestration, progress stepper expand/collapse, error resilience.

### Full Suite

```bash
npm run test:e2e:all          # Phase 1 + Phase 2 (~3-4min total)
```

### Environment Configuration (`.env.e2e`)

| Variable                               | Default                 | Description                                    |
| -------------------------------------- | ----------------------- | ---------------------------------------------- |
| `EXTERNAL_REST_API_BASE_URL`           | `http://localhost:8091` | external-rest-api URL                          |
| `RPC_PROXY_BASE_URL`                   | `http://localhost:8094` | rpc-proxy URL                                  |
| `MEMBER_REGISTRATION_SERVICE_BASE_URL` | `http://localhost:8092` | member-registration-service activation URL     |
| `E2E_DEV_LOGIN_EMAIL`                  | `test@clerum.io`        | Test-only login email (must have agent access) |
| `E2E_DEV_LOGIN_NAME`                   | `Test User`             | Test-only login display name                   |
| `E2E_HOST_REF`                         | `chatllm`               | Agent hostRef to test against                  |

## Notes

- The Google path currently expects an already-issued `idToken` pasted in the app. Integrating full OAuth browser/redirect is a separate step.
- Renderer runs with:
  - `contextIsolation: true`
  - `nodeIntegration: false`
- API access is exposed via preload IPC only (`window.clerum.*`).
