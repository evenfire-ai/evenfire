# Clerum Control API

`control-api` is the internal control-plane backend for Clerum.

It provides:

- CRUD and list APIs for Clerum CRDs (`Host`, `Context`, `CommunicationChannel`, `McpServer`)
- constrained secret-management endpoints
- external and rpc-access APIs consumed by `external-rest-api` and `rpc-proxy`
- JWT issuance/verification for external sessions and RPC access

## Current Implementation Overview

### Router layout

- `createHealthRouter()` -> liveness
- `/api/v1` mounted routers:
  - `createAdminRouter(gateway)` (admin profile + hosts overview + secrets + resources)
  - `requireInternalToken` + `createExternalRouter()` + `createRpcAccessRouter(gateway)`

`control-api` does not expose unauthenticated invitation routes. Invitation token lookup, confirmation,
and password setup all enter through `external-rest-api` or `profile-ui` and then call the
internal `/api/v1/external/...` surface with service authentication.

### Data/control responsibilities

- Kubernetes resource operations are handled through `K8sGateway`
- Profile/team data persistence is in control-plane Postgres
- Secrets operations are namespace-constrained and label-filtered for host secrets

## Authentication and Authorization

### 1) Internal service authentication (`/api/v1/external/...` and `/api/v1/rpc/access/...`)

The internal service route chain (`createExternalRouter()` + `createRpcAccessRouter(gateway)`) is guarded by `requireInternalToken`.

Current expected headers for internal service calls:

- `Authorization: Bearer <service-token>`
- `x-service-token: <service-name>`
- `x-user-session-token: <user-session-jwt>` (required on `/api/v1/external/{users|teams|invitations|directory}/*`)
- `x-rpc-access-token: <rpc-access-jwt>` (required on `/api/v1/rpc/access/*`)

Validation behavior:

- service name is used to look up expected token in `CONTROL_API_INTERNAL_SERVICE_TOKENS`
- token comparison uses timing-safe equality
- invalid/missing identity or token returns `401`
- `/external/users`, `/external/teams`, `/external/invitations`, and `/external/directory` additionally require a valid `x-user-session-token` verified by `control-api`
- `/rpc/access/*` additionally requires a valid `x-rpc-access-token` (RS256 JWT), with scope and route-claim matching (`sub` = `:userId`, `teamId` = `:teamId`, `hostRefs` must include `:hostRef` for host routes)

### 2) User/session JWT

`externalSessionAuthToken.ts` signs and verifies session tokens with:

- `RS256`
- `iss` / `aud` checks
- required claims: `userId`, `email`, `teamId`, `role`, `exp`

### 3) RPC access JWT for `rpc-proxy`

`rpcAuthToken.ts` issues short-lived RPC tokens for first-party app RPC access (RS256-signed):

- claims: `sub` (user), `typ` (`user`), `teamId`, `hostRefs`, `scopes`, `jti`, `iat`, `exp`
- role-based default scope narrowing (`mcp:servers:list`, `mcp:server:invoke`, `host:health:read`, `host:status:read`, `host:activity:read`, `host:message:invoke`, `host:task:read`, `host:approval:write`)
- requested scopes are filtered against allowed scopes

### Why RPC and REST use different env vars

`control-api` issues two different token families with different consumers and risk profiles, so configuration is split on purpose:

- **REST session JWTs** (`CONTROL_API_SESSION_JWT_PRIVATE_KEY`, `CONTROL_API_JWT_ISSUER`, `CONTROL_API_JWT_AUDIENCE`) are used for user session authentication consumed by `external-rest-api` and user-facing flows.
- **RPC access JWTs** (`CONTROL_API_RPC_JWT_PRIVATE_KEY`, `CONTROL_API_RPC_JWT_ISSUER`, `CONTROL_API_RPC_JWT_AUDIENCE`, `CONTROL_API_RPC_TOKEN_TTL_SECONDS`) are short-lived capability tokens consumed by `rpc-proxy` for constrained MCP operations.

Benefits of keeping them separate:

- **Blast-radius reduction**: compromise of one token domain (for example RPC) does not automatically compromise session-token trust.
- **Independent key rotation**: rotate RPC and REST credentials on different schedules without cross-service outages.
- **Audience isolation**: each token family is bound to a specific audience (`profile-ui`/session consumers vs `rpc-proxy`), reducing token reuse across surfaces.
- **Policy flexibility**: RPC tokens can keep tighter TTL/scope constraints while session tokens keep user-session ergonomics.

If you need fewer variables operationally, you can reuse a single keypair across both domains, but keep distinct audiences and TTL policies to preserve the security boundary.

### 4) rpc/access protection model

`rpc/access` authorization is currently enforced through service-token checks, gateway whitelist, and network policy constraints (for example, `rpc-proxy` limited to GET discovery path).

Host runtime scope intent for `rpc-proxy` callers:

| Scope                 | Purpose                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `host:message:invoke` | authorizes host message/task submission route                            |
| `host:status:read`    | authorizes host status snapshot and status stream routes                 |
| `host:activity:read`  | authorizes host activity snapshot and activity stream routes (read-only) |
| `host:health:read`    | authorizes host health/liveness route                                    |
| `host:task:read`      | authorizes host task status and result routes (read-only)                |
| `host:approval:write` | authorizes host approval submission                                      |

### 5) Control UI admin auth

`control-api` exposes a dedicated admin auth flow for `control-ui`:

- `POST /api/v1/admin/auth/login` (username/password)
- `GET /api/v1/admin/auth/me`
- `POST /api/v1/admin/auth/logout`

Admin sessions are signed as RS256 JWTs with audience `control-ui`. UI-facing routes (`/api/v1/admin/hosts`, `/api/v1/admin/contexts`, `/api/v1/admin/mcp-servers`, `/api/v1/admin/communication-channels`, `/api/v1/admin/secrets`, `/api/v1/admin/...`) require this admin JWT.

## API Surface (high level)

### Core control-plane

- `GET /health`
- `GET /api/v1/admin/hosts-overview`
- `GET /api/v1/admin/hosts/:name/overview`
- `GET|POST /api/v1/admin/{hosts|contexts|communication-channels|mcp-servers}`
- `GET|PUT|DELETE /api/v1/admin/{hosts|contexts|communication-channels|mcp-servers}/:name`

### Secrets

- `GET /api/v1/admin/secrets`
- `POST /api/v1/admin/secrets`
- `PUT /api/v1/admin/secrets`
- `DELETE /api/v1/admin/secrets/:name`

`secrets` routes always use `CONTROL_API_SECRETS_NAMESPACE` and reject `namespace` query overrides.

### External and RPC-access

- `POST /api/v1/external/auth/google-login`
- `POST /api/v1/external/auth/verify`
- `POST /api/v1/external/auth/session-token`
- `POST /api/v1/external/rpc/token`
- `GET /api/v1/rpc/access/users/:userId/{contexts|agents}`
- `GET /api/v1/rpc/access/teams/:teamId/{contexts|agents}`
- `GET /api/v1/rpc/access/users/:userId/mcp-servers`
- `GET /api/v1/rpc/access/users/:userId/mcp-hosts/:hostRef`
- additional `/api/v1/external/...` team/member/invitation/directory operations

`/external/rpc/token` requires a `sessionToken` and verifies it server-side in `control-api`; user identity claims are derived from the verified JWT instead of trusting forwarded identity fields.

### Admin

- `POST /api/v1/admin/auth/login`
- `GET /api/v1/admin/auth/me`
- `POST /api/v1/admin/auth/logout`
- `GET /api/v1/admin/users`
- `DELETE /api/v1/admin/users/:userId` — hard-deletes the user row (profiles, personal context/agent links, and their `team_members` rows CASCADE). Teams are retained even if this leaves them with zero members. User-linked audit/history rows keep their event data but set the deleted user reference to `NULL`. **Destructive and irreversible** for that user id.
- `GET /api/v1/admin/teams`
- `POST /api/v1/admin/teams` — creates a team shell without assigning initial members
- `DELETE /api/v1/admin/teams/:teamId` — hard-deletes the team (memberships, invitations, team context/agent links CASCADE). **Destructive and irreversible** for that team id.
- `PUT /api/v1/admin/teams/:teamId/name`
- `GET /api/v1/admin/teams/:teamId/members`
- `PATCH /api/v1/admin/teams/:teamId/members/:userId/role`
- `DELETE /api/v1/admin/teams/:teamId/members/:userId` — soft-removes membership (`status = deleted`)
- `POST /api/v1/admin/teams/:teamId/invitations`
- plus related user/team context and agent mapping endpoints

## Key Environment Variables

Resource/namespace controls:

- `CONTROL_API_HOSTS_NAMESPACE` (default `mcp-host`)
- `CONTROL_API_CONTEXTS_NAMESPACE` (default `mcp-server`)
- `CONTROL_API_COMMUNICATION_CHANNELS_NAMESPACE` (default `channels`)
- `CONTROL_API_MCP_SERVERS_NAMESPACE` (default `mcp-server`)
- `CONTROL_API_SECRETS_NAMESPACE` (default `mcp-host`)

Auth settings:

- `CONTROL_API_SESSION_JWT_PRIVATE_KEY`: RSA private key used to sign external REST API session JWTs (`/external/auth/*`) with RS256.
- `CONTROL_API_RPC_JWT_PRIVATE_KEY`: RSA private key used to sign RPC access JWTs for `rpc-proxy` (RS256).
- `CONTROL_API_JWT_ISSUER`: expected `iss` for session token signing and verification.
- `CONTROL_API_JWT_AUDIENCE`: expected `aud` for session token signing and verification.
- `CONTROL_API_GOOGLE_CLIENT_ID`: Google OAuth client ID used when `control-api` verifies incoming Google ID tokens for `/external/auth/google-login`.
- `CONTROL_API_RPC_JWT_ISSUER`: expected `iss` claim for RPC access tokens.
- `CONTROL_API_RPC_JWT_AUDIENCE`: expected `aud` claim for RPC access tokens (must match `rpc-proxy`).
- `CONTROL_API_RPC_TOKEN_TTL_SECONDS`: lifetime of RPC access tokens in seconds.
- `CONTROL_API_INTERNAL_SERVICE_TOKENS`: service-to-token map for internal service auth (`service=token,service=token`).
- `CONTROL_API_ADMIN_JWT_PRIVATE_KEY`: RSA private key used to sign `control-ui` admin JWTs (RS256).
- `CONTROL_API_ADMIN_JWT_ISSUER`: expected `iss` for admin JWT signing and verification.
- `CONTROL_API_ADMIN_JWT_AUDIENCE`: expected `aud` for admin JWTs (`control-ui`).
- `CONTROL_API_ADMIN_JWT_TTL_SECONDS`: lifetime of admin JWTs in seconds.
- `CONTROL_API_ADMIN_AUTH_MAX_FAILURES`: failed login attempts before temporary account lock.
- `CONTROL_API_ADMIN_AUTH_LOCK_MINUTES`: account lock duration after too many failed attempts.
- `CONTROL_API_ADMIN_BOOTSTRAP_USERNAME`: bootstrap admin username inserted/updated at startup.
- `CONTROL_API_ADMIN_BOOTSTRAP_PASSWORD_HASH`: bcrypt password hash for bootstrap admin user.
- `CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL`: desktop runtime external-rest-api URL registered with invitation flows.
- `CONTROL_API_DESKTOP_RPC_PROXY_BASE_URL`: desktop runtime rpc-proxy URL registered with invitation flows.
- `CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL`: profile-ui URL used for invitation links and desktop setup.
- `CONTROL_API_DESKTOP_APP_NAME`: desktop app name associated with invitation flow configs.

Issuance and image controls:

- `CONTROL_API_ALLOWED_ISSUANCE_NAMESPACES`: comma-separated allowlist of namespaces a caller may mint host/provisioner tokens for (default: `mcp-host,sandbox-recipes`). Values are lowercased and de-duplicated. A startup guard **rejects boot** unless the list contains both the hosts and sandbox namespaces.
- `CONTROL_API_REMOTE_MCP_EGRESS_PROXY_IMAGE`: image stamped into `spec.image` for remote-MCP entries installed from the registry (default `clerum/nginx-egress-proxy:0.1.0`).

OAuth secrets — **both are required in production**; control-api refuses to start without them (see [Generating Secrets and Keys](#generating-secrets-and-keys)):

- `CONTROL_API_OAUTH_STATE_HMAC_SECRET`: HMAC secret for OAuth state parameters.
- `CONTROL_API_OAUTH_ENCRYPTION_KEY`: encryption key for stored OAuth tokens.

Route-policy controls:

- `CONTROL_API_POLICY_AUTH_AUDIENCE`: expected audience used by protected route-policy checks.

### Generating Secrets and Keys

Generate RSA keypair for session JWTs (RS256):

```bash
# Private key for control-api (CONTROL_API_SESSION_JWT_PRIVATE_KEY)
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out session-jwt-private.pem

# Public key for external-rest-api (EXTERNAL_REST_API_JWT_PUBLIC_KEY)
openssl pkey -in session-jwt-private.pem -pubout -out session-jwt-public.pem
```

Generate internal service tokens:

```bash
EXTERNAL_REST_API_TOKEN="$(openssl rand -hex 32)"
RPC_PROXY_TOKEN="$(openssl rand -hex 32)"
echo "external-rest-api=${EXTERNAL_REST_API_TOKEN},rpc-proxy=${RPC_PROXY_TOKEN}"
```

Generate bcrypt hash for bootstrap `control-ui` admin password:

```bash
node -e "const b=require('bcryptjs'); console.log(b.hashSync('replace-with-strong-password', 12));"
```

Generate RSA keypair for RS256 RPC tokens:

```bash
# Private key for control-api (CONTROL_API_RPC_JWT_PRIVATE_KEY)
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out rpc-jwt-private.pem

# Public key for rpc-proxy (RPC_PROXY_JWT_PUBLIC_KEY)
openssl pkey -in rpc-jwt-private.pem -pubout -out rpc-jwt-public.pem
```

Generate the OAuth secrets. **Both are required in production** — control-api
refuses to start without them (`src/config.ts`, `requiredOrDevDefault`), so a
Secret built by hand without these will crash-loop:

```bash
# CONTROL_API_OAUTH_STATE_HMAC_SECRET
openssl rand -hex 32

# CONTROL_API_OAUTH_ENCRYPTION_KEY
openssl rand -hex 32
```

When storing PEM values in env vars/secrets, preserve line breaks (or encode as `\n` and normalize at runtime).

> The scripted paths already do all of the above —
> [`deploy/scripts/gen-jwt-keys.sh`](../deploy/scripts/gen-jwt-keys.sh) and
> [`scripts/minikube/generate-keys.sh`](../scripts/minikube/generate-keys.sh)
> generate every key in this section, including the two OAuth secrets. Prefer
> them over assembling the Secret by hand.

## Deployment

Build and push the image:

```bash
cd control-api
make docker-push
```

Manifests live under `deploy/base/control-plane/` and are applied via the Kustomize overlays from the repo root (`make minikube-deploy-all`).

`deploy/base/control-plane/control-api.yaml` expects RSA key material in the `control-api-secrets` Secret, including:

- `CONTROL_API_SESSION_JWT_PRIVATE_KEY`
- `CONTROL_API_RPC_JWT_PRIVATE_KEY`

In-cluster DNS:

`http://control-api.control-plane.svc.cluster.local:8090`

## Notes

- Intended for internal cluster use.
- Secrets list endpoint returns metadata only (not secret payloads).
- Profile/team data is persisted in control-plane Postgres.
- Session JWT and RPC JWT issuance are centralized in this service.
- `rpc-proxy` validates RPC tokens using an RSA public key (RS256), so it cannot mint tokens.
- `external-rest-api` validates session tokens using the session JWT public key (RS256).
