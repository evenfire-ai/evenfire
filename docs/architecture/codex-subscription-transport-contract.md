# Codex subscription transport contract

Frozen protocol version: `codex-subscription-transport.v1`.

Request schemas: `codex-completion-request.v1` for ordinary text and
`codex-completion-request.v2` for ordered visual content (including text parts
left after media pruning). The transport, execution-ticket type and receipt
version remain V1. Request V2 does not imply a transport protocol upgrade.

## Visual requests (issue #650)

V2 user messages may carry `contentParts`: ordered text parts or inline PNG/JPEG
parts. Images contain `mimeType`, canonical base64 `data`, and a closed `source`
identity: `{ kind: 'attachment', attachmentId, messageId }` or
`{ kind: 'tool', attachmentId, toolCallId }`. Sources are established by the Host
message/tool producers, included in the canonical request hash, and omitted from
the upstream projection. They are attribution inside the authorized request,
not permission to fetch another object. No arbitrary URL is accepted.

The text parts joined with a newline must equal the message's `content`.
Producers synchronize the fields when adding turn context. After media pruning,
the remaining text parts are authoritative, so redaction text is preserved.
Ordinary V1 textual requests retain their existing wire representation and hashes.

Tool-image source retention is enabled only when a configured primary or fallback
provider requires source identity. Pure API-key chains keep the existing loop
deduplication and message shape. Mixed chains retain distinct source identities
in canonical history; each provider adapter selects its own view without mutating
that history. The internal `sourceIdentityOnly` marker identifies extra copies and
never enters the Codex request schema. API-key adapters omit those copies when an
unmarked representative remains. If pruning removed that representative, they
retain one remaining image per MIME/bytes pair and its explanatory text. They do
not restore pixels removed by pruning. The user-facing attachment collection
keeps its existing deduplication behavior.

Local visual budgets are three images, 10 MiB decoded per image, 15 MiB decoded
across a request, 8192 pixels per dimension and 64,000,000 pixels per image.
The aggregate is independent: one 10 MiB image plus one 5 MiB image fits, as do
three 5 MiB images; three 10 MiB images do not. Original bytes are preserved.
These are conservative Evenfire limits, not claims about upstream capabilities.
The shared pure validator checks canonical base64, MIME/container framing and
header dimensions; it does not decode pixels or prove image decodability.
The fixtures contain independently decoded 2x2 PNG/JPEG images.

V1 keeps its existing 1 MiB request/envelope ceiling. V2 has a 24 MiB ceiling
for the complete serialized request and HTTP envelope, including base64,
history and the signed execution ticket. V2 text, tools and other non-image
fields remain bounded to 1 MiB, measured with only image data blanked in a
temporary size projection; the actual request and its hash are not modified.
The authorizer builds the exact V2 proxy envelope inside its transaction after
signing but before commit. Exceeding the bound rolls back the new attempt,
ticket and new reservation; it does not call the receipt finalizer before redeem.
The Host uses the same envelope builder. V2 has no outer deadline: its deadline
is `request.deadlineMs`, part of the authorized hash. A proxy configured below
the shared visual envelope budget refuses visual activation at startup.

Desktop enforces the 10 MiB individual and 15 MiB combined attachment budgets.
RPC and Host permit a 24 MiB JSON body only on their message POST routes; their
6 MiB budget for other content and routes remains unchanged. The proxy's larger
parser requires a valid platform identity on the visual completion route.
Admin and unauthenticated requests retain the ordinary configured body limit.
`CODEX_LLM_PROXY_MAX_VISUAL_BODY_BYTES` controls the visual transport ceiling;
`CODEX_LLM_PROXY_MAX_BODY_BYTES` continues to control ordinary requests.

The proxy projects parts to Responses `input_text` and `input_image` items with
an inline data URL. The shape is grounded in the official Codex client
[ContentItem and ImageReference definitions](https://github.com/openai/codex/blob/fc2ea82e7eff22c618a56db29c68a6b1967cba7d/codex-rs/protocol/src/models.rs#L878).
This source evidence is not a successful call to Evenfire's frozen endpoint.

`CODEX_IMAGE_INPUT_MODELS` is an explicit, comma-separated model rollout gate in
both Host and proxy. It defaults to empty. Set it only for the models whose
interoperability has been independently verified, after every authorizer/proxy
replica accepts V2. This gate is not a replacement for catalog authorization.
Until enabled, visual input returns `image_input_unsupported`; it is not silently
removed and does not trigger automatic fallback. Ordinary eligible failures
retain the existing configured fallback policy. Limit errors, including HTTP
413 without a JSON body, remain non-retryable.

Deploy accepting consumers before visual senders. An old consumer must reject
V2 explicitly; do not translate V2 to text to work around that rejection. On
rollback disable visual activation first, drain attempts, then restore consumers.
Do not roll back to a sender that silently discards images without a front guard.
Committed abandoned attempts retain their audit identity. Existing ticket and
budget TTLs, rather than the receipt finalizer, bound their execution and pending
budget; a new physical attempt must have a fresh attempt binding. Tests of these
lifecycle guarantees and a real upstream image check are separate acceptance lanes.

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

| Limit                | Value   |
| -------------------- | ------- |
| maxRequestBodyBytes  | 1048576 |
| maxMessages          | 128     |
| maxToolCalls         | 32      |
| maxOutputTokens      | 16384   |
| maxStreamDurationMs  | 300000  |
| maxDeadlineMs        | 300000  |
| maxConcurrentStreams | 8       |
| maxQueuedRequests    | 16      |
| maxRetriesPerAttempt | 1       |

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

| Sender                         | Authorizer     | Proxy                 | Result within all other limits                                                |
| ------------------------------ | -------------- | --------------------- | ----------------------------------------------------------------------------- |
| Old (at most 32 definitions)   | New            | New                   | Accepted; unchanged hash                                                      |
| New (at most 32 definitions)   | Old            | Old                   | Accepted; unchanged hash                                                      |
| New (more than 32 definitions) | Old            | Any                   | Rejected before issuing the execution ticket                                  |
| New (more than 32 definitions) | New            | Old                   | Authorization can succeed, then the proxy rejects the request                 |
| New (more than 32 definitions) | New            | New                   | Accepted locally; upstream capability is tested separately                    |
| New (more than 32 definitions) | Mixed replicas | Mixed or new replicas | Results can vary by serving replica; readiness of one replica is insufficient |

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

For interactive task tool loops whose provider chain includes Codex, the Host validates selected MCP
arguments before approval and rechecks the live schema immediately before
dispatch. Other provider chains retain server-side argument validation. Missing `$schema` uses JSON Schema 2020-12;
explicit draft-07 and 2019-09 are also supported, including HTTP/HTTPS URI aliases. Unsupported dialects and
unresolved references fail explicitly. Validation never coerces types, applies
defaults, removes arguments, or loads remote references.

This validation applies to the task adapter path, including resolved discovery
calls. Workflow steps that call MCP directly retain their existing server-side
validation. The adapter checks the manager's registered catalog schema; it does
not claim to validate a distinct schema returned only by a per-user OAuth client.

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
Direct is the default when the primary or an allowed fallback uses Codex. It
presents all approved definitions without the search/describe/call discovery bridge,
regardless of the discovery thresholds or legacy dynamic-tools flag.
Explicitly selecting auto uses discovery above the existing
`CLERUM_DYNAMIC_TOOLS_THRESHOLD` (60) or `CODEX_TOOL_DISCOVERY_BYTES`
(32768 serialized MCP definition bytes). These
are optimization thresholds; no tools are discarded from the local registry.
Direct retains all definitions subject to the bounded request contract.
Discovery exposes the stable native set and search/describe/call bridge.
The same presentation is usable across a configured failover chain.

All Codex modes emit the structured `tool-presentation` diagnostic when the
presentation counts change, including the first refresh. It reports the mode,
strategy, native/MCP counts and presented/deferred counts without tool definitions.
Direct mode reports `strategy: direct` and `deferredCount: 0`.

Search results contain bounded compact descriptions and no schemas. Follow
`nextOffset` with the same query/filter to continue; explicit `enumerate`
permits full traversal. Describe returns the exact selected schema, never a
truncated schema. Existing output spillover (enabled by default) handles
large results; transport/context limits still apply and no unbounded-schema
support or measured subscription-quota reduction is claimed.
