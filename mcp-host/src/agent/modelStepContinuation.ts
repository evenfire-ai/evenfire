import { randomUUID } from 'node:crypto'
import type { ConversationManager } from '../core/conversation/conversation'
import {
  MODEL_STEP_BLOCKED_REASONS,
  MODEL_STEP_CONTINUE_ERROR_CODES,
  type ModelStepBlockedReason,
  type ModelStepContinueResponse,
} from '../core/conversation/modelStepCheckpointContract'
import { toModelStepCheckpointView } from '../core/conversation/modelStepCheckpointView'
import { logger } from '../logger'
import type { ModelStepContinuationRef, ModelStepContinuationVerdict } from '../queue/types'
import type { IncomingMessage } from '../server/types'
import { serializeSessionKey } from '../session/types.js'
import type { ModelStepCheckpointSupport } from './types'

export const MODEL_STEP_CONTINUATION_VERDICT_TIMEOUT_MS = 10_000

/** Fixed log code for every admission failure that is not a corrupt source message. */
const ADMISSION_FAILED_CODE = 'model_step_continuation_admission_failed'

/**
 * A stored `source_message` that is not valid JSON. V8 embeds a fragment of the
 * offending input in a SyntaxError message, so the raw parse error is replaced
 * by this fixed, content-free one before it can reach a log or the continuation
 * route's 500 handler.
 */
class SourceMessageParseError extends Error {
  readonly code = 'source_message_invalid_json'

  constructor() {
    super('Model-step checkpoint source message is not valid JSON')
    this.name = 'SourceMessageParseError'
  }
}

export interface ModelStepContinuationRequest {
  userId: string
  agent: string
  chatId: string
  checkpointId: string
  version: number
}

export interface ModelStepContinuationResult {
  status: 200 | 202 | 404 | 409
  body: ModelStepContinueResponse
}

export type ModelStepContinuationHandler = (
  request: ModelStepContinuationRequest
) => Promise<ModelStepContinuationResult>

export interface ModelStepContinuationServiceDeps {
  checkpoints: ModelStepCheckpointSupport
  conversationManager: ConversationManager
  /** Creates an indexed task and uses the ordinary async admission and result-delivery path. */
  enqueue: (
    message: IncomingMessage,
    taskId: string,
    continuation: ModelStepContinuationRef
  ) => void | Promise<void>
}

function blockedReason(value: string): ModelStepBlockedReason {
  if (!(MODEL_STEP_BLOCKED_REASONS as readonly string[]).includes(value)) {
    throw new Error('Model-step checkpoint has an unknown blocked reason')
  }
  return value as ModelStepBlockedReason
}

function notFound(): ModelStepContinuationResult {
  return { status: 404, body: { code: MODEL_STEP_CONTINUE_ERROR_CODES.notFound } }
}

/** Claims one continuation and waits only for its first revalidation verdict. */
export class ModelStepContinuationService {
  constructor(private readonly deps: ModelStepContinuationServiceDeps) {}

  async continue(request: ModelStepContinuationRequest): Promise<ModelStepContinuationResult> {
    const { checkpoints } = this.deps
    // The same normalisation the session store uses: a blank/omitted chat id
    // (the blank rpc threadId) and its literal `default` spelling are one
    // session, so a continuation addressed as `default` reaches the checkpoint
    // whose source message omitted its threadId.
    const sessionKey = serializeSessionKey({
      userId: request.userId,
      channelType: 'rpc',
      channelId: request.agent,
      threadId: request.chatId,
    })
    const claim = await checkpoints.store.claim({
      sessionKey,
      checkpointId: request.checkpointId,
      version: request.version,
      hostInstanceId: checkpoints.hostInstanceId,
      newTaskId: randomUUID(),
      leaseMs: checkpoints.claimLeaseMs,
    })
    switch (claim.outcome) {
      case 'not_found':
        return notFound()
      case 'completed':
        return {
          status: 200,
          body: {
            taskId: claim.taskId,
            checkpointId: request.checkpointId,
            status: 'completed',
            replayed: true,
          },
        }
      case 'replayed':
        return {
          status: 202,
          body: {
            taskId: claim.taskId,
            checkpointId: request.checkpointId,
            status: 'claimed',
            replayed: true,
          },
        }
      case 'blocked':
        return {
          status: 409,
          body: {
            code: MODEL_STEP_CONTINUE_ERROR_CODES.blocked,
            blockedReason: blockedReason(claim.blockedReason),
          },
        }
      case 'version_mismatch': {
        const current = toModelStepCheckpointView(claim.current)
        if (!current) throw new Error('Version mismatch has no visible model-step checkpoint')
        return {
          status: 409,
          body: { code: MODEL_STEP_CONTINUE_ERROR_CODES.versionMismatch, current },
        }
      }
      case 'claimed':
        break
    }

    const { header, tools } = claim.snapshot
    const mismatch =
      header.principal !== request.userId
        ? 'principal_mismatch'
        : header.host_id !== checkpoints.hostId
          ? 'host_mismatch'
          : undefined
    if (mismatch) {
      const version = await checkpoints.store.transition(sessionKey, claim.fence, {
        from: ['claimed'],
        to: 'blocked',
        blockedReason: mismatch,
      })
      return version === null
        ? notFound()
        : {
            status: 409,
            body: { code: MODEL_STEP_CONTINUE_ERROR_CODES.blocked, blockedReason: mismatch },
          }
    }

    let resolveVerdict!: (verdict: ModelStepContinuationVerdict) => void
    let verdictEmitted = false
    const verdictPromise = new Promise<ModelStepContinuationVerdict>(resolve => {
      resolveVerdict = resolve
    })
    try {
      if (!header.source_message) throw new Error('Model-step checkpoint has no source message')
      let source: IncomingMessage
      try {
        source = JSON.parse(header.source_message) as IncomingMessage
      } catch {
        // A SyntaxError message can quote the persisted user content, so the
        // failure is re-thrown as a fixed error instead of the parse error.
        throw new SourceMessageParseError()
      }
      // The raw field guards stay strict: a serializer call would coerce a
      // number or array into a matching string. Only the session identity is
      // normalised exactly as the stored session key is, so a blank/omitted
      // threadId and its literal `default` spelling are one session.
      if (
        !source ||
        typeof source.content !== 'string' ||
        source.channelType !== 'rpc' ||
        source.sender !== request.userId ||
        source.channelId !== request.agent ||
        (source.threadId !== undefined && typeof source.threadId !== 'string') ||
        typeof source.timestamp !== 'string' ||
        typeof source.hostRef !== 'string' ||
        serializeSessionKey({
          userId: source.sender,
          channelType: source.channelType,
          channelId: source.channelId,
          threadId: source.threadId,
        }) !== sessionKey
      ) {
        throw new Error('Model-step checkpoint source message does not match its session')
      }
      const sourceMessage = { ...source, messageId: randomUUID() }
      const continuation: ModelStepContinuationRef = {
        checkpointId: header.checkpoint_id,
        originTaskId: header.origin_task_id,
        originTurnNumber: header.origin_turn_number,
        provider: header.provider,
        model: header.model,
        fence: claim.fence,
        confirmedResults: tools.confirmed,
        taskBudget: header.task_budget,
        onVerdict: verdict => {
          if (verdictEmitted) throw new Error('Model-step continuation verdict emitted twice')
          verdictEmitted = true
          resolveVerdict(verdict)
        },
      }
      await this.deps.enqueue(sourceMessage, claim.taskId, continuation)
    } catch (err) {
      const abandoned = await checkpoints.store.abandonAdmission(
        sessionKey,
        claim.taskId,
        claim.fence
      )
      if (abandoned.resetSession) {
        const conversation = this.deps.conversationManager.getSessionByKey(sessionKey)
        if (conversation?.activeTaskId === claim.taskId) {
          await this.deps.conversationManager.failTurn(conversation)
        }
      }
      logger.error(
        {
          checkpointId: request.checkpointId,
          taskId: claim.taskId,
          code: err instanceof SourceMessageParseError ? err.code : ADMISSION_FAILED_CODE,
          errorName: err instanceof Error ? err.name : typeof err,
        },
        'Model-step continuation admission failed'
      )
      throw err
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    let verdict: ModelStepContinuationVerdict | undefined
    try {
      verdict = await Promise.race([
        verdictPromise,
        new Promise<undefined>(resolve => {
          timer = setTimeout(() => resolve(undefined), MODEL_STEP_CONTINUATION_VERDICT_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    if (verdict?.kind === 'lost') return notFound()
    if (verdict?.kind === 'blocked') {
      return {
        status: 409,
        body: {
          code: MODEL_STEP_CONTINUE_ERROR_CODES.blocked,
          blockedReason: verdict.blockedReason,
        },
      }
    }
    // `started`, `reference_check_failed` and no verdict yet all answer 202:
    // the task exists and its outcome (including a file-reference error,
    // reported exactly as message admission reports it) arrives through the
    // ordinary async task result.
    return {
      status: 202,
      body: {
        taskId: claim.taskId,
        checkpointId: request.checkpointId,
        status: 'claimed',
        replayed: false,
      },
    }
  }
}
