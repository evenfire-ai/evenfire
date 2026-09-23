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

Local visual budgets have two layers. The usual product target is 5 MiB decoded
per image, 9 MiB decoded across a request, and a 14 MiB envelope at 2048 pixels
(the official Codex client size, with `detail: high`). The hard ceiling is 20
images, 16 MiB per image and 16 MiB aggregate so a poorly compressed 2048
PNG may exceed 10 MiB; the HTTP envelope stays 24 MiB so that encoded body
still fits. Dimensions above 2048 px are rejected here because the frozen
ChatGPT endpoint 400s them; that is a model/pixel limit, not a byte limit.
For `codex-subscription`, visual input is on by default for every catalog model.
Which non-Codex providers accept images is owned by issue #654 / PR #669
(models.dev). These byte numbers are conservative Evenfire limits, not
upstream facts.
The shared pure validator checks canonical base64, MIME/container framing and
header dimensions; it does not decode pixels or prove image decodability.
The fixtures contain independently decoded 2x2 PNG/JPEG images.

V1 keeps the `maxRequestBodyBytes` request ceiling (8 MiB, #731); its envelope
adds a 16 KiB allowance (`ENVELOPE_ALLOWANCE_BYTES`, exported by both contract
packages and imported by both proxies, the control-api authorizer and the Host
authorizer). V2 has a 24 MiB ceiling for the complete serialized request and
HTTP envelope, including base64, history and the signed execution ticket, with
no allowance on top: the authorize route's JSON parser, the gateway's
`client_max_body_size` and `buildCodexProxyEnvelope` all hold the whole V2
envelope to `maxVisualRequestBodyBytes`. The ticket is about 3.5 KB of it. V2 text, tools and other
non-image fields remain bounded to `maxRequestBodyBytes`, measured with only
image data blanked in a temporary size projection; the actual request and its
hash are not modified. The two caps are not additive: a V2 request carrying a
hard-ceiling image (16 MiB decoded, about 21.3 MiB encoded) has about 2.7 MiB
left for non-image data before the 24 MiB envelope refuses it.
The authorizer builds the exact V2 proxy envelope inside its transaction after
signing but before commit. Exceeding the bound rolls back the new attempt,
ticket and new reservation; it does not call the receipt finalizer before redeem.
The Host uses the same envelope builder. V2 has no outer deadline: its deadline
is `request.deadlineMs`, part of the authorized hash. A proxy configured below
the shared visual envelope budget refuses to start.

Desktop enforces the 16 MiB individual and 16 MiB combined hard attachment
budgets (usual target remains 5 / 9 MiB).
RPC and Host permit a 24 MiB JSON body only on their message POST routes; chat
non-image bytes stay on the 6 MiB share. Non-chat rpc-proxy and Host control
routes keep the 10 MB ordinary JSON cap. The proxy's larger
parser requires a valid platform identity on the visual completion route.
Admin and unauthenticated requests retain the ordinary configured body limit.
`CODEX_LLM_PROXY_MAX_VISUAL_BODY_BYTES` controls the visual transport ceiling;
`CODEX_LLM_PROXY_MAX_BODY_BYTES` continues to control ordinary requests; the
manifest leaves it unset so the proxy derives it from the contract cap plus the
envelope allowance.
The internal authorization gateway also permits 24 MiB only at the exact
`/api/v1/mcp-host/llm/provider-attempts/authorize` POST location. That single
`client_max_body_size` also covers the V1 cap plus the authorize envelope
allowance, which is smaller. Other locations
retain their prior limits, and the Authorization header and method restrictions
are unchanged.

The proxy projects parts to Responses `input_text` and `input_image` items with
an inline data URL. The shape is grounded in the official Codex client
[ContentItem and ImageReference definitions](https://github.com/openai/codex/blob/fc2ea82e7eff22c618a56db29c68a6b1967cba7d/codex-rs/protocol/src/models.rs#L878).
This source evidence is not a successful call to Evenfire's frozen endpoint.

Visual input is on by default for every `codex-subscription` model. Catalog
authorization still decides which model a Host may call; this transport does
not keep a second model-vision allowlist. To stop all Codex traffic, use the
existing kill switches (`MCP_HOST_CODEX_SUBSCRIPTION_ENABLED` and
`CODEX_LLM_PROXY_EXECUTION_ENABLED`). Missing image provenance returns
`image_source_invalid`. Limit errors, including HTTP 413 without a JSON body,
remain non-retryable. Images are never silently stripped and do not trigger
automatic fallback.

Deploy accepting consumers before visual senders. An old consumer must reject
V2 explicitly; do not translate V2 to text to work around that rejection. On
rollback set `CODEX_LLM_PROXY_EXECUTION_ENABLED=false`, drain attempts, then
restore consumers.
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
The value is not a counter the proxy consults; it is a property of the
single-use redeem in control-api, enforced in three layers inside one
transaction: the ticket row is locked and must still be `issued`, the attempt
must still be `authorized`, and the consuming `UPDATE` matches only
`status = 'issued'`. A second redeem of the same ticket fails with
`ticket_replayed` and leaves the ledger unchanged. The real-PostgreSQL tests
`services.llmProviderAttemptRedemption.realPostgres.integration.test.ts`
(sequential replay and 20 concurrent redeems) and
`services.grokProviderAttemptRedemption.refresh.realPostgres.integration.test.ts`
(Grok replay) pin this behaviour.

| Limit                     | Value    |
| ------------------------- | -------- |
| maxRequestBodyBytes       | 8388608  |
| maxVisualRequestBodyBytes | 25165824 |
| maxMessages               | 1024     |
| maxToolCalls              | 256      |
| maxOutputTokens           | 16384    |
| maxStreamDurationMs       | 1800000  |
| maxDeadlineMs             | 1800000  |
| maxConcurrentStreams      | 8        |
| maxQueuedRequests         | 16       |
| maxQueueWaitMs            | 60000    |
| upstreamIdleTimeoutMs     | 300000   |
| maxRetriesPerAttempt      | 1        |
| executionTicketTtlMs      | 60000    |

`maxConcurrentStreams` is 8 slots per proxy process, shared by every Host;
per-Host fairness is tracked in #767.

Tool definitions have no independent count ceiling in the Evenfire request
contract. The entire serialized request, including all definitions, remains
bounded by `maxRequestBodyBytes`. Every definition still undergoes
name, schema, finite-value and unknown-field validation. The limit values live
only in the table above, which the freeze gate checks against the fixture and
the runtime. `maxToolCalls` bounds calls in each assistant history message and each newly returned
response. The proxy buffers tool calls until successful completion and
validates the bound before publishing any executable call; the Host validates
it again before returning the batch. A response over the bound fails with
`tool_call_limit_exceeded`, which is not retried and does not fail over. It is
not a catalog size limit and does not widen execution concurrency.
`maxMessages` bounds the request history. The Host rejects a longer
history with `request_limit_exceeded` before authorization, so no ticket is
minted for it.

The former `maxTools: 32` definition limit was imposed by Evenfire, not a
verified Codex Subscription limit. Remote endpoint limits remain separately
subject to authorized interoperability testing; local acceptance does not
certify that the endpoint accepts any particular count. Discovery optimizes
which schemas are sent, without changing the approved catalog or permissions.
An oversized explicit direct request fails before authorization rather than
silently truncating tools or changing presentation.

`maxRequestBodyBytes` is 8388608 (8 MiB) for every request that carries no
image (#731). It covers a 1M-token window serialized as escaped JSON. The
proxy's body limit is that cap plus a 16 KiB envelope allowance. The
workflow-approval-gateway authorize location sets `client_max_body_size` to
25165824, the visual cap, which is larger and therefore covers it. The proxy
admits bodies against an in-flight byte budget before parsing them.

The Host starts compaction at 80% of the model's context window, so the window
decides how much of that cap a conversation can use. The proxy keeps the
catalog's `context_window` field when it is a positive integer no larger than
2147483647, the ceiling of the Postgres `INTEGER` column
`llm_allowed_models.context_window_tokens`, and omits it otherwise.
`max_context_window` is an opt-in upstream extension and is not read.
control-api stores the value on every catalog sync; a sync whose catalog omits
the field keeps the stored value rather than clearing it. When no window is
stored, the Host uses 256000 for `codex-subscription`. It logs
`context_window_resolved` once per task with the provider, the model, the
window and its source (`catalog` or `default`).

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

### Codex changes shipped with the Grok broker

The Grok subscription broker (see
`docs/architecture/grok-subscription-transport-contract.md`) shares the
contract, authorizer, proxy robustness and recipe-grant code with Codex. The V1
wire and hash projection are unchanged. Operators should know about these Codex
behavior changes:

- **Revoke and reconnect.** Codex connection keys stay reusable after revoke:
  `deployment-default` and named keys can be revoked and then reconnected with
  a new OAuth flow.
  - Revoke also cancels every pending browser and device OAuth state for that
    key, atomically in the same statement.
  - A flow that started before the revoke cannot persist a grant. It fails
    with `state_cancelled`.
  - When two first grants race on the same key, the losing active-key insert
    maps to a stale-revision conflict instead of a 500.
- **Attempt integrity (migration 0114_llm_provider_attempts_connection_integrity).** A constraint trigger requires a
  non-null `llm_provider_attempts.connection_id` of a Codex attempt to exist in
  `codex_subscription_connections`. This replaces the FK that 0112 dropped.
  Historic rows are not revalidated, and the migration is forward-only.
- **Catalog bounds.** Catalog sync stores at most 256 discovered models, each
  with an id of at most 128 characters.
  - Extra entries are dropped with a count-only warning.
  - The catalog record, row mutations and union rebuild commit in one
    transaction.
  - `codex-llm-proxy` admin catalog and connection-test calls have a 15 s
    deadline and an 8 MiB streamed body cap.
- **Request identity.** `mcp-host` hashes with `hashCanonicalCodexRequest(raw)`
  (parse, then hash the canonical value), so empty `generation`, `tools` or
  `transportHints` objects hash the same as on the server. Contract trees are
  capped at a nesting depth of 64. The authorizer rejects deeper bodies with
  `invalid_request`.
- **Terminal outcomes.** Only `success` is a completion. `canceled`, `error`,
  and `unknown` with partial text or tool calls are errors. The proxy maps an
  unrecognized finalize outcome to `unknown`.
- **Proxy robustness.**
  - `codex-llm-proxy` fails at startup when its control-api URL or service
    token is empty.
  - It respects SSE write backpressure.
  - It drops queued stream-gate waiters on abort and checks the abort signal
    before redeeming a ticket. It also rejects an invalid or out-of-bounds
    deadline before the redeem, so the single-use ticket is not consumed.
  - It gives each request one admission clock, stamped at arrival: arrival +
    `maxQueueWaitMs`. The body budget, the visual gate and the stream gate
    all wait against that same instant, so `maxQueueWaitMs` is the total
    time a request may spend queued in the proxy. A waiter still queued when
    it runs out is rejected with `provider_unavailable` (reason
    `body admission wait exceeded` or `stream queue wait exceeded`). Queue
    wait, the 15 s control-api redeem timeout and the first keepalive
    together (60 + 15 + 60 = 135 s) stay below the Host HTTP client's 300 s
    header timeout.
  - The stream-gate wait also ends at the execution ticket's `exp`, with no
    margin. A request still queued then is answered 503
    `provider_unavailable` without a redeem, and the proxy logs
    `codex_proxy_admission_refused` with `reason: ticket_life`,
    `providerAttemptId` and `hostRef`.
  - It requires the redeem response to carry `maxStreamDurationMs` greater
    than 0. An absent value is a contract violation, not a default.
  - It logs one `codex_proxy_attempt_finished` event per completion attempt,
    with identifiers and counts only (never the body, ticket, frames, tool
    names or arguments): `providerAttemptId`, `hostRef`, `model`,
    `requestHash`, `outcome`, `deliveredAs`, `toolCalls`, `textChunks`,
    `heartbeats` and `durationMs`. On a stream that reached the upstream's
    terminal frame,
    `outcome` is `success`, `canceled`, `error` or `unknown`, with
    `deliveredAs: 'sse_done'` and `usage` when present. On a thrown failure,
    `outcome` is `failed` and the event adds `code`, the transport `reason`,
    `details` (for example `{limit, observed}` on
    `tool_call_limit_exceeded`) and `deliveredAs`: `http_status` with
    `httpStatus` when no SSE byte had been sent, or `sse_error` when the
    failure went out as an SSE error frame.
  - Once the redeem succeeds, the proxy writes a `: keepalive` SSE comment
    every `CODEX_LLM_PROXY_HEARTBEAT_INTERVAL_MS` (default 15000, at most 60000) until the
    response ends. A larger value stops the proxy at startup instead of
    being lowered. The comments keep the Host's HTTP client, whose headers
    and body timeouts are 300 s, from cutting an attempt while the upstream
    is silent (reasoning, or tool calls buffered until the stream completes).
    SSE readers, including `mcp-host`, ignore comment lines. `heartbeats`
    counts the comments sent. A keepalive counts as a sent SSE byte, so a
    failure after the first one is delivered as `sse_error`, not
    `http_status`. A redeem denial is always `http_status`, because no
    keepalive is written before the redeem succeeds.
  - Do not confuse the two `outcome` fields. The finalize receipt sent to
    control-api keeps `success | canceled | error | unknown`. Only the
    `codex_proxy_attempt_finished` log line adds `failed`.
  - It counts failed attempts in `codex_proxy_attempt_failures_total{code}`.
    A request the proxy refuses on its own request limits (stream queue full,
    queue wait exceeded, invalid deadline) reaches the Host as
    `provider_unavailable`. The metric labels it `request_limit` to keep it
    apart from upstream outages, and the log line carries the limit's fixed
    `reason`.
- **Live-target attestation.** Codex authorize attests the live Host or recipe
  target. The allowed providers come only from the spec's model, allowed
  models and fallbacks (Hosts) or agent providers (recipes). A target that
  reached Codex only through a grant annotation or `connectionRef` now gets
  `host_binding_mismatch`.
- **Recipe grant annotations.** control-api now writes both
  `codex-connection-ref` and `subscription-connection-ref` for Codex recipes.
  It rejects explicit disagreeing pairs with 422
  `subscriptionAnnotationsDisagree`. Broker changes that omit the annotations
  return 422 `providerChangeRequiresGrant`.
- **Rollout.** Roll out control-api first, and wait until every pod runs the
  new image. An older control-api rejects the entire workflow-control token
  issue when HCC or WRC request the unknown `llm:grok:execute` scope.
- **Rollback.** Turn the Grok flags off and wait for HCC and WRC to drop
  `llm:grok:execute` before rolling back control-api. While an older
  control-api serves, a reassigned Codex recipe grant updates only
  `codex-connection-ref`. The new WRC then reads the disagreeing pair as
  `unassigned`. After rolling forward again, re-assign those Codex recipe
  grants with explicit annotations.

## Errors

Stable codes: `insufficient_scope`, `no_grant`, `model_not_allowed`,
`budget_denied`, `connection_unavailable`, `provider_unavailable`,
`origin_denied`, `ticket_invalid`, `ticket_replayed`, `request_hash_mismatch`,
`invalid_request`, `tool_call_limit_exceeded`, `sse_buffer_exceeded`,
`stream_duration_exceeded`, `context_length_exceeded`, `invalid_tool_arguments`,
`payload_too_large`, `request_timeout`, `length_required`, `ticket_expired`,
`unsupported_media_type`, `unknown_field`, `host_binding_mismatch`, `disabled`,
`Unauthorized`, `not_found`, `internal_error`. The freeze gate checks that every
code the proxy constructs, and every code it refuses a request with
(`reject(res, <status>, <code>)`), is in the fixture's `errorTaxonomy`.

- `request_timeout`: HTTP 408. A body granted admission was not read and
  parsed within the proxy's read deadline; the upstream never saw it.
- `length_required`: HTTP 411. The request carried `Transfer-Encoding` instead
  of a `Content-Length`, so its size cannot be admitted before reading.
- `unsupported_media_type`: HTTP 415. The body is not `application/json`, or it
  carries a `Content-Encoding` (the parsers never inflate).
- `length_required` and `unsupported_media_type` stay in the Host's generic
  non-retryable bucket (`LLM_API_CALL_FAILED`): the Host sends a string body,
  so its client always sets `Content-Length`, never sets `Content-Encoding` and
  always sends `application/json`. Either code means a caller other than the
  Host, or a Host defect, and retrying the same request cannot succeed.
- `ticket_expired`: HTTP 403. The execution ticket outlived
  `executionTicketTtlMs`. The proxy answers it directly when the ticket's
  signature, audience, issuer and claims are valid and only `exp` has passed,
  which body admission's wait can cause; it also passes the code through when
  control-api refuses the redeem for the same reason. Every other ticket
  failure is `ticket_invalid`. The Host retries it with a fresh authorization.
- `unknown_field`: HTTP 400. The completion or admin body carries a top-level
  field outside the schema.
- `host_binding_mismatch`: HTTP 403. The execution ticket is bound to a Host
  the caller's platform JWT does not name.
- `disabled`: HTTP 404. The execution kill switch is off.
- `Unauthorized`: HTTP 401. The platform JWT is missing or invalid.
- `not_found`: HTTP 404. Unknown route on the runtime, admin or probe listener.
- `internal_error`: HTTP 500. An unhandled error in the request pipeline.

- `context_length_exceeded`: the upstream refused the request because it
  exceeds the model's context window. The upstream sends an SSE `error` event
  (`error.code`) and a `response.failed` event (`response.error.code`) with
  this code; the proxy forwards it as HTTP 400, or as an SSE error frame when
  text had already been streamed. The same `error.code` in the JSON body of a
  non-success HTTP reply other than 401/403 is mapped the same way; the proxy
  reads at most `UPSTREAM_ERROR_BODY_MAX_BYTES` (16 KiB) of that body and
  otherwise keeps the status mapping (400 `invalid_request`, 401/403
  `connection_unavailable`, any other `provider_unavailable`). It is the only
  upstream code the proxy forwards: a streamed failure with any other upstream
  code, or none, stays `provider_unavailable`. The Host maps it to
  `LLM_CONTEXT_LENGTH_EXCEEDED`,
  not retryable, like `request_limit_exceeded`.

- `invalid_request`: the request body failed the transport schema (HTTP 400
  before redeem), or the upstream answered the completion with HTTP 400.
- `sse_buffer_exceeded`: the upstream sent more than 1 MiB without the blank
  line that ends an SSE event.
- `stream_duration_exceeded`: the attempt reached `maxStreamDurationMs` (the
  total cap, bounded again by the ticket's deadline). The proxy cancels the
  upstream body and returns HTTP 504, or an SSE error frame when text had
  already been streamed. The Host maps it to `LLM_STREAM_DURATION_EXCEEDED`.
  It is not retryable and not failover-eligible: another attempt would spend
  the same budget on the same turn. The 1800000 ms value is a policy choice,
  not an upstream limit: the upstream publishes no maximum stream length.
  Observed durations are recorded in
  `codex_llm_proxy_stream_duration_seconds` (buckets up to 1800 s), which is
  the data the cap should be revisited with.
- Idle timeout: when the upstream sends no byte for `upstreamIdleTimeoutMs`
  (the Codex CLI default `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000`,
  openai/codex `codex-rs/model-provider-info/src/lib.rs:63` at 6824dabe0),
  the proxy cancels the upstream body and fails the attempt with
  `provider_unavailable` (HTTP 503, reason `upstream stream idle timeout`).
  That code stays retryable and failover-eligible, because a silent upstream
  is an outage of that provider, not a property of the turn.
  `CODEX_LLM_PROXY_UPSTREAM_IDLE_TIMEOUT_MS` can lower the idle timeout; the
  transport never raises it above the table value. Both cuts are counted in
  `codex_proxy_upstream_timeouts_total{kind="idle"|"total"}`.
- `tool_call_limit_exceeded`: the upstream response carried more than
  `maxToolCalls` tool calls. The proxy returns HTTP 422, or an SSE error frame
  when text had already been streamed. The Host maps it to
  `LLM_TOOL_CALL_LIMIT_EXCEEDED`. It is not retryable and not
  failover-eligible (failover class `null`), so the task fails with that code
  instead of `LLM_MODEL_OVERLOADED`.
- `invalid_tool_arguments`: a tool call's `arguments` are not a JSON object —
  truncated JSON or a non-object value. The transport refuses the whole
  response instead of running the tool with `{}`, both when the call is closed
  by `response.output_item.done` / `response.function_call_arguments.done` and
  when a pending call is flushed at `response.completed`. Empty or
  whitespace-only `arguments` on a call closed by one of those two events are
  a call without parameters and reach the Host as `{}`; the Host still
  validates `{}` against the tool's schema. A closing event with empty
  `arguments` never replaces what the deltas already delivered, so truncated
  deltas stay refused. Empty `arguments` on a call that was never closed,
  flushed at `response.completed`, are refused like truncated JSON. A stream
  that was canceled or that the upstream failed keeps its own outcome (`canceled`,
  `context_length_exceeded` or `provider_unavailable`), because its open call
  is truncated as a consequence. A stream that ends with no terminal event
  keeps the outcome `unknown`: its open calls keep the name and count checks,
  their arguments are not parsed, and none is delivered. Delivered like
  `tool_call_limit_exceeded` — 422 carrying the code, or an SSE error frame
  once text is on the wire. The Host maps it to `LLM_INVALID_RESPONSE`, not
  retryable, failover class `null`.
- `request_limit_exceeded` (Host-side only): the turn carries too much. The
  Host raises it before authorization — so no provider attempt is spent — and
  maps it to `LLM_CONTEXT_LENGTH_EXCEEDED`, not retryable, which the UI shows
  as "Conversation Too Long".

  Five of the contract's `limit` refusals mean this. The Host classifies on
  the refusal message: `hashCanonicalCodexRequest` returns
  `{ ok, code, message, kind }`, but `kind` cannot tell them apart from the
  image budgets, because `size` covers the conversation bytes and the image
  byte and dimension budgets alike, and `count` covers `maxMessages` and
  `maxImages` alike.

  | Refusal message                                          | Guard                             |
  | -------------------------------------------------------- | --------------------------------- |
  | `request exceeds maxRequestBodyBytes`                    | serialized UTF-8 byte cap         |
  | `request exceeds maxRequestBodyBytes outside image data` | non-image share of a V2 request   |
  | `request exceeds maxRequestBodyBytes element bound`      | element count in `checkStructure` |
  | `messages exceed <maxMessages>`                          | message count                     |
  | `messages[i].toolCalls exceed <maxToolCalls>`            | tool calls on one message         |

  All five mean the conversation is too long, but compaction does not reach
  them equally. The Host's context manager counts the serialized bytes and,
  for this provider, the message count against the contract's `maxMessages`,
  so it compacts before either bound. A single turn holding more than
  `maxMessages` messages stays unshrinkable, because the cut never lands
  inside a turn. `maxToolCalls` also bounds every response, so only history
  produced by another provider can carry an over-long `toolCalls` array.

  The element bound is named distinctly
  from the byte cap so that a user report can tell which guard fired, not
  because it is fixed differently: every element serializes to at least one
  byte, so a request of plain JSON data with more elements than the byte cap
  cannot fit under the byte cap either, and for such a request an
  element-bound refusal is always also a byte-bound one. A value that
  `JSON.stringify` drops (a function, a symbol) is still counted, so for other
  input the element bound can only refuse earlier.

  The byte cap covers the whole request, tool definitions included. A tool
  catalog that alone exceeds it is refused with the same message and labelled
  context length, although compaction shrinks only the conversation and cannot
  bring that request under the cap.

  The contract's remaining `limit` refusals — nesting depth,
  `generation.maxOutputTokens` and `deadlineMs` out of range, and more than
  `maxImages` images — stay `invalid_request`: a shorter conversation fixes
  none of them, and labelling them a context-length failure would invite a
  compaction loop that cannot converge.

- `payload_too_large`: an envelope over a body limit, one hop after the Host's
  own check. The authorize hop raises it for every HTTP 413, whether
  control-api answered `payload_too_large` or the workflow-approval gateway's
  `client_max_body_size`, in front of control-api, answered with no JSON error
  code (`ProviderAttemptAuthorizer`). The Host's own whole-body check before
  authorize raises it too, and so does the proxy's 413. A V2 request whose
  text alone crosses `maxVisualRequestBodyBytes` is refused locally with it as
  well, because no attachment caused that refusal. The Host maps it to
  `LLM_CONTEXT_LENGTH_EXCEEDED`, not retryable. No provider attempt is spent
  when authorize refused it.
- `attachment_too_large` (Host-side only): an attached image broke one of the
  contract's image budgets. The Host raises it before authorization and maps
  it to `LLM_INVALID_ATTACHMENT`, not retryable and not failover-eligible,
  which the UI shows as "Invalid Attachment". Compaction cannot shrink an
  image, so this is never labelled a context-length failure. The message is
  the sentence the Desktop shows in the error bubble, and it names the limit,
  taken from `VISUAL_LIMITS` and `LIMITS`:

  | Refusal message                                          | Budget                       | User message names            |
  | -------------------------------------------------------- | ---------------------------- | ----------------------------- |
  | `…: image exceeds <maxImageBytes> decoded bytes`         | one image's decoded bytes    | the per-image size in MiB     |
  | `…: image dimension exceeds <maxImageDimension>`         | one image's width or height  | the dimension in pixels       |
  | `…: image pixel count exceeds <maxImagePixels>`          | one image's pixel count      | the pixel count               |
  | `request exceeds <maxTotalImageBytes> total image bytes` | all images together          | the total size in MiB         |
  | `request exceeds maxVisualRequestBodyBytes`              | V2 whole body, with an image | the whole-body ceiling in MiB |

  The pixel refusal is unreachable with today's limits: `maxImagePixels` is
  `maxImageDimension` squared and the dimension check runs first. The
  whole-body row applies only when the request carries an image; without one
  the refusal is `payload_too_large` above.

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
