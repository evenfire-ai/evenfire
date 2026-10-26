# CodeQL `js/missing-rate-limiting` — control-api and External REST disposition

This document records audited dispositions for [CodeQL](https://codeql.github.com/)
`js/missing-rate-limiting` findings. It supports Security-tab dismissals
(`dismissed_comment` + reason) per
[GitHub code scanning guidance](https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts#dismissing-alerts).

## Product invariant

Authenticated control-api routes that perform expensive work **must** be rate
limited. Enforcement uses the Postgres-backed `rateLimitMiddleware`
(`services/rateLimiterService.ts`) so limits are consistent across replicas.

CodeQL 2.x models `express-rate-limit` (and some framework plugins) but **does
not** model our custom PG limiter. Routes that only use `rateLimitMiddleware`
may still alert until an `express-rate-limit` **edge backstop** is added (see
`control-api/src/routes/external/gfs.ts`).

## Approved patterns

| Pattern                                                | Purpose                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| `rateLimitMiddleware` only                             | Production enforcement (cross-replica)                          |
| PG + `express-rate-limit` backstop                     | Production + CodeQL/SAST visibility                             |
| Auth as Express middleware **before** business handler | Keeps authorization out of the final handler node CodeQL labels |

Tier defaults (requests/minute, per verified admin session identity unless noted):

| Tier                                                           | Limit                   | Config anchor                  |
| -------------------------------------------------------------- | ----------------------- | ------------------------------ |
| Admin public token                                             | 20                      | `adminPublicTokenRlPerMin`     |
| Admin workflow grant read                                      | 60                      | `workflowGrantReadRateLimit`   |
| Admin workflow grant write                                     | 20                      | `workflowGrantWriteRateLimit`  |
| Registry identity voucher                                      | 30                      | inline in `registry.ts`        |
| Registry connect request                                       | 3                       | inline in `registryConnect.ts` |
| External GFS read (resource, proxy, grants, shares) / mutation | 480, 480, 120, 120 / 90 | `externalGfsClassRlPerMin`     |

## PR #428 / F4 scope (fixed in branch)

| Alert                                                                        | Location                        | Resolution                                                        |
| ---------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------- |
| [#81](https://github.com/evenfire-ai/evenfire/security/code-scanning/81)     | `grants.routes.ts:173`          | Fixed: cookie bucket + dual limiter + auth middleware             |
| [#82](https://github.com/evenfire-ai/evenfire/security/code-scanning/82)     | `grants.routes.ts:197`          | Fixed: same                                                       |
| [#83](https://github.com/evenfire-ai/evenfire/security/code-scanning/83)     | `grants.routes.ts:236`          | Fixed: same                                                       |
| [#63](https://github.com/evenfire-ai/evenfire/security/code-scanning/63)     | `outputs.ts:35`                 | Fixed: `adminOutputsReadRateLimits()` PG + edge backstop (30/min) |
| [#1157](https://github.com/evenfire-ai/evenfire/security/code-scanning/1157) | `llmProviderAttempts.routes.ts` | Fixed: `express-rate-limit` + PG **before** `requireMcpHostJwt`   |

Edge backstop keys: a **verified admin session identity hash** for signed
Control UI sessions/bearers and a **source-IP fallback** for credentials that
fail verification; requests with no credential are **skipped** (anonymous).
PG tiers use the same verified-session identity, with the source-IP fallback
only for an unverified credential. Distinct signed sessions for one admin are
kept separate so a revoked/stale session cannot consume the replacement
session's quota.

Additional tiers shipped in PR #428:

| Tier                       | Limit   | Config anchor                                             |
| -------------------------- | ------- | --------------------------------------------------------- |
| Admin workflow read        | 60      | `workflowAdminReadRateLimits`                             |
| Admin outputs read         | 30      | `adminOutputsReadRateLimits`                              |
| Admin workflow trigger     | 10      | `adminWorkflowTriggerRateLimit`                           |
| Admin Codex read / write   | 30 / 20 | `adminCodexReadRateLimits` / `adminCodexWriteRateLimits`  |
| Codex OAuth callback       | 20      | `codexOAuthCallbackRateLimits` (IP)                       |
| mcp-host attempt authorize | 60      | `llmProviderAttemptAuthorizeRateLimits` (edge before JWT) |

## Out-of-scope dispositions (Layer 3)

Follow-up implementation tracked separately (`fix/codeql-control-api-rate-limit-backstops`).

### False positive — PG limiter or non-route sink present

| Alert                                                                        | Location                                                             | Evidence                                                                  |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [#57](https://github.com/evenfire-ai/evenfire/security/code-scanning/57)     | `app.ts:131`                                                         | Middleware mount only; per-route limiters apply downstream                |
| [#58](https://github.com/evenfire-ai/evenfire/security/code-scanning/58)     | `app.ts:219`                                                         | 404 guard for unknown `/gfs/*`; no expensive work                         |
| [#60](https://github.com/evenfire-ai/evenfire/security/code-scanning/60)     | `auth.ts:572`                                                        | Handler under `publicAdminTokenRateLimit()` (`adminPublicTokenRlPerMin`)  |
| [#171](https://github.com/evenfire-ai/evenfire/security/code-scanning/171)   | `registry.ts:24`                                                     | `rateLimitMiddleware` 30/min at `:28-35`                                  |
| [#826](https://github.com/evenfire-ai/evenfire/security/code-scanning/826)   | `registryConnect.ts:321`                                             | `rateLimitMiddleware` 3/min at `:329-336`                                 |
| [#803](https://github.com/evenfire-ai/evenfire/security/code-scanning/803)   | `gfs/grants.ts:849`                                                  | Internal DB helper, not an HTTP route handler                             |
| [#1767](https://github.com/evenfire-ai/evenfire/security/code-scanning/1767) | `app.ts:73`                                                          | False positive — invitation error-response middleware; evidence below     |
| [#1769](https://github.com/evenfire-ai/evenfire/security/code-scanning/1769) | `passwordResetPayload.externalRest.realPostgres.integration.test.ts` | Test-only composition: Control API and External REST bind loopback; producer is task-local on an ephemeral port |

Alert #1767 is attached to the invitation error-response middleware mount, which maps upstream
failures to bounded public responses. External REST token lookup is limited to 30 requests/minute
per trusted `req.ip`; password setup and acceptance are limited to 10/minute. The Control API
applies external-client source limits to invitation routes and server-side 30/minute and 10/minute
admission buckets to token lookup and password-token setup, with its documented process-memory
fallback. Cost-12 password work remains behind the shared durable owner. CodeQL's authorization
dataflow points through error presentation and does not model this custom and cross-service limiter
chain. `external-rest-api/test/routes.invitations.test.ts` asserts the 429 and `Retry-After`
contract; `external-rest-api/test/middleware.rateLimit.test.ts` verifies trusted-source bucketing.

Alert #1769 points to error-response handling in
`control-api/test/passwordResetPayload.externalRest.realPostgres.integration.test.ts`. The test
mounts `requireInternalToken` and the real `createExternalInvitationsRouter()` on a task-owned
Control API Express app, then binds that app to an ephemeral `127.0.0.1` port. The middleware
validates the bearer token against the service named by `x-service-token` and attaches that service
identity for downstream authorization. The test also starts its task-local Member Registration
service on a selected ephemeral port; the test addresses it through `127.0.0.1`, while the
producer app does not specify a host bind. The built External REST app runs in a separate child
process on its own ephemeral port explicitly bound to `127.0.0.1`. Supertest sends HTTP requests
to the External REST child; it does not receive the Express app object directly. These listeners
are test-owned, not deployed service listeners.

The production External REST `POST /invitations/password` route retains its 10/minute
`acceptRateLimit`. The Control API password-token route applies its external-client source limiters
and 10/minute admission bucket, with the documented process-memory fallback when the limiter
backend is unavailable. In production, the Control API mounts this router behind
`requireInternalService('external-rest-api')`. The composed test fixture mounts
`requireInternalToken` directly and does not exercise that expected-service gate; it does validate
the bearer token and exercise the real route and its limiter/admission behavior. These controls
support the test-only false-positive disposition; the alert does not identify an unbounded deployed
route.

The `createDropResetResponseProxy` helper is exercised both for ordinary response forwarding and
for the ambiguous-reset case. For ordinary proxy responses it copies the upstream status and body,
sets a constant `application/json` content type, and forwards no response headers, including
`Retry-After` or `Set-Cookie`. For the one-use password-token POST it consumes the upstream
response and destroys the downstream connection to model a lost reset acknowledgement. The public
External REST route owns its bounded retry response and issues its own session cookie only after a
successful reset with a valid session token. Focused invitation and trusted-source tests verify the
public 429/`Retry-After` behavior; they do not assert that the fault-injection proxy forwards those
headers.

GitHub currently records alert #1769 as dismissed with reason `false positive`. Its 2026-10-12
dismissal note relied on the earlier Supertest-only topology. This entry updates the repository's
current evidence to the loopback child-service topology; the alert state and historical dismissal
were not changed.

### Won't fix (accepted) — real gap, follow-up backstop PR

Tracked for `fix/codeql-control-api-rate-limit-backstops`. No auth bypass; missing
SAST-visible backstop (and in some cases PG limiter — see Notes).

| Alert                                                                      | Location                 | Planned tier        | Notes                          |
| -------------------------------------------------------------------------- | ------------------------ | ------------------- | ------------------------------ |
| [#61](https://github.com/evenfire-ai/evenfire/security/code-scanning/61)   | `auth.ts:607`            | 60/min session read | `/admin/auth/me` SPA hydration |
| [#62](https://github.com/evenfire-ai/evenfire/security/code-scanning/62)   | `controlAdmins.ts:327`   | 10/min write        | Admin invitation POST          |
| [#70](https://github.com/evenfire-ai/evenfire/security/code-scanning/70)   | `registryConnect.ts:520` | 10/min write        | Claim redemption               |
| [#71](https://github.com/evenfire-ai/evenfire/security/code-scanning/71)   | `registryConnect.ts:715` | 10/min write        | Key rotation                   |
| [#133](https://github.com/evenfire-ai/evenfire/security/code-scanning/133) | `gfs/proxy.ts:31`        | 120 read            | Control UI GFS                 |
| [#138](https://github.com/evenfire-ai/evenfire/security/code-scanning/138) | `gfs/resolve.ts:80`      | 120 read            | Control UI GFS                 |
| [#140](https://github.com/evenfire-ai/evenfire/security/code-scanning/140) | `gfs/resolve.ts:89`      | 120 read            | Control UI GFS                 |
| [#144](https://github.com/evenfire-ai/evenfire/security/code-scanning/144) | `gfs/token.ts:44`        | 30 mutation         | GFS token mint                 |
| [#145](https://github.com/evenfire-ai/evenfire/security/code-scanning/145) | `gfs/resources.ts:350`   | 30 mutation         | PATCH resource                 |
| [#149](https://github.com/evenfire-ai/evenfire/security/code-scanning/149) | `gfs/tree.ts:24`         | 120 read            | Tree browse                    |
| [#150](https://github.com/evenfire-ai/evenfire/security/code-scanning/150) | `gfs/tree.ts:51`         | 120 read            | Children paging                |

## Dismissal template (Security tab / API)

```
Documented in docs/how-to/codeql-js-missing-rate-limiting.md (alert #<NUMBER>).
<One-line evidence from table above>.
```

## Re-open triggers

Re-audit when:

- `rateLimitMiddleware` signature or call pattern changes repo-wide
- A listed route removes its PG limiter
- CodeQL adds modeling for our PG limiter (then remove redundant backstops)
- New authenticated route is added without an entry in this registry
