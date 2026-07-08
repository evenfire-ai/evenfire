# Deep Research — Third‑Party OAuth Bridging in the Sandbox UI

> Status: research / current-state map + gap analysis.
> Scope: how a sandbox‑UI app ("recipe embed" or backend workload) obtains and
> reuses third‑party OAuth credentials, the IPC/SDK surface that drives it, and
> where the credentials/refresh tokens are stored.

## TL;DR

The feature you described **already exists end‑to‑end** in the codebase. A
recipe embed can connect a third‑party account (Slack, Google, Salesforce,
Microsoft Graph, Notion), the platform stores the **OAuth refresh token
encrypted at rest in control‑api**, and reuses it to mint fresh access tokens on
demand. There are two delivery paths:

- **Path A — user grant (embed/interactive):** the end user clicks *Connect* in
  the sandbox‑UI embed; the grant belongs to that user.
- **Path B — service grant (admin/background):** an admin connects the account
  "for the recipe"; background workloads fetch tokens through a broker.

One important correction to the original framing ("get the refresh token from
the control UI, bring it to the control API"): **the refresh token never passes
through control‑ui or the embed.** control‑api receives the authorization `code`
directly from the provider redirect, exchanges it for tokens server‑side, and
stores the refresh token encrypted. The UI only *initiates* the flow and later
reads short‑lived **access** tokens. This is the correct, more secure design and
is already what the code does.

The main genuine gap relative to your ask is a **generic "request input from the
user" SDK bridge** — today the embed→host IPC surface only exposes OAuth
completion + session refresh, not an arbitrary "prompt the user for X" channel.

---

## 1. Components involved

| Layer | Service / file | Role |
|------|----------------|------|
| Embed (recipe JS) | recipe pod in `sandbox-ui` ns | Renders Connect/Connected UI; talks to host via `window.clerum.*` and same‑origin `fetch` |
| Embed host (IPC) | `desktop-app/src/sandboxUiEmbedPreload.ts`, `sandboxUiDriver.ts`, `main.ts` | Electron `WebContentsView` + `contextBridge`; intercepts `clerum://` deep links |
| Edge proxy | `rpc-proxy/src/routes/sandboxUi.ts` | Reverse‑proxies the embed; fronts OAuth helper endpoints; mints per‑recipe session cookie |
| OAuth core | `control-api/src/oauth/*` | Provider adapters, state signing, token exchange/refresh, encrypted store |
| OAuth routes | `control-api/src/routes/{external/oauthCallback,internal/oauth,recipeOauth,admin/recipeOauth}.ts` | Public callback, embed‑fronted helpers, background broker, admin connect |
| Storage | Postgres `oauth_grants` (migrations `0013`, `0015`) | Encrypted access + refresh tokens |
| Schema | `charts/clerum-crds/crds/workflowrecipe.yaml` → `spec.oauthClients[]` | Declares providers + client‑credential Secret refs |

---

## 2. How a recipe declares OAuth (CRD)

`WorkflowRecipe.spec.oauthClients[]` (see CRD + `workflow-recipes/src/types.ts`):

```yaml
spec:
  oauthClients:
    - id: slack-bot                 # referenced by the embed and by workloads
      provider: slack               # enum: salesforce|slack|notion|microsoft-graph|google
      clientIdRef:     { name: slack-oauth-creds, key: client-id }
      clientSecretRef: { name: slack-oauth-creds, key: client-secret }
      scopes: [users:read, channels:read]
      # backgroundAccess: true      # opt-in for Path B (service grant)
  ui:
    workloadRef: hello
    port: 8080
```

CRD CEL invariants (enforced in `workflowrecipe.yaml`):
- **O1/O2** every `oauthClient` must have a consumer — either `spec.ui` (embed,
  Path A) or a `workloads[].oauthClientRefs` entry (background, Path B, which
  also requires `backgroundAccess: true`).
- **O3** `oauthClients[].id` unique.
- Provider is a closed enum — recipes cannot point OAuth at arbitrary endpoints.

Provider client credentials (`client_id` / `client_secret`) live in an ordinary
K8s Secret in the recipe namespace, referenced by `clientIdRef`/`clientSecretRef`.
Working example: `workflow-recipes/samples/sandbox-ui-oauth-hello.yaml`.

---

## 3. Path A — user grant (the interactive sandbox‑UI flow)

End‑to‑end sequence (this is the flow you described):

```
1. Embed renders:  <a href="clerum://oauth?clientId=slack-bot">Connect Slack</a>

2. Desktop driver intercepts clerum://oauth?clientId=…  (sandboxUiDriver.ts)
        → POST rpc-proxy /api/v1/sandbox-ui/:ns/:name/oauth/authorize-url
            (userId from the session cookie's `sub`; only oauthClientId in body)
        → control-api POST /internal/sandbox-ui/oauth/authorize-url
            (requireInternalService('rpc-proxy'); grantKind forced to 'user' [SEC-1])
        → buildAuthorizeUrl(): loads recipe+client creds, signs HMAC `state`
        ← { authorizeUrl }
        → desktop shell.openExternal(authorizeUrl)   // real OS browser

3. Provider auth → redirect to
        control-api GET /api/v1/oauth-callback/:clientId?code&state
            (no cookie/bearer — auth IS the signed state, re-verified;
             recipe ns/name recovered from the state, not the URL path)
        → handleOAuthCallback(): verify state, exchange code→tokens,
          upsert ENCRYPTED grant in oauth_grants (user_id = caller)
        ← success HTML that bounces to clerum://oauth-completed?clientId&provider

4. Desktop main.ts `open-url` handler parses clerum://oauth-completed
        → driver.dispatchSandboxUiOauthCompleted({ oauthClientId, provider })
        → IPC 'clerum:sandbox-ui:oauth-completed' into the embed
        → recipe JS window.clerum.onOauthCompleted(cb) re-probes

5. Embed reads the token:
        → POST /oauth/token  (same-origin, cookie-authed) via rpc-proxy
        → control-api POST /internal/sandbox-ui/oauth/token
        → getAccessToken(): returns a FRESH access token (refreshing if stale)
        ← { accessToken, expiresAt }     // refresh token is NEVER returned
```

Disconnect: embed `DELETE /oauth/grant` → control‑api `deleteOAuthGrant` (drops
the local row, idempotent 204; **no provider‑side revocation**).

### The IPC/SDK surface (your "sandbox UI SDK")

`desktop-app/src/sandboxUiEmbedPreload.ts` exposes exactly two methods to
untrusted recipe JS via `contextBridge`:

```ts
window.clerum = {
  requestSessionRefresh(): Promise<void>,          // recover from a stale cookie
  onOauthCompleted(cb): () => void,                // subscribe to OAuth completion
}
```

Plus the navigation‑based triggers handled by the driver/main:
- `clerum://oauth?clientId=…`   → start Connect
- `clerum://oauth-completed?…`  → completion event (host → embed)

Security properties already in place: `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, IPC handlers sender‑pinned by
`webContents.id` and rate‑limited; embed served under CSP `script-src 'self'`
(hence recipes must use external `app.js`, not inline `<script>`).

---

## 4. Path B — service grant (admin connect + background workloads)

For workloads that must call a provider **without a user present**:

- **Admin connects** via control‑ui → `control-api POST
  /admin/recipes/:name/oauth/:oauthClientId/connect` → same authorize/callback
  machinery but `grantKind: 'service'` (state records the initiating admin for
  audit). Stored row has `user_id = NULL` (`oauth_grants_service_unique`).
- **Background workload fetches a token** via the broker:
  `control-api /api/v1/recipe-oauth/token` (`routes/recipeOauth.ts`), gated by
  `requireBrokerToken`. `(recipeNamespace, recipeName)` come **only** from the
  broker token's `sub` ([SEC‑3]); just `oauthClientId` is taken from the body.
  Returns a fresh access token; refresh token + encryption key never leave
  control‑api.

Status check for admin UI: `GET /admin/recipes/:name/oauth/:clientId/status`
returns `{ connected }` without decrypting anything.

---

## 5. Refresh‑token storage & reuse (the "guardar el refresh token" requirement)

This is fully implemented in `control-api/src/oauth/`:

- **Table `oauth_grants`** (`store.ts`, migrations `0013`/`0015`) keyed by
  `(recipe_namespace, recipe_name, user_id, oauth_client_id)` for user grants and
  by `(recipe_namespace, recipe_name, oauth_client_id) WHERE grant_kind='service'`
  for service grants.
- **Encryption at rest** (`encryption.ts`): AES‑256‑GCM, 12‑byte random IV,
  16‑byte auth tag, payload `v1.<iv>.<ct>.<tag>`. Key from
  `CONTROL_API_OAUTH_ENCRYPTION_KEY` (32‑byte hex). Both access and refresh
  tokens are encrypted columns.
- **Reuse / refresh on demand** (`tokenHelper.getAccessToken`): if the stored
  access token is within `refreshBufferMs` (default 60s) of expiry and a refresh
  token exists, control‑api POSTs the provider's refresh endpoint (per‑provider
  adapter), re‑upserts the row (keeping the old refresh token if the provider
  doesn't issue a new one), and returns only the new **access** token.
- **Isolation:** the refresh token and the encryption key are confined to
  control‑api. rpc‑proxy, the embed, the desktop app, and workloads only ever
  see short‑lived access tokens.

Provider adapters (`providers.ts`) encode per‑provider quirks:
Google `access_type=offline&prompt=consent`; Microsoft `offline_access`;
Notion HTTP‑Basic token POST and **no refresh token**; Slack v2 (classic scopes
don't refresh); Salesforce requires explicit scopes.

---

## 6. Trust boundaries (summary)

| Hop | Auth | Notes |
|-----|------|-------|
| embed → rpc-proxy | per‑recipe httpOnly session cookie (HS256), `SameSite=Strict`, path‑scoped, ~5 min TTL | `sub` = userId; refreshed ~270s |
| rpc-proxy → control-api internal OAuth | `x-service-token` + bearer, `requireInternalService('rpc-proxy')` | rpc‑proxy is the sole caller; forces `grantKind='user'` |
| provider → control-api callback | signed HMAC `state` (recipe/user/client/grantKind + nonce + 10‑min expiry) | no cookie/bearer |
| workload → control-api broker | mounted broker token, `requireBrokerToken` | recipe identity from `sub` only |
| admin → control-api connect | control‑ui admin JWT | issues `service` grants |

---

## 7. Gaps & recommendations

What is **missing or worth hardening** relative to the stated goal:

1. **Generic "request input from user" SDK bridge (your explicit ask).** Today
   the embed↔host IPC only does OAuth completion + session refresh, and the
   pod‑side plugin‑workload SDK (`mcp-host/src/pluginWorkloadSdk`) exposes only
   `prompt-bridge` (LLM) and `client-notifications`. There is **no** generic
   "ask the user for a value / approval / secret" round‑trip. If recipes need
   interactive input beyond OAuth, design a new `clerum.requestInput(schema)`
   IPC method (host‑rendered modal, sender‑pinned + rate‑limited like the
   existing handlers) with an SSE/IPC response channel.
2. **Provider set is closed (5 providers).** Adding one is a 3‑site code change
   (`control-api/src/oauth/providers.ts`, `workflow-recipes/src/types.ts`, CRD
   enum). Acceptable for auditability, but document the checklist.
3. **No provider‑side revocation on Disconnect.** `deleteOAuthGrant` only drops
   the local row; the token stays valid at the provider until it expires.
   Consider calling provider revoke endpoints where available.
4. **Single static encryption key.** `CONTROL_API_OAUTH_ENCRYPTION_KEY` has no
   rotation/versioning or KMS envelope. The payload is already versioned
   (`v1.`), so add key‑id support before this scales.
5. **No refresh for Notion / Slack‑classic.** Expiry forces full re‑auth; make
   sure embeds surface a clear Reconnect affordance (the sample already does).
6. **Plugin‑workload SDK does not surface OAuth tokens.** Background token
   access is the separate broker token path, not the SDK. If desired, unify so a
   workload's SDK client can request `service`‑grant access tokens directly.

### Suggested next steps
- If the intent is **only** OAuth bridging: the feature is built — focus on
  end‑to‑end verification (`scripts/e2e/e2e-sandbox-ui-oauth.sh`), real provider
  apps, and the gaps above (revocation, key rotation).
- If the intent includes a **general plugin↔user input SDK**: that is net‑new;
  scope it as item (1) and reuse the existing IPC hardening patterns.

---

## 8. Key file index

```
control-api/src/oauth/providers.ts          # 5 provider adapters
control-api/src/oauth/store.ts              # oauth_grants CRUD (user + service)
control-api/src/oauth/encryption.ts         # AES-256-GCM at rest
control-api/src/oauth/state.ts              # HMAC signed-state binding
control-api/src/oauth/authorizeUrlHelper.ts # builds provider authorize URL
control-api/src/oauth/tokenHelper.ts        # getAccessToken + refresh-on-demand
control-api/src/oauth/callback.ts           # token exchange + grant upsert
control-api/src/routes/external/oauthCallback.ts  # public /oauth-callback
control-api/src/routes/internal/oauth.ts          # embed-fronted helpers (Path A)
control-api/src/routes/recipeOauth.ts             # background broker (Path B)
control-api/src/routes/admin/recipeOauth.ts       # admin connect (service grants)
rpc-proxy/src/routes/sandboxUi.ts                 # edge proxy + OAuth bridge
desktop-app/src/sandboxUiEmbedPreload.ts          # window.clerum.* IPC surface
desktop-app/src/sandboxUiDriver.ts                # clerum://oauth interception
desktop-app/src/main.ts                           # clerum://oauth-completed handler
charts/clerum-crds/crds/workflowrecipe.yaml       # spec.oauthClients[] schema
workflow-recipes/samples/sandbox-ui-oauth-hello.yaml  # working demo recipe
scripts/e2e/e2e-sandbox-ui-oauth.sh               # e2e gate
```
