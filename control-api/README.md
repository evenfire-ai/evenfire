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
- invalid/missing identity or token returns `401 {"error":"Unauthorized"}` with the response header `x-internal-service-auth-refusal: service_credential_rejected` (`INTERNAL_SERVICE_AUTH_REFUSAL_HEADER`, `INTERNAL_SERVICE_CREDENTIAL_REJECTED` in `src/middleware/internalServiceAuth.ts`); every refusal of `requireInternalToken` and `requireInternalService` carries it, whoever the caller. rpc-proxy reads it on the Host access route to tell a refused service credential from a refused `x-rpc-access-token`, whose `401` does not carry the header
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

| Scope                 | Purpose                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `host:message:invoke` | authorizes host message/task submission route                                                                            |
| `host:status:read`    | authorizes host status snapshot and status stream routes                                                                 |
| `host:activity:read`  | authorizes host activity snapshot and activity stream routes (read-only)                                                 |
| `host:health:read`    | authorizes host health/liveness route                                                                                    |
| `host:task:read`      | authorizes host task status and result routes (read-only)                                                                |
| `host:approval:write` | authorizes host approval submission, the session approval-mode change, and a first message that carries an approval mode |

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
- `DELETE /api/v1/admin/teams/:teamId` — hard-deletes an empty team (invitations, inactive memberships, team context/agent links CASCADE). Active members block deletion (`409 team_not_empty`); a team referenced by workflow audit history is kept (`409 team_has_audit_history`). **Destructive and irreversible** for that team id.
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

For local development, leave the signing-key env vars unset and start
`control-api` first, from the repository root:

```bash
CLERUM_DEV_MODE=true npm --prefix control-api run dev
```

Then start `rpc-proxy` and `external-rest-api` in separate terminals with the
same `CLERUM_DEV_MODE=true` opt-in. This mode is rejected with
`NODE_ENV=production`.

Control API generates one RSA-2048 key per slot under the gitignored
`control-api/.dev-keys/` directory (`0700` directory, `0600` signing files,
`0644` derived public files) on first use, reuses it across restarts, and
publishes each derived public half as `<slot>.public.pem`. When
`rpc-proxy` and `external-rest-api` also run with `CLERUM_DEV_MODE=true`, they
load `rpc.public.pem` and `session.public.pem` from that store, so a monorepo
dev boot keeps one shared key identity. Leave `EVENFIRE_DEV_KEY_STORE` unset
or blank for the default; a nonblank override must be an absolute path set
consistently in all three services.

An environment-supplied signing key takes precedence and does not update the
store. If you set `CONTROL_API_RPC_JWT_PRIVATE_KEY` or
`CONTROL_API_SESSION_JWT_PRIVATE_KEY`, explicitly configure its matching public
key in `RPC_PROXY_JWT_PUBLIC_KEY` or `EXTERNAL_REST_API_JWT_PUBLIC_KEY`,
respectively. A store left from an earlier run may contain a different key.
After deleting or rotating stored keys, or switching to an environment-supplied
key, reconfigure the affected verifiers as needed and restart them. Running
verifiers do not silently refresh their key identity.

Outside dev mode, `CONTROL_API_RPC_JWT_PRIVATE_KEY`,
`CONTROL_API_SESSION_JWT_PRIVATE_KEY`, and `CONTROL_API_ADMIN_JWT_PRIVATE_KEY`
are always required. Keys whose public halves were ever committed to this
repository are rejected in every slot, including the RPC verifier public key.

All three services use `@clerum/jwt-key-policy` to select one complete PEM
object and canonicalize its identity before signing or verification. Signing
inputs accept unencrypted RSA PKCS#8/PKCS#1 private keys. Verifier environment
variables accept RSA SPKI/PKCS#1 public keys and X509 public-key carriers;
private PEMs remain accepted there for legacy compatibility, but configuring
only the public half is recommended. X509 is a key carrier here: CA trust,
hostname and certificate expiry are not validated. A public store file must
never contain private material. Bundles, encrypted private keys, non-RSA keys
and historically committed identities are rejected.

RSA keys must have at least 2048 bits for every RS256 signing and verification
role, including registry vouchers and proof-of-possession. This deliberately
rejects weak verifier keys previously accepted; see
[RFC 7518 section 3.3](https://www.rfc-editor.org/rfc/rfc7518.html#section-3.3).
Material and descriptor reads are limited to 64 KiB. Invalid explicit input
fails instead of generating a replacement or changing its source.

The local store requires POSIX no-follow, nonblocking and exclusive-file
guarantees. Keep its ancestors trusted and run cooperating services with the
same effective UID; users or containers with another UID should configure
their keys explicitly. The store does not defend against hostile ancestors or
processes with the same UID. On a platform without these guarantees, configure
all signing and verifying keys through the environment; explicit keys do not
access the store. Stored-key corruption, or a rejected persisted registry key,
requires explicit operator repair or re-enrollment. Startup never rotates,
rewrites or deletes those identities automatically.

Build the service image from the repository root with
`docker build -f control-api/Dockerfile .`. Its context and runtime contain
only the shared policy's production files and declarations, not its tests or
local key data.

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

### OIDC member sign-in (unreleased)

Members can sign in to Profile UI with one OpenID Connect provider. The
feature is unreleased and off by default: with no `CONTROL_API_OIDC_*`
variable set, the OIDC routes answer 404 and Profile UI shows only the
password form.

Settings:

- The registration, all nine or none: `CONTROL_API_OIDC_REGISTRATION_ID`,
  `CONTROL_API_OIDC_DISPLAY_LABEL`, `CONTROL_API_OIDC_ISSUER`,
  `CONTROL_API_OIDC_CLIENT_ID`, `CONTROL_API_OIDC_CLIENT_SECRET`,
  `CONTROL_API_OIDC_CLIENT_AUTH_METHOD` (`client_secret_basic` or
  `client_secret_post`), `CONTROL_API_OIDC_REDIRECT_URI`,
  `CONTROL_API_OIDC_RESPONSE_MODE` (`query`) and
  `CONTROL_API_OIDC_TRUST_GENERATION`. Sign-in requests the scopes
  `openid profile email`.
- `CONTROL_API_OIDC_MEMBER_SIGN_IN=enabled` turns member sign-in on. It also
  needs `CONTROL_API_OIDC_UNRELEASED=acknowledged`.
- `CONTROL_API_OIDC_REQUIRED_CLAIM_VALUE`: the value a top-level ID token
  claim must hold: 1–256 characters, no control or format characters, and no
  leading or trailing whitespace (inner spaces are allowed). A format
  character such as U+200B is invisible and would match no token. The claim
  matches when it is
  a string exactly equal to the value, or an array of strings with one element
  exactly equal to it. Anything else does not match, including a missing
  claim, a prefix or substring, and an array with a non-string element. A
  claim value the sign-in cannot read, such as an array of more than 32 items
  or a string over 512 characters, refuses sign-in too, and so does an
  unreadable `roles` claim, whichever claim is required.
- `CONTROL_API_OIDC_REQUIRED_CLAIM_NAME`: the claim's name. It is `roles`
  when a value is set and the name is omitted. Omitting both settings adds no
  claim check. A name without a value is refused, and so is a name that is an
  OIDC protocol claim (`iss`, `sub`, `aud`, `exp`, `iat`, `nbf`, `jti`,
  `nonce`, `azp`, `auth_time`, `at_hash`, `c_hash`, `s_hash`, `sid`), a claim
  eligibility already reads (`tid`, `idp`, `acct`, `email`, `email_verified`,
  `xms_edov`), empty, over 128 characters, or has control characters, format
  characters, or leading or trailing whitespace. Use a claim only an
  identity-provider admin can set, such as an app role, a group, or
  `app_metadata`. Do not use a profile claim the person can edit, such as
  `name`, `nickname`, `preferred_username`, or `given_name`.
- `CONTROL_API_OIDC_ACCOUNT_CREATION`: what a first sign-in that finds no
  account does. Unset, a non-Entra issuer signs in only existing accounts.
  The setting is refused for Entra ID, which always creates accounts for the
  pinned tenant. Two values turn creation on for other issuers. With either,
  an account is created only when the ID token has an `email` claim and
  `email_verified` is `true`; a first sign-in without them is refused.
  - `enabled` creates an account for each person whose ID token holds the
    required claim, and needs `CONTROL_API_OIDC_REQUIRED_CLAIM_VALUE`. Without
    a value it is refused. Use a group or app role your administrators
    assign, not a profile claim people can edit.
  - `any_issuer_account` creates an account for every person the issuer signs
    in with a verified email, with no claim check, and is refused when a
    required claim value is set. Use it only when the issuer cannot sign in
    anyone outside your company: the application requires assignment, and
    self-service sign-up and social or external logins are off at the
    issuer. Sign in with Apple, Entra External ID user flows with sign-up on,
    and Auth0 tenants with sign-up on sign in people who registered
    themselves. With this value each of them gets an active account, and
    joins `CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID` if it is set. Google's
    `accounts.google.com` needs the `hd` required claim, so only `enabled`
    can turn creation on there.
- `CONTROL_API_OIDC_NEW_MEMBER_TEAM_ID`: a team UUID that each account the
  sign-in creates joins as a `member`.
- Entra ID is an issuer on `login.microsoftonline.com`,
  `login.microsoftonline.us` or `login.partner.microsoftonline.cn`. It needs
  `CONTROL_API_OIDC_TENANT_ID` (a tenant GUID), and the issuer must be
  `https://<host>/<tenant-id>/v2.0` for that tenant; multi-tenant authorities
  and the Microsoft consumer tenant are refused.
  `CONTROL_API_OIDC_ALLOW_GUESTS=true` admits guest accounts and needs a
  required claim named `roles`. Every other issuer, Entra External ID and
  Azure AD B2C included, is generic, and the tenant and guest settings are
  refused for it.
- Google's `accounts.google.com` issuer needs the required claim name `hd`,
  with your Workspace domain as the value.

A configuration that breaks these rules does not stop control-api. Every OIDC
route answers 503 `oidc_configuration_unavailable`, and each request logs
`oidc_configuration_unavailable` with the names of the settings at fault,
never their values. Profile UI then shows only the password form, and
password sign-in keeps working. `CONTROL_API_OIDC_ACCOUNT_CREATION` in the
list means a value other than exactly `enabled` or `any_issuer_account`, any
value on Entra ID, `enabled` with no required claim value, or
`any_issuer_account` beside one. Set a claim value, or use
`any_issuer_account` if every person the issuer signs in should get an
account. On `accounts.google.com`, `any_issuer_account` is always refused:
use `enabled` with the `hd` claim there. An empty
`CONTROL_API_OIDC_REQUIRED_CLAIM_VALUE` is refused, and the list names it.
It still counts as a value, so `any_issuer_account` beside it is refused as
well. An unknown `CONTROL_API_OIDC_*` name fails the same way, even with no
registration set. That includes the removed
`CONTROL_API_OIDC_ALLOWED_EMAIL_DOMAINS` and
`CONTROL_API_OIDC_REQUIRED_ROLE`, which the required claim and account
creation settings replace. While `CONTROL_API_OIDC_MEMBER_SIGN_IN` is set, a
configuration that fails to load still counts as member sign-in on when a
member is removed: the member is kept as a retired row rather than deleted.

Provider checklist:

- **Assignment.** In Entra ID, set the enterprise application's
  **Assignment required?** to **Yes**, so unassigned users can't sign in.
  Microsoft notes that it doesn't apply to Global Administrators; a required
  `roles` claim still does. In Okta, give the app to selected groups
  (**Limit access to selected groups**), not to everyone in the org, which is
  the wizard's default. Federation Broker Mode drops assignments and leaves
  access to sign-on policies.
- **Self-service sign-up.** In Auth0, turn on **Disable Sign Ups** on the
  database connection and turn off social connections for the application. In
  Entra External ID, set `isSignUpAllowed` to `false` on the sign-up and
  sign-in user flow through Microsoft Graph. In Azure AD B2C, use a **Sign in**
  user flow with no social identity providers selected.
- **Google Workspace.** Use an Internal app, which limits authorization to
  members of your Google Cloud organization, and require `hd`. Google says to
  check `hd`, not the email domain, to restrict access to a domain.
- **`email_verified`.** Know what your issuer's `email_verified` proves. A
  first sign-in with a verified email links to the existing account with that
  address, or creates one where account creation is on. OpenID Connect leaves
  how an address is verified to the issuer.
- **New-member team.** Don't set one for an issuer that isn't bound to your
  company: every account the sign-in creates joins that team.
- **Okta groups.** Okta's org authorization server puts the groups claim in
  the ID token only when the `groups` scope is requested, and sign-in doesn't
  request it. Add the groups claim on a custom authorization server instead,
  set to always be included in the ID token, and use that server's issuer as
  `CONTROL_API_OIDC_ISSUER`. Set `CONTROL_API_OIDC_REQUIRED_CLAIM_NAME` to the
  claim's name, or name the claim `roles`.
- **More than 32 groups.** A groups claim with more than 32 items refuses
  sign-in, so send only the groups that matter. In Entra ID, emit only the groups
  assigned to the application, or use app roles. In Okta, use the groups claim
  filter.

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
