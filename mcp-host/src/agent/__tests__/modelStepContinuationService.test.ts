/**
 * #1043 — the continuation service: status-first claim precedence over the
 * real SQLite checkpoint store, Host revalidation before admission, the first
 * verdict from the continuation task and the bounded wait that answers 202.
 *
 * Only `enqueue` is fake: it captures the continuation the executor would run
 * and lets the test emit the verdict. The store, its fence, its versions and
 * its CAS are the production ones.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ConversationManager } from '../../core/conversation/conversation'
import {
  MODEL_STEP_CONTINUE_ERROR_CODES,
  type ModelStepContinueClaimed,
  type ModelStepContinueVersionMismatch,
} from '../../core/conversation/modelStepCheckpointContract'
import {
  type StoreHandle,
  makeSqliteStore,
} from '../../core/conversation/persistence/__tests__/testHelpers'
import { ModelStepCheckpointStore } from '../../core/conversation/persistence/modelStepCheckpointStore'
import type {
  ModelStepCheckpointEntryInput,
  ModelStepCheckpointFence,
  ModelStepCheckpointOpenHeader,
} from '../../db/worker/modelStepCheckpointOps'
import { logger } from '../../logger'
import type { ModelStepContinuationRef, ModelStepContinuationVerdict } from '../../queue/types'
import type { IncomingMessage } from '../../server'
import {
  MODEL_STEP_CONTINUATION_VERDICT_TIMEOUT_MS,
  type ModelStepContinuationRequest,
  ModelStepContinuationService,
} from '../modelStepContinuation'
import type { ModelStepCheckpointSupport } from '../types'

/** The same vectors the Desktop suite (#1044) loads. */
const VECTOR_DIR = path.join(__dirname, '../../../../tests/fixtures/model-step-checkpoint')

const NOW = 1_700_000_000_000
const RESUMABLE_TTL_MS = 7 * 24 * 3_600_000
const ATTACHMENT_TTL_MS = 3_600_000
const LEASE_MS = 300_000
const HOST_ID = 'host-a'
const HOST_INSTANCE_ID = 'host-instance-1'
const USER_ID = 'user-1043'
const AGENT = 'agent-x'
const CHAT_ID = 'chat-1'
const SESSION_KEY = `${USER_ID}:rpc:${AGENT}:${CHAT_ID}`
/** The session suffix rpc-proxy and the session routes use for a blank threadId. */
const DEFAULT_CHAT_ID = 'default'
const DEFAULT_SESSION_KEY = `${USER_ID}:rpc:${AGENT}:${DEFAULT_CHAT_ID}`
const CHECKPOINT_ID = 'cp-1043'
const ORIGIN_TASK_ID = 'task-origin'
const ORIGIN_TURN_NUMBER = 3
const ATTACHMENT_ID = 'attachment-1'
const ATTACHMENT_TEXT = 'inline file bytes of the default session'
const ATTACHMENT_BYTES = Buffer.from(ATTACHMENT_TEXT, 'utf8')
const ATTACHMENT_DIGEST = createHash('sha256').update(ATTACHMENT_BYTES).digest('hex')

const openHandles: StoreHandle[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const handle of openHandles.splice(0)) await handle.shutdown()
})

interface Vector {
  httpStatus: number
  body: Record<string, unknown>
}

function readVector(name: string): Vector {
  return JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, name), 'utf8')) as Vector
}

/** Key-set equality against a vector: the shape is the contract, the ids are not. */
function expectKeysAsInVector(actual: unknown, vector: unknown, label: string): void {
  expect(Object.keys(actual as object).sort(), label).toEqual(Object.keys(vector as object).sort())
}

function sourceMessage(): IncomingMessage {
  return {
    content: 'summarize the repository',
    channelType: 'rpc',
    channelId: AGENT,
    sender: USER_ID,
    timestamp: '2026-10-07T23:58:23.000Z',
    messageId: 'message-original',
    hostRef: 'chatllm',
    threadId: CHAT_ID,
  }
}

interface HeaderOverrides {
  principal?: string
  hostId?: string
  checkpointId?: string
  /** Defaults to {@link SESSION_KEY}; a default-session checkpoint overrides it. */
  sessionKey?: string
  /** Explicit `null` stores no source message; `undefined` stores the valid one. */
  sourceMessage?: string | null
  originTurnNumber?: number
}

function header(overrides: HeaderOverrides = {}): ModelStepCheckpointOpenHeader {
  return {
    checkpointId: overrides.checkpointId ?? CHECKPOINT_ID,
    sessionKey: overrides.sessionKey ?? SESSION_KEY,
    originTurnNumber: overrides.originTurnNumber ?? ORIGIN_TURN_NUMBER,
    originTaskId: ORIGIN_TASK_ID,
    provider: 'codex-subscription',
    model: 'gpt-6.1-sol',
    hostId: overrides.hostId ?? HOST_ID,
    principal: overrides.principal ?? USER_ID,
    loopState: JSON.stringify({ iteration: 4 }),
    taskBudget: JSON.stringify({ elapsedActiveMs: 1_234 }),
    sourceMessage:
      overrides.sourceMessage === undefined
        ? JSON.stringify(sourceMessage())
        : overrides.sourceMessage,
  }
}

const userEntry: ModelStepCheckpointEntryInput = {
  kind: 'message',
  toolCallId: null,
  payload: JSON.stringify({ role: 'user', content: 'summarize the repository' }),
}
const dispatch = (id: string): ModelStepCheckpointEntryInput => ({
  kind: 'tool_dispatch',
  toolCallId: id,
  payload: JSON.stringify({ name: 'list_files' }),
})
const toolResult = (id: string): ModelStepCheckpointEntryInput => ({
  kind: 'tool_result',
  toolCallId: id,
  payload: JSON.stringify({ name: 'list_files', isError: false }),
})

/**
 * Opens one checkpoint with a confirmed and an unknown tool call and moves it
 * to `resumable` (version 2).
 */
async function openResumable(
  checkpoints: ModelStepCheckpointStore,
  overrides: HeaderOverrides = {}
): Promise<{ fence: ModelStepCheckpointFence; version: number }> {
  const fence = await checkpoints.open(header(overrides), [userEntry])
  expect(
    await checkpoints.append(SESSION_KEY, fence, [
      dispatch('tc-1'),
      toolResult('tc-1'),
      dispatch('tc-2'),
    ])
  ).toBe(true)
  const version = await checkpoints.transition(SESSION_KEY, fence, {
    from: ['open'],
    to: 'resumable',
    failedAt: NOW,
    expiresAt: NOW + RESUMABLE_TTL_MS,
  })
  expect(version).toBe(2)
  return { fence, version: version as number }
}

function checkpointRow(handle: StoreHandle, checkpointId: string): Record<string, unknown> {
  const row = handle.worker.db
    .prepare('SELECT * FROM model_step_checkpoints WHERE checkpoint_id = ?')
    .get(checkpointId) as Record<string, unknown> | undefined
  if (!row) throw new Error(`checkpoint ${checkpointId} is missing`)
  return row
}

function continuationRequest(version: number): ModelStepContinuationRequest {
  return { userId: USER_ID, agent: AGENT, chatId: CHAT_ID, checkpointId: CHECKPOINT_ID, version }
}

interface EnqueueCall {
  message: IncomingMessage
  taskId: string
  continuation: ModelStepContinuationRef
}

interface Harness {
  handle: StoreHandle
  checkpoints: ModelStepCheckpointStore
  service: ModelStepContinuationService
  enqueue: ReturnType<typeof vi.fn>
  /** Resolves with the continuation the service admitted. */
  captured: Promise<EnqueueCall>
}

function createHarness(
  options: { hostId?: string; verdict?: ModelStepContinuationVerdict; now?: () => number } = {}
): Harness {
  const handle = makeSqliteStore()
  openHandles.push(handle)
  const now = options.now ?? (() => NOW)
  const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
    now,
    blockedTtlMs: RESUMABLE_TTL_MS,
  })
  const support: ModelStepCheckpointSupport = {
    store: checkpoints,
    hostInstanceId: HOST_INSTANCE_ID,
    hostId: options.hostId ?? HOST_ID,
    resumableTtlMs: RESUMABLE_TTL_MS,
    claimLeaseMs: LEASE_MS,
    pendingApprovalTtlMs: RESUMABLE_TTL_MS,
    attachmentTtlMs: ATTACHMENT_TTL_MS,
  }
  let resolveCaptured: (call: EnqueueCall) => void = () => {}
  const captured = new Promise<EnqueueCall>(resolve => {
    resolveCaptured = resolve
  })
  const enqueue = vi.fn(
    async (message: IncomingMessage, taskId: string, continuation: ModelStepContinuationRef) => {
      resolveCaptured({ message, taskId, continuation })
      if (options.verdict) continuation.onVerdict(options.verdict)
    }
  )
  const service = new ModelStepContinuationService({
    checkpoints: support,
    conversationManager: new ConversationManager(handle.store),
    enqueue,
  })
  return { handle, checkpoints, service, enqueue, captured }
}

describe('ModelStepContinuationService — status-first claim precedence (#1043)', () => {
  it('answers the not-found vector for a missing checkpoint and for an abandoned one', async () => {
    const { checkpoints, service } = createHarness()
    const notFound = readVector('continue-response.not-found.json')

    const missing = await service.continue(continuationRequest(1))
    expect(missing.status).toBe(notFound.httpStatus)
    expect(missing.body).toEqual(notFound.body)

    const fence = await checkpoints.open(header(), [userEntry])
    expect(
      await checkpoints.transition(SESSION_KEY, fence, { from: ['open'], to: 'abandoned' })
    ).toBe(2)
    const abandoned = await service.continue(continuationRequest(1))
    expect(abandoned.status).toBe(404)
    expect(abandoned.body).toEqual({ code: MODEL_STEP_CONTINUE_ERROR_CODES.notFound })
  })

  it('answers 200 replayed with the completed task id, whatever version the POST carries', async () => {
    const { checkpoints, service } = createHarness()
    const { version } = await openResumable(checkpoints)
    const claim = await checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: CHECKPOINT_ID,
      version,
      hostInstanceId: 'host-instance-2',
      newTaskId: 'task-completed',
      leaseMs: LEASE_MS,
    })
    if (claim.outcome !== 'claimed') throw new Error(`unexpected claim: ${claim.outcome}`)
    expect(
      await checkpoints.transition(SESSION_KEY, claim.fence, {
        from: ['claimed'],
        to: 'completed',
      })
    ).toBe(4)

    const result = await service.continue(continuationRequest(1))
    const fixture = readVector('continue-response.completed.json')
    expect(result.status).toBe(fixture.httpStatus)
    expect(result.body).toEqual({
      taskId: 'task-completed',
      checkpointId: CHECKPOINT_ID,
      status: 'completed',
      replayed: true,
    })
    expectKeysAsInVector(result.body, fixture.body, 'completed body')
  })

  it('answers 202 replayed with the live claim task id', async () => {
    const { checkpoints, service } = createHarness()
    const { version } = await openResumable(checkpoints)
    const claim = await checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: CHECKPOINT_ID,
      version,
      hostInstanceId: HOST_INSTANCE_ID,
      newTaskId: 'task-live',
      leaseMs: LEASE_MS,
    })
    if (claim.outcome !== 'claimed') throw new Error(`unexpected claim: ${claim.outcome}`)

    const result = await service.continue(continuationRequest(version))
    const fixture = readVector('continue-response.replayed.json')
    expect(result.status).toBe(202)
    expect(result.body).toEqual({
      taskId: 'task-live',
      checkpointId: CHECKPOINT_ID,
      status: 'claimed',
      replayed: true,
    })
    expectKeysAsInVector(result.body, fixture.body, 'replayed body')
  })

  it('re-claims a lapsed lease on a new instance of the same Host CRD and answers 202', async () => {
    let now = NOW
    const { handle, checkpoints, service, enqueue, captured } = createHarness({
      now: () => now,
      verdict: { kind: 'started' },
    })
    const { version } = await openResumable(checkpoints)
    const stale = await checkpoints.claim({
      sessionKey: SESSION_KEY,
      checkpointId: CHECKPOINT_ID,
      version,
      hostInstanceId: 'host-instance-old',
      newTaskId: 'task-stale',
      leaseMs: LEASE_MS,
    })
    if (stale.outcome !== 'claimed') throw new Error(`unexpected claim: ${stale.outcome}`)

    // The old continuation Host died without a verdict and its lease lapsed.
    now = NOW + LEASE_MS + 1
    // The echoed version is the one the client last saw; a lapsed claim is
    // decided by its status and expiry, never by that version.
    const result = await service.continue(continuationRequest(version))
    const call = await captured
    const fixture = readVector('continue-response.reclaimed.json')
    expect(result.status).toBe(202)
    expect(result.body).toEqual({
      taskId: call.taskId,
      checkpointId: CHECKPOINT_ID,
      status: 'claimed',
      replayed: false,
    })
    expectKeysAsInVector(result.body, fixture.body, 'reclaimed body')
    expect(call.taskId).not.toBe(stale.taskId)
    expect(call.continuation.fence).toEqual({
      checkpointId: CHECKPOINT_ID,
      owner: HOST_INSTANCE_ID,
      generation: 2,
    })
    expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({
      status: 'claimed',
      continuation_task_id: call.taskId,
      claim_generation: 2,
      version: version + 2,
    })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('answers 409 with the current view when a resumable version does not match', async () => {
    // The store and the wire projection must observe the same test clock.
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const { handle, checkpoints, service } = createHarness()
    const { version } = await openResumable(checkpoints)
    const fixture = readVector('continue-response.version-mismatch.json')

    const result = await service.continue(continuationRequest(version + 1))
    expect(result.status).toBe(fixture.httpStatus)
    const body = result.body as ModelStepContinueVersionMismatch
    expect(body.code).toBe(MODEL_STEP_CONTINUE_ERROR_CODES.versionMismatch)
    expectKeysAsInVector(body, fixture.body, 'version-mismatch body')
    expectKeysAsInVector(body.current, fixture.body.current, 'version-mismatch current view')
    expect(body.current).toMatchObject({
      checkpointId: CHECKPOINT_ID,
      version,
      status: 'resumable',
      retryAvailable: true,
      originTaskId: ORIGIN_TASK_ID,
      provider: 'codex-subscription',
      model: 'gpt-6.1-sol',
      tools: { confirmed: 1, unknown: 1, notDispatched: 0 },
    })
    expect(body.current.failedAt).toBe(new Date(NOW).toISOString())
    expect(body.current.expiresAt).toBe(new Date(NOW + RESUMABLE_TTL_MS).toISOString())
    // The rejected CAS wrote nothing.
    expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({
      status: 'resumable',
      version,
    })
  })

  it('answers the blocked vector for a blocked checkpoint before comparing versions', async () => {
    const { handle, checkpoints, service } = createHarness()
    const { fence } = await openResumable(checkpoints)
    expect(
      await checkpoints.transition(SESSION_KEY, fence, {
        from: ['resumable'],
        to: 'blocked',
        blockedReason: 'budget_exhausted',
      })
    ).toBe(3)

    // The POST deliberately carries a version the row does not have: a blocked
    // checkpoint is answered by its status, before any version comparison.
    const result = await service.continue(continuationRequest(999))
    const fixture = readVector('continue-response.blocked.json')
    expect(result.status).toBe(fixture.httpStatus)
    expect(result.body).toEqual(fixture.body)
    // The status-first answer wrote nothing: reason and version survive it.
    expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({
      status: 'blocked',
      blocked_reason: 'budget_exhausted',
      version: 3,
    })
  })
})

describe('ModelStepContinuationService — default session (#1043)', () => {
  /**
   * The stored source message of a session the client opened without a
   * threadId: rpc-proxy forwards `threadId: undefined`, so the persisted JSON
   * carries no `threadId` key at all.
   */
  function defaultSessionHeader(checkpointId: string): ModelStepCheckpointOpenHeader {
    const stored = sourceMessage()
    delete stored.threadId
    return {
      ...header({ checkpointId, sessionKey: DEFAULT_SESSION_KEY }),
      sourceMessage: JSON.stringify(stored),
    }
  }

  async function openDefaultSessionResumable(
    checkpoints: ModelStepCheckpointStore,
    checkpointId: string
  ): Promise<{ fence: ModelStepCheckpointFence; version: number }> {
    const fence = await checkpoints.open(defaultSessionHeader(checkpointId), [userEntry])
    expect(
      await checkpoints.append(DEFAULT_SESSION_KEY, fence, [
        dispatch('tc-1'),
        toolResult('tc-1'),
        dispatch('tc-2'),
      ])
    ).toBe(true)
    const version = await checkpoints.transition(DEFAULT_SESSION_KEY, fence, {
      from: ['open'],
      to: 'resumable',
      failedAt: NOW,
      expiresAt: NOW + RESUMABLE_TTL_MS,
      attachments: [
        {
          attachmentId: ATTACHMENT_ID,
          digestHex: ATTACHMENT_DIGEST,
          bytes: ATTACHMENT_BYTES,
          expiresAt: NOW + ATTACHMENT_TTL_MS,
        },
      ],
    })
    expect(version).toBe(2)
    return { fence, version: version as number }
  }

  it('keeps the claim live and the inline bytes readable when the threadId was blank', async () => {
    const { handle, checkpoints, service, enqueue, captured } = createHarness({
      verdict: { kind: 'started' },
    })
    const { version } = await openDefaultSessionResumable(checkpoints, CHECKPOINT_ID)

    // The client addresses the default session as `default`; its source message
    // omitted the threadId, so an identity comparison on the raw field would
    // mismatch and abandon the claim with its inline bytes.
    const result = await service.continue({
      userId: USER_ID,
      agent: AGENT,
      chatId: DEFAULT_CHAT_ID,
      checkpointId: CHECKPOINT_ID,
      version,
    })

    const call = await captured
    const fixture = readVector('continue-response.claimed.json')
    expect(result.status).toBe(fixture.httpStatus)
    expect(result.body).toEqual({
      taskId: call.taskId,
      checkpointId: CHECKPOINT_ID,
      status: 'claimed',
      replayed: false,
    })
    expectKeysAsInVector(result.body, fixture.body, 'default-session claimed body')
    expect(enqueue).toHaveBeenCalledTimes(1)
    // The re-admitted message stays in the same default session.
    expect(call.message.threadId).toBeUndefined()
    expect(call.continuation.fence).toEqual({
      checkpointId: CHECKPOINT_ID,
      owner: HOST_INSTANCE_ID,
      generation: 1,
    })
    // Live witness: the claim survives and its inline bytes are still readable.
    expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({
      status: 'claimed',
      continuation_task_id: call.taskId,
      claim_generation: 1,
      version: version + 1,
    })
    const attachments = await checkpoints.loadAttachments(DEFAULT_SESSION_KEY, CHECKPOINT_ID)
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      attachment_id: ATTACHMENT_ID,
      digest_hex: ATTACHMENT_DIGEST,
      size_bytes: ATTACHMENT_BYTES.byteLength,
    })
    expect(Buffer.from(attachments[0].bytes).toString('utf8')).toBe(ATTACHMENT_TEXT)
  })
})

describe('ModelStepContinuationService — Host revalidation (#1043)', () => {
  it('blocks a claim whose principal is not the session owner, without enqueueing', async () => {
    const { handle, checkpoints, service, enqueue } = createHarness({
      verdict: { kind: 'started' },
    })
    const { version } = await openResumable(checkpoints, { principal: 'user-other' })

    const result = await service.continue(continuationRequest(version))
    expect(result).toEqual({
      status: 409,
      body: {
        code: MODEL_STEP_CONTINUE_ERROR_CODES.blocked,
        blockedReason: 'principal_mismatch',
      },
    })
    // Witness that the claim ran: owner set, generation bumped, row blocked.
    expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({
      status: 'blocked',
      blocked_reason: 'principal_mismatch',
      claim_owner: HOST_INSTANCE_ID,
      claim_generation: 1,
      version: version + 2,
    })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('blocks a claim recorded for another Host CRD, without enqueueing', async () => {
    const { handle, checkpoints, service, enqueue } = createHarness({
      hostId: 'host-b',
      verdict: { kind: 'started' },
    })
    const { version } = await openResumable(checkpoints)

    const result = await service.continue(continuationRequest(version))
    expect(result).toEqual({
      status: 409,
      body: { code: MODEL_STEP_CONTINUE_ERROR_CODES.blocked, blockedReason: 'host_mismatch' },
    })
    expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({
      status: 'blocked',
      blocked_reason: 'host_mismatch',
      claim_generation: 1,
      version: version + 2,
    })
    expect(enqueue).not.toHaveBeenCalled()
  })
})

describe('ModelStepContinuationService — verdicts and admission (#1043)', () => {
  it('answers 202 replayed:false with the claim task id once the continuation started', async () => {
    const { checkpoints, service, captured } = createHarness({ verdict: { kind: 'started' } })
    const { version } = await openResumable(checkpoints)
    const fixture = readVector('continue-response.claimed.json')

    const result = await service.continue(continuationRequest(version))
    const call = await captured
    expect(result.status).toBe(fixture.httpStatus)
    expect(result.body).toEqual({
      taskId: call.taskId,
      checkpointId: CHECKPOINT_ID,
      status: 'claimed',
      replayed: false,
    })
    expectKeysAsInVector(result.body, fixture.body, 'claimed body')
  })

  it('answers 409 with the blocked reason the continuation reported', async () => {
    const { handle, checkpoints, service, captured } = createHarness()
    const { version } = await openResumable(checkpoints)

    const pending = service.continue(continuationRequest(version))
    const call = await captured
    // What the executor does before reporting the block: claimed -> blocked.
    expect(
      await checkpoints.transition(SESSION_KEY, call.continuation.fence, {
        from: ['claimed'],
        to: 'blocked',
        blockedReason: 'model_unavailable',
      })
    ).toBe(version + 2)
    call.continuation.onVerdict({ kind: 'blocked', blockedReason: 'model_unavailable' })

    const result = await pending
    expect(result).toEqual({
      status: 409,
      body: {
        code: MODEL_STEP_CONTINUE_ERROR_CODES.blocked,
        blockedReason: 'model_unavailable',
      },
    })
    expect((result.body as { code: string }).code).toBe(
      readVector('continue-response.blocked.json').body.code
    )
    expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({
      status: 'blocked',
      blocked_reason: 'model_unavailable',
    })
  })

  it('answers 404 when the continuation lost its fence before starting', async () => {
    const { handle, checkpoints, service } = createHarness({ verdict: { kind: 'lost' } })
    const { version } = await openResumable(checkpoints)

    const result = await service.continue(continuationRequest(version))
    expect(result).toEqual({
      status: 404,
      body: { code: MODEL_STEP_CONTINUE_ERROR_CODES.notFound },
    })
    // The lost verdict does not rewrite the row it no longer owns.
    expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({
      status: 'claimed',
      version: version + 1,
    })
  })

  it('answers 202 after a file-reference check failure released the claim to resumable', async () => {
    const { handle, checkpoints, service, enqueue, captured } = createHarness()
    const { version } = await openResumable(checkpoints)
    const fixture = readVector('continue-response.claimed.json')

    const pending = service.continue(continuationRequest(version))
    const call = await captured
    // What the executor does before emitting the verdict: claimed -> resumable.
    const releasedVersion = await checkpoints.transition(SESSION_KEY, call.continuation.fence, {
      from: ['claimed'],
      to: 'resumable',
      failedAt: NOW,
      expiresAt: NOW + RESUMABLE_TTL_MS,
    })
    expect(releasedVersion).toBe(version + 2)
    call.continuation.onVerdict({ kind: 'reference_check_failed' })

    // The task exists; its file-reference error arrives through the ordinary
    // async task result, exactly as message admission reports it.
    const result = await pending
    expect(result.status).toBe(fixture.httpStatus)
    const body = result.body as ModelStepContinueClaimed
    expectKeysAsInVector(body, fixture.body, 'claimed body')
    expect(body).toMatchObject({ checkpointId: CHECKPOINT_ID, status: 'claimed', replayed: false })
    expect(body.taskId).toBe(call.taskId)
    expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({
      status: 'resumable',
      version: releasedVersion,
    })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('answers 202 replayed:false only after the bounded verdict wait', async () => {
    vi.useFakeTimers()
    const { checkpoints, service } = createHarness()
    const { version } = await openResumable(checkpoints)

    const pending = service.continue(continuationRequest(version))
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(MODEL_STEP_CONTINUATION_VERDICT_TIMEOUT_MS - 1)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    const result = await pending
    expect(settled).toBe(true)
    expect(result.status).toBe(202)
    expect(result.body).toMatchObject({ status: 'claimed', replayed: false })
  })
})

describe('ModelStepContinuationService — admission failures (#1043)', () => {
  it('abandons the claim and rethrows when the stored source message belongs elsewhere', async () => {
    const { handle, checkpoints, service, enqueue } = createHarness({
      verdict: { kind: 'started' },
    })
    const { version } = await openResumable(checkpoints, {
      sourceMessage: JSON.stringify({ ...sourceMessage(), sender: 'user-other' }),
    })

    await expect(service.continue(continuationRequest(version))).rejects.toThrow(
      'Model-step checkpoint source message does not match its session'
    )
    expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({
      status: 'abandoned',
      claim_generation: 1,
      version: version + 2,
    })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('abandons the claim and rethrows when the checkpoint kept no source message', async () => {
    const { handle, checkpoints, service, enqueue } = createHarness({
      verdict: { kind: 'started' },
    })
    const { version } = await openResumable(checkpoints, { sourceMessage: null })

    await expect(service.continue(continuationRequest(version))).rejects.toThrow(
      'Model-step checkpoint has no source message'
    )
    expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({
      status: 'abandoned',
      claim_generation: 1,
    })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it.each(['sender', 'threadId'] as const)(
    'rejects a source message whose %s only coerces to the session key',
    async field => {
      const { handle, checkpoints, service, enqueue, captured } = createHarness({
        verdict: { kind: 'started' },
      })
      // A one-element array serializes into the same session key as its plain
      // string field, so the source validation must reject the array itself.
      const { version } = await openResumable(checkpoints, {
        sourceMessage: JSON.stringify({
          ...sourceMessage(),
          [field]: [field === 'sender' ? USER_ID : CHAT_ID],
        }),
      })

      await expect(service.continue(continuationRequest(version))).rejects.toThrow(
        'Model-step checkpoint source message does not match its session'
      )
      expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({
        status: 'abandoned',
        claim_generation: 1,
      })
      expect(enqueue).not.toHaveBeenCalled()

      // Positive liveness witness: the identical message with the field as a
      // plain string continues through the ordinary path.
      const validCheckpointId = 'cp-sender-string-1043'
      const { version: validVersion } = await openResumable(checkpoints, {
        checkpointId: validCheckpointId,
      })
      const valid = await service.continue({
        userId: USER_ID,
        agent: AGENT,
        chatId: CHAT_ID,
        checkpointId: validCheckpointId,
        version: validVersion,
      })
      const call = await captured
      expect(valid.status).toBe(202)
      expect(valid.body).toMatchObject({ taskId: call.taskId, status: 'claimed', replayed: false })
      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(checkpointRow(handle, validCheckpointId)).toMatchObject({ status: 'claimed' })
    }
  )

  it('abandons the claim and rethrows when admission itself fails', async () => {
    const handle = makeSqliteStore()
    openHandles.push(handle)
    const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
      now: () => NOW,
      blockedTtlMs: RESUMABLE_TTL_MS,
    })
    const failure = new Error('continuation admission failed')
    const enqueue = vi.fn(async () => {
      throw failure
    })
    const service = new ModelStepContinuationService({
      checkpoints: {
        store: checkpoints,
        hostInstanceId: HOST_INSTANCE_ID,
        hostId: HOST_ID,
        resumableTtlMs: RESUMABLE_TTL_MS,
        claimLeaseMs: LEASE_MS,
        pendingApprovalTtlMs: RESUMABLE_TTL_MS,
        attachmentTtlMs: ATTACHMENT_TTL_MS,
      },
      conversationManager: new ConversationManager(handle.store),
      enqueue,
    })
    const { version } = await openResumable(checkpoints)

    await expect(service.continue(continuationRequest(version))).rejects.toThrow(failure)
    expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({
      status: 'abandoned',
      claim_generation: 1,
      version: version + 2,
    })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it('resets a reopened session atomically when admission fails before dispatch', async () => {
    const handle = makeSqliteStore()
    openHandles.push(handle)
    const manager = new ConversationManager(handle.store)
    const conversation = await manager.getOrCreate(SESSION_KEY, {
      userId: USER_ID,
      channelType: 'rpc',
      channelId: AGENT,
      threadId: CHAT_ID,
      source: 'rpc',
    })
    await manager.startTurn(conversation, sourceMessage().content, ORIGIN_TASK_ID)
    await manager.failTurn(conversation)
    const checkpoints = new ModelStepCheckpointStore(handle.persistQueue, {
      now: () => NOW,
      blockedTtlMs: RESUMABLE_TTL_MS,
    })
    const { version } = await openResumable(checkpoints, { originTurnNumber: 1 })
    const failure = new Error('enqueue rejected after turn reopen')
    const service = new ModelStepContinuationService({
      checkpoints: {
        store: checkpoints,
        hostInstanceId: HOST_INSTANCE_ID,
        hostId: HOST_ID,
        resumableTtlMs: RESUMABLE_TTL_MS,
        claimLeaseMs: LEASE_MS,
        pendingApprovalTtlMs: RESUMABLE_TTL_MS,
        attachmentTtlMs: ATTACHMENT_TTL_MS,
      },
      conversationManager: manager,
      enqueue: async (_message, taskId) => {
        await manager.resumeTurnForContinuation(conversation, taskId, 1, null)
        throw failure
      },
    })

    await expect(service.continue(continuationRequest(version))).rejects.toThrow(failure)
    expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({ status: 'abandoned' })
    expect(
      handle.worker.db
        .prepare('SELECT state, active_task_id FROM sessions WHERE session_key = ?')
        .get(SESSION_KEY)
    ).toEqual({ state: 'idle', active_task_id: null })
    expect(conversation.state).toBe('idle')
    await manager.startTurn(conversation, 'new request after failed admission', 'task-new')
    expect(conversation.activeTaskId).toBe('task-new')
  })

  it('re-admits the stored source message under a fresh messageId', async () => {
    const { checkpoints, service, captured } = createHarness({ verdict: { kind: 'started' } })
    const { version } = await openResumable(checkpoints)
    const stored = sourceMessage()

    const result = await service.continue(continuationRequest(version))
    const call = await captured
    expect(result.status).toBe(202)
    expect(call.taskId).toBe((result.body as ModelStepContinueClaimed).taskId)
    // A reused messageId would hit the delivery dedupe of the original turn.
    expect(call.message.messageId).toMatch(/^[0-9a-f-]{36}$/)
    expect(call.message.messageId).not.toBe(stored.messageId)
    expect(call.message).toMatchObject({
      content: stored.content,
      channelType: 'rpc',
      channelId: AGENT,
      sender: USER_ID,
      threadId: CHAT_ID,
      timestamp: stored.timestamp,
      hostRef: stored.hostRef,
    })
    expect(call.continuation).toMatchObject({
      checkpointId: CHECKPOINT_ID,
      originTaskId: ORIGIN_TASK_ID,
      originTurnNumber: ORIGIN_TURN_NUMBER,
      provider: 'codex-subscription',
      model: 'gpt-6.1-sol',
      confirmedResults: 1,
      taskBudget: header().taskBudget,
    })
    expect(call.continuation.fence).toEqual({
      checkpointId: CHECKPOINT_ID,
      owner: HOST_INSTANCE_ID,
      generation: 1,
    })
  })

  it('logs a fixed code for a corrupt source message and still admits a fresh checkpoint', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const { handle, checkpoints, service, enqueue, captured } = createHarness({
      verdict: { kind: 'started' },
    })
    // V8 quotes a fragment of the offending input in a SyntaxError message, so
    // this marker would surface if the raw parse error were logged.
    const userFragment = 'user-content-fragment-1043'
    const corruptSource = `{"content":"${userFragment}"`
    const { version } = await openResumable(checkpoints, { sourceMessage: corruptSource })

    await expect(service.continue(continuationRequest(version))).rejects.toThrow(
      'Model-step checkpoint source message is not valid JSON'
    )
    // The cleanup contract is unchanged: the claim is abandoned and nothing is
    // admitted.
    expect(checkpointRow(handle, CHECKPOINT_ID)).toMatchObject({
      status: 'abandoned',
      claim_generation: 1,
      version: version + 2,
    })
    expect(enqueue).not.toHaveBeenCalled()
    // Only the fixed classification is logged: no `err` field exists, so the
    // SyntaxError message cannot travel through the log fields. The exact shape
    // is the falsifier — the structured logger already strips an Error's
    // message, so a spy on the raw fields is what proves the producer never
    // passes it on.
    expect(errorSpy.mock.calls.at(-1)).toEqual([
      {
        checkpointId: CHECKPOINT_ID,
        taskId: expect.any(String),
        code: 'source_message_invalid_json',
        errorName: 'SourceMessageParseError',
      },
      'Model-step continuation admission failed',
    ])
    const loggedWithMessages = JSON.stringify(errorSpy.mock.calls, (_key, value) =>
      value instanceof Error ? { message: value.message } : value
    )
    expect(loggedWithMessages).not.toContain(userFragment)

    // Positive liveness witness: after the corrupt checkpoint was abandoned, the
    // same store and service admit a valid one through the ordinary path.
    const validCheckpointId = 'cp-valid-1043'
    const { version: validVersion } = await openResumable(checkpoints, {
      checkpointId: validCheckpointId,
    })
    const valid = await service.continue({
      userId: USER_ID,
      agent: AGENT,
      chatId: CHAT_ID,
      checkpointId: validCheckpointId,
      version: validVersion,
    })
    const call = await captured
    expect(valid.status).toBe(202)
    expect(valid.body).toEqual({
      taskId: call.taskId,
      checkpointId: validCheckpointId,
      status: 'claimed',
      replayed: false,
    })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(checkpointRow(handle, validCheckpointId)).toMatchObject({
      status: 'claimed',
      claim_generation: 1,
    })
  })
})
