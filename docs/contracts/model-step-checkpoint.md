# Model-step checkpoint wire contract

Issues: [#1043](https://github.com/evenfire-ai/evenfire/issues/1043) (Host) and
[#1044](https://github.com/evenfire-ai/evenfire/issues/1044) (Desktop).

When a tool-use turn fails because the provider returned `provider_unavailable`
(HTTP 503 or a failed SSE terminal), and at least one tool result in that turn was
already confirmed, the Host keeps the turn's tool protocol in a durable checkpoint.
Desktop then offers **Retry model step**: a continuation of the same logical turn that
replays the confirmed tool results to the model and never re-executes those tools.
It is distinct from Resend, which re-sends the user's original message.

Codex/Grok subscription providers retry a transient `provider_unavailable` before
failover, for at most 3 attempts total (backoffs of about 1 s and 3 s, with jitter).
Each attempt uses fresh authorization and a fresh attempt index. This provider-level
retry is allowed only when the failed attempt is known not to have reached the
provider (`providerDispatched === false`, for example a failed authorization)
and no output has streamed. A dispatched attempt, such as a proxy timeout, is not
retried by the provider layer, because a second call could be billed twice.
Only after these provider attempts end does the failure reach the tool-use loop.
Sources: [retry guard](../../mcp-host/src/llm/rateLimitRetry.ts#L52),
[dispatch flag](../../mcp-host/src/llm/types.ts#L61).

The loop then retries the failed model step
`CLERUM_MODEL_STEP_AUTO_RETRIES` times (default `1`, valid `0`–`5`; `0` disables
the retry) when that failure would leave a resumable checkpoint: an eligible
`provider_unavailable` after at least one confirmed tool result. The retry runs
inside the running task, so the task id, the progress stream and the claim do not
change, `llm_in_progress` heartbeats continue, and no loop iteration is consumed.
A model-step retry is a dispatched call and can be billed, and it re-runs the
whole provider chain, including any configured failover fallbacks; "at most `N`
extra calls" per failing step therefore holds only when no failover is
configured. The worst case per step is `N + 1` times the attempt time.

If the retries also fail, the returned `TaskError` is the last error. When the
step's first failure was eligible and the retries ended on a different,
non-eligible error (a 429, a connection failure, an auth failure or the stream
cap), the checkpoint still becomes `resumable`: the Host remembers the eligible
failure that started the step's retries, so the turn is not thrown away and the
confirmed tools are not re-executed. That memory is per model step and is bound
to the exact error the retries ended on, so a later step's failure never inherits
it. Sources:
[retry loop](../../mcp-host/src/core/orchestration/toolUseLoopRuntime.ts),
[settle gate](../../mcp-host/src/core/orchestration/modelStepCheckpointRecorder.ts),
[bounded knob](../../mcp-host/src/config.ts).

Retry remains available after an approval resume while the Host stays up. If the
Host restarts while a turn waits for approval, that turn's checkpoint is abandoned
and Retry is not offered.

This document is the only coupling between the Host change and the Desktop change.
The TypeScript source of truth is
[`mcp-host/src/core/conversation/modelStepCheckpointContract.ts`](../../mcp-host/src/core/conversation/modelStepCheckpointContract.ts).
Example payloads live in
[`tests/fixtures/model-step-checkpoint/`](../../tests/fixtures/model-step-checkpoint/);
the Host and Desktop test suites both load them, so a change on one side that the other
does not follow breaks a test.

## Read: session field

`GET /v1/runtime/sessions/:agent/:chatId/messages` (rpc-proxy:
`GET /api/v1/rpc/hosts/:hostRef/sessions/:agent/:chatId/messages`, a passthrough) adds an
optional `modelStepCheckpoint` next to `state`, `activeTaskId`, `pendingApproval` and
`tokens`.

| Field | Type | Notes |
|---|---|---|
| `checkpointId` | string | Stable for the life of the checkpoint, across re-claims. |
| `version` | number | Increases on every transition. The continuation POST echoes it. |
| `status` | `resumable` \| `claimed` \| `blocked` | `completed` and `abandoned` checkpoints are never served and are purged on the next five-minute sweep, except while the session's active task is the checkpoint's continuation task or a pending approval is bound to the checkpoint; those headers are purged on a later sweep. `open` checkpoints (a turn still recording its first tool steps) are never served. A claimed row with a lapsed lease and no live approval is projected as `resumable` at its stored version. Blocked rows retain their configured TTL. |
| `retryAvailable` | boolean | `true` only when `status` is `resumable`. |
| `originTaskId` | string | The failed task. It stays terminal. |
| `continuationTaskId` | string, optional | Present when `status` is `claimed`. |
| `provider`, `model` | string | The turn's configured pair: Host provider + session model resolved when the turn started. A continuation always uses this pair and never fails over, even when a fallback served earlier steps of the turn. |
| `blockedReason` | enum, optional | Present when `status` is `blocked`: `principal_mismatch`, `host_mismatch`, `grant_revoked`, `model_unavailable`, `budget_exhausted`, `reference_unavailable`, `attachment_expired` (the retained bytes of an inline uploaded file expired after their 1 h TTL or are missing; Resend still works). |
| `tools` | `{ confirmed, unknown, notDispatched }` | Counts only. `unknown` means a dispatch was recorded without a recorded result; such a tool is never re-executed. |
| `failedAt`, `expiresAt` | ISO-8601 string | |

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
Sources: [Host validation](../../mcp-host/src/server/routes.ts#L304),
[proxy trace and forwarding](../../rpc-proxy/src/routes/rpc.ts#L1042).

The status is checked first. The version is compared only when the status is `resumable`.

| Order | Checkpoint state | Response | Example |
|---|---|---|---|
| 1 | `abandoned`, `open`, missing, or another session | `404 { code: "model_step_checkpoint_not_found" }` | `continue-response.not-found.json` |
| 1b | `resumable`, `claimed` or `blocked` past `expiresAt`, with no live lease or same-task approval (before the sweep abandons it) | Same `404` as row 1 | `continue-response.not-found.json` |
| 2 | `completed` (before the next terminal sweep; then row 1) | `200 { taskId, checkpointId, status: "completed", replayed: true }` | `continue-response.completed.json` |
| 3 | `claimed`, lease or same-task approval live (any version) | `202 { taskId: continuationTaskId, checkpointId, status: "claimed", replayed: true }` | `continue-response.replayed.json` |
| 3b | `claimed`, lease expired and no live same-task approval (any version) | Re-claim: revalidate (row 6); on success `202 { taskId: <new>, checkpointId, status: "claimed", replayed: false }` | `continue-response.reclaimed.json` |
| 4 | `blocked` | `409 { code: "model_step_checkpoint_blocked", blockedReason }` | `continue-response.blocked.json` |
| 5 | `resumable`, other version | `409 { code: "model_step_checkpoint_version_mismatch", current: <view> }` | `continue-response.version-mismatch.json` |
| 6 | `resumable`, same version, revalidation fails | `409 { code: "model_step_checkpoint_blocked", blockedReason }`; the checkpoint becomes `blocked` | `continue-response.blocked.json` |
| 7 | `resumable`, same version, claim won | `202 { taskId, checkpointId, status: "claimed", replayed: false }` | `continue-response.claimed.json` |
| 7b | Claim won, then `reference_check_failed` | Same `202` as row 7; the ordinary async task result carries the file-reference error. The checkpoint is already `resumable` with a new version. | See below. |
| 7c | Claim won, then, within the 10 s verdict wait, the continuation finds it no longer owns the claim (a lease renewal returns `false`, or another claim or transition replaced its fence), or preparation fails and the claim is abandoned | `404 { code: "model_step_checkpoint_not_found" }`, synchronously. The checkpoint keeps the state its current owner gave it. | `continue-response.not-found.json` |

Every claim creates a new task id: the task lifecycle refuses a terminal id. "The same
continuation" means the same `checkpointId` and the same recorded entries.

After a `202`, Desktop attaches to `taskId` with the existing task-progress path.
A `202` acknowledges the task, not successful preparation. After
`reference_check_failed`, refresh the session checkpoint before retrying: sending
the old version gets row 5 rather than replaying the failed task.
Sources: [admission verdict response](../../mcp-host/src/agent/modelStepContinuation.ts#L262),
[reference failure releases the claim](../../mcp-host/src/agent/taskExecutor.ts#L1286).

Other responses are outside the checkpoint-state table:

- Host `400 { error }`: invalid route segments, a version that is not a positive
  safe integer, or invalid trace context; `401 { error: "Missing rpc edge caller context" }`;
  `501 { error: "Model-step continuation handler not configured" }`;
  `500 { error: "Model-step continuation failed" }`.
  The `500` is also returned after a won claim when, within the verdict wait,
  admission cannot enqueue the task, a claim lease renewal fails with a worker
  error (the checkpoint stays `claimed` until its lease expires), or the
  transition to `blocked` cannot be stored. The task fails through the ordinary
  task-result path; no `202` is sent.
  [Host route](../../mcp-host/src/server/routes.ts#L304),
  [admission error](../../mcp-host/src/agent/modelStepContinuation.ts#L228).
- Host `503 { code: "host_draining" }` enters the proxy's wake-and-hold path.
  If the Host is still waking when the hold ends, the proxy may return
  `503 { code: "host_waking", hostRef, retryAfterMs, message, lastKnownState }`
  with `Retry-After` in seconds.
  [Host lifecycle gate](../../mcp-host/src/server.ts#L493),
  [proxy wake handling](../../rpc-proxy/src/routes/rpc.ts#L1123),
  [wake response](../../rpc-proxy/src/services/wakeAndHold.ts#L621).
- An async `TaskError` may contain `modelStepCheckpointId` when the failed model
  step leaves a checkpoint. Continuation preparation can also report
  `model_step_checkpoint_blocked` or `model_step_checkpoint_not_found` through
  the task-result path, including after the admission response's verdict wait ends.
  [Task error field](../../mcp-host/src/queue/types.ts#L40),
  [emission](../../mcp-host/src/agent/taskExecutor.ts#L1754),
  [preparation errors](../../mcp-host/src/agent/taskExecutor.ts#L783).

## Deploy order

Roll out **rpc-proxy before mcp-host**. The Host continuation route requires the
proxy-authored trace header above; a request without it gets `400` without
consuming the checkpoint. Deploying the proxy first makes its public continuation
route available before the Host can advertise Retry.
Sources: [Host header guard](../../mcp-host/src/server/routes.ts#L330),
[proxy continuation route](../../rpc-proxy/src/routes/rpc.ts#L1021).

## Example files

`session-view.{resumable,claimed,blocked}.json` hold one `ModelStepCheckpointView` each.
There is no `completed` view file, because a completed checkpoint is not served.

`continue-response.*.json` hold `{ "httpStatus": number, "body": <response> }`.
