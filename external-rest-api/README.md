# External REST API

`external-rest-api` (deployed as image `external-rest-api`) stores and serves user profile channel identifiers (email, slack username, telegram id), team membership roles, invitation workflows, and RPC token brokerage.

## Stack

- Node.js + TypeScript
- Express.js
- Internal REST integration with `control-api` (through the profile control funnel)
- Internal REST integration with `member-registration-service` for outbound email delivery
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
- `DELETE /api/v1/members/:userId` - retire a member account (`admin`); requires
  JSON `{ "reason": "<non-empty>" }` and an `Idempotency-Key` header. Missing
  fields return `400`; this is a breaking v1 contract for direct clients.
- `POST /api/v1/invitations/accept` - accept invitation after profile-ui sign-in
- `GET /api/v1/directory/search?q=...` - lookup directory users for channel mapping

### RPC token mint denials

`POST /api/v1/rpc/token` relays the mint's 403 as `{ error, code, revokedHostRefs }` only when Control API supplies the exact code `host_access_revoked` and `revokedHostRefs` is exactly the sorted, trimmed, deduplicated set of requested Host refs. Both extra fields are forwarded together; unknown fields are excluded. Missing, malformed or noncanonical revocation fields produce only `{ error }`. The relay never repairs a malformed list into a confirmed revocation. Non-403 and network errors keep their existing propagation.

Control API emits this code only when all requested agent Hosts are denied and none is reachable through direct grants or any active team membership. The references are the sorted, deduplicated, trimmed requested agent-Host set. A mixed granted/reachable and denied request retains its original error-only body, so a healthy requested Host is never classified as revoked by a correct mint response.

Malformed extras are dropped without a runtime signal. C1 covers the mint output, E1/E2 cover canonical relay validation, and cross-service guards G1/G2 cover propagation of the reserved field names. Deploy Control API before this relay, then release Desktop. Older server hops leave mint denials uncertain; a new Desktop validates coverage of every requested Host before confirming revocation.

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
- `EXTERNAL_REST_API_MEMBER_REGISTRATION_SERVICE_BASE_URL`: Base URL for internal calls to `member-registration-service`.
- `EXTERNAL_REST_API_MEMBER_REGISTRATION_SERVICE_SERVICE_TOKEN`: Shared bearer token used when `external-rest-api` authenticates to `member-registration-service`.
- `EXTERNAL_REST_API_MEMBER_REGISTRATION_SERVICE_SERVICE_NAME`: Service identity sent in `x-service-token` for `member-registration-service` internal auth checks.
- `EXTERNAL_REST_API_JWT_PUBLIC_KEY`: RSA public key used to verify session JWTs locally in `external-rest-api` (RS256).
- `EXTERNAL_REST_API_JWT_ISSUER`: Expected `iss` claim for session JWT verification.
- `EXTERNAL_REST_API_JWT_AUDIENCE`: Expected `aud` claim for session JWT verification.

Session JWT issuance is centralized in `control-api`. `external-rest-api` verifies session JWTs locally with a public key and still uses `control-api` for internal profile/team operations.

## Security Model

`external-rest-api` uses a delegated security model where identity and session authority remain in `control-api`, while `external-rest-api` enforces request-level guards for public endpoints.

- **Edge identity proof (Google)**: `POST /api/v1/auth/google` verifies the Google ID token with `google-auth-library` using `EXTERNAL_REST_API_GOOGLE_CLIENT_ID` as audience.
- **Session issuance authority**: after Google token verification, `external-rest-api` calls `control-api` internal auth endpoints, and `control-api` mints Clerum session tokens.
- **Local session verification**: protected routes in `external-rest-api` validate bearer tokens locally using `EXTERNAL_REST_API_JWT_PUBLIC_KEY` (RS256) with issuer and audience checks.
- **Internal service authentication**: calls from `external-rest-api` to `control-api` include `Authorization: Bearer <service-token>` plus `x-service-token: <service-name>`, and are checked by `control-api` internal middleware.
- **Delegated email delivery**: invitation email dispatch is forwarded to `member-registration-service`, which owns the actual SMTP integration.
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

## Security Improvements (Next Steps)

- **Harden Google claim validation**: explicitly require `email_verified=true` and document accepted identity claims.
- **Keep centralized policy for sensitive operations**: use a hybrid model where critical actions still perform live authorization checks in `control-api`.
- **Strengthen transport and network boundaries**: enforce TLS everywhere, tighten NetworkPolicies, and limit egress from `external-rest-api` to only required services.
- **Improve credential hygiene**: move all service credentials to Kubernetes Secrets, rotate regularly, and avoid inline placeholders in deployment examples.
- **Add security-focused tests**: extend tests for tampered tokens, disabled users, role downgrades, and authorization regression cases across route handlers.
- **Add audit logging**: emit structured auth and privileged-action audit events with request correlation IDs across `external-rest-api` and `control-api`.

## Local Run

Use Node 24 or newer. Start `control-api` first with `CLERUM_DEV_MODE=true`
so it creates the shared development signing keys, then start this service in
a separate terminal:

```bash
cd external-rest-api
npm install
CLERUM_DEV_MODE=true npm run dev
```

`make dev` also opts into this local mode. It is rejected with
`NODE_ENV=production`. Without this opt-in, set
`EXTERNAL_REST_API_JWT_PUBLIC_KEY` explicitly.

The shared store defaults to `control-api/.dev-keys` in the same checkout.
Leave `EVENFIRE_DEV_KEY_STORE` unset or blank to use that default; a nonblank
override must be an absolute path set consistently in all three services.
`control-api` persists generated keys across restarts, and this service reads
`session.public.pem` at startup.

If `CONTROL_API_SESSION_JWT_PRIVATE_KEY` is supplied through the environment,
set `EXTERNAL_REST_API_JWT_PUBLIC_KEY` to its matching public key explicitly.
The signer does not update the store for an environment-supplied key, so an
older store may contain a different identity. After deleting or rotating stored
keys, or switching to an environment-supplied key, reconfigure the verifier as
needed and restart it. Running verifiers do not silently refresh their key
identity.

JWT material is checked by the shared `@clerum/jwt-key-policy`. Configure an
RSA public key as SPKI or PKCS#1 PEM. An X509 certificate may carry the public
identity, without CA, hostname or expiry validation. Private PEM environment
values remain accepted for legacy compatibility and are converted to public
SPKI; prefer supplying only the public half. Store public files reject private
material. Exactly one complete PEM object is required; bundles, encrypted
private material, non-RSA keys and historical committed identities fail.

Every RS256 key must be RSA-2048 or stronger, including verifiers. This
deliberately rejects previously accepted weak verifier keys under
[RFC 7518 section 3.3](https://www.rfc-editor.org/rfc/rfc7518.html#section-3.3).
The material/read limit is 64 KiB. Invalid explicit input never selects a
different source or regenerates an identity.

The dev store requires POSIX no-follow/nonblocking/exclusive-file guarantees,
trusted ancestor directories and cooperating services with the same effective
UID. It does not defend against hostile ancestors or same-UID processes.
Use explicit signing/verifying environment keys for different users or
unsupported platforms; this verifier then performs no store access. Corrupt
or rejected keys require operator repair; they are not rotated automatically.

`make docker-build` uses the repository root context. The equivalent command
from that root is `docker build -f external-rest-api/Dockerfile .`. The image
preserves the service/package layout and excludes package tests and local key
data.

## Kubernetes Deploy

```bash
cd external-rest-api
kubectl apply -f deploy/example.secret.yaml
make deploy
```

`deploy/deployment.yaml` expects `EXTERNAL_REST_API_JWT_PUBLIC_KEY` in the `external-rest-api-secrets` Secret.
