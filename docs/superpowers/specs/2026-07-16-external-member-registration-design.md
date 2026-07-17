# External Member Registration — Design

**Date:** 2026-07-16
**Status:** Approved design, pre-implementation
**Repos affected:** `evenfire-member-registration` (hub, primary) and the OSS control-api (this repo, companion)

> **STATUS NOTE — BOTH HALVES SHIPPED (updated 2026-07-17).**
> - **Hub half = DONE.** The `evenfire-member-registration` changes in this spec (open `POST /public/tenants` mint, per-credential domain binding, hub-owned `GET /i/:token` redirect + interstitial, per-domain quota/blocklist kill switch, hashed send log, XFF fix, profile-lookup shadowing fix) shipped in hub PR #11 (merged, auto-deployed to `registration.evenfire.ai`).
> - **Control-api half (§8) = DONE.** Shipped in **PR #91** (merged to `main` 2026-07-17 as `a3159b0`): mode switch, encrypted credential store (migration `0055`), lock-free enrollment with host guard + negative cache, fire-and-forget boot hook, per-destination credential resolution, and the 503 error surface. `remote` remains the default and is byte-for-byte unchanged.
> - **Live contract verified 2026-07-17** (what the mocked suite could not prove): a self-minted throwaway tenant returned `201 {tenantId:"ext-…", kid, secret}` — camelCase, exactly as the client expects — and the live hub **accepted a token from this repo's signer** (`/invitations-flow/validate` with a bogus token → `400 invalid_invitation`, not 401/403).
> - **Deviations from §8 as written, decided during implementation:**
>   - §8.1's fail-fast is scoped to `HMAC_KID`/`TENANT_ID` only. `HMAC_SECRET` is **excluded** (warn-and-ignore): the shipped deploy always injects it via `apply-inter-service-tokens.sh`, so including it would brick hosted mode on every existing install.
>   - §8.1 gained a dedicated `CONTROL_API_MEMBER_REGISTRATION_EXTERNAL_HUB_BASE_URL`; the legacy `_SERVICE_BASE_URL` is ignored in hosted mode (the base configmap always sets it to the cluster-local URL).
>   - §8.4's "await after `initDb`, ~2×10s before the listener comes up" was **replaced by fire-and-forget after `server.start()`**. Control-api's liveness probe (`initialDelay 8` + `period 12` × 3, no `startupProbe`) kills the pod at ~32s of not listening, so the specced delay risked a permanent CrashLoop — the opposite of the degrade guarantee.
> - **§14 step 2 was NEVER done — VERIFIED 2026-07-17 against the live hub.** `MEMBER_REGISTRATION_SERVICE_SMTP_FROM_EMAIL` on `member-registration-service` (namespace `registration`, cluster `evenfire-hub`) is **`info@joinevenfire.com`** — neither the `no-reply@evenfire.ai` this spec mandates (§2/§11) nor the `no-reply@hypersig.xyz` §11 claimed was live. §11's premise is stale. Consequences: (a) hosted-mode invitations currently arrive from `info@joinevenfire.com`; (b) the OSS how-to shipped in PR #91 asserted `no-reply@evenfire.ai` and was **wrong** — corrected in PR #92 to describe the sender generically rather than name an address the deployment does not use. **Decide the intended sender and confirm its Postmark DKIM before a full e2e**; until then §2's "emails are sent from `no-reply@evenfire.ai`" is aspirational, not as-built.
> - **Reconciliation resolved (2026-07-16 brainstorm): hosted replaces offline.** The
>   offline-mode work (`2026-07-16-offline-member-registration-mode-design.md` + plan,
>   implemented on `impl/offline-member-registration`, PR #88) was closed unmerged and is
>   **superseded** by this design. The mode axis is `remote | hosted` — no `offline`
>   value ships. §8 below was rewritten with the resolved control-api design (mode
>   semantics, credential store, enrollment, per-host credentials, failure posture).

## 1. Context

The member-registration hub (`registration.evenfire.ai`) currently serves only
MCC-provisioned tenants. Credentials are minted by MCC via the admin-token-guarded
`POST /admin/tenant-credentials`, and the tenant's control-api signs per-tenant HS256
JWTs to call `/api/v1/invitations-flow/*`. An external, self-hosted Evenfire instance
(e.g. someone running it on their own domain or minikube) has no way to use the hub.

We want any self-hosted Evenfire instance to invite members by email, with the whole
invite flow handled by us: the email is sent from `no-reply@evenfire.ai` through our
Postmark account, and it "just works" with **zero credential handling by the operator**.

The hub never calls into a tenant cluster — every flow is either outbound from the
instance or a public read from an end user's browser — so a self-hosted instance with
no inbound path works on the network layer today. The gaps are trust, onboarding, and
a set of latent multi-tenant bugs that become live the moment an untrusted party holds
a credential.

## 2. Goals

- A self-hosted instance can send member invitations through the hub with no manual
  credential setup.
- Emails are sent from `no-reply@evenfire.ai` via our infrastructure.
- We retain the ability to observe and shut off abuse (per-destination kill switch),
  without recalling already-delivered mail.
- Existing MCC-provisioned ("managed") tenants are unaffected and, specifically, cannot
  be shadowed or impersonated by an external instance.

## 3. Non-goals and explicitly accepted risks

- **No email-DNS setup for the operator.** No SPF/DKIM/DMARC on the operator's domain;
  we always send as `no-reply@evenfire.ai` signed with our own DKIM.
- **No domain-ownership verification** (`.well-known`/TXT/callback) in this iteration.
  The operator's domain is **self-asserted at mint time**. A lazy first-send callback
  check is deferred as a future flag (§13).
- **Postmark abuse risk is accepted** (owner decision). A determined actor who buys a
  domain, runs Evenfire on it, and sends links to that domain can send branded mail
  from our sender. The controls in §9 reduce and contain this; they do not eliminate it.
  Because we send from a single account/domain, a severe abuse event can affect
  deliverability for `clerum` and all managed tenants — this is understood and accepted.
- **No separate sending identity / IP pool.** Rejected as ineffective containment
  (subdomains share org reputation; Postmark suspends at the account level) and as a
  permanent ESP-operations burden.

## 4. Architecture overview

Two coordinated changes:

1. **Hub (`evenfire-member-registration`)** — primary. Adds an open self-service mint,
   a domain binding on each credential, a hub-owned redirect for every outbound invite
   link, and abuse controls (revoke, per-domain blocklist, quota, logging). Fixes the
   public profile-lookup shadowing bug and the `X-Forwarded-For` trust bug.
2. **OSS control-api (evenfire/clerum monorepo)** — companion. Adds boot-time
   self-enrollment: when hosted mode is enabled and no credential is stored, it mints
   one against the hub and persists it in its own Postgres.

There is no zero-manual path that avoids the control-api change: in a pure self-hosted
deploy, the control-api is the only always-present component that can enroll on the
operator's behalf.

## 5. Identity model

- **Two populations, one table, namespaced by tenant-id prefix:**
  - Managed tenants keep `clerum-<slug>`, minted only by `POST /admin/tenant-credentials`.
  - External instances get `ext-<random>`, minted only by `POST /public/tenants`.
  - Each endpoint enforces its own prefix and refuses the other's. A public caller can
    never mint a `clerum-*` id, so an external cannot impersonate a managed tenant.
- **The credential is the identity.** No operator-chosen slug — no name-squatting.
- **Each credential is bound to exactly one destination domain**, supplied at mint and
  stored on the credential row. The hub enforces one-credential-one-domain on every send
  (§8). The domain is self-asserted (not proven), but bound and locked.

## 6. Data model changes (hub)

New migration (following the existing `applyXxxMigration` pattern in `src/db.ts`):

- `tenant_credentials`: add `tenant_type TEXT NOT NULL DEFAULT 'managed'`
  (`managed` | `external`), and `bound_domain TEXT` (NULL for managed, the normalized
  destination host for external). Index on `bound_domain WHERE revoked_at IS NULL`.
- `invite_redirect_tokens` (new): `token TEXT PRIMARY KEY`, `kid TEXT NOT NULL`,
  `tenant_id TEXT NOT NULL`, `destination_url TEXT NOT NULL`, `destination_domain TEXT NOT NULL`,
  `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `clicked_at TIMESTAMPTZ`,
  `expires_at TIMESTAMPTZ NOT NULL`. Index on `(destination_domain)`.
- `blocked_domains` (new): `domain TEXT PRIMARY KEY`, `reason TEXT`,
  `blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`.
- `invite_send_log` (new): `id`, `kid`, `tenant_id`, `destination_domain`,
  `recipient_hash TEXT NOT NULL` (SHA-256 of normalized email; never store plaintext
  recipient), `created_at`. Used for quota accounting and abuse correlation.

Existing `apps`/`app_configs`/`invitation_flow_registrations` are unchanged except as
needed by the shadowing fix (§10).

## 7. API surface

### New: `POST /public/tenants` (unauthenticated, rate-limited)

Request: `{ "domain": "evenfire.acme.com" }`
Behavior:
- Normalize `domain` (lowercase host, strip scheme/port/path); reject empty/invalid.
- Generate `ext-<random>` tenant id, a `kid`, and a random `hmac_secret`.
- Insert `tenant_credentials` row with `tenant_type='external'`, `bound_domain=<domain>`.
- Return `201 { tenantId, kid, secret }` (secret shown once).
- Rate-limited per real client IP (see §9 XFF fix).

Idempotency: none server-side; the control-api is responsible for minting once and
persisting (§8). Restart-driven re-mints would leak orphan credentials and, critically,
would reset any per-credential quota — which is why persistence is mandatory client-side
and quota is keyed on the stable domain (§9).

### Changed: invite endpoints route links through the hub

All four caller-supplied link builders in `src/services/emailService.ts` —
`buildInviteUrl` (member), `buildControlAdminInviteUrl`,
`buildControlAdminEmailConfirmationUrl`, `buildControlAdminPasswordResetUrl` — currently
email a URL built from a caller-supplied base (`profileUiBaseUrl` / `controlUiBaseUrl`).
Each must instead:
1. Build the real destination URL as today.
2. **For `external` credentials only**, enforce the destination host equals the
   credential's `bound_domain` (§8); reject otherwise. `managed` credentials have a NULL
   `bound_domain` and skip this check (their destinations are MCC-controlled).
3. Store an `invite_redirect_tokens` row and email
   `https://registration.evenfire.ai/i/<token>` instead of the raw destination.

**Every outbound link must go through the redirect** — a builder that is missed remains
an open relay. This applies to managed tenants too; verify managed invites still resolve
end-to-end after the change (§14).

### New: `GET /i/:token` (public, interstitial + redirect)

- Look up the token; expired/unknown → generic "link expired" page.
- If the credential is revoked OR `destination_domain` is in `blocked_domains` →
  "this link has been disabled" page (this is the retroactive kill switch — it fires at
  click time on already-delivered mail).
- Otherwise render an interstitial naming the destination host in plain text with a
  single "Continue" control that navigates to `destination_url`. Set `clicked_at`.
- **Not a bare redirect** — the interstitial is what prevents this from being an open
  redirect that lends our domain's credibility to an attacker page.

### Unchanged auth surface

External instances reuse the existing `requireTenantJwt` path for
`/api/v1/invitations-flow/*`. No new signing scheme; the only change is that some `kid`s
now resolve to `external` credentials with a `bound_domain`.

## 8. Self-enrollment (control-api, companion repo)

> Rewritten 2026-07-16 after the reconciliation brainstorm. Four open questions were
> resolved with the owner: (1) hosted **replaces** offline — enum is `remote | hosted`;
> (2) hosted mode + explicitly injected credentials **fail fast** at startup;
> (3) admin flows are covered by **one credential per destination host**, minted at
> boot; (4) hub-unreachable **degrades** (boot proceeds, enrollment retries on demand);
> rotation is schema-supported, no API.
>
> Amended the same day after the adversarial deep review (18 confirmed findings, all
> folded in): the fail-fast is scoped to the deliberately-set identity vars, hosted
> mode reads its own dedicated hub var, the mint is lock-free with bounded timeouts
> and a negative cache, secrets are envelope-encrypted with the existing key, the
> error surface enumerates the real interception sites, and the test list was
> sharpened to be direction- and regression-proof.

### 8.1 Mode switch and config

- `CONTROL_API_MEMBER_REGISTRATION_MODE` = `remote` (default) | `hosted`
  (repo-convention `CONTROL_API_` prefix; supersedes this spec's earlier bare
  `MEMBER_REGISTRATION_MODE` and the abandoned PR #88's `offline` value).
  - `remote` — today's behavior byte-for-byte: base URL and non-placeholder HMAC secret
    required in production, static env credential signs every call. Covers MCC-managed
    tenants (which never set the var) and self-hosters running their own
    member-registration-service.
  - `hosted` — self-enrollment against the shared hub. The hub address is read from a
    **dedicated var** `CONTROL_API_MEMBER_REGISTRATION_EXTERNAL_HUB_BASE_URL`
    (default `https://registration.evenfire.ai/api/v1`; override = staging/test hub
    only). The legacy `CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL` is **ignored
    in hosted mode** — it is a remote-mode concept, and the shipped base configmap
    (`deploy/base/control-plane/configmaps.yaml:37`) always sets it to the
    cluster-local URL, so reusing it would silently point enrollment at a nonexistent
    in-cluster service (permanent 503, no startup signal). In hosted mode this URL is
    also the **enrollment authority** — mint origin, credential issuer, and receiver
    of invitation tokens and recipient emails — a trust decision that deserves its own
    deliberate setting. The `CONTROL_API_MEMBER_REGISTRATION_{HMAC_SECRET,HMAC_KID,TENANT_ID}`
    requirements are dropped — credentials come from the DB (§8.2).
  - Any other value → **hard startup error** listing valid values (nothing in the wild
    sets this var yet; strictness catches e.g. a stale `offline` from the abandoned
    overlay).
- **Fail fast on ambiguity — scoped to the deliberately-set identity vars:** `hosted`
  + either of `CONTROL_API_MEMBER_REGISTRATION_{HMAC_KID,TENANT_ID}` **non-empty
  (after trim) in raw `process.env`** → startup error: an injected remote identity and
  hosted mode are mutually exclusive. Those two vars are only ever set deliberately
  (MCC injection or a BYO remote setup) and live in removable ConfigMaps.
  `CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET` is **excluded from the check**: the
  shipped deploy unconditionally injects it
  (`deploy/scripts/apply-inter-service-tokens.sh` writes it into the
  `control-api-internal-tokens` Secret, projected via `envFrom` in
  `deploy/base/control-plane/control-api.yaml` — today's config cannot boot without
  it, and the script re-adds it on every run), so including it would brick hosted mode
  on every existing install. A lone secret in hosted mode is ignored with a loud
  startup warning. Empty-string values never count as present. Managed tenants remain
  structurally safe — MCC injects credentials and leaves the mode unset (`remote`).
- **No `NODE_ENV=production` interlock** (unlike offline's): hosted is the intended
  production posture for self-hosters; default-off already keeps throwaway/dev/CI
  deploys from silently provisioning a sender against our Postmark.

### 8.2 Credential store

New migration in `control-api/src/db.ts` `CONTROL_API_MIGRATIONS` (next version slot):

```sql
CREATE TABLE IF NOT EXISTS member_registration_credentials (
  id            BIGSERIAL PRIMARY KEY,
  bound_domain     TEXT NOT NULL,       -- normalized: lowercase hostname, port stripped (mirrors hub)
  tenant_id        TEXT NOT NULL,       -- "ext-<hex>" from the hub
  kid              TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,       -- envelope-encrypted, never plaintext (see below)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX member_registration_credentials_active_domain_idx
  ON member_registration_credentials (bound_domain)
  WHERE revoked_at IS NULL;
```

- **Persistence is mandatory**, not a nicety: re-minting per boot leaks credentials and
  resets per-credential quota.
- `secret_encrypted` holds the hub secret **envelope-encrypted with the existing
  mandatory key** (`encryptOAuthSecret`/`decryptOAuthSecret` over
  `config.oauthEncryptionKey`) — the same posture as every comparable credential in
  this DB (`registry_connection`, OAuth grants; see
  `src/services/registryConnectionSchema.ts`). A Postgres dump leak yields nothing
  usable, and there is **no new operator key handling**: the envelope key is already
  provisioned by the standard deploy. If the envelope key is ever lost or rotated,
  decryption failure is treated as "no credential" and the normal re-mint path
  recovers — fails soft.
- **Rotation posture:** schema-supported, no API. Deliberate rotation is an ops action
  (`UPDATE … SET revoked_at = now(), secret_encrypted = ''`); the next send/boot
  re-mints. Rows are kept — minus the secret, blanked on revoke — as audit trail.
  **Local rotation is not compromise remediation:** the hub keeps accepting the old
  secret's JWTs until it is revoked hub-side (`tenant_credentials.revoked_at`, §9) —
  an operator who suspects a leak must contact Evenfire. An operator-facing
  self-revoke endpoint is future work (§13).

### 8.3 Enrollment service

New `control-api/src/services/memberRegistrationEnrollment.ts`:

- `ensureEnrollment(domain)` — return the active credential row if present; otherwise
  mint and persist, **entirely outside any transaction or lock**:
  1. `SELECT` the active row (`revoked_at IS NULL`); hit → return it.
  2. Miss → host guard (below), then mint `POST <hub-origin>/public/tenants
     { domain }` with a **bounded timeout** (`AbortSignal.timeout(~10s)`). The mint
     endpoint is **unauthenticated** and hangs off the hub **origin**, not the
     `/api/v1` base — derive the origin from
     `CONTROL_API_MEMBER_REGISTRATION_EXTERNAL_HUB_BASE_URL`; never route the mint
     through the signing client.
  3. `INSERT … ON CONFLICT DO NOTHING` (backed by the partial unique index), then
     re-`SELECT` (filtered `revoked_at IS NULL`) and adopt the winner. A losing race
     logs the orphan **without secret material** and moves on. A rare orphan is
     acceptable; a mint storm is not.
- **Concurrency and repetition guards:** an in-process in-flight promise map per
  domain collapses concurrent attempts within a replica; the partial unique index +
  adopt-winner handles cross-replica races. There is **no advisory lock** — holding a
  pooled connection idle-in-transaction across a network call is a failure mode, not a
  guard (managed Postgres kills it via `idle_in_transaction_session_timeout`; the
  `initDb` advisory lock is a boot-only session lock, not a request-path precedent).
  Repetition is bounded by a **negative cache**: a hub **4xx** mint response is
  terminal for that domain — cache `{reason, until}` for a TTL (~10 min) and fail
  sends fast with the typed error instead of re-minting per request; network errors
  and 5xx retry under **exponential backoff** (capped ~5 min). Without this, an
  unenrolled instance turns its public unauthenticated routes (invite-token lookup,
  password-reset) into a per-request mint amplifier against the hub.
- **Host guard:** refuse to enroll hosts that are `localhost`, IP literals, or dotless
  names — a typed misconfiguration error (distinct from unavailability; surfaces as
  `member_registration_misconfigured`, §8.6) and a loud boot log. The hub factually
  accepts `127.0.0.1` as a domain, and the shipped UI base-URL defaults are exactly
  that (`config.ts:451-454`) — without this guard, a default-config instance in hosted
  mode sends real branded emails whose links dead-end, all sharing one global
  `127.0.0.1` quota bucket on the hub. Hosted mode requires real domains (§8.9).
- **Log hygiene:** enrollment, orphan-adoption, and failure logs carry only
  `bound_domain`, `tenant_id`, `kid`, and timestamps — never the secret and never a
  raw mint response body (the mint response contains the secret; the house pattern of
  stringifying response bodies into thrown errors must not be applied to it).
- Domain normalization: `new URL(base).hostname.toLowerCase()` — hostname excludes the
  port, mirroring the hub's normalization.

### 8.4 Boot integration (degrade, never block)

Boot integration is an **exported, unit-testable hook** — `runBootEnrollment(hosts)`
in the enrollment module, whose contract is **"never rejects: catches, logs,
returns"** — and `main.ts` (after `initDb()`, next to `assertRegistryConnectionReady`)
only calls it. Do not inline the try/catch in `main.ts`: no test imports `main.ts`, so
an inlined swallow is unverifiable, and a dropped `catch` would ship green while
crash-looping every hub-down boot.

When `hosted`, the hook runs `ensureEnrollment` for each **unique** normalized host of
`desktopProfileUiBaseUrl` and `controlUiBaseUrl` (deduped — two UIs on one hostname
mint once; subdomain deploys like `profile.acme.com` / `control.acme.com` mint two).
Enrollment failure **logs loudly and does not block boot** — the control plane is
never hostage to an auxiliary email feature — and boot delay is bounded by the mint
timeout (§8.3), worst case roughly 2 × ~10s before the listener comes up. Every later
send re-attempts enrollment on demand (§8.5, subject to the negative cache), so the
system self-heals without a restart. Once enrolled, later boots never need the hub.

### 8.5 Send-path credential resolution (per-host credentials)

The mode branch lives in **one place**: `memberRegistrationServiceRequest` gains a
**required** `destinationBaseUrl` parameter (all nine call sites live in the two
wrappers; requiring it means no call site can silently sign with the wrong
credential).

- The member wrapper (`invitationFlowRegistrationService.ts`) passes
  `config.desktopProfileUiBaseUrl`; the three admin wrappers
  (`controlAdminInvitationRegistrationService.ts`) pass `config.controlUiBaseUrl` — on
  **both send and validate** calls (a validate must be signed by the same tenant
  credential that registered the token).
- `remote`: ignore the destination, sign with the static env credential — today's path
  untouched.
- `hosted`: `ensureEnrollment(normalizeHost(destinationBaseUrl))` → sign with that row.
  One credential per destination host means all four flows — member invite, admin
  invite, admin email confirmation, admin password reset — work in hosted mode with no
  hub changes and no UI changes (unlike offline, the hub already handles their validate
  path and the control-ui redeem pages already exist).
- `signMemberRegistrationJwt` becomes **pure**: takes `{ secret, kid, tenantId }`
  explicitly. Token shape (HS256, `kid` header, `iss=control-api`,
  `aud=member-registration-service`, `sub=<tenantId>`, 60s TTL, `jti`) is unchanged —
  the hub sees identical JWTs.

### 8.6 Error surface

When enrollment is impossible (hub unreachable, still unenrolled), the wrappers throw
a typed `MemberRegistrationUnavailableError` → **503
`member_registration_unavailable`**; the host guard throws its own typed error → **503
`member_registration_misconfigured`** (§8.3). Today's behavior being replaced is **500
on the send paths and a misleading 400 on the validate paths** — the validate routes
wrap the wrappers in bare catch-alls that would otherwise convert a hub outage into
`400 invalid_invitation`, telling an invitee with a perfectly valid link that it is
invalid, permanently.

A route-level mapper alone therefore does **not** work — the inner catches intercept
first. The typed errors must be **rethrown (checked via `instanceof`) ahead of each
existing catch-all**, with a global error-middleware mapping in `app.ts` as the
backstop. Interception sites (verified):

- `routes/external/invitations.ts` — bare `catch → 400 invalid_invitation` at :52,
  :88, :250, plus the desktop-authorization string-matching catch (~:204-213).
- `routes/admin/auth.ts` — `catch → 400 invalid_password_reset`-style at :278, :312,
  :353, :483, :528 (the completion flow around :420 already forwards via
  `next(error)` and is covered by the middleware backstop alone).
- `routes/admin/controlAdmins.ts` — the two send sites; their compensating cleanup
  (revoke, ~:169-177) must still run before the error surfaces.
- Sends reached via `services/directory/membership.ts` (from `routes/admin/teams.ts`
  and `routes/external/members.ts`) — confirm membership does not catch, so the typed
  error propagates to the route/middleware layer.

Nothing else in the platform blocks or degrades.

### 8.7 What does not change

- `remote` mode, byte-for-byte — same required envs, same static signing.
- Managed/MCC tenants: injected env + mode unset → `remote`.
- profile-ui, external-rest-api, control-ui, desktop-app: **no changes** — the hub's
  `/i/<token>` interstitial is transparent and destination URLs are unchanged.

### 8.8 Testing (control-api, existing repo patterns)

- config: mode parsing (default `remote`; `hosted`; unknown → error); hosted +
  non-empty `HMAC_KID`/`TENANT_ID` → startup error, and **empty-string values do not
  trip it**; a lone `HMAC_SECRET` in hosted → boots with a warning; hosted relaxes the
  base-URL/secret requirements under `NODE_ENV=production` **non-vacuously** (mirror
  `config.prod.test.ts`). **Negative companions — load-bearing for "remote
  unchanged":** under `applyProdEnv` with the mode unset (and again with
  `MODE=remote` explicit), deleting `CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET`
  (and separately `_SERVICE_BASE_URL`) must make the config import **reject, naming
  the variable** — without these, an implementer who relaxes the requirements
  unconditionally instead of gating on mode ships green while breaking the
  managed-tenant fail-fast. (`KID`/`TENANT_ID` are never prod-required today —
  `config.ts:444-446` — so the relaxation claim is scoped to base URL + secret.)
- migration DDL (mirror `db.registryConnectionMigration.test.ts`): the emitted SQL
  contains `CREATE TABLE member_registration_credentials` **and the literal
  `WHERE revoked_at IS NULL`** on the unique index — the rotation re-mint path
  depends on that clause, and a mocked-conflict test cannot detect its absence.
- enrollment (mocked `fetch` + mocked `db.js` pool): mints when absent with the
  correct origin-derived URL **and a bounded timeout on the request**; persists the
  secret **encrypted** (the INSERTed value is not the plaintext); reuses without
  minting; concurrent calls yield one mint (in-flight map); insert conflict adopts
  the winner via a re-`SELECT` that **filters `revoked_at IS NULL`**; hub 4xx →
  negative-cached (no re-mint within the TTL, typed error immediately); network/5xx →
  typed error with backoff; the host guard rejects `localhost`/IP-literal/dotless
  hosts with the misconfiguration error; **captured log output never contains the
  secret string**.
- boot hook: `runBootEnrollment` with `ensureEnrollment` mocked to reject →
  **resolves** (never rejects) and logs; the enrollment-level rejection is asserted
  separately. (Asserting this inside `main.ts` is impossible — no test imports it;
  that is why the hook is exported, §8.4.)
- resolution — **directional, not just distinct**: the fetch mock mints distinct
  `{kid, secret, tenantId}` per domain; for each wrapper call capture the
  `Authorization` header and decode the JWT header; assert member **send and
  validate** carry the kid minted for the profile-ui host, admin **send and
  validate** carry the control-ui host's kid, and verify each signature with that
  host's secret. (A bare "kids differ" assertion stays green when the wrapper→host
  mapping is transposed — which in production 403s every member send.) Remote mode
  signs with the env credential and never calls `/public/tenants`.
- error surface: a validate route (e.g. `GET /external/invitations/token/:token`)
  whose wrapper throws `MemberRegistrationUnavailableError` returns **503
  `member_registration_unavailable`, not 400 `invalid_invitation`**.
- signer: pure-credential signing preserves the existing token shape.
- Live e2e against the real hub happens in the /verify step, not CI — it must
  provision its **own** throwaway tenant via `/public/tenants` (never borrow a
  managed credential) and tear down via hub-side revoke.

### 8.9 Docs (OSS)

Rewrite `docs/how-to/member-invitations-self-hosted.md`: hosted mode as the
zero-config recommended path — set `CONTROL_API_MEMBER_REGISTRATION_MODE=hosted` plus
**real, publicly resolvable domains** in the two UI base URLs (the host guard refuses
localhost/IP literals, §8.3). **No configmap surgery is needed**: the legacy
`_SERVICE_BASE_URL` value and the deploy-injected `HMAC_SECRET` are ignored in hosted
mode by design. BYO member-registration-service (`remote`) stays as the advanced
path; a BYO operator switching to hosted must remove their `HMAC_KID`/`TENANT_ID` env
(the §8.1 fail-fast names them). Touch the member-registration paragraph in
`docs/concepts/open-core-and-hosted.md`.

## 9. Abuse controls

- **Revoke a credential** — reuse `tenant_credentials.revoked_at`. Future sends 401;
  already-sent links dead-end at `GET /i/:token`.
- **Block a destination domain** — `blocked_domains`. Fastest response: one domain off,
  blocks future sends and kills pending links to that host at click time.
- **Daily send quota** — keyed primarily on `destination_domain` (stable across
  re-mints), accounted from `invite_send_log`. Because each credential is bound to one
  domain, per-credential and per-domain quota coincide. A speed bump (bypassable by
  registering more domains), plus an alertable signal.
- **Abuse correlation** — `invite_send_log` gives per-credential/per-domain history. The
  one-credential-one-domain invariant means cross-domain fan-out from a single credential
  is impossible by construction; unusual volume/recipient-spread per domain is the signal
  to watch.
- **Rate-limit fix (prerequisite):** `src/middleware/rateLimit.ts:getClientIp` trusts the
  leftmost `X-Forwarded-For`, which is attacker-controlled behind Cloudflare (CF appends
  rather than replaces). Switch to `CF-Connecting-IP` (fallback to the last XFF entry).
  Without this, per-IP limits on `/public/tenants` and public routes are decorative.
- **Recipient privacy** — store `recipient_hash` (SHA-256 of normalized email), never
  plaintext, to limit what a hub compromise leaks.

## 10. Profile-lookup shadowing fix (correctness — required regardless)

`getInvitationFlowProfileForEmail` (`src/services/invitationsFlowService.ts:343`) is
email-only and most-recent-row-wins across **all** tenants
(`WHERE t.email = $1 ORDER BY created_at DESC LIMIT 1`). Today this is latent among
trusted tenants; it becomes live once an external holds a credential — a stranger who
registers `ceo@paying-customer.com` becomes the newest row and hijacks that member's
public lookup.

Fix: partition by `tenant_type` and make **managed rows always win over external rows**
for the same email; external lookups are additionally scoped to their own
`bound_domain`. A stranger can never shadow a managed tenant's member; external instances
still resolve their own members. Exact query lands in implementation; the invariant is
"managed-wins, external-scoped-to-own-domain."

## 11. Sender / config prerequisites

- `MEMBER_REGISTRATION_SERVICE_SMTP_FROM_EMAIL` must become `no-reply@evenfire.ai` (live
  deployment currently sends `no-reply@hypersig.xyz`).
- **DKIM for `evenfire.ai` must exist in Postmark** before flipping the from-address, or
  deliverability drops. This is a Postmark/DNS prerequisite, not code.
- `registration` namespace NetworkPolicies already restrict egress to DNS/SMTP/Postgres.
  No new egress is required by this design (the hub does not fetch operator domains in
  this iteration), so the SSRF surface stays closed. If the future callback check (§13)
  is ever added, it needs the SSRF guard + a NetworkPolicy egress carve-out that excludes
  loopback/RFC1918/link-local and the GKE metadata IP.

## 12. Testing

Unit:
- `ext-`/`clerum-` prefix enforcement on both mint endpoints.
- Credential↔domain binding: send rejected when destination host ≠ `bound_domain`.
- Redirect token issue/resolve; interstitial gating on revoked credential and blocked
  domain (kill switch at click time).
- Quota accounting from `invite_send_log`.
- `CF-Connecting-IP` rate-limit fix (spoofed `X-Forwarded-For` no longer resets bucket).
- Shadowing fix: managed row wins over a newer external row for the same email; external
  lookup scoped to its own domain.

Integration (testcontainers Postgres, existing pattern):
- Full path: public mint → invite → `GET /i/:token` interstitial → redirect to bound
  domain.
- Blocked-domain kill mid-flight: token issued, domain blocked, click now dead-ends.

## 13. Future / deferred

- **Lazy domain verification** as a single flag: on first send for a credential, fetch
  `https://<bound_domain>/.well-known/evenfire-registration-challenge` and compare a
  hub-issued token before enabling email. Upgrades self-asserted → proven without
  disturbing the rest of the design. Requires the SSRF guard and NetworkPolicy egress
  carve-out noted in §11. Not in this iteration.
- Orphan-credential GC: TTL-sweep `external` credentials with no sends.
- Operator-facing self-revoke: a hub endpoint (authenticated by the credential being
  revoked) so a self-hoster can invalidate a leaked secret without contacting
  Evenfire. Until it exists, hub-side revocation is an Evenfire ops action (§8.2).

## 14. Rollout ordering

1. Hub: migration + `/public/tenants` + redirect + abuse controls + shadowing fix +
   XFF fix. Deploy (managed tenants keep working; redirect applies to all outbound links
   including managed — verify managed invites still resolve end-to-end).
2. Postmark: verify `evenfire.ai` DKIM; flip `SMTP_FROM_EMAIL`.
3. Control-api (companion repo): self-enroll behind
   `CONTROL_API_MEMBER_REGISTRATION_MODE=hosted` (§8).
4. Document the self-hosted onboarding (real UI domains +
   `CONTROL_API_MEMBER_REGISTRATION_MODE=hosted`) in the OSS docs (§8.9).
