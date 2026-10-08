# Model-step checkpoint wire contract

Issues: [#1043](https://github.com/evenfire-ai/evenfire/issues/1043) (Host) and
[#1044](https://github.com/evenfire-ai/evenfire/issues/1044) (Desktop).

When a tool-use turn fails because the provider returned `provider_unavailable`
(HTTP 503 or a failed SSE terminal), and at least one tool result in that turn was
already confirmed, the Host keeps the turn's tool protocol in a durable checkpoint.
Desktop then offers **Retry model step**: a continuation of the same logical turn that
replays the confirmed tool results to the model and never re-executes those tools.
It is distinct from Resend, which re-sends the user's original message.

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
| `status` | `resumable` \| `claimed` \| `blocked` | `completed` and `abandoned` checkpoints are never served: the field is absent. |
| `retryAvailable` | boolean | `true` only when `status` is `resumable`. |
| `originTaskId` | string | The failed task. It stays terminal. |
| `continuationTaskId` | string, optional | Present when `status` is `claimed`. |
| `provider`, `model` | string | The effective selection when the checkpoint was created. A continuation always uses these. |
| `blockedReason` | enum, optional | Present when `status` is `blocked`: `principal_mismatch`, `host_mismatch`, `grant_revoked`, `model_unavailable`, `budget_exhausted`, `reference_unavailable`, `attachment_expired` (the retained bytes of an inline uploaded file expired after their 1 h TTL or are missing; Resend still works). |
| `tools` | `{ confirmed, unknown, notDispatched }` | Counts only. `unknown` means a dispatch was recorded without a recorded result; such a tool is never re-executed. |
| `failedAt`, `expiresAt` | ISO-8601 string | |

The field never carries the transcript, tool arguments or tool results.

A new user message (or a Resend) in the session retires the previous checkpoint when
that message is admitted, so the field disappears before the new turn runs.

## Write: continuation

`POST /v1/runtime/sessions/:agent/:chatId/model-step-checkpoints/:checkpointId/continue`
(rpc-proxy:
`POST /api/v1/rpc/hosts/:hostRef/sessions/:agent/:chatId/model-step-checkpoints/:checkpointId/continue`),
body `{ "version": number }`. Same edge guard as `POST /v1/runtime/messages`: caller
`rpc-proxy`, with a `userId` equal to the session owner; the lifecycle drain gate
answers `503 host_draining`.

The status is checked first. The version is compared only when the status is `resumable`.

| Order | Checkpoint state | Response | Example |
|---|---|---|---|
| 1 | `abandoned`, missing, or another session | `404 { code: "model_step_checkpoint_not_found" }` | `continue-response.not-found.json` |
| 2 | `completed` | `200 { taskId, checkpointId, status: "completed", replayed: true }` | `continue-response.completed.json` |
| 3 | `claimed`, lease live (any version) | `202 { taskId: continuationTaskId, checkpointId, status: "claimed", replayed: true }` | `continue-response.replayed.json` |
| 3b | `claimed`, lease expired (any version) | Re-claim: revalidate (row 6); on success `202 { taskId: <new>, checkpointId, status: "claimed", replayed: false }` | `continue-response.reclaimed.json` |
| 4 | `blocked` | `409 { code: "model_step_checkpoint_blocked", blockedReason }` | `continue-response.blocked.json` |
| 5 | `resumable`, other version | `409 { code: "model_step_checkpoint_version_mismatch", current: <view> }` | `continue-response.version-mismatch.json` |
| 6 | `resumable`, same version, revalidation fails | `409 { code: "model_step_checkpoint_blocked", blockedReason }`; the checkpoint becomes `blocked` | `continue-response.blocked.json` |
| 6b | `resumable`, same version, revalidation could not run (transient GFS or credential failure) | `503 { code: "model_step_checkpoint_check_unavailable", current: <view> }`; the claim is released and the checkpoint is `resumable` again under a new version (every transition bumps it), so the client retries with `current.version` | `continue-response.check-unavailable.json` |
| 7 | `resumable`, same version, claim won | `202 { taskId, checkpointId, status: "claimed", replayed: false }` | `continue-response.claimed.json` |

Every claim creates a new task id: the task lifecycle refuses a terminal id. "The same
continuation" means the same `checkpointId` and the same recorded entries.

After a `202`, Desktop attaches to `taskId` with the existing task-progress path.

## Example files

`session-view.{resumable,claimed,blocked}.json` hold one `ModelStepCheckpointView` each.
There is no `completed` view file, because a completed checkpoint is not served.

`continue-response.*.json` hold `{ "httpStatus": number, "body": <response> }`.
