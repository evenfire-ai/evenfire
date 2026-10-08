import { randomUUID } from 'node:crypto'
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
import type { ModelStepCheckpointSupport } from './types'

export const MODEL_STEP_CONTINUATION_VERDICT_TIMEOUT_MS = 10_000

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
    const sessionKey = `${request.userId}:rpc:${request.agent}:${request.chatId}`
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
      const source = JSON.parse(header.source_message) as IncomingMessage
      if (
        !source ||
        typeof source.content !== 'string' ||
        source.channelType !== 'rpc' ||
        source.sender !== request.userId ||
        source.channelId !== request.agent ||
        source.threadId !== request.chatId ||
        typeof source.timestamp !== 'string' ||
        typeof source.hostRef !== 'string'
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
      await checkpoints.store.transition(sessionKey, claim.fence, {
        from: ['claimed'],
        to: 'abandoned',
      })
      logger.error(
        { checkpointId: request.checkpointId, taskId: claim.taskId, err },
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
