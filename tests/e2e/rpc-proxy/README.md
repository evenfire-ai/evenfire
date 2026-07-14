# RPC Proxy E2E Security Suite

This suite validates internet-facing `rpc-proxy` behavior with emphasis on authentication, authorization, token integrity, TTL, scope controls, and upstream handling.

## Location

- Tests: `tests/e2e/rpc-proxy/security.e2e.test.ts`
- Helpers: `tests/e2e/rpc-proxy/helpers/*`

## Prerequisites

- Node.js 24+ available locally.
- Repo dependencies installed for:
  - `rpc-proxy`
  - `tests/e2e`
- Optional remote `control-api` port-forward can be active, but this suite uses an isolated local control-api stub for deterministic E2E behavior.

## Run

From repo root:

```bash
npm --prefix tests/e2e install
npm --prefix rpc-proxy install
npm --prefix rpc-proxy run test:e2e
```

or directly:

```bash
npm --prefix tests/e2e run test:rpc-proxy-e2e
```

## Security Coverage

- Health endpoint baseline.
- Authorization header enforcement (missing/non-bearer/oversized token).
- JWT hardening:
  - malformed tokens
  - bad signatures
  - wrong issuer/audience
  - expired tokens
  - token type mismatch (`typ=service` on user routes)
- Claims constraints:
  - empty scopes
  - empty/wildcard `hostRefs`
- missing required route scope (`mcp:servers:list`, `mcp:server:invoke`, `host:message:invoke`, `host:status:read`, `host:health:read`, `host:activity:read`)
- Route authorization:
  - valid token but unauthorized server
  - valid token but unauthorized host
  - authorized server invoke path
  - authorized host message invoke path
  - authorized host status snapshot path
  - authorized host health path
  - authorized host status stream path (read-only)
- JSON-RPC validation:
  - invalid payload
  - disallowed method pattern
  - allowed slash method (`tools/list`)
- Upstream handling:
  - upstream 400/500 mapped to JSON-RPC `-32002`
  - upstream timeout mapped to HTTP 504
  - response payloads avoid token leaks
  - host message upstream failures/timeouts mapped safely
- MCP session bootstrap path (MongoDB style):
  - initial generic `-32004 invalid request`
  - initialize + `notifications/initialized`
  - successful retry of `tools/list`

## Notes

- The test harness starts a real `rpc-proxy` process (no router mocks).
- A local stub control-api and MCP upstream are used to keep tests deterministic and CI-safe.
- Host runtime contract under test:
  - `POST /api/v1/rpc/hosts/:hostRef/messages` is write-only message submit.
  - `GET /api/v1/rpc/hosts/:hostRef/activity` and `GET /activity/stream` are read-only timeline channels.
  - `GET /api/v1/rpc/hosts/:hostRef/status` and `GET /health` are REST reads.
  - `GET /api/v1/rpc/hosts/:hostRef/status/stream` is SSE read-only telemetry.
