# External REST API

`external-rest-api` (deployed as image `external-rest-api`) stores and serves user profile channel identifiers (email, slack username, telegram id), team membership roles, invitation workflows, and RPC token brokerage.

## Stack

- Node.js + TypeScript
- Express.js
- Internal REST integration with `control-api` (through the profile control funnel)
- Google ID token verification (`google-auth-library`)

## Key Endpoints

- `POST /api/v1/auth/google` - login with Google ID token
- `GET /api/v1/me` - current user + team + profile
- `GET /api/v1/me/contexts` - contexts authorized for the authenticated user
- `GET /api/v1/me/agents` - agents authorized for the authenticated user
- `PUT /api/v1/me/profile` - update current user profile channels
- `GET /api/v1/team/contexts` - contexts authorized for the authenticated team
- `GET /api/v1/team/agents` - agents authorized for the authenticated team
- `POST /api/v1/rpc/token` - issue short-lived RPC access token for `rpc-proxy`
- `GET /api/v1/team/members` - list team members
- `POST /api/v1/team/members/invite` - invite member (`admin/inviter`)
- `DELETE /api/v1/team/members/:userId` - remove member (`admin`)
- `POST /api/v1/invitations/accept` - accept invitation after profile-ui sign-in
- `GET /api/v1/directory/search?q=...` - lookup directory users for channel mapping

## Roles

- `admin`: invite and delete members
- `inviter`: invite members
- `member`: basic profile usage

## Environment

See `.env.example`.

Environment variables:

- `EXTERNAL_REST_API_PORT`: HTTP port the service listens on (default `8091`).
- `EXTERNAL_REST_API_CORS_ORIGIN`: Allowed CORS origin for browser requests (`*` allows all origins).
- `EXTERNAL_REST_API_GOOGLE_CLIENT_ID`: Google OAuth client ID used to verify incoming Google ID tokens.
- `EXTERNAL_REST_API_CONTROL_API_BASE_URL`: Base URL for internal calls to `control-api` (typically through the profile control funnel).
- `EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN`: Shared bearer token used when `external-rest-api` authenticates to `control-api`.
- `EXTERNAL_REST_API_CONTROL_API_SERVICE_NAME`: Service identity sent in `x-service-token` for `control-api` internal auth checks (default `external-rest-api`).
- `EXTERNAL_REST_API_JWT_PUBLIC_KEY`: RSA public key used to verify session JWTs locally in `external-rest-api` (RS256).
- `EXTERNAL_REST_API_JWT_ISSUER`: Expected `iss` claim for session JWT verification.
- `EXTERNAL_REST_API_JWT_AUDIENCE`: Expected `aud` claim for session JWT verification.
- `EXTERNAL_REST_API_JSON_BODY_LIMIT`: Max JSON request body accepted by Express (default `150mb`).
- `EXTERNAL_REST_API_PROFILE_SESSION_COOKIE_TTL_SECONDS`: Profile session cookie lifetime in seconds (default `43200` — 12h). Must be a positive integer.

Returned to the desktop app by `GET /api/v1/desktop/environment`, so setup can
discover where to reach the platform. The dev defaults point at localhost; set
these in any real deployment:

- `EXTERNAL_REST_API_PUBLIC_BASE_URL`: Publicly reachable base URL of **this** service (dev default `http://127.0.0.1:8091`). Trailing slashes stripped.
- `EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL`: `rpc-proxy` base URL advertised to the desktop app (dev default `http://127.0.0.1:8094`). Trailing slashes stripped.
- `EXTERNAL_REST_API_DESKTOP_APP_NAME`: Desktop app name in that payload (default `Evenfire`).
- `EXTERNAL_REST_API_DESKTOP_RELEASE_BASE_URL`: Base URL for the release link from `GET /api/v1/desktop/release` (default `https://github.com/evenfire-ai/evenfire/releases`).

> `EXTERNAL_REST_API_PG_CONNECTION_STRING` exists in `src/db.ts` but is **not
> live**: nothing imports `db.ts` or `src/repositories/`, and `initDb()` is never
> called. All data access goes through `control-api` (see the delegated security
> model below). Setting it has no effect.

Session JWT issuance is centralized in `control-api`. `external-rest-api` verifies session JWTs locally with a public key and still uses `control-api` for internal profile/team operations.

## Security Model

`external-rest-api` uses a delegated security model where identity and session authority remain in `control-api`, while `external-rest-api` enforces request-level guards for public endpoints.

- **Edge identity proof (Google)**: `POST /api/v1/auth/google` verifies the Google ID token with `google-auth-library` using `EXTERNAL_REST_API_GOOGLE_CLIENT_ID` as audience.
- **Session issuance authority**: after Google token verification, `external-rest-api` calls `control-api` internal auth endpoints, and `control-api` mints Clerum session tokens.
- **Local session verification**: protected routes in `external-rest-api` validate bearer tokens locally using `EXTERNAL_REST_API_JWT_PUBLIC_KEY` (RS256) with issuer and audience checks.
- **Internal service authentication**: calls from `external-rest-api` to `control-api` include `Authorization: Bearer <service-token>` plus `x-service-token: <service-name>`, and are checked by `control-api` internal middleware.
- **Authorization boundary**: team membership and role decisions are enforced by `control-api` profile services; `external-rest-api` acts as the external facade and transport boundary.
- **Reduced machine-to-machine surface**: service-token access to `/directory/search` was removed; directory lookups now require an authenticated user token.

### Forwarding Endpoints Security

The new access discovery endpoints are forwarding-only endpoints that preserve claim-binding security:

- `GET /api/v1/me/contexts` forwards to `control-api` `GET /api/v1/external/users/:userId/contexts`.
- `GET /api/v1/me/agents` forwards to `control-api` `GET /api/v1/external/users/:userId/agents`.
- `GET /api/v1/team/contexts` forwards to `control-api` `GET /api/v1/external/teams/:teamId/contexts`.
- `GET /api/v1/team/agents` forwards to `control-api` `GET /api/v1/external/teams/:teamId/agents`.

Security guarantees:

- Caller must present a valid bearer session token (`requireAuth`).
- `external-rest-api` derives `userId` and `teamId` from verified token claims, never from user input.
- `external-rest-api` forwards the same session token to `control-api` in `x-user-session-token`.
- `control-api` re-validates token and claim-binding at route level (`:userId`/`:teamId` match), preventing cross-user or cross-team data access.

## Local Run

```bash
cd external-rest-api
npm install
npm run dev
```
