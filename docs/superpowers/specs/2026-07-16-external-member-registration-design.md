# External Member Registration — Design

**Date:** 2026-07-16
**Status:** Approved design, pre-implementation
**Repos affected:** `evenfire-member-registration` (hub, primary) and the OSS control-api (this repo, companion)

> **STATUS NOTE (added on copy into evenfire-open-source, 2026-07-16).**
> - **Hub half = DONE.** The `evenfire-member-registration` changes in this spec (open `POST /public/tenants` mint, per-credential domain binding, hub-owned `GET /i/:token` redirect + interstitial, per-domain quota/blocklist kill switch, hashed send log, XFF fix, profile-lookup shadowing fix) shipped in hub PR #11 (merged, auto-deployed to `registration.evenfire.ai`).
> - **This repo implements §8 (control-api self-enrollment)** — the "hosted mode" companion. It is greenfield: control-api is currently a pure client that reads injected env and never self-mints.
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

### 8.1 Mode switch and config

- `CONTROL_API_MEMBER_REGISTRATION_MODE` = `remote` (default) | `hosted`
  (repo-convention `CONTROL_API_` prefix; supersedes this spec's earlier bare
  `MEMBER_REGISTRATION_MODE` and the abandoned PR #88's `offline` value).
  - `remote` — today's behavior byte-for-byte: base URL and non-placeholder HMAC secret
    required in production, static env credential signs every call. Covers MCC-managed
    tenants (which never set the var) and self-hosters running their own
    member-registration-service.
  - `hosted` — self-enrollment against the shared hub. `memberRegistrationServiceBaseUrl`
    defaults to `https://registration.evenfire.ai/api/v1` (env override allowed, e.g. a
    staging hub). The `CONTROL_API_MEMBER_REGISTRATION_{HMAC_SECRET,HMAC_KID,TENANT_ID}`
    requirements are dropped — credentials come from the DB (§8.2).
  - Any other value → **hard startup error** listing valid values (nothing in the wild
    sets this var yet; strictness catches e.g. a stale `offline` from the abandoned
    overlay).
- **Fail fast on ambiguity:** `hosted` + any of
  `CONTROL_API_MEMBER_REGISTRATION_{HMAC_SECRET,HMAC_KID,TENANT_ID}` present in raw
  `process.env` (not resolved dev defaults) → startup error: injected credentials and
  hosted mode are mutually exclusive. Managed tenants are structurally safe — MCC
  injects credentials and leaves the mode unset (`remote`).
- **No `NODE_ENV=production` interlock** (unlike offline's): hosted is the intended
  production posture for self-hosters; default-off already keeps throwaway/dev/CI
  deploys from silently provisioning a sender against our Postmark.

### 8.2 Credential store

New migration in `control-api/src/db.ts` `CONTROL_API_MIGRATIONS` (next version slot):

```sql
CREATE TABLE IF NOT EXISTS member_registration_credentials (
  id            BIGSERIAL PRIMARY KEY,
  bound_domain  TEXT NOT NULL,          -- normalized: lowercase hostname, port stripped (mirrors hub)
  tenant_id     TEXT NOT NULL,          -- "ext-<hex>" from the hub
  kid           TEXT NOT NULL,
  secret        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX member_registration_credentials_active_domain_idx
  ON member_registration_credentials (bound_domain)
  WHERE revoked_at IS NULL;
```

- **Persistence is mandatory**, not a nicety: re-minting per boot leaks credentials and
  resets per-credential quota.
- **Rotation posture:** schema-supported, no API. Deliberate rotation is an ops action
  (`UPDATE … SET revoked_at = now()`); the next send/boot re-mints. Old rows remain as
  audit trail.
- Secret is stored **plaintext** in control-api's own Postgres — proportionate (this DB
  already holds far more sensitive material), and an env-key envelope scheme would
  reintroduce exactly the operator credential handling hosted mode exists to remove.

### 8.3 Enrollment service

New `control-api/src/services/memberRegistrationEnrollment.ts`:

- `ensureEnrollment(domain)` — return the active credential row if present; otherwise
  mint `POST <hub-origin>/public/tenants { domain }` and persist. The mint endpoint is
  **unauthenticated** and hangs off the hub **origin**, not the `/api/v1` base — derive
  the origin from the configured base URL; do not route the mint through the signing
  client.
- **Concurrency guard, both layers:** an in-process in-flight promise map per domain
  (no double-mint within a replica), plus `pg_advisory_xact_lock(hash(domain))` around
  check-mint-insert (no cross-replica mint storm; the advisory-lock pattern exists in
  `initDb`). The partial unique index is the backstop: if a race still loses, adopt the
  winner's row and log the orphan. A rare orphan is acceptable; a mint storm is not.
- Domain normalization: `new URL(base).hostname.toLowerCase()` — hostname excludes the
  port, mirroring the hub's normalization.

### 8.4 Boot integration (degrade, never block)

In `main.ts` after `initDb()` (next to `assertRegistryConnectionReady`): when `hosted`,
run `ensureEnrollment` for each **unique** normalized host of `desktopProfileUiBaseUrl`
and `controlUiBaseUrl` (deduped — two UIs on one hostname mint once; subdomain deploys
like `profile.acme.com` / `control.acme.com` mint two). Hosted mode presumes real,
publicly meaningful domains; whether the hub accepts IP/localhost hosts is the hub's
validation call, not something this design relies on. Enrollment failure **logs loudly
and does not block boot** — the control plane is never hostage to an auxiliary email
feature. Every later send re-attempts enrollment on demand (§8.5), so the system
self-heals without a restart. Once enrolled, later boots never need the hub.

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

When enrollment is impossible (hub unreachable, still unenrolled), the wrappers throw a
typed `MemberRegistrationUnavailableError`, mapped in the calling routes to a clean
**503 `member_registration_unavailable`** — replacing today's opaque 500. Nothing else
in the platform blocks or degrades.

### 8.7 What does not change

- `remote` mode, byte-for-byte — same required envs, same static signing.
- Managed/MCC tenants: injected env + mode unset → `remote`.
- profile-ui, external-rest-api, control-ui, desktop-app: **no changes** — the hub's
  `/i/<token>` interstitial is transparent and destination URLs are unchanged.

### 8.8 Testing (control-api, existing repo patterns)

- config: mode parsing (default `remote`; `hosted`; unknown → error); hosted +
  explicit env credentials → startup error; hosted relaxes the base-URL/secret
  requirements under `NODE_ENV=production` **non-vacuously** (mirror
  `config.prod.test.ts`); remote unchanged.
- enrollment (mocked `fetch` + mocked `db.js` pool): mints when absent (correct
  origin-derived URL), persists, reuses without minting; concurrent calls yield one
  mint; insert conflict adopts the winner; hub failure → typed error and boot
  continues.
- resolution: hosted signs member vs admin calls with **different kids** (per-host);
  remote signs with the env credential and never calls `/public/tenants`.
- signer: pure-credential signing preserves the existing token shape.
- Live e2e against the real hub happens in the /verify step, not CI.

### 8.9 Docs (OSS)

Rewrite `docs/how-to/member-invitations-self-hosted.md`: hosted mode as the
zero-config recommended path (`CONTROL_API_MEMBER_REGISTRATION_MODE=hosted` + real
domains in the two UI base URLs), BYO member-registration-service (`remote`) kept as
the advanced path. Touch the member-registration paragraph in
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

## 14. Rollout ordering

1. Hub: migration + `/public/tenants` + redirect + abuse controls + shadowing fix +
   XFF fix. Deploy (managed tenants keep working; redirect applies to all outbound links
   including managed — verify managed invites still resolve end-to-end).
2. Postmark: verify `evenfire.ai` DKIM; flip `SMTP_FROM_EMAIL`.
3. Control-api (companion repo): self-enroll behind
   `CONTROL_API_MEMBER_REGISTRATION_MODE=hosted` (§8).
4. Document the self-hosted onboarding (real UI domains +
   `CONTROL_API_MEMBER_REGISTRATION_MODE=hosted`) in the OSS docs (§8.9).
