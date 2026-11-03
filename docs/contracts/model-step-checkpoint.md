# Model-step checkpoint wire contract

Issues: [#1043](https://github.com/evenfire-ai/evenfire/issues/1043) (Host) and
[#1044](https://github.com/evenfire-ai/evenfire/issues/1044) (Desktop).

When a tool-use turn fails because the provider returned `provider_unavailable`
(HTTP 503 or a failed SSE terminal), and at least one tool result in that turn was
already confirmed, the Host keeps the turn's tool protocol in a durable checkpoint.
Desktop then offers **Retry model step**: a continuation of the same logical turn that
replays the confirmed tool results to the model and never re-executes those tools.
It is distinct from Resend, which re-sends the user's original message.

## Retry layers

Codex/Grok subscription providers retry a transient `provider_unavailable` before
failover, for at most 3 attempts in total (waits of about 1 s and 3 s, with 20 %
jitter, abort-aware). Each attempt uses fresh authorization and a fresh attempt
index. This provider-level retry is allowed only when the failed attempt is known
not to have reached the provider (`providerDispatched === false`, for example a
failed authorization) and no output has streamed; an attempt whose dispatch is
unknown counts as dispatched. A dispatched attempt, such as a proxy timeout, is not
retried by this layer, because a second call could be billed twice. A rate-limited
or queued authorize refusal gets at most one short Retry-After retry here, and the
retry stays with the same provider: a second `authorize_capacity_exceeded` is
terminal and does not fail over, while a repeated `rate_limited` keeps its
retryable class for the layers above. Only after these provider attempts end does
the failure reach the tool-use loop. Sources:
[provider retry schedule](../../mcp-host/src/llm/rateLimitRetry.ts)
(`providerUnavailableRetryDelayMs`, `authorizeRetryDelayMs`),
[dispatch flag](../../mcp-host/src/llm/types.ts) (`LlmError.providerDispatched`).

The loop then retries the failed model step `CLERUM_MODEL_STEP_AUTO_RETRIES` times
(default `3`, valid `0`–`5`; `0` disables the retry, and any other value stops the
Host at config load). The gate is: the failure would leave a resumable checkpoint
(an eligible `provider_unavailable` after at least one confirmed tool result), the
failed attempt was not known to be pre-dispatch (`providerDispatched !== false`),
and error recovery would not answer the failure (no workflow fallback). The retry
runs inside the running task, so the task id, the progress stream and the claim do
not change, `llm_in_progress` heartbeats continue, and no loop iteration is
consumed.

A model-step retry is a dispatched call and can be billed, and it re-runs the whole
provider chain, including any configured failover fallbacks; a continuation never
fails over. The billing bound per model step is `(1 + N) x (1 + fallbacks)`
dispatched calls, where `N` is the configured retry count and the fallback factor
is 1 when no failover is configured. Before retry _k_ the loop waits the _k_-th
entry of 500 ms, 1 500 ms, 3 000 ms, 6 000 ms, 12 000 ms (5 s in total for the
default 3, 23 s for 5), each shortened at random by up to 20 %.

The 60 s window after the step's first `provider_unavailable` only blocks starting
a new retry: a retry whose wait would end at or after that point does not start,
while an attempt already running when the window closes runs to completion under
its own provider timeouts and its answer is the step's result. The step ends on the
last failure the provider reported, so the checkpoint follows the final-error rule
below and the user sees the same notice as when the retries run out. A cancel
during a wait or an attempt stops the retries at once and ends the turn as a
cancellation. The worst case per step is the first attempt, plus the transport
retry when the first failure is a connection failure, plus the 60 s window, plus
one full attempt bounded by the provider deadline.

If the retries also fail, the returned `TaskError` is the last error. A step that
began on an eligible failure and whose retries ended on another error keeps the
checkpoint resumable only when that final error is itself retryable: `503 -> 503`,
`503 -> 429` and `503 -> connection failure` stay resumable, while a retry that
ends on a terminal error — `no_grant`, `insufficient_scope`,
`host_binding_mismatch`, `origin_denied`, `upstream_rejected`, the stream cap,
`model_not_allowed`, `budget_denied` or `authorize_capacity_exceeded` — does not,
because Retry would not restore access. The Host remembers the eligible failure
that started the step's retries; that memory is per model step and bound to the
exact error object the retries ended on, so a later step's failure never inherits
it. Sources:
[retry loop](../../mcp-host/src/core/orchestration/toolUseLoopRuntime.ts)
(`callReasoningForIteration`),
[settle gate](../../mcp-host/src/core/orchestration/modelStepCheckpointRecorder.ts)
(`settle`, `canResume`, `noteModelStepRetry`),
[error classes](../../mcp-host/src/core/orchestration/toolUseLoopIntentRecovery.ts)
(`isRetryableLlmError`), [bounded knob](../../mcp-host/src/config.ts)
(`modelStepAutoRetries`).

Every model step starts with the full retry count and its own 60 s window. Desktop
**Retry model step** also starts a continuation with the full count and its own
window; no retry count or deadline is carried from the origin.

Retry remains available after an approval resume while the Host stays up. If the
Host restarts while the **origin** turn waits for approval, that turn's checkpoint
is abandoned and Retry is not offered, because the origin recorder lives in the
process. A continuation suspended for approval is durable instead: the Host adopts
its claim at boot and still answers `202 replayed` for it. When that adopted
continuation resolves its approval, its source message is the approval row's
projection, which the continuation wrote at suspend from its own message: its own
`messageId` and its re-resolved file references. The attachment list comes from the
checkpoint header's `source_message` projection, because the approval row keeps the
#666 files-only projection while the header carries every image's metadata and the
sha256 digest that binds it to the retained bytes; file attachments are identical in
both. The approval binding reads the sender and channel fields, and both projections
carry those identically. A NULL header source, or an approval row without a message
id, is retired as corrupt: there is no fallback to the approval row's files-only
projection. If the retained image bytes expired before boot, the checkpoint is
`blocked` / `attachment_expired` instead.
Sources: [boot source selection](../../mcp-host/src/agent/stateMachine.ts)
(`continuationSourceMessageForBoot`),
[source projection](../../mcp-host/src/agent/sourceMessageForResume.ts)
(`sourceMessageForResume`).

This document is the only coupling between the Host change and the Desktop change.
The TypeScript source of truth is
[`mcp-host/src/core/conversation/modelStepCheckpointContract.ts`](../../mcp-host/src/core/conversation/modelStepCheckpointContract.ts).
Example payloads live in
[`tests/fixtures/model-step-checkpoint/`](../../tests/fixtures/model-step-checkpoint/);
the Host suites load them, so a change in the wire shape that the fixtures do not
follow breaks a test.

## Read: session field

`GET /v1/runtime/sessions/:agent/:chatId/messages` (rpc-proxy:
`GET /api/v1/rpc/hosts/:hostRef/sessions/:agent/:chatId/messages`, a passthrough) adds an
optional `modelStepCheckpoint` next to `state`, `activeTaskId`, `pendingApproval` and
`tokens`.

| Field                   | Type                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkpointId`          | string                                  | Stable for the life of the checkpoint, across re-claims.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `version`               | number                                  | Increases on every transition. The continuation POST echoes it.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `status`                | `resumable` \| `claimed` \| `blocked`   | `completed` and `abandoned` checkpoints are never served and are purged on the next five-minute sweep, except while the session's active task is the checkpoint's continuation task or a pending approval is bound to the checkpoint; those headers are purged on a later sweep. `open` checkpoints (a turn still recording its first tool steps) are never served. A claimed row with a lapsed lease and no live approval is projected as `resumable` at its stored version. Blocked rows retain their configured TTL. |
| `retryAvailable`        | boolean                                 | `true` only when `status` is `resumable`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `originTaskId`          | string                                  | The failed task. It stays terminal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `originTurnNumber`      | number                                  | Required, a positive safe integer: the turn this checkpoint resumes (`origin_turn_number`). A continuation's reply is the assistant row of that turn. The Host writes it into that slot (the continuation start reopens this turn under the fence), so a client places the reply there and never appends it as a new turn. Added to the unreleased v1 before release.                                                                                                                                                   |
| `continuationTaskId`    | string, optional                        | Present when `status` is `claimed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `provider`, `model`     | string                                  | The turn's configured pair: Host provider + session model resolved when the turn started. A continuation always uses this pair and never fails over, even when a fallback served earlier steps of the turn.                                                                                                                                                                                                                                                                                                             |
| `blockedReason`         | enum, optional                          | Present when `status` is `blocked`: `principal_mismatch`, `host_mismatch`, `grant_revoked`, `model_unavailable`, `budget_exhausted`, `reference_unavailable`, `attachment_expired` (the retained bytes of an inline uploaded file expired after their 1 h TTL or are missing; Resend still works).                                                                                                                                                                                                                      |
| `tools`                 | `{ confirmed, unknown, notDispatched }` | Counts only. `unknown` means a dispatch was recorded without a recorded result; such a tool is never re-executed.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `failedAt`, `expiresAt` | ISO-8601 string                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Clients ignore unknown fields in the view and in the continue response, and must
keep ignoring them: adding a field is not a breaking change. A new **required**
field, a new `status` value or a changed meaning of an existing field is breaking
and needs a new contract version.

The field never carries the transcript, tool arguments or tool results. If stored checkpoint data fails validation, the session GET omits the field and logs only the checkpoint id and entry sequence; worker timeouts and IO errors still fail the read. The continuation POST remains strict.

A new user message (or a Resend) in the session retires the previous checkpoint when
that message is admitted, so the field disappears before the new turn runs.

## Write: continuation

`POST /v1/runtime/sessions/:agent/:chatId/model-step-checkpoints/:checkpointId/continue`
(rpc-proxy:
`POST /api/v1/rpc/hosts/:hostRef/sessions/:agent/:chatId/model-step-checkpoints/:checkpointId/continue`),
body `{ "version": number }`. Same edge guard as `POST /v1/runtime/messages`: caller
`rpc-proxy`, with a `userId` equal to the session owner; the lifecycle drain gate
answers `503 host_draining`.

The Host also requires the proxy-authored `x-clerum-edge-trace-context` header:
percent-encoded JSON satisfying `TraceContextV1`, with `origin: "direct_chat"` and
`sessionId` equal to `:chatId`. A missing or invalid header returns
`400 { error: "Invalid continuation traceContext" }` before admission, leaving the
checkpoint untouched. Clients send `{version}` to the proxy; the proxy constructs
the trusted header and forwards only `version` in the body.
Sources: [Host validation](../../mcp-host/src/server/routes.ts)
(`handleModelStepContinuationRoute`),
[proxy trace and forwarding](../../rpc-proxy/src/routes/rpc.ts) (continue route).

The status is checked first. The version is compared only when the status is `resumable`.

| Order | Checkpoint state                                                                                                                                                                                                                           | Response                                                                                                                                                                                                                                                                | Example                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1     | `abandoned`, `open`, missing, or another session                                                                                                                                                                                           | `404 { code: "model_step_checkpoint_not_found" }`                                                                                                                                                                                                                       | `continue-response.not-found.json`        |
| 1b    | `resumable`, `claimed` or `blocked` past `expiresAt`, with no live lease or same-task approval (before the sweep abandons it)                                                                                                              | Same `404` as row 1                                                                                                                                                                                                                                                     | `continue-response.not-found.json`        |
| 2     | `completed` (before the next terminal sweep; then row 1)                                                                                                                                                                                   | `200 { taskId, checkpointId, status: "completed", replayed: true }`                                                                                                                                                                                                     | `continue-response.completed.json`        |
| 3     | `claimed`, lease or same-task approval live, and the claim's task has a live executor in this Host (including a suspended executor rehydrated at boot)                                                                                     | `202 { taskId: continuationTaskId, checkpointId, status: "claimed", replayed: true }`                                                                                                                                                                                   | `continue-response.replayed.json`         |
| 3b    | `claimed`, lease expired and no live same-task approval (any version)                                                                                                                                                                      | Re-claim: revalidate (row 6); on success `202 { taskId: <new>, checkpointId, status: "claimed", replayed: false }`                                                                                                                                                      | `continue-response.reclaimed.json`        |
| 3c    | `claimed`, lease or same-task approval live, but no live executor for the claim's task in this Host (a crashed or replaced executor whose claim was not released)                                                                          | `503 { code: "continuation_claim_settling" }`; the claim is not consumed. A re-POST succeeds once the claim is released (`resumable`) or its lease expires (re-claim), bounded by the default 300 s lease. The code contains neither `host_draining` nor `host_waking`. | —                                         |
| 4     | `blocked`                                                                                                                                                                                                                                  | `409 { code: "model_step_checkpoint_blocked", blockedReason }`                                                                                                                                                                                                          | `continue-response.blocked.json`          |
| 5     | `resumable`, other version                                                                                                                                                                                                                 | `409 { code: "model_step_checkpoint_version_mismatch", current: <view> }`                                                                                                                                                                                               | `continue-response.version-mismatch.json` |
| 6     | `resumable`, same version, revalidation fails                                                                                                                                                                                              | `409 { code: "model_step_checkpoint_blocked", blockedReason }`; the checkpoint becomes `blocked`                                                                                                                                                                        | `continue-response.blocked.json`          |
| 7     | `resumable`, same version, claim won                                                                                                                                                                                                       | `202 { taskId, checkpointId, status: "claimed", replayed: false }`                                                                                                                                                                                                      | `continue-response.claimed.json`          |
| 7b    | Claim won, then `reference_check_failed`                                                                                                                                                                                                   | Same `202` as row 7; the ordinary async task result carries the file-reference error. The checkpoint is already `resumable` with a new version.                                                                                                                         | See below.                                |
| 7c    | Claim won, then, within what remains of the 10 s verdict deadline that started at request receipt, the continuation finds it no longer owns the claim (a lease renewal returns `false`, or another claim or transition replaced its fence) | `404 { code: "model_step_checkpoint_not_found" }`, synchronously. The checkpoint keeps the state its current owner gave it.                                                                                                                                             | `continue-response.not-found.json`        |
| 7d    | Claim won, then preparation fails and the claim cannot be released or abandoned (the storage write rejects or times out)                                                                                                                   | `500 { error: "Model-step continuation failed" }`. The claim stays `claimed` until its lease expires; a later re-POST replays or re-claims it.                                                                                                                          | —                                         |

Every claim creates a new task id: the task lifecycle refuses a terminal id. "The same
continuation" means the same `checkpointId` and the same recorded entries.

After a `202`, Desktop attaches to `taskId` with the existing task-progress path.
A `202` acknowledges the task, not successful preparation. After
`reference_check_failed`, refresh the session checkpoint before retrying: sending
the old version gets row 5 rather than replaying the failed task.
Sources: [admission verdict response](../../mcp-host/src/agent/modelStepContinuation.ts)
(`ModelStepContinuationService.continue`),
[reference failure releases the claim](../../mcp-host/src/agent/taskExecutor.ts)
(`releaseClaimAfterReferenceCheckFailure`).

Other responses are outside the checkpoint-state table:

- Host `400 { error }`: invalid route segments, a version that is not a positive
  safe integer, or invalid trace context; `401 { error: "Missing rpc edge caller context" }`;
  `501 { error: "Model-step continuation handler not configured" }`;
  `500 { error: "Model-step continuation failed" }`.
  The `500` is also returned after a won claim when, within the verdict wait,
  admission cannot enqueue the task, a claim lease renewal fails with a worker
  error (the checkpoint stays `claimed` until its lease expires), the transition
  to `blocked` cannot be stored, or a preparation failure cannot release the
  claim (row 7d). The task fails through the ordinary task-result path; no `202`
  is sent.
  [Host route](../../mcp-host/src/server/routes.ts),
  [admission error](../../mcp-host/src/agent/modelStepContinuation.ts).
- Host `503 { code: "host_draining" }` enters the proxy's wake-and-hold path.
  If the Host is still waking when the hold ends, the proxy may return
  `503 { code: "host_waking", hostRef, retryAfterMs, message, lastKnownState }`
  with `Retry-After` in seconds. After a wake-eligible failure the proxy retries
  the continue POST with the **whole remaining hold** (`wakeMaxHoldMs`, default
  48 s) instead of the generic upstream timeout, until the hold ends or the Host
  answers. When that remainder is below the proxy's 12 s admission floor
  (`HOST_CONTINUATION_ADMISSION_BUDGET_MS`) the proxy does not start the POST at
  all and answers the same `503 host_waking`: the Host claims the checkpoint
  before its verdict, so an attempt cut short after the claim landed would strand
  a live claim. The floor is the Host's verdict deadline
  (`MODEL_STEP_CONTINUATION_VERDICT_TIMEOUT_MS`, 10 s, mirrored by the proxy's
  `HOST_CONTINUATION_VERDICT_BUDGET_MS`) plus a fixed pre-verdict allowance
  (`HOST_CONTINUATION_PRE_VERDICT_ALLOWANCE_MS`, 2 s), 12 s in total. The allowance covers the
  bounded pre-verdict steps — the claim is a durable-store sync write — plus
  request transit and response serialization; its stated basis is the Host's
  default sync timeout of 2000 ms (`CLERUM_DB_PERSIST_SYNC_TIMEOUT_MS`). The Host
  counts its verdict deadline from request receipt, not from the verdict race:
  claim, revalidation and `enqueue` all run inside it, and when the deadline is
  already spent after `enqueue` the Host answers the `202` at once and the
  outcome arrives through the ordinary async task result. A proxy timeout that
  lands after a claim is therefore recoverable: a re-POST replays the live claim
  (`202 replayed`) only while the claim's task has an executor in this Host, and
  answers `503 continuation_claim_settling` otherwise (row 3c).
  [Host lifecycle gate](../../mcp-host/src/server.ts),
  [proxy wake handling](../../rpc-proxy/src/routes/rpc.ts),
  [wake response](../../rpc-proxy/src/services/wakeAndHold.ts)
  (`respondWithWakeAndHold`).
- An async `TaskError` may contain `modelStepCheckpointId` when the failed model
  step leaves a checkpoint. Continuation preparation can also report
  `model_step_checkpoint_blocked` or `model_step_checkpoint_not_found` through
  the task-result path, including after the admission response's verdict wait ends.
  [Task error field](../../mcp-host/src/queue/types.ts),
  [emission](../../mcp-host/src/agent/taskExecutor.ts),
  [preparation errors](../../mcp-host/src/agent/taskExecutor.ts).

The approval deny response is not part of this route, but it shares the same
settlement owner. `POST /v1/runtime/approvals/deny` answers
`{ success: true }` after the executor settled the cancellation. The ordinary turn
answers `{ success: false, code: "denial_not_saved", error: "The tool call was
cancelled, but the denial could not be saved." }` when the cancellation settled and
either write of `persistApprovalResolved` failed: the `pending_approvals` delete, or
the session update that follows it. The task completes with the denial message. When
the delete failed, the orphan row is left to #726's atomic, task-conditional worker
resolution. When the session update failed, no approval row remains: the durable
session keeps `awaiting_approval`, which the boot reaper
(`reap_awaiting_approval_sessions`) treats as an orphan and moves to `idle`. An
operational continuation settlement is a failed request instead, never
`denial_not_saved`, because a continuation has a claim whose outcome a failed
approval write does not establish. An approval that times out keeps its single
`completed/approval_timeout` lifecycle event and does not emit a second terminal.
That terminal delivers exactly one response through the task's response callback,
"The approval for `X` timed out. The operation was not performed.", whether or not
the denial write succeeded, for ordinary and continuation turns; for an RPC turn it
is the stored async result. A task rehydrated at boot has neither a lifecycle record
nor a response callback, so its timeout delivers neither.
Sources: [deny handler](../../mcp-host/src/agent/stateMachine.ts) (`handleDenial`),
[executor deny](../../mcp-host/src/agent/taskExecutor.ts) (`deny`).

A cleanup whose request id is no longer the session's current pending approval is
refused, and the refusal is not silent success: it deletes that obsolete approval
row by its own request id and writes nothing to the session, so a session owned by
a newer task keeps its state, `active_task_id` and trace context. The obsolete row
therefore cannot outlive the cleanup that owns it, nor be returned later as the
session's current approval. This rule does not cover a replacement task that
is `processing` and has no current pending request, nor an ordinary stale deny (it
passes no owner) or an `approve` (it passes no expected task) across caches, and it
is not full atomic resolution: all of these stay with PR #726, which owns the
identity-scoped `(session_key, request_id)` resolution.
Sources: [cleanup refusal](../../mcp-host/src/core/conversation/conversation.ts)
(`clearPendingApproval`),
[targeted delete](../../mcp-host/src/core/conversation/persistence/sqliteConversationStore.ts)
(`deletePendingApproval`),
[worker op](../../mcp-host/src/db/worker/dispatcher.ts) (`delete_pending_approval`).

## Deploy order

Roll out **rpc-proxy before mcp-host**. The Host continuation route requires the
proxy-authored trace header above; a request without it gets `400` without
consuming the checkpoint. Deploying the proxy first makes its public continuation
route available before the Host can advertise Retry.
Sources: [Host header guard](../../mcp-host/src/server/routes.ts),
[proxy continuation route](../../rpc-proxy/src/routes/rpc.ts).

The reverse skew is degraded, not corrupting. With a new Host and an old rpc-proxy,
the session read still serves the checkpoint, so Desktop offers Retry, but the
continue POST reaches a proxy without the route and answers the proxy's generic
`404` with no `code`. The client's response parser requires a known body, so it
turns that reply into an `ApiError` (status and text attached): Retry stays offered
with an error, and Resend is not offered while the checkpoint is `resumable` or
`claimed` — recovery is the continuation, not a resend. No checkpoint is consumed,
because the request never reaches the Host. Rolling out rpc-proxy before mcp-host
prevents this state. Treat a `404` without a `code` as "this proxy cannot continue
yet", not as "the checkpoint is gone": the row-1 `404` always carries
`model_step_checkpoint_not_found`. The same skew in the other direction (old Host,
new proxy) is harmless: the proxy forwards and the Host answers its own `404`, and
Retry is not advertised because the old Host never serves the field.

## Known limits

- **A manual Retry is pinned to the turn-start provider/model pair, including
  while that primary is in cooldown.** A turn that a failover fallback served
  continues on the primary; when the primary is rate-limited the continuation
  fails instead of using the fallback. Changing that needs an admission-time
  re-resolution of the pair (follow-up issue).
- **Physical failover dispatches are not observed individually.** One
  `llm:completed` event and one `llm_call` record describe each logical reasoning
  call: the first call and each in-place model-step retry, with `attempt` counted
  inside the step, `durationMs` excluding retry waits and the real status. The
  primary and fallback calls inside one failover chain are not separated
  (follow-up issue).

## Design note: who owns which state

This section describes the integrated Host implementation. It names functions, not
line numbers, so it stays true across refactors.

### State inventory

| State                                                                                                                                            | Writer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | What it means                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RAM turn (`Conversation` object: state, pending approval, active task, trace, turns)                                                             | `ConversationManager.startTurn`, `completeTurn`, `resumeTurnForContinuation`, `failTurn`, `cancelTurn`, `suspendForApproval`, `approve`, `deny`, `clearPendingApproval` mutate it; the object-identity guards (`turnCompletionOwners`) protect concurrent mutations of the same cache.                                                                                                                                                                                                                                    | The turn this process is serving. It is a cache of the durable row, not the authority.                                                                                                      |
| Session row (`sessions.state`, `active_task_id`, `active_trace_context`, and `messages.model_step_checkpoint_id` on the final assistant message) | `SqliteConversationStore.persistTurnStart`, `persistTurnComplete`, `persistContinuationStart`, `persistTurnCancel`, `persistTurnFail`, `persistSuspend`, `persistApprovalResolved`, each one worker op; `dispatcher` applies the message, the state flip, the `active_task_id` clear and any checkpoint completion in one transaction.                                                                                                                                                                                    | The durable owner of the turn. `active_task_id` names the task allowed to close it.                                                                                                         |
| Turn fence (`ModelStepTurnFence`: checkpoint id, owner, generation, task id, origin turn number)                                                 | `TaskExecutor.continuationTurnFence` builds it; the start fence in `dispatcher` requires the checkpoint to be `claimed`; the close fence requires the session's active task to match.                                                                                                                                                                                                                                                                                                                                     | Proves that the writer is the current claim owner and the current session task.                                                                                                             |
| Checkpoint row (`open`, `resumable`, `claimed`, `blocked`, `completed`, `abandoned`)                                                             | `ModelStepCheckpointRecorder.begin`, `append`, `updateState`, `settle` through `ModelStepCheckpointStore`; `ModelStepCheckpointStore.transition`/`claim`; the worker's `modelStepCheckpointOps` validate, reap at boot and sweep.                                                                                                                                                                                                                                                                                         | The durable tool protocol of the failed turn. Only one non-terminal row exists per session.                                                                                                 |
| Lease (`claim_owner`, `claim_generation`, `claim_expires_at`)                                                                                    | `claim` writes it; `TaskExecutor.startContinuationLease` renews every third of the lease and does not renew while the task waits for approval; `renewContinuationClaim` renews at the start of preparation and again before reopening the turn; `requireContinuationClaim` renews on approval resume, before `approve()` and before the approved effect. Tool effects between renewals are guarded by the timer and by the fence on every ledger write. A live pending approval participates in boot adoption and expiry. | Distinguishes the current claim owner from a replacement. A thrown renewal is not evidence of loss; only `false` is.                                                                        |
| Recorder (`StoreBackedRecorder`: fence, `recordedUpTo`, batch-scoped tool-message set, confirmed count, poison flag, settlement result)          | `createOriginCheckpointRecorder` and `createContinuationRecorder` build it; `adoptRecordedToolMessages` seeds the cold batch identity from the durable ledger; `recordDispatch`/`recordResult` write the ledger.                                                                                                                                                                                                                                                                                                          | In-memory mirror of the ledger and claim. A failed write poisons it, and a poisoned recorder can never make the checkpoint resumable (a continuation stops before the tool effect instead). |
| `pending_approvals` row                                                                                                                          | `ConversationManager.suspendForApproval` → `persistSuspend`; `approve`/`deny` → `persistApprovalResolved`; `clearPendingApproval`; the worker's boot reaper.                                                                                                                                                                                                                                                                                                                                                              | The durable approval. Deletion and the session update are two awaited operations, not one transaction (the atomic, task-conditional worker resolution is #726).                             |

The `ContinuationClaim` object in `taskExecutor` is the single settlement owner of
one continuation. It holds the fence, the lease stop handle, the recorder, the
completion fence, the admission verdict flag and one settlement promise. Its
`settle(outcome, transition, recover?)` runs once and returns `{kind:'applied'}`,
`{kind:'lost'}` or `{kind:'operational', durableStateUnknown}`; later calls return
the first result. `settleRecorder` serializes a recorder settlement with a competing
terminal settlement and observes its applied outcome, so an applied transition is
never repeated. Only an applied fence transition yields `resumable`, `abandoned`,
`blocked` or `completed`.

### Await and event table

A sync worker write that times out is **unknown**, not failed: `PersistQueue` keeps a
per-id late-settlement promise that resolves with the worker's answer and rejects on
a worker error, worker exit or the stall bound. `SqliteConversationStore.settleUncertainBoundary`
awaits it before deciding anything. At every await below, a restart can stop the
process, a cancel, denial, competing claim or lease expiry can be scheduled, and the
write can fail busy, time out or lose the worker.

| Path                     | Await                                                                                                                                                                                                           | Events that can land there                                                                                                                                                                          | What the code does now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Close                    | `handleLoopResult` → `ConversationManager.completeTurn` → `SqliteConversationStore.persistTurnComplete` (`persist_turn_boundary`)                                                                               | Sync timeout with the op still in flight; worker exit; fence mismatch (another claim completed or replaced the checkpoint); task-owner mismatch (a replacement reopened the turn); restart.         | Committed late → keep the durable close, keep the answer in RAM and deliver it once, leave the reopened marker cleared. Not committed or worker exit → restore the reopened marker and rethrow the settled error (the worker's own error on exit); `completeTurn` rolls RAM back (turn response and `completed_at`, state, approval, active task, trace, `updated_at`). A worker exit fails loud and leaves the turn in RAM `processing` so no conflicting write can start. The typed `ModelStepBoundaryNotCommittedError` wrapper exists on the cancel, fail and continuation-start boundaries (`persistTurnCancel`, `persistTurnFail`, `persistContinuationStart`); cancel and fail wrap only a timed-out write, the start wraps any rejected write, and the close path rethrows the settled error itself.                                                                                                                                                                                                                                                                                                                                            |
| Cleanup                  | `continuationCleanup('abandon' \| 'fail_turn', fn)`                                                                                                                                                             | Any rejection from the wrapped step.                                                                                                                                                                | Logs the failure and continues: the task's original error is preserved, and an unreleased claim recovers through its lease (default 300 s).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Abandon                  | `abandonModelStepContinuation` → `ContinuationClaim.settle('abandoned', transition)`                                                                                                                            | The transition returns `false` (fence lost), throws a fence mismatch, throws an operational error, or a recorder settlement already applied.                                                        | Settle-once: the first result is reused. Applied → `claimReleased`; `lost` → `fenceLost`; operational → the caller logs it and the claim stays `claimed` until its lease expires. A recorder transition that applied first is observed through `observeApplied`, so no second transition runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Deny                     | `TaskExecutor.deny` → `ConversationManager.deny` → `persistApprovalResolved`, then `stopContinuationLease`, `abandonModelStepContinuation`, `abandonOriginCheckpoint`, `settleGfsRetentionOwner`                | The denial write rejects; the session already belongs to a replacement (`expectedTaskId` mismatch); the lifecycle is already terminal (approval timeout); a continuation settlement is operational. | Ordinary turn: a settled cancellation whose denial write failed throws `DenialNotSavedError` and the HTTP handler answers `denial_not_saved`; the task completes with the denial message. Continuation: an operational settlement fails the task (HTTP failure) and is never reported as saved. A continuation whose denial reaches a session the durable row already gave to a replacement is refused by the owner guard: RAM is restored, the lease is stopped without abandoning the claim, `onFail` runs once and the handler answers a generic failure rather than `denial_not_saved`, while the replacement's session and approval stay intact; the obsolete approval row is deleted by its own request id when a later cleanup is refused, or pruned at the next boot. A terminal lifecycle logs any settlement failure, resolves completion once and emits no second terminal; when that terminal is the approval timeout, the response callback receives the timeout message once. Every outcome leaves the suspension first and releases the GFS retention owner exactly once, even when an earlier step rejects, before completion resolves. |
| Abort                    | `abort()`: none synchronously; a suspended run joins `stopContinuationLease` → `abandonModelStepContinuation` → `abandonOriginCheckpoint` → `settleGfsRetentionOwner` in `suspendedCancellation`                | The loop is mid-call; the cleanup rejects; a deny or approval arrives concurrently.                                                                                                                 | The lifecycle moves to `cancelled` before the signal fires, the in-flight call sees the task signal and the loop returns `cancelled`. A suspended run resolves completion once; a cleanup rejection logs, calls `onFail` once (none when the lifecycle is already terminal) and still resolves completion. The GFS retention owner is released exactly once after the earlier cleanup, whether that cleanup succeeded or rejected, and before completion resolves; the same holds for the `run()` and `resumeAfterApproval()` terminal cleanup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `resumeAfterApproval`    | `requireContinuationClaim` (renewal), `ConversationManager.approve`, `recordDispatch`, the approved tool effect, `handleLoopResult`                                                                             | Renewal returns `false` or throws; `approve` rejects; the dispatch write is unacknowledged; the tool rejects; a cancel lands between approval and the effect.                                       | Renewal `false` → fence lost → fail. Renewal throw → operational → lease stopped, claim released to `resumable`, task failed through the ordinary task-result path (the verdict was emitted at preparation). A continuation's unacknowledged dispatch throws before the tool effect (operational). A cancel before the effect cleans up and fails the turn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Continuation preparation | `runModelStepContinuation`: renewal, budget/ledger restore, attachment rows, file references, `getOrCreate`, entries, registry build, second renewal, live header, message restore, `resumeTurnForContinuation` | A competing claim or lease expiry; a worker error or timeout; a cancel; a restart.                                                                                                                  | Lost → `failContinuationPreparation({kind:'lost'})` and the 404 verdict. Operational → `ContinuationOperationalError` and the 500 verdict, with `releaseContinuationClaim` returning the checkpoint to `resumable`; a rejected release leaves the claim to its lease. Blocked → the 409 verdict. `reference_check_failed` → the 202 was already sent and the claim is released to `resumable`. The verdict is emitted once (`emitContinuationVerdict`); `started` is emitted before the durable reopen, and the reopen itself is fenced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Continuation start       | `ConversationManager.resumeTurnForContinuation` → `SqliteConversationStore.persistContinuationStart` (`update_session_state` with the turn fence)                                                               | A sync timeout with the op still in flight; any other rejected write; a worker error, exit or stall; a lease lapse with or without a reclaim; a restart.                                            | The `started` verdict precedes this write, so the caller already has its `202`. Committed late → the settlement is awaited and applied: the reopened marker is released, the executor continues, and no claim is settled. Not committed → the marker is restored and the write throws `ModelStepBoundaryNotCommittedError`, which the executor maps to `ContinuationOperationalError`; that is a pre-effect operational failure, so the task fails through the ordinary task-result path while the checkpoint stays `resumable` and Retry stays offered. A fence or owner mismatch is `lost` instead. The start fence requires identity, owner, generation, origin turn and `status = 'claimed'`, but it does not read `claim_expires_at`: a lapse without a reclaim leaves this still-live executor's start applied, so it continues and its next renewal decides, while a reclaim changes owner and generation and makes the start fail as `lost`. A worker that makes no progress is killed by the stall watchdog, whose rejection is the late `not committed` answer.                                                                               |

### Retry policy

Every layer below is inside one Host process and one task. "Call" means one physical
provider request. Defaults: `N = 3` model-step retries, no fallbacks unless a policy
is wired, and continuations never fail over.

| Failure                                                                                                     | Transport retry            | Provider retry                                                                 | In-place model-step retry                                                     | Workflow fallback                                  | Failover (origin only)                 | Calls per model step                                                           | Billable                                                          | End state                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection failure before any dispatch (`LLM_API_CALL_FAILED` / `LLM_CONTROL_PLANE_UNAVAILABLE`, retryable) | One more call after 350 ms | No                                                                             | No: `canResume` needs `provider_unavailable`                                  | Yes when a cached workflow tool result exists      | Yes: retryable class                   | 2, plus one per fallback                                                       | No for the first two; a fallback attempt is billable              | Answer, workflow answer, or failed. Resumable only as the retry's final error of an eligible step                                                                                                                 |
| Pre-dispatch authorize 503 (`provider_unavailable`, `providerDispatched === false`)                         | No                         | Up to 3 attempts (about 1 s, then 3 s)                                         | No: the gate requires `providerDispatched !== false`                          | Yes when the final error is still retryable        | Yes: retryable class                   | 3 authorize attempts per physical attempt, times the fallback chain; 0 streams | No                                                                | Workflow answer; otherwise resumable only when the final error is itself an eligible `provider_unavailable`. Another retryable final is failed, because the in-place latch does not run on a pre-dispatch failure |
| Dispatched 503 (proxy timeout, 300 s idle timeout, queued ticket refusal)                                   | No                         | One attempt                                                                    | Yes: up to `N` more calls while the window allows                             | Yes on the final error when a cached result exists | Yes                                    | `(1 + N) x (1 + fallbacks)` streams                                            | Yes, every streamed attempt                                       | Answer, workflow answer, or resumable only when the final error is retryable; a terminal final is failed and not resumable                                                                                        |
| 429 `rate_limited`                                                                                          | No                         | One Retry-After retry on the first attempt, only when the wait is in (0, 30 s] | No: not eligible                                                              | Yes: retryable class                               | Yes when the policy includes the class | At most 2                                                                      | The streamed 429 may have been billed; the authorize form was not | Workflow answer or failed; resumable only as the retry's final error of an eligible step                                                                                                                          |
| Auth (`no_grant`, `insufficient_scope`, `host_binding_mismatch`, `origin_denied`)                           | No                         | No                                                                             | No                                                                            | No: not retryable                                  | No: non-eligible                       | 1                                                                              | No for authorize; a streamed auth error may be                    | Failed, not resumable                                                                                                                                                                                             |
| `upstream_rejected`                                                                                         | No                         | No                                                                             | No                                                                            | No                                                 | No                                     | 1                                                                              | Yes if dispatched                                                 | Failed, not resumable                                                                                                                                                                                             |
| `authorize_capacity_exceeded` (queued refusal)                                                              | No                         | One Retry-After retry on the first attempt, then terminal                      | No                                                                            | No                                                 | No: terminal                           | At most 2                                                                      | No                                                                | Failed, and **not** resumable even when the step began on an eligible 503                                                                                                                                         |
| Stream cap (`LLM_STREAM_DURATION_EXCEEDED`)                                                                 | No                         | No                                                                             | No                                                                            | No                                                 | No                                     | 1                                                                              | Yes                                                               | Failed, not resumable                                                                                                                                                                                             |
| Codeless non-2xx proxy rejection (no string `error` in the body, status other than 413 or 429)              | No                         | No                                                                             | Follows the dispatched-503 row (the client maps it to `provider_unavailable`) | Yes on the final error                             | Yes                                    | As the dispatched-503 row                                                      | Yes                                                               | As the dispatched-503 row. Pre-existing mapping; a status-based classification is a follow-up issue                                                                                                               |
| User cancel or lease loss                                                                                   | Every layer stops          | Every layer stops                                                              | Every layer stops                                                             | Not reached                                        | Not reached                            | No new call; the in-flight one is aborted                                      | An attempt already streamed may have been billed                  | `cancelled`; the checkpoint is abandoned                                                                                                                                                                          |

A non-2xx proxy reply is classified by its status and body before this table applies,
and the two clients differ in one step:

- Status 429, both clients: a machine code in the body's `error` is kept (for example
  `budget_denied`, which is terminal); without one the code is `rate_limited` (the 429
  row).
- Status 413: the Codex client always maps it to `payload_too_large` (terminal,
  `retryable: false`), even when the body carries a string `error`. The Grok client
  uses a string `error` when present and maps a codeless 413 to `payload_too_large`.
- Any other status: a string `error` in the body is the code; without one the code is
  `provider_unavailable`.

Only that last codeless case falls back to `provider_unavailable`, and that fallback is
what the follow-up issue is about. Sources:
[Codex proxy client](../../mcp-host/src/llm/codexLlmProxyClient.ts),
[Grok proxy client](../../mcp-host/src/llm/grokLlmProxyClient.ts),
[`rateLimitedCode`](../../mcp-host/src/llm/retryAfter.ts).

### Decision table: first eligible failure wins

The step's **first eligible failure** decides whether the checkpoint can survive
the automatic retries; the **final error** decides whether the user is offered
Retry. The order of the decisions is fixed:

| #   | Situation                                                                                                                                                                                                                  | Decision                                                                                                       | Reason                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | The first failure is eligible and `recoveryAnswers` would answer it                                                                                                                                                        | No in-place retry; the workflow fallback answers                                                               | An answer beats a retry: the turn can finish without another provider call              |
| 2   | The first failure is eligible and `providerDispatched === false`                                                                                                                                                           | No in-place retry; the provider layer already spent its attempts                                               | Retrying a request that never left the process only re-runs authorization               |
| 3   | The first failure is eligible, dispatched, and no recovery answer                                                                                                                                                          | In-place retry runs, up to `N` times, inside the 60 s window                                                   | Stopping now would leave a resumable checkpoint; the retry can finish the step in place |
| 4   | The retries end on a retryable error (including the same 503, a 429 or a connection failure)                                                                                                                               | Checkpoint `resumable`, Retry offered                                                                          | The user can still get the turn back without re-executing confirmed tools               |
| 5   | The retries end on a terminal error (`no_grant`, `insufficient_scope`, `host_binding_mismatch`, `origin_denied`, `upstream_rejected`, the stream cap, `model_not_allowed`, `budget_denied`, `authorize_capacity_exceeded`) | Checkpoint not resumable, no Retry                                                                             | Retry would not restore access, so offering it is a dead end                            |
| 6   | The first failure is not eligible                                                                                                                                                                                          | No in-place retry; the workflow fallback may answer; otherwise the checkpoint rule is `canResume(final error)` | There is nothing to preserve unless the failure itself qualifies                        |
| 7   | Cancel or lease loss at any point                                                                                                                                                                                          | Cancellation wins; no retry starts; the claim is abandoned                                                     | The user's action or lost ownership outranks the retry policy                           |

The memory that implements rows 4 and 5 is per model step and bound to the exact
error object the retries ended on (`noteModelStepRetry` on the recorder, read by
`settle`), so a later step's failure cannot inherit it.

## Example files

`session-view.{resumable,claimed,blocked}.json` hold one `ModelStepCheckpointView` each.
There is no `completed` view file, because a completed checkpoint is not served.

`continue-response.*.json` hold `{ "httpStatus": number, "body": <response> }`.
