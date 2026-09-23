# Grok subscription transport contract

Starting freeze: `grok-subscription-transport.v1`.

This is the Phase 0 architecture freeze for provider `grok-subscription`.

## Probe gate

The following facts are a starting freeze taken from Grok Build docs and
third-party probes. No live SuperGrok probe has confirmed them yet:

- the catalog origin,
- the CLI identity headers,
- the numeric limits,
- the public CLI `client_id`,
- the OAuth scope list,
- whether the upstream accepts `temperature`.

Rule: before the production flag flip, commit a redacted probe record beside
this document. Regenerate the sanitized fixture
(`tests/e2e/fixtures/grok-subscription/sanitized-upstream-contract.json`) from
that record. The freeze test must assert that the fixture matches the enforced
origin-policy constants. A recorded `GROK_REAL_UPSTREAM_CONFIRM=1` run must also
exist.

A live probe may tighten this allowlist but must never widen it. If the probe
finds a different catalog endpoint, or no list API at all, the origin may be
replaced once. After that, it cannot be widened. Until the probe record exists,
the fixture's `approvedTestAccountFingerprint` stays
`redacted:grok-subscription-pending-live-confirm`.

## Ownership

- Control API is the only OAuth custodian.
- `mcp-host` authorizes each physical attempt and streams to `grok-llm-proxy`.
- `grok-llm-proxy` redeems a single-use ticket, holds the access token in
  operation memory only, and talks to the frozen HTTPS origins below.
- The LLM stream never transits Control API or its gateways.
- Traffic never enters `codex-llm-proxy` or `https://api.x.ai`.

## Origins

Exact HTTPS origins (no caller-supplied URL):

- Device authorization: `https://auth.x.ai/oauth2/device/code`
- Token: `https://auth.x.ai/oauth2/token`
- Revoke: `https://auth.x.ai/oauth2/revoke`
- Device verification page (user-facing, returned by the device endpoint; confirmed by live probe 2026-09-18): `https://accounts.x.ai/oauth2/device`. Control API and Control UI accept only the exact hosts `auth.x.ai` and `accounts.x.ai` over HTTPS.
- Completions: `https://cli-chat-proxy.grok.com/v1/responses`
- Catalog (starting candidate): `https://cli-chat-proxy.grok.com/v1/models`

Forbidden: `https://api.x.ai`, HTTP, loopback, link-local, metadata.

Redirects: at most one, HTTPS, same origin and same path and same query.
OAuth `device/code`, `token` and `revoke` use `redirect: 'manual'`; any 3xx is
an error.

## OAuth

- `client_id`: `b1a00492-073a-47ea-816f-4c329264a828`. This is the public
  Grok CLI registration, not a secret. `CONTROL_API_GROK_OAUTH_CLIENT_ID` may
  override it, but only to pin a documented registration.
- Grant: `urn:ietf:params:oauth:grant-type:device_code`.
- Scopes (`GROK_OAUTH_SCOPES` in
  `control-api/src/services/grokSubscriptionOAuth.ts`): `openid`, `profile`,
  `email`, `offline_access`, `grok-cli:access`, `api:access`,
  `conversations:read`, `conversations:write`.
  - This list is **pending the live probe trim**. `api:access` and
    `conversations:read/write` are broader than inference needs: a leaked
    access token could read or write Grok conversations. The probe must record
    the minimum set the CLI proxy accepts, and the list must shrink to that
    set before the production flag flip.
- The refresh token rotates on every refresh. The new ciphertext is persisted
  before any fallible post-processing.
- Revoke revokes the refresh token upstream. Access tokens that were already
  issued stay valid until they expire (at most one access-token lifetime).

## Connection lifecycle

- **Grok connection keys are terminal after revoke (migration 0113_grok_subscription_terminal_connection_key).**
  - A revoked key cannot be reconnected. Create a new connection key instead.
  - A device flow that started before the revoke cannot revive the key: it
    fails with `revoked grant cannot be reused`.
  - 0113 archives superseded revoked rows for the same key as
    `<key>~revoked~<id>`. It also cancels pending OAuth states for revoked
    keys and replaces the partial active-key index with a unique index on
    `connection_key`.
  - Archived `~revoked~` rows fall outside the key grammar. Admin list and GET
    hide them. The key's own terminal tombstone stays listed as `revoked`.
- **Attempt integrity (migration 0114_llm_provider_attempts_connection_integrity).** A constraint trigger on
  `llm_provider_attempts` INSERT, and on UPDATE of `provider` or
  `connection_id`, requires a non-null `connection_id` to exist in the
  provider's own connection table:
  - `grok-subscription` → `grok_subscription_connections`
  - `codex-subscription` → `codex_subscription_connections`

  This replaces the FK that 0112 dropped, so it covers Codex too. It does not
  revalidate historic rows: the migration logs only a count of dangling rows.
- Catalog sync stores at most 256 discovered models, each with an id of at most
  128 characters. Extra entries are dropped with a structured count-only
  warning. The catalog record, row mutations and union rebuild commit in one
  transaction.

## Ticket

- `typ`: `grok-execution-ticket`
- `aud`: `grok-llm-proxy`
- Admin permit `typ`/`aud`: `grok-admin-permit` / `grok-llm-proxy-admin`

## Request identity

- `mcp-host` hashes the request with `hashCanonicalGrokRequest(raw)` from
  `@clerum/grok-provider-attempt-contract`. This function parses the request
  first and then hashes the parsed canonical value, so empty `generation: {}`,
  `tools: []` or `transportHints: {}` hash the same on the client and the
  server. Codex uses the twin `hashCanonicalCodexRequest`.
- Contract trees are capped at a nesting depth of 64 (`fail('limit')`). The
  control-api authorizer rejects deeper bodies with `invalid_request` before it
  calls `JSON.stringify`.

## Limits

Owned by `@clerum/grok-provider-attempt-contract`, a separate module from Codex
`LIMITS` but carrying the same values: `maxToolCalls` 256 and `maxMessages`
1024. `maxToolCalls` bounds the `toolCalls` array of a single assistant
message, not the conversation, and the 1:4 spread between the two numbers is a
design choice rather than an arithmetic requirement: a turn of N calls adds
N+1 messages, so a full 256-call turn occupies 257 of the 1024 message slots.
`maxRequestBodyBytes` is 8388608 (8 MiB) for every request that carries no
image, as for Codex (#731). It covers a 1M-token window serialized as escaped
JSON. The proxy's body limit is that cap plus a 16 KiB envelope allowance,
and the proxy admits bodies against an in-flight byte budget before parsing
them.

| Limit                 | Value   |
| --------------------- | ------- |
| maxRequestBodyBytes   | 8388608 |
| maxMessages           | 1024    |
| maxToolCalls          | 256     |
| maxOutputTokens       | 16384   |
| maxStreamDurationMs   | 1800000 |
| maxDeadlineMs         | 1800000 |
| maxConcurrentStreams  | 8       |
| maxQueuedRequests     | 16      |
| maxQueueWaitMs        | 60000   |
| upstreamIdleTimeoutMs | 600000  |
| maxRetriesPerAttempt  | 1       |
| executionTicketTtlMs  | 60000   |

The limit values live only in the table above, which
`grok-llm-proxy/test/contractFreeze.test.ts` checks against the fixture; the
same suite pins the fixture to the contract `LIMITS` and the proxy
`STREAM_LIMITS`.

All three enforcement points read this module — the control-api authorizer,
`grok-llm-proxy` and the Host — so a deployment that mixes versions rejects
requests that fall between the old and the new bounds. Which code the caller
sees depends on where the rejection happens: the control-api authorizer and
the proxy both surface the contract parser's failure as `invalid_request`,
while the Host raises `request_limit_exceeded` before it authorizes at all —
for the four size refusals listed under that code below, and `invalid_request`
for the other four, which no amount of compaction would fix.

That symmetry holds for a request and not for a response, which is why the
rollout order below is not interchangeable. A proxy carrying the new bound in
front of a Host still carrying the old one delivers a response in the band
between them — 65 to 256 tool calls — as `outcome: 'success'`, and
`ingestGrokFinalizeLedgerRow` bills it, because it records usage for exactly
that outcome. The old Host then refuses the same response as
`provider_unavailable`, which it maps to `LLM_MODEL_OVERLOADED` with
`retryable: true`. That classification is failover-eligible, so an `llmPolicy`
fallback switches providers and puts the primary in a 300 s cooldown, and the
calls are never executed: the terminal-outcome assertion throws before the
turn returns them. With no fallback configured the same retryable error
reaches the tool-loop recovery path and can become a synthesized answer. The
upstream call is paid for in every one of those endings.

The opposite order has no such hole. A Host on the new bound in front of a
proxy on the old one sees the proxy refuse the band itself, exactly as it does
today, and the attempt finalizes as an error rather than as billed success. A
proxy cannot close this by holding the old bound until the Hosts catch up,
because the contract package carries no version identity a caller could
present: the proxy has no way to tell which bound the Host on the other end
was built with.

The context window follows the same rules as Codex. The proxy keeps the
catalog's `context_window` field, the name the Grok CLI model cache uses, when
it is a positive integer no larger than 2147483647 (the Postgres `INTEGER`
ceiling of `llm_allowed_models.context_window_tokens`), and omits it
otherwise. control-api stores it on every catalog sync and keeps the stored
value when a later catalog omits the field. When no window is stored, the Host
uses 256000 for `grok-subscription` and logs `context_window_resolved` once per
task with the window and its source (`catalog` or `default`).

Proxy robustness (both proxies):

- Admin catalog and connection-test upstream calls have a 15 s deadline that
  covers headers and body, and a streamed body cap: 1 MiB for Grok, 8 MiB for
  Codex. Normalized models are capped at 256, and each id at 128 characters,
  matching control-api.
- The SSE writer respects `res.write` backpressure: it waits for `drain` and
  stops waiting if the client closes.
- Queued stream-gate waiters stop when the request aborts, and the proxy
  checks the abort signal before redeeming a ticket. It also rejects an
  invalid or out-of-bounds deadline before the redeem, so the single-use
  ticket is not consumed.
- Each request gets one admission clock, stamped at arrival: arrival +
  `maxQueueWaitMs`. The body budget and the stream gate both wait against
  that same instant, so `maxQueueWaitMs` is the total time a request may
  spend queued in the proxy. A waiter still queued when it runs out is
  rejected with `provider_unavailable` (reason `body admission wait exceeded`
  or `stream queue wait exceeded`). Queue wait, the 15 s control-api redeem
  timeout and the first keepalive together (60 + 15 + 60 = 135 s) stay below
  the Host HTTP client's 300 s header timeout.
- The stream-gate wait also ends at the execution ticket's `exp`, with no
  margin. A request still queued then is answered 503 `provider_unavailable`
  without a redeem, and the proxy logs `grok_proxy_admission_refused` with
  `reason: ticket_life`, `providerAttemptId` and `hostRef`.
- A single attempt streams for at most `maxStreamDurationMs`: the minimum of the proxy configuration, `STREAM_LIMITS`, the contract
  `maxDeadlineMs` and the value control-api returns on redeem.
- The proxy fails at startup when `GROK_LLM_PROXY_CONTROL_API_URL` or
  `GROK_LLM_PROXY_CONTROL_API_TOKEN` is empty.
- An unrecognized finalize outcome maps to `unknown`, never `success`.
  The redeem response must carry `maxStreamDurationMs` greater than 0; an
  absent value is a contract violation, not a default.

## Identity headers

Stamped in `grok-llm-proxy`, never taken from mcp-host or the hashed request:

- `user-agent: evenfire-grok-subscription grok-build/<clientVersion>`
- `x-grok-client-version: <clientVersion>` — default `1.0.34`, overridden with
  `GROK_LLM_PROXY_CLIENT_VERSION`; a malformed override falls back to the pinned
  default rather than sending a value xAI would refuse
- `x-grok-client-identifier: evenfire`
- `x-grok-client-mode: headless`
- `x-xai-token-auth: xai-grok-cli` — the token TYPE designator for an OAuth
  session token, not a claim to be the CLI
- `accept: text/event-stream` on stream

**Probe record (2026-09-18, local minikube against live SuperGrok).** With only
`user-agent: evenfire-grok-subscription` and no version, `POST /v1/responses`
returned `426` with `{"error":"Your Grok CLI version (none) is outdated. Please
update to version 0.1.202 or later …"}`, while `GET /v1/models` succeeded and
synced a catalog. So xAI gates inference on a client version. Evenfire sends
that version but keeps its own identity: never `grok-shell`,
`xai-grok-workspace`, or any other CLI-owned identifier — the same rule the
Codex adapter follows with `originator: evenfire`
(`codex-llm-proxy/src/chatgptUpstreamHeaders.ts`). This is not an
xAI-sanctioned integration; the sanctioned automation path is an xAI API key
(the separate metered `xai` provider). Prod enablement still needs the D15
human ToS sign-off, and the Control UI connect copy discloses it.

**When xAI raises the floor**, the proxy returns `426` →
`client_upgrade_required` (non-retryable, one clean failure, no retry storm).
Fix it by setting `GROK_LLM_PROXY_CLIENT_VERSION` to a current published
`@xai-official/grok` release; no code release is required.

Do not send `OpenAI-Beta` or `service_tier`.

`max_output_tokens` is bindable on this wire and is sent.

`temperature` is **withheld upstream** while
`GROK_UPSTREAM_TEMPERATURE_PROBE_CONFIRMED` (in
`grok-llm-proxy/src/grokTransport.ts`) is `false`. The Codex Responses wire
rejects sampling fields, and no live probe has shown that Grok accepts them.
`generation.temperature` still counts toward the authorize hash. Set the
constant to `true` only with recorded live-probe evidence.

Tool payloads send `strict: false` so optional MCP fields stay optional on the
Responses-shaped Grok wire (sibling of Codex #648). Agent tool presentation
uses the same `CODEX_TOOL_PRESENTATION` knob as Codex and defaults to `direct`
when Grok is the primary or a fallback (sibling of Codex #644).

## Terminal outcomes

For both providers, a stream counts as a completion only when it ends with
`success`. `mcp-host` reports these outcomes as errors, never as a completion:

- `canceled`,
- `error`,
- `unknown` with partial text or tool calls.

## Errors

Stable codes: `insufficient_scope`, `no_grant`, `model_not_allowed`,
`budget_denied` (Host-side only), `connection_unavailable`,
`provider_unavailable`, `origin_denied`, `ticket_invalid`, `ticket_replayed`,
`request_hash_mismatch`, `client_upgrade_required`, `tool_call_limit_exceeded`,
`tool_call_arguments_exceeded`, `invalid_tool_arguments`, `invalid_request`,
`sse_buffer_exceeded`, `stream_duration_exceeded`, `payload_too_large`,
`context_length_exceeded`, `request_limit_exceeded` (Host-side only),
`request_timeout`, `length_required`, `ticket_expired`,
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
- `ticket_expired`: HTTP 403. control-api refused the redeem because the
  execution ticket outlived `executionTicketTtlMs`; the proxy passes the code
  through.
- `unknown_field`: HTTP 400. The completion or admin body carries a top-level
  field outside the schema.
- `host_binding_mismatch`: HTTP 403. The execution ticket is bound to a Host
  the caller's platform JWT does not name.
- `disabled`: HTTP 404. The execution kill switch is off.
- `Unauthorized`: HTTP 401. The platform JWT is missing or invalid.
- `not_found`: HTTP 404. Unknown route on the runtime, admin or probe listener.
- `internal_error`: HTTP 500. An unhandled error in the request pipeline.

- `invalid_request`: the request body failed the transport schema (HTTP 400
  before redeem), or the upstream answered the completion with HTTP 400.
- `sse_buffer_exceeded`: the upstream sent more than 1 MiB without the blank
  line that ends an SSE event.
- `stream_duration_exceeded`: the attempt reached `maxStreamDurationMs` (the
  total cap, bounded again by the ticket's deadline). The proxy cancels the
  upstream body and returns HTTP 504, or an SSE error frame when text had
  already been streamed. The Host maps it to `LLM_STREAM_DURATION_EXCEEDED`.
  It is not retryable and not failover-eligible: another attempt would spend
  the same budget on the same turn.
- Idle timeout: when the upstream sends no byte for `upstreamIdleTimeoutMs`
  (the value read from the Grok Build client source), the proxy cancels the upstream
  body and fails the attempt with `provider_unavailable` (HTTP 503, reason
  `upstream stream idle timeout`). That code stays retryable and
  failover-eligible, because a silent upstream is an outage of that provider,
  not a property of the turn. `GROK_LLM_PROXY_UPSTREAM_IDLE_TIMEOUT_MS` can
  lower the idle timeout; the transport never raises it above the contract
  value. Both cuts are counted in
  `grok_proxy_upstream_timeouts_total{kind="idle"|"total"}`.
- Keepalive: once the redeem succeeds, the proxy writes a `: keepalive` SSE
  comment every `GROK_LLM_PROXY_HEARTBEAT_INTERVAL_MS` (default 15000, at most 60000) until
  the response ends. A larger value stops the proxy at startup instead of
  being lowered. The comments keep the Host's HTTP client, whose headers
  and body timeouts are 300 s, from cutting an attempt while the upstream is
  silent (reasoning, or tool calls buffered until the stream completes). SSE
  readers, including `mcp-host`, ignore comment lines. The
  `grok_proxy_attempt_finished` log line counts them in `heartbeats`. A
  keepalive counts as a sent SSE byte, so every failure after the first one is
  delivered as an SSE error frame instead of an HTTP status. A redeem denial
  always keeps its HTTP status, because no keepalive is written before the
  redeem succeeds.
- `tool_call_limit_exceeded`: the upstream response carried more than
  `maxToolCalls` tool calls. The proxy returns HTTP 422 whose body is the code
  alone — `{"error":"tool_call_limit_exceeded"}` — or an SSE error frame when
  text had already been streamed; the branch is decided by whether a frame
  reached the wire, since tool-call frames are buffered until the stream
  completes. `limit` and `observed` are recorded in the
  `grok_proxy_attempt_finished` log line and are not sent to the caller. The
  Host maps the code to `LLM_TOOL_CALL_LIMIT_EXCEEDED`. It is not retryable and
  not failover-eligible (failover class `null`), so the task fails with that
  code instead of `LLM_MODEL_OVERLOADED`.
- `tool_call_arguments_exceeded`: the `arguments` text retained across one
  response's pending tool calls crossed `MAX_TOOL_CALL_ARGUMENT_BYTES`
  (`grok-llm-proxy/src/grokTransport.ts`, equal to `maxRequestBodyBytes`,
  8 MiB, counted in UTF-8 bytes). `maxToolCalls` bounds how
  many calls a response may carry, never how large each one is, and the SSE
  buffer guard cannot see this: it bounds the unparsed tail between two `\n\n`
  boundaries and is reset on every read. Delivered like
  `tool_call_limit_exceeded` — 422 carrying the code, or an SSE error frame
  once text is on the wire — and mapped by the Host to
  `LLM_CONTEXT_LENGTH_EXCEEDED`, not retryable, failover class `null`, the same
  family as `request_limit_exceeded` seen from the response side. Because the
  proxy body carries only the code, the Host turns it into guidance for
  whoever composes the next turn (`grokProxyErrorMessage`): send a more bounded
  request — fewer items per call, narrower fields, or the work split across
  several smaller calls. The bound and that wording are interim: the #731
  request-size work classifies this refusal as context length (above) and
  leaves the bound's value and the wording as they are.
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
  that was
  canceled or that the upstream failed keeps its own outcome (`canceled`,
  `provider_unavailable`), because its open call is truncated as a
  consequence. Delivered like `tool_call_limit_exceeded` — 422 carrying the
  code, or an SSE error frame once text is on the wire. The Host maps it to
  `LLM_INVALID_RESPONSE`, not retryable, failover class `null`.
- `request_limit_exceeded` (Host-side only): the turn carries too much. The
  Host raises it before authorization — so no provider attempt is spent — and
  maps it to `LLM_CONTEXT_LENGTH_EXCEEDED`, not retryable, which the UI shows
  as "Conversation Too Long". The upstream's own context-window refusal is
  `context_length_exceeded`, below.

  Four of the contract's `limit` refusals mean this, and the Host classifies on
  the refusal message because `hashCanonicalGrokRequest` returns
  `{ ok, code, message }` and nothing else:

  | Refusal message                                     | Guard                             |
  | --------------------------------------------------- | --------------------------------- |
  | `request exceeds maxRequestBodyBytes`               | serialized UTF-8 byte cap         |
  | `request exceeds maxRequestBodyBytes element bound` | element count in `checkStructure` |
  | `messages exceed <maxMessages>`                     | message count                     |
  | `messages[i].toolCalls exceed <maxToolCalls>`       | tool calls on one message         |

  All four mean the conversation is too long, but compaction does not reach
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

  The message count is refused by the Host's own guard before the canonical
  hash runs; the other three reach this classification through the hash. Until
  #731 the hash path reported them as `invalid_request`, which the UI rendered
  as a retryable "Connection Error" and which invited the retry that reproduced
  the refusal.

  The contract's remaining `limit` refusals — nesting depth,
  `generation.maxOutputTokens` and `deadlineMs` out of range — stay
  `invalid_request`: a shorter conversation fixes none of them, and labelling
  them a context-length failure would invite a compaction loop that cannot
  converge.

- `payload_too_large`: an envelope over a body limit, one hop after the Host's
  own check. The authorize hop raises it for every HTTP 413, whether
  control-api answered `payload_too_large` or the workflow-approval gateway's
  `client_max_body_size`, in front of control-api, answered with no JSON error
  code (`ProviderAttemptAuthorizer`). The Host's own whole-body check before
  authorize raises it too, and so does the proxy's 413, with or without a
  JSON body. The Host maps it to `LLM_CONTEXT_LENGTH_EXCEEDED`, not
  retryable. No provider attempt is spent when authorize refused it.
- `context_length_exceeded`: the upstream refused a prompt over the model's
  context window. Recorded on 2026-09-23 against `/v1/responses` with
  `grok-4.6`, the refusal is an HTTP 400 before any stream starts, with the
  body `{"code":"invalid-argument","error":"Failed to start sampling:
  [input_too_large] The prompt is too long for this model's context window
  (<n> tokens > <window> tokens)"}`. The `code` field is generic, so the
  transport keys on the `[input_too_large]` marker inside the `error` string.
  It reads a non-success body once, up to 16 KiB, for both the log hint and
  the marker; a 401, a body past the bound, and any other body keep the
  status mapping (`invalid_request` for 400). The proxy answers HTTP 400
  `{"error":"context_length_exceeded"}`, and the Host maps it to
  `LLM_CONTEXT_LENGTH_EXCEEDED`, not retryable, failover class `null`. The
  provider attempt was spent: the upstream received the request.

`grok_proxy_attempt_failures_total{code}` counts failed attempts. Its label
allowlist is `ATTEMPT_ERROR_STATUS` in `grok-llm-proxy/src/server.ts` — the
same table that maps a code to its HTTP status — not the list above. The two
differ: the table also carries two control-api codes the list does not publish
(`invalid_receipt`, `conflict`), and it leaves out the two Host-side codes above
and the proxy's own request refusals (`payload_too_large`, `length_required`,
`unsupported_media_type`, `unknown_field`, `not_found`, `internal_error`).
Anything outside the table is recorded as `other`, because a control-api error
body is not bounded by the proxy. The raw code stays in the
`grok_proxy_attempt_finished` log line.
A request the proxy refuses on its own request limits (stream queue full,
queue wait exceeded, invalid deadline) reaches the Host as
`provider_unavailable`. The metric labels it `request_limit` to keep it apart
from upstream outages, and the log line carries the limit's fixed `reason`.

## Feature flags

All flags default to off.

| Flag | Owner | Gates |
| --- | --- | --- |
| `CONTROL_API_GROK_SUBSCRIPTION_ENABLED` | control-api ConfigMap | Admin Grok routes, Host/recipe acceptance of `grok-subscription`, and the `clerum.io/grok-enabled` annotation that control-api publishes on `clerum-llm-allowed-models`. |
| `WRC_GROK_SUBSCRIPTION_ENABLED` | workflow-recipes Deployment | Folded into the recipe verdict. Gates the `llm:grok:execute` scope, the `<recipe>-mcp-host-to-grok-proxy` egress NetworkPolicy, the bootstrap binding, the pod env, and `grantRedeemable`. |
| `GROK_LLM_PROXY_EXECUTION_ENABLED` | grok-llm-proxy ConfigMap | Kill switch: while it is off, runtime and admin requests return 404 `disabled`, even with a valid JWT, ticket or permit. |
| `MCP_HOST_GROK_SUBSCRIPTION_ENABLED` | **injected, not a manual key** | HCC injects it on Host pods whose Grok projection mints `llm:grok:execute`. WRC injects it, with `GROK_LLM_PROXY_RUNTIME_URL`, on recipe pods that declare Grok when `WRC_GROK_SUBSCRIPTION_ENABLED` is on. Do not add it to `mcp-host-config`. |

HCC has no local Grok switch. Its Grok projection follows the
`clerum.io/grok-enabled` annotation together with the Host's own Grok
references.

## Recipe grant annotations

Annotation write shapes:

- Codex: `{codex-connection-ref: k, subscription-connection-ref: k}`
- Grok: `{codex-connection-ref: '', subscription-connection-ref: k}`

The server (`control-api/src/services/recipeGrantTransition.ts`) enforces
these transitions. None of them may return a 500:

| Case | Behavior |
| --- | --- |
| Explicit alias and canonical both non-empty and unequal (any spec) | 422 `subscriptionAnnotationsDisagree` |
| Create, or static → broker | Omitted annotations: 422 (grant required). Explicit: validate, then write the broker's shape. |
| Same broker, annotations omitted | Keep the stored annotations |
| Same broker, annotations explicit | Validate the key, then write that broker's shape |
| Codex → Grok | Omitted annotations: 422 `providerChangeRequiresGrant`. Non-empty alias: 422. Otherwise validate the canonical key and write the Grok shape. |
| Grok → Codex | Omitted annotations: 422 `providerChangeRequiresGrant`. Otherwise validate (canonical-only is allowed) and write the Codex shape. Never clear silently. |
| Broker → static | Without an SDK: clear both annotations. With an SDK: keep them (the SDK route owns them). |
| Static → static | Keep the stored annotations (the SDK route owns static-recipe identity) |

## Allowlist ConfigMap republish

control-api is `replicas: 1`. After rolling out a new control-api that writes
`clerum.io/grok-*` annotations, republish `clerum-llm-allowed-models` once the
new pod is Ready. Otherwise a mutation served by the old pod could strip the
Grok annotations. A new control-api also republishes on boot.

## Rollout order

1. **evenfire-infra first.** Pin the `grok-llm-proxy` image for `gcp-dev` and
   `gcp-prod`. Provision `grok-llm-proxy-secrets`
   (`GROK_LLM_PROXY_CONTROL_API_TOKEN`) with
   `deploy/scripts/apply-inter-service-tokens.sh`. Both must be in place before
   the merge to `dev` triggers the automatic deploy.
2. **control-api** with migrations 0109_grok_subscription_connections through
   0114_llm_provider_attempts_connection_integrity. Wait until every control-api pod
   runs the new image. An old control-api rejects the whole workflow-control
   token issue when the request includes the unknown `llm:grok:execute` scope
   (`invalid_workflow_control_scopes`). HCC or WRC deployed first could
   therefore break token issuance for every pod they mint for, not only Grok
   pods (C-RP-016).
3. **HCC, WRC and every mcp-host image**, before `grok-llm-proxy`. Grok flags
   stay off. The four Host images — `mcp-host`, `mcp-host-slim`,
   `mcp-host-full` and `mcp-host-desktop` — each copy
   `packages/grok-provider-attempt-contract` at build time, and
   `.github/workflows/build-publish.yml` builds them in one matrix without
   ordering the deploys. Wait until every Host pod runs the new image.
4. **grok-llm-proxy**, only after step 3 is complete. A proxy on the new bound
   in front of a Host still on the old one bills the band between them and
   then discards it as a retryable outage (see *Limits*); the reverse order
   has no such window.
5. Republish `clerum-llm-allowed-models` (see above).
6. Turn on the flags only after the control-api rollout is complete:
   `CONTROL_API_GROK_SUBSCRIPTION_ENABLED`, `WRC_GROK_SUBSCRIPTION_ENABLED` and
   `GROK_LLM_PROXY_EXECUTION_ENABLED`. `MCP_HOST_GROK_SUBSCRIPTION_ENABLED`
   follows automatically through HCC and WRC.

## Rollback order

1. Turn the Grok flags off. control-api republishes
   `clerum.io/grok-enabled=false`.
2. Wait for HCC and WRC to reconcile, so that no Host or recipe pod still mints
   `llm:grok:execute` and the Grok proxy NetworkPolicies are gone. Only then
   roll back control-api. An old control-api rejects the entire token issue
   for the unknown scope (C-RP-016).
3. After a control-api rollback, the old control-api writes only
   `codex-connection-ref` when a Codex recipe grant is reassigned. The stale
   `subscription-connection-ref` then disagrees with it. The new WRC reads the
   recipe as `unassigned`, and authorize returns a mismatch (B-M5b).
   - Once a control-api that writes both keys is serving again, list the Codex
     recipes whose two annotations are both non-empty and unequal.
   - Re-assign each grant with explicit annotations, which write the Codex
     shape. In the UI, re-pick the connection.
   - A save that omits the annotations keeps the stored disagreeing pair, so
     it does not repair the grant.
4. Migrations 0113_grok_subscription_terminal_connection_key (terminal Grok keys)
   and 0114_llm_provider_attempts_connection_integrity (attempt connection
   integrity) are forward-only. An older control-api still runs against them:
   - The 0114 trigger only rejects connection ids that do not exist.
   - Under 0113, a revoked Grok key can no longer be reconnected by the old
     code path. That attempt fails on the unique key index instead of reviving
     the key.

## SDK bootstrap

Binding slots are strict:

- Grok writers emit `subscriptionBinding`, and Grok readers (mcp-host
  `bootstrapIdentity`, WRC provisioner and bootstrap proof parsers) read only
  `subscriptionBinding`.
- Codex writes and reads only `codexBinding`. A proof in the other slot is
  ignored.

Missing-binding reasons:

- Grok: `execution_binding_missing`
- Codex: `codex_execution_binding_missing`
