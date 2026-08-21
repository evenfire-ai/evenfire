# CodeQL `js/missing-rate-limiting` — control-api disposition

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

| Pattern | Purpose |
| -------- | -------- |
| `rateLimitMiddleware` only | Production enforcement (cross-replica) |
| PG + `express-rate-limit` backstop | Production + CodeQL/SAST visibility |
| Auth as Express middleware **before** business handler | Keeps authorization out of the final handler node CodeQL labels |

Tier defaults (requests/minute, per admin credential hash unless noted):

| Tier | Limit | Config anchor |
| ---- | ----- | ------------- |
| Admin public token | 20 | `adminPublicTokenRlPerMin` |
| Admin workflow grant read | 60 | `workflowGrantReadRateLimit` |
| Admin workflow grant write | 20 | `workflowGrantWriteRateLimit` |
| Registry identity voucher | 30 | inline in `registry.ts` |
| Registry connect request | 3 | inline in `registryConnect.ts` |
| External GFS read / mutation | 120 / 30 | `externalGfsReadRlPerMin` / `externalGfsOperationRlPerMin` |

## PR #428 / F4 scope (fixed in branch)

| Alert | Location | Resolution |
| ----- | -------- | ---------- |
| [#81](https://github.com/evenfire-ai/evenfire/security/code-scanning/81) | `grants.routes.ts:173` | Fixed: cookie bucket + dual limiter + auth middleware |
| [#82](https://github.com/evenfire-ai/evenfire/security/code-scanning/82) | `grants.routes.ts:197` | Fixed: same |
| [#83](https://github.com/evenfire-ai/evenfire/security/code-scanning/83) | `grants.routes.ts:236` | Fixed: same |
| [#63](https://github.com/evenfire-ai/evenfire/security/code-scanning/63) | `outputs.ts:35` | Fixed: `adminOutputsReadRateLimits()` PG + edge backstop (30/min) |

Edge backstop keys: **cookie hash** for Control UI sessions, **source IP** for bearer-only automation, **skipped** when no credential (anonymous). PG tiers remain per admin credential hash.

Additional tiers shipped in PR #428:

| Tier | Limit | Config anchor |
| ---- | ----- | ------------- |
| Admin workflow read | 60 | `workflowAdminReadRateLimits` |
| Admin outputs read | 30 | `adminOutputsReadRateLimits` |
| Admin workflow trigger | 10 | `workflowTriggerRateLimit` |

## Out-of-scope dispositions (Layer 3)

Follow-up implementation tracked separately (`fix/codeql-control-api-rate-limit-backstops`).

### False positive — PG limiter or non-route sink present

| Alert | Location | Evidence |
| ----- | -------- | -------- |
| [#57](https://github.com/evenfire-ai/evenfire/security/code-scanning/57) | `app.ts:131` | Middleware mount only; per-route limiters apply downstream |
| [#58](https://github.com/evenfire-ai/evenfire/security/code-scanning/58) | `app.ts:219` | 404 guard for unknown `/gfs/*`; no expensive work |
| [#60](https://github.com/evenfire-ai/evenfire/security/code-scanning/60) | `auth.ts:572` | Handler under `publicAdminTokenRateLimit()` (`adminPublicTokenRlPerMin`) |
| [#171](https://github.com/evenfire-ai/evenfire/security/code-scanning/171) | `registry.ts:24` | `rateLimitMiddleware` 30/min at `:28-35` |
| [#826](https://github.com/evenfire-ai/evenfire/security/code-scanning/826) | `registryConnect.ts:321` | `rateLimitMiddleware` 3/min at `:329-336` |
| [#803](https://github.com/evenfire-ai/evenfire/security/code-scanning/803) | `gfs/grants.ts:849` | Internal DB helper, not an HTTP route handler |

### Won't fix (accepted) — real gap, follow-up backstop PR

Tracked for `fix/codeql-control-api-rate-limit-backstops`. No auth bypass; missing
SAST-visible backstop (and in some cases PG limiter — see Notes).

| Alert | Location | Planned tier | Notes |
| ----- | -------- | ------------ | ----- |
| [#61](https://github.com/evenfire-ai/evenfire/security/code-scanning/61) | `auth.ts:607` | 60/min session read | `/admin/auth/me` SPA hydration |
| [#62](https://github.com/evenfire-ai/evenfire/security/code-scanning/62) | `controlAdmins.ts:327` | 10/min write | Admin invitation POST |
| [#70](https://github.com/evenfire-ai/evenfire/security/code-scanning/70) | `registryConnect.ts:520` | 10/min write | Claim redemption |
| [#71](https://github.com/evenfire-ai/evenfire/security/code-scanning/71) | `registryConnect.ts:715` | 10/min write | Key rotation |
| [#133](https://github.com/evenfire-ai/evenfire/security/code-scanning/133) | `gfs/proxy.ts:31` | 120 read | Control UI GFS |
| [#138](https://github.com/evenfire-ai/evenfire/security/code-scanning/138) | `gfs/resolve.ts:80` | 120 read | Control UI GFS |
| [#140](https://github.com/evenfire-ai/evenfire/security/code-scanning/140) | `gfs/resolve.ts:89` | 120 read | Control UI GFS |
| [#144](https://github.com/evenfire-ai/evenfire/security/code-scanning/144) | `gfs/token.ts:44` | 30 mutation | GFS token mint |
| [#145](https://github.com/evenfire-ai/evenfire/security/code-scanning/145) | `gfs/resources.ts:350` | 30 mutation | PATCH resource |
| [#149](https://github.com/evenfire-ai/evenfire/security/code-scanning/149) | `gfs/tree.ts:24` | 120 read | Tree browse |
| [#150](https://github.com/evenfire-ai/evenfire/security/code-scanning/150) | `gfs/tree.ts:51` | 120 read | Children paging |

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
