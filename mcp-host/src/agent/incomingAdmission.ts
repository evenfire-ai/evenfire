/**
 * Issue #654 — the admission gate every incoming message crosses before a task
 * exists.
 *
 * It lived inside `main.ts`, which runs `main()` on import and therefore cannot
 * be loaded by a unit test. The gate decides whether a user's turn is accepted,
 * refused, or accepted with a different model than the one that was asked for,
 * so it is exactly the code that needs direct tests. Everything the gate reads
 * from live process state arrives through {@link IncomingAdmissionDeps}; the
 * decision logic here is pure.
 */
import { resolveImageInputCapability } from '@clerum/llm-providers'
import { LlmErrorCode } from '../core/errors'
import { chatTransportSupportsImageInput, imageInputDenialMessage } from '../llm/imageInput'
import type { IncomingMessage, MessageResponse, SetModelResult } from '../server/types'
import { serializeSessionKey } from '../session/types.js'
import { validateIncomingImageAttachments } from './incomingImageAttachments'

/** The model a task would actually run on, as `resolveTaskModel` reports it. */
interface AdmissionResolvedModel {
  provider: { getProviderType: () => string }
  model: string
}

/** What the live catalog knows about one (provider, model) pair. */
interface AdmissionImageFacts {
  capability?: unknown
}

/** Live process state the gate reads. Every member is injected so the gate is
 *  testable without booting the Host. */
export interface IncomingAdmissionDeps {
  limits: { maxCount: number; maxBytes: number }
  /** False while the message queue is not initialized yet. */
  queueReady: () => boolean
  /** Non-null while the Host refuses new tasks (missing LLM key, …). */
  degradedReason: () => { reason: string; message: string } | null | undefined
  /** The Host's configured provider, for error envelopes that have no pair yet. */
  hostProvider: () => string | undefined
  getConversationByKey: (
    key: string,
    userId: string
  ) => Promise<{ modelSelections?: Record<string, string> } | undefined>
  resolveTaskModel: (
    selections: Record<string, string> | undefined
  ) => AdmissionResolvedModel | null | undefined
  resolveImageInput: (provider: string, model: string) => AdmissionImageFacts | undefined
  applySessionModelSelection: (
    userSub: string,
    hostRef: string,
    chatId: string | undefined,
    model: string,
    expectedRevision?: number
  ) => Promise<SetModelResult>
  dispatch: (
    message: IncomingMessage,
    options?: { async?: boolean }
  ) => MessageResponse | Promise<MessageResponse>
  logger: {
    info: (obj: Record<string, unknown>, msg: string) => void
    warn: (obj: Record<string, unknown>, msg: string) => void
  }
}

export type IncomingAdmission = (
  message: IncomingMessage,
  options?: { async?: boolean }
) => MessageResponse | Promise<MessageResponse>

export function createIncomingAdmission(deps: IncomingAdmissionDeps): IncomingAdmission {
  return function prepareIncomingMessage(
    message: IncomingMessage,
    options?: { async?: boolean }
  ): MessageResponse | Promise<MessageResponse> {
    const validated = validateIncomingImageAttachments(message.attachments, deps.limits)
    if (!validated.ok) return { success: false, error: validated.error }

    const hasAttachments = Boolean(validated.attachments?.length)

    /** One structured line per refusal, so an operator can tell WHY a turn was
     *  dropped without the payload ever reaching the log. */
    const logRefusal = (fields: {
      provider: string
      model: string | null
      code: string
      reason: string
    }): void => {
      deps.logger.info(
        {
          level: 'info',
          event: 'message_image_refused',
          userId: message.sender,
          chatId: message.threadId ?? null,
          ...fields,
        },
        'Host runtime event'
      )
    }

    if (
      hasAttachments &&
      message.modelSelectionRevision !== undefined &&
      (!Number.isSafeInteger(message.modelSelectionRevision) || message.modelSelectionRevision < 0)
    ) {
      const provider = deps.hostProvider() ?? 'unknown'
      logRefusal({
        provider,
        model: null,
        code: LlmErrorCode.ModelSelectionConflict,
        reason: 'invalid_revision',
      })
      // No `modelSelectionRevision` on the response: the client cannot adopt a
      // revision we never read, so it must re-read the current selection.
      return {
        success: false,
        error: {
          code: LlmErrorCode.ModelSelectionConflict,
          message: 'The model selection revision is invalid. Select the model again.',
          retryable: true,
          provider,
        },
      }
    }
    const normalizedMessage: IncomingMessage = {
      ...message,
      attachments: validated.attachments,
      // Never accept a caller-supplied visual execution identity.
      imageModel: undefined,
    }
    deps.logger.info(
      {
        channel: normalizedMessage.channelType,
        attachmentCount: validated.attachments?.length ?? 0,
      },
      'Received message'
    )
    let acceptedVisualSelection: Record<string, string> | undefined

    if (!deps.queueReady()) {
      return {
        success: false,
        error: {
          code: LlmErrorCode.ApiCallFailed,
          message: 'Message queue not initialized',
          retryable: false,
          provider: 'unknown',
        },
      }
    }

    // Refuse new tasks while the Host is degraded. Operator fixes the LLM
    // Secret and the Host returns to ready within ~1 s — no restart.
    const degraded = deps.degradedReason()
    if (degraded) {
      deps.logger.warn({ reason: degraded.reason }, '[Main] Refusing message — Host is degraded:')
      return {
        success: false,
        error: {
          code: 'LLM_KEY_MISSING',
          message: degraded.message,
          retryable: true,
          provider: deps.hostProvider() ?? 'unknown',
        },
      }
    }

    const dispatchMessage = () => deps.dispatch(normalizedMessage, options)

    const runHandler = (): MessageResponse | Promise<MessageResponse> => {
      if (!hasAttachments) return dispatchMessage()
      return (async () => {
        const key = serializeSessionKey({
          userId: normalizedMessage.sender,
          channelType: normalizedMessage.channelType,
          channelId: normalizedMessage.channelId || 'default',
          threadId: normalizedMessage.threadId,
        })
        const conversation = await deps.getConversationByKey(key, normalizedMessage.sender)
        const resolved = deps.resolveTaskModel(
          acceptedVisualSelection ?? conversation?.modelSelections
        )
        if (!resolved) {
          logRefusal({
            provider: deps.hostProvider() ?? 'unknown',
            model: null,
            code: LlmErrorCode.ImageInputUnknown,
            reason: 'no_model',
          })
          return {
            success: false,
            error: {
              code: LlmErrorCode.ImageInputUnknown,
              message: 'The image model is unavailable. Select a verified image-capable model.',
              retryable: false,
              provider: 'unknown',
            },
          }
        }
        const pair = { provider: resolved.provider.getProviderType(), model: resolved.model }
        const facts = deps.resolveImageInput(pair.provider, pair.model)
        const decision = resolveImageInputCapability(facts?.capability, {
          transportSupported: chatTransportSupportsImageInput(pair.provider),
        })
        if (decision.state !== 'supported') {
          const code =
            decision.state === 'unknown'
              ? LlmErrorCode.ImageInputUnknown
              : LlmErrorCode.ImageInputUnsupported
          logRefusal({ provider: pair.provider, model: pair.model, code, reason: decision.reason })
          return {
            success: false,
            error: {
              code,
              message: imageInputDenialMessage(decision, pair),
              retryable: false,
              provider: pair.provider,
            },
          }
        }
        normalizedMessage.imageModel = pair
        return dispatchMessage()
      })()
    }

    // R2 — piggybacked per-session model. Because a suspended Host can't serve
    // `POST /v1/runtime/model`, the desktop rides the user's pick on the message
    // that wakes us. Apply it to THIS session and AWAIT the write BEFORE the task
    // is created, so the per-task resolver (`stateMachine` taskModelResolver over
    // `conv.modelSelections`) reads the row we just wrote. Fail-OPEN on the
    // message: a rejected/degraded selection is logged and ignored, never dropping
    // the user's turn (fail-closed only on the selection, inside the helper).
    const piggybackModel = typeof message.model === 'string' ? message.model.trim() : ''
    if (piggybackModel && normalizedMessage.channelType === 'rpc') {
      return (async () => {
        // Hoisted out of the try so the ack below can report the revision the
        // write produced. The send IS the write; its result travels back here.
        let applied: SetModelResult | undefined
        try {
          applied = await deps.applySessionModelSelection(
            normalizedMessage.sender,
            normalizedMessage.channelId,
            normalizedMessage.threadId,
            piggybackModel,
            hasAttachments ? message.modelSelectionRevision : undefined
          )
          if (!applied.ok) {
            if (hasAttachments) {
              const conflict = applied.reason === 'model_selection_conflict'
              const code = conflict
                ? LlmErrorCode.ModelSelectionConflict
                : LlmErrorCode.ModelNotAllowed
              logRefusal({
                provider: applied.provider,
                model: applied.model,
                code,
                reason: applied.reason,
              })
              return {
                success: false,
                // The winning revision, so the client can adopt it and retry
                // without a separate read against a Host that may suspend again.
                ...(conflict && applied.modelSelectionRevision !== undefined
                  ? { modelSelectionRevision: applied.modelSelectionRevision }
                  : {}),
                error: {
                  code,
                  message: conflict
                    ? 'The model selection changed before this message was accepted. Select the model again.'
                    : 'The selected model is no longer allowed. Select a model again before sending the image.',
                  retryable: conflict,
                  provider: applied.provider,
                },
              }
            }
            deps.logger.warn(
              {
                level: 'warn',
                event: 'message_model_ignored',
                userId: normalizedMessage.sender,
                chatId: normalizedMessage.threadId ?? null,
                provider: applied.provider,
                model: piggybackModel,
                reason: applied.reason,
              },
              'Host runtime event'
            )
          } else if (hasAttachments) {
            acceptedVisualSelection = { [applied.provider]: applied.model }
          }
        } catch (error) {
          applied = undefined
          if (hasAttachments) {
            deps.logger.warn({ err: error }, 'Visual model selection could not be confirmed')
            logRefusal({
              provider: deps.hostProvider() ?? 'unknown',
              model: piggybackModel,
              code: LlmErrorCode.ApiCallFailed,
              reason: 'apply_failed',
            })
            // An unreachable selection store is an internal failure, not a
            // statement about what this model can accept: the client may retry.
            return {
              success: false,
              error: {
                code: LlmErrorCode.ApiCallFailed,
                message:
                  'The image model selection could not be confirmed. Select the model again.',
                retryable: true,
                provider: deps.hostProvider() ?? 'unknown',
              },
            }
          }
          deps.logger.warn(
            {
              level: 'warn',
              event: 'message_model_ignored',
              userId: normalizedMessage.sender,
              chatId: normalizedMessage.threadId ?? null,
              provider: deps.hostProvider() ?? 'unknown',
              model: piggybackModel,
              reason: 'apply_failed',
              err: error,
            },
            'Host runtime event'
          )
        }
        const response = await runHandler()
        // A successful ack carries the revision only when the selection was
        // actually persisted. Its ABSENCE after a piggyback is the contract for
        // "the Host ignored your model".
        return applied?.ok && applied.modelSelectionRevision !== undefined
          ? { ...response, modelSelectionRevision: applied.modelSelectionRevision }
          : response
      })()
    }

    return runHandler()
  }
}
