# External REST API E2E Security Suite

This suite validates the internet-facing `external-rest-api` with a security-first focus.

## Location

- Tests: `tests/e2e/external-rest-api/security.e2e.test.ts`
- Helpers: `tests/e2e/external-rest-api/helpers/*`

## Prerequisites

- Node.js 22+ installed.
- Dependencies installed for:
  - `tests/e2e`
  - `external-rest-api`
- No cluster dependency is required for this suite. It uses local deterministic stubs.

## Run

From repo root:

```bash
npm --prefix tests/e2e install
npm --prefix external-rest-api install
npm --prefix external-rest-api run test:e2e
```

Or run directly:

```bash
npm --prefix tests/e2e run test:external-rest-api-e2e
```

## Security Matrix Covered

- **Auth endpoint behavior**
  - `/api/v1/auth/google` missing `idToken` validation

- **Session token hardening**
  - Missing `Authorization` rejected
  - Non-bearer header rejected
  - Oversized token rejected
  - Malformed token rejected
  - Wrong signature rejected
  - Wrong issuer rejected
  - Wrong audience rejected
  - Expired token rejected
  - Missing required claims rejected

- **Claim binding and protected route behavior**
  - `/api/v1/me` and `/api/v1/me/*` use identity from verified token
  - `/api/v1/team/*` uses team from verified token
  - `/api/v1/me/profile` rejects cross-user update attempts
  - `/api/v1/directory/search` requires auth

- **RPC token brokerage**
  - Valid `scopes` + `hostRefs` returns token + TTL
  - Invalid scopes rejected
  - Empty scopes/hostRefs rejected
  - Wildcard hostRef rejected

- **Upstream dependency failure handling**
  - Control API failures map to safe HTTP 500 responses
  - Response bodies do not leak service token secrets

## Notes

- Tests start a real `external-rest-api` process.
- A local stub `control-api` server is used for deterministic, CI-safe behavior.
- Session JWT signing uses test-only keys under `tests/e2e/external-rest-api/helpers/jwt.ts`.
