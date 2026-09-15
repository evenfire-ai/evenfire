# Codex subscription transport contract

Frozen protocol version: `codex-subscription-transport.v1`.

This document is the Phase 0 architecture freeze for provider `codex-subscription`.
It is not a runtime client and does not authorize API-key billing.

![Evenfire Codex subscription - grant, assign, project, spend](diagrams/codex-subscription-lifecycle.png)

## Ownership

- Control API is the only OAuth custodian.
- `mcp-host` authorizes each physical attempt and streams to `codex-llm-proxy`.
- `codex-llm-proxy` redeems a single-use ticket, holds the access token in
  operation memory only, and talks to the frozen HTTPS origins below.
- The LLM stream never transits Control API or its gateways.

## Origins

Exact HTTPS origins (no caller-supplied URL or header):

- OAuth authorize: `https://auth.openai.com/oauth/authorize`
- OAuth token: `https://auth.openai.com/oauth/token`
- OAuth device prefix: `https://auth.openai.com/api/accounts/deviceauth`
- OAuth device usercode: `https://auth.openai.com/api/accounts/deviceauth/usercode`
- OAuth device token poll: `https://auth.openai.com/api/accounts/deviceauth/token`
- OAuth device callback: `https://auth.openai.com/deviceauth/callback`
- OAuth device verification: `https://auth.openai.com/codex/device`
- OAuth revoke: `https://auth.openai.com/oauth/revoke`
- Catalog: `https://chatgpt.com/backend-api/codex/models?client_version=1.0.0`
- Completions: `https://chatgpt.com/backend-api/codex/responses`

Forbidden examples: `https://api.openai.com/v1/chat/completions` (ordinary API
billing), HTTP, loopback, and link-local/metadata addresses.

Redirects: HTTPS only, same origin as `https://auth.openai.com` or
`https://chatgpt.com`, never private or special-use addresses.

## Operations

`oauth_browser`, `oauth_device`, `oauth_refresh`, `oauth_revoke`,
`oauth_reconnect`, `catalog_list`, `completion_stream`, `completion_cancel`,
`connection_test`.

OAuth scopes: `openid`, `profile`, `email`, `offline_access`.

## Limits

All values are finite and greater than zero. `maxRetriesPerAttempt` is `1`:
one physical execution per ticket. A retry or fallback must mint a new attempt.

| Limit | Value |
| --- | --- |
| maxRequestBodyBytes | 1048576 |
| maxMessages | 128 |
| maxTools | 32 |
| maxOutputTokens | 16384 |
| maxStreamDurationMs | 300000 |
| maxDeadlineMs | 300000 |
| maxConcurrentStreams | 8 |
| maxQueuedRequests | 16 |
| maxRetriesPerAttempt | 1 |

### Evenfire request bounds are not upstream limits

The table above records the UPSTREAM contract. `@clerum/llm-provider-attempt-contract`
carries Evenfire's own bounds on what a host may ask the proxy to execute, and
those are set independently.

Until #627 one `maxTools: 32` in that package governed two unrelated quantities:
the number of tool DEFINITIONS a request may advertise, and the number of tool
CALLS one assistant turn may emit. They are now distinct:

| Evenfire bound | Value | Governs |
| --- | --- | --- |
| `maxToolDefinitions` | 128 | `tools[]` — the advertised catalog |
| `maxToolCallsPerMessage` | 32 | `messages[].toolCalls[]` — one assistant turn |

`maxToolDefinitions` is sized from measured native inventory, not from an
assumed provider cap. A fully-featured chat Host registers roughly 53 native
tools: core file/shell/http/system/json, four memory tools, `cron_manage`,
`spillover_read`, `session_search`, five `workflow_*`, seven
`clerum__generate_*`, two `clerum__context_files_*`,
`clerum__get_capabilities`, ten `clerum__gfs_*`, the three discovery/bridge
tools, and up to twelve desktop/browser tools. 128 leaves about 2.4x headroom
over that while keeping every request bounded.

What a host actually puts on the wire is smaller and separately configurable:
`CLERUM_CODEX_MAX_TOOL_DEFINITIONS` (default 64), clamped to
`maxToolDefinitions`. Tools beyond that capacity are deferred to the
`clerum__tool_search` / `clerum__tool_describe` / `clerum__tool_call` bridge
rather than dropped, so the advertised set plus the bridge-reachable set always
covers the whole permitted catalog. The separate env knob is what allows a
bounded canary to raise presented capacity without touching the shared contract.

Whether the upstream provider accepts more than 32 tool definitions is NOT
established by the evidence below, which is why the upstream table is unchanged
and the default presented capacity stays conservative.

## Errors

Stable codes: `insufficient_scope`, `no_grant`, `model_not_allowed`,
`budget_denied`, `connection_unavailable`, `provider_unavailable`,
`origin_denied`, `ticket_invalid`, `ticket_replayed`, `request_hash_mismatch`.

## Evidence

Origins are frozen from the public Codex CLI OAuth registration observed at
implementation start against `origin/dev`
`1b845a3d636cc1b766cfcec66bb44a880581014b`. Live account connect / list /
stream / cancel / refresh / revoke is Task 25 (`CODEX_REAL_UPSTREAM_CONFIRM=1`)
and must not weaken this allowlist. Account identifiers stay redacted.

The focused drift from spec SHA `7d56b10849458a67b15f7d9a0991fa62604913a3` to
current `HEAD` did not change credential owner, data path, trust boundary,
namespace/workload shape, gateway count, mTLS stance, or access-token recipient.

Phase 2 grant binding hashes `{ catalogRevision, connectionKey,
credentialRevision, model, provider }` so two named subscriptions with the
same integer revisions do not collide. Host `spec.model.connectionRef` selects
the grant; revoke of one key fail-closes only that assignment.
