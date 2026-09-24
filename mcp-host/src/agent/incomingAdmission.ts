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
import { FileReferenceErrorCode, LlmErrorCode } from '../core/errors'
import {
  chatTransportSupportsImageInput,
  imageInputDenialMessage,
  resolveHostImageInput,
} from '../llm/imageInput'
import type { TaskError } from '../queue/types'
import type { IncomingMessage, MessageResponse, SetModelResult } from '../server/types'
import { serializeSessionKey } from '../session/types.js'
import { type FileReferenceGfscClient, resolveFileReferences } from './fileReferenceResolver'
import { type IncomingAttachmentLimits, validateIncomingAttachments } from './incomingAttachments'
import type { SessionModelSelectionOptions } from './sessionModelSelection'

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
  /** The message id is taken from each message, not configured. */
  limits: Omit<IncomingAttachmentLimits, 'messageId'>
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
    expectedRevision?: number,
    options?: SessionModelSelectionOptions
  ) => Promise<SetModelResult>
  dispatch: (
    message: IncomingMessage,
    options?: { async?: boolean }
  ) => MessageResponse | Promise<MessageResponse>
  /**
   * Issue #666 — the gfsc client that re-authorizes file references, or null
   * when this Host holds no `gfs.read` scope (every GFS reference is then
   * `unsupported`, and gfsc is never called).
   */
  fileReferenceClient: () => FileReferenceGfscClient | null
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
    const validated = validateIncomingAttachments(message.attachments, {
      ...deps.limits,
      messageId: message.messageId,
    })
    if (!validated.ok) return { success: false, error: validated.error }

    // Only images engage the image-capability gate, the revision check and the
    // visual model selection write. A file-only message runs on any model: the
    // model reads it through a tool, not as image input (issue #666).
    const hasImageAttachments = Boolean(validated.attachments?.some(a => a.kind === 'image'))
    const acceptedAttachmentIds = validated.attachments?.map(a => a.id) ?? []

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
      hasImageAttachments &&
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
      // Resolutions are the Host's own answer; a caller cannot pre-fill them.
      fileReferenceResolutions: undefined,
    }
    const fileReferences = message.fileReferences ?? []
    let acceptedFileReferenceIds: string[] = []
    deps.logger.info(
      {
        channel: normalizedMessage.channelType,
        attachmentCount: validated.attachments?.length ?? 0,
      },
      'Received message'
    )
    if (validated.fileReferences.length) {
      // Classes, sizes and a digest prefix only: never the file name, the
      // bytes or any decoded text.
      deps.logger.info(
        {
          event: 'attachment_admitted',
          channel: normalizedMessage.channelType,
          attachmentCount: acceptedAttachmentIds.length,
          fileClasses: validated.fileReferences.map(ref => ref.class),
          byteLength: validated.fileReferences.reduce((sum, ref) => sum + ref.byteLength, 0),
          digestPrefixes: validated.fileReferences.map(ref => ref.digest?.hex.slice(0, 8)),
        },
        'Host runtime event'
      )
    }
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

    // A successful response names every attachment and file reference the Host
    // accepted, on the sync response and on the async ack alike. Their absence
    // on a send that carried them is how a client detects a Host that dropped
    // them.
    const withAcceptedAttachments = (response: MessageResponse): MessageResponse =>
      response.success && (acceptedAttachmentIds.length || acceptedFileReferenceIds.length)
        ? {
            ...response,
            ...(acceptedAttachmentIds.length ? { acceptedAttachmentIds } : {}),
            ...(acceptedFileReferenceIds.length ? { acceptedFileReferenceIds } : {}),
          }
        : response
    const dispatchMessage = (): MessageResponse | Promise<MessageResponse> => {
      const response = deps.dispatch(normalizedMessage, options)
      return response instanceof Promise
        ? response.then(withAcceptedAttachments)
        : withAcceptedAttachments(response)
    }

    /** Decide whether the model a task resolved to can read this message's
     *  images. The refusal is the exact response the Desktop receives, so the
     *  pre-write check and the per-task check cannot drift apart. */
    const admitImageModel = (
      resolved: AdmissionResolvedModel | null | undefined
    ):
      | { ok: true; pair: { provider: string; model: string } }
      | { ok: false; response: MessageResponse } => {
      if (!resolved) {
        logRefusal({
          provider: deps.hostProvider() ?? 'unknown',
          model: null,
          code: LlmErrorCode.ImageInputUnknown,
          reason: 'no_model',
        })
        return {
          ok: false,
          response: {
            success: false,
            error: {
              code: LlmErrorCode.ImageInputUnknown,
              message: 'The image model is unavailable. Select a verified image-capable model.',
              retryable: false,
              provider: 'unknown',
            },
          },
        }
      }
      const pair = { provider: resolved.provider.getProviderType(), model: resolved.model }
      const facts = deps.resolveImageInput(pair.provider, pair.model)
      // A missing catalog row is not an omitted `imageInput` field. Optional
      // chaining would collapse both to `undefined` and the Codex upgrade
      // would advertise support the adapter later rejects.
      const decision = facts
        ? resolveHostImageInput(pair.provider, facts.capability, {
            transportSupported: chatTransportSupportsImageInput(pair.provider),
          })
        : { state: 'unknown' as const, reason: 'model_unknown' as const }
      if (decision.state !== 'supported') {
        const code =
          decision.state === 'unknown'
            ? LlmErrorCode.ImageInputUnknown
            : LlmErrorCode.ImageInputUnsupported
        logRefusal({ provider: pair.provider, model: pair.model, code, reason: decision.reason })
        return {
          ok: false,
          response: {
            success: false,
            error: {
              code,
              message: imageInputDenialMessage(decision, pair),
              retryable: false,
              provider: pair.provider,
            },
          },
        }
      }
      return { ok: true, pair }
    }

    const runHandler = (): MessageResponse | Promise<MessageResponse> => {
      if (!hasImageAttachments) return dispatchMessage()
      return (async () => {
        const key = serializeSessionKey({
          userId: normalizedMessage.sender,
          channelType: normalizedMessage.channelType,
          channelId: normalizedMessage.channelId || 'default',
          threadId: normalizedMessage.threadId,
        })
        const conversation = await deps.getConversationByKey(key, normalizedMessage.sender)
        // Checked again here even after the pre-write check below: this is the
        // pair the task will actually run on, on every path into the handler.
        const admission = admitImageModel(
          deps.resolveTaskModel(acceptedVisualSelection ?? conversation?.modelSelections)
        )
        if (!admission.ok) return admission.response
        normalizedMessage.imageModel = admission.pair
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
    const admitAndRun = (): MessageResponse | Promise<MessageResponse> => {
      const piggybackModel = typeof message.model === 'string' ? message.model.trim() : ''
      if (piggybackModel && normalizedMessage.channelType === 'rpc') {
        // An image the requested model cannot read is refused BEFORE the
        // selection is written: persisting it (and bumping the revision) for a
        // turn that is then refused would leave the session on a model the user
        // never got an answer from. Only the pair the selection resolves to is
        // checked here; when resolution does not honour the requested model
        // (not in the catalog, or a boot fallback serves another pair) the write
        // gate and the per-task check below keep their existing verdicts.
        const hostProvider = deps.hostProvider()
        if (hasImageAttachments && hostProvider) {
          const requested = deps.resolveTaskModel({ [hostProvider]: piggybackModel })
          if (
            !requested ||
            (requested.provider.getProviderType() === hostProvider &&
              requested.model === piggybackModel)
          ) {
            const admission = admitImageModel(requested)
            if (!admission.ok) return admission.response
          }
        }
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
              hasImageAttachments ? message.modelSelectionRevision : undefined,
              // An image send carries the model the client displays, not a user
              // pick: asking for the effective model must not pin it. Text-only
              // piggybacks and `POST /v1/runtime/model` keep writing.
              hasImageAttachments ? { skipWriteWhenEffective: true } : undefined
            )
            if (!applied.ok) {
              if (hasImageAttachments) {
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
            } else if (hasImageAttachments) {
              acceptedVisualSelection = { [applied.provider]: applied.model }
            }
          } catch (error) {
            applied = undefined
            if (hasImageAttachments) {
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

    if (!fileReferences.length) return admitAndRun()
    // Issue #666 — every reference is re-authorized under the Host principal
    // before the task exists. An unavailable file is still a valid turn: it is
    // listed with its availability. Only a failure to ask gfsc refuses it.
    return (async () => {
      const resolved = await resolveFileReferences(fileReferences, deps.fileReferenceClient())
      if (!resolved.ok) {
        deps.logger.warn(
          {
            event: 'file_reference_refused',
            channel: normalizedMessage.channelType,
            referenceCount: fileReferences.length,
            failure: resolved.failure,
          },
          'Host runtime event'
        )
        return { success: false, error: fileReferenceFailure(resolved.failure) }
      }
      normalizedMessage.fileReferenceResolutions = resolved.resolutions
      acceptedFileReferenceIds = resolved.resolutions.map(r => r.reference.id)
      // Classes, sizes and availabilities only: never a file name.
      deps.logger.info(
        {
          event: 'file_reference_resolved',
          channel: normalizedMessage.channelType,
          referenceCount: resolved.resolutions.length,
          fileClasses: resolved.resolutions.map(r => r.reference.class),
          availabilities: resolved.resolutions.map(r => r.availability),
          byteLength: resolved.resolutions.reduce((sum, r) => sum + r.reference.byteLength, 0),
        },
        'Host runtime event'
      )
      return admitAndRun()
    })()

    function fileReferenceFailure(failure: 'transient' | 'invalid' | 'contract'): TaskError {
      const provider = deps.hostProvider() ?? 'unknown'
      if (failure === 'invalid')
        return {
          code: FileReferenceErrorCode.Invalid,
          message: 'A referenced file does not match the file it names. Pick the file again.',
          retryable: false,
          provider,
        }
      return {
        code: LlmErrorCode.ApiCallFailed,
        message:
          failure === 'transient'
            ? 'The referenced files could not be checked. Send the message again.'
            : 'The file service returned an unexpected answer for a referenced file.',
        retryable: failure === 'transient',
        provider,
      }
    }
  }
}
