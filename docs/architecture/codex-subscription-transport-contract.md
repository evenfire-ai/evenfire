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
| maxToolCalls | 32 |
| maxOutputTokens | 16384 |
| maxStreamDurationMs | 300000 |
| maxDeadlineMs | 300000 |
| maxConcurrentStreams | 8 |
| maxQueuedRequests | 16 |
| maxRetriesPerAttempt | 1 |

Tool definitions have no independent count ceiling in the Evenfire request
contract. The entire serialized request, including all definitions, remains
bounded by `maxRequestBodyBytes` (1 MiB). Every definition still undergoes
name, schema, finite-value and unknown-field validation. `maxToolCalls` bounds
calls in each assistant history message and each newly returned response. The proxy buffers tool calls until successful completion and validates the bound before publishing any executable call; the Host validates it again before returning the batch. It is not a catalog size limit and
does not widen execution concurrency. This preserves the existing call bound.

The former `maxTools: 32` definition limit was imposed by Evenfire, not a
verified Codex Subscription limit. Remote endpoint limits remain separately
subject to authorized interoperability testing; local acceptance does not
certify that the endpoint accepts any particular count. Discovery optimizes
which schemas are sent, without changing the approved catalog or permissions.
An oversized explicit direct request fails before authorization rather than
silently truncating tools or changing presentation.

### Compatibility and deployment order

The V1 wire fields and canonical hash projection are unchanged. Previously
accepted requests retain their hashes; every newly advertised definition is
included in the hash. Tickets and receipts keep their existing binding.
This is a validator relaxation, not a new wire format. No version negotiation
or fallback to a truncated catalog is introduced.

| Sender | Validator | Result within all other limits |
| --- | --- | --- |
| Old (at most 32 definitions) | New | Accepted; unchanged hash |
| New (at most 32 definitions) | Old | Accepted; unchanged hash |
| New (more than 32 definitions) | Old | Explicit count-limit rejection |
| New (more than 32 definitions) | New | Accepted locally; upstream capability is tested separately |

Deploy updated Control API and proxy consumers before the updated MCP Host
sender. Verify that both consumers use the updated shared package; rebuilding
only the sender is insufficient. For rollback, restore the old sender first,
drain outstanding incompatible attempts, then restore older validators. An old
sender reintroduces the known connector exclusion and is not a correction.

### Transport tool names

Canonical Evenfire tool names remain unchanged in authorization, request hashes,
Host dispatch and stored history. At the proxy boundary, names outside
`[A-Za-z0-9_-]{1,64}` receive deterministic, reversible aliases. Compliant names
are reserved first; bounded collision handling also covers legitimate names
that resemble generated aliases. The map includes active definitions and
historical assistant calls, and restores canonical names before emitting calls
to the Host. Call IDs and function-call outputs remain unchanged.

This uses the conservative function-name envelope documented by the
[official OpenAI SDK](https://github.com/openai/openai-python/blob/main/src/openai/types/shared_params/function_definition.py).
It is not evidence of a measured rejection by the ChatGPT Codex endpoint.
The transformation preserves all tools; no name is truncated or omitted.
If an inventory change introduces an alias collision, the request remaps its
entire history consistently. Unknown generated aliases fail explicitly;
ordinary unknown names retain the Host registry's authorization checks.

### Selected MCP argument validation

For tasks whose provider chain includes Codex, the Host validates selected MCP
arguments before approval and rechecks the live schema immediately before
dispatch. Other provider chains retain server-side argument validation. Missing `$schema` uses JSON Schema 2020-12;
explicit draft-07 and 2019-09 are also supported, including HTTP/HTTPS URI aliases. Unsupported dialects and
unresolved references fail explicitly. Validation never coerces types, applies
defaults, removes arguments, or loads remote references.

Compilation and evaluation run in disposable Node workers, outside the Host
event loop. Each operation has a two-second deadline and V8 heap/stack limits;
these are not a total-process RSS guarantee. Inputs are bounded to 256 KiB per
schema/argument document, 10,000 nodes and depth 64. At most four workers may be
active, with a FIFO queue of at most 32 waiting requests. Admission and execution
share the two-second deadline; queue overflow and timeout fail explicitly.
Worker startup adds latency and is not claimed as a quota optimization. A
successful validation waits for worker teardown before releasing its caller.
A single successful schema/argument pair may be reused by the same adapter;
byte-identical live inputs are required, so changes invalidate reuse before
dispatch. Sanitized failure codes distinguish argument/schema errors, resource
limits, saturation, timeout and worker failure.

Deployment readiness checks after a combined apply do not enforce the ordering
above. The infrastructure rollout barrier remains a separate release dependency;
this document alone does not certify mixed-version deployment safety.

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

## Tool presentation in the agent

`CODEX_TOOL_PRESENTATION=auto|direct|discovery` controls presentation, not access.
Auto is the default when the primary or an allowed fallback uses Codex: it
uses discovery above the existing `CLERUM_DYNAMIC_TOOLS_THRESHOLD` (60) or
`CODEX_TOOL_DISCOVERY_BYTES` (32768 serialized MCP definition bytes). These
are optimization thresholds; no tools are discarded from the local registry.
Direct retains all definitions subject to the bounded request contract.
Discovery exposes the stable native set and search/describe/call bridge.
The same presentation is usable across a configured failover chain.

Search results contain bounded compact descriptions and no schemas. Follow
`nextOffset` with the same query/filter to continue; explicit `enumerate`
permits full traversal. Describe returns the exact selected schema, never a
truncated schema. Existing output spillover (enabled by default) handles
large results; transport/context limits still apply and no unbounded-schema
support or measured subscription-quota reduction is claimed.
