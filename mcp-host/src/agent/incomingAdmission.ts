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
import {
  type ApprovalConfigSnapshot,
  type ApprovalMode,
  effectiveApprovalMode,
  normalizeApprovalMode,
  parseApprovalModeCommand,
  raisesApprovalMode,
  readChannelCap,
  readChannelSwitch,
  readModeCeiling,
} from '../core/approval/approvalMode'
import { type ApproverPolicyRefusal, approverPolicyRefusal } from '../core/approval/approverPolicy'
import { approvalLogId, syncEffectiveMode } from '../core/approval/grantMemory'
import type { ConversationManager } from '../core/conversation/conversation'
import { FileReferenceErrorCode, LlmErrorCode } from '../core/errors'
import {
  chatTransportSupportsImageInput,
  imageInputDenialMessage,
  resolveHostImageInput,
} from '../llm/imageInput'
import { logger } from '../logger'
import type { TaskError } from '../queue/types'
import type { IncomingMessage, MessageResponse, SetModelResult } from '../server/types'
import { normalizeSessionChannelId, resolveCanonicalSessionKey } from '../session/types.js'
import type { FileReferenceGfsAccess } from './fileReferenceGfsGate'
import {
  type FileReferenceCheckFailure,
  type MessageReferenceResolutionResult,
  resolveMessageReferences,
} from './fileReferenceResolver'
import type { GfsSurfaceRuntimeCapability } from './gfsReferenceSurfaces'
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
   * Issue #666 — the gfsc client that re-authorizes file references. Without a
   * `gfs.read` scope every GFS reference is `unsupported` and gfsc is never
   * called; a token that cannot be read or decoded refuses the message.
   */
  fileReferenceGfs: () => FileReferenceGfsAccess
  /** Host-owned surface capability; omitted means every optional surface fails closed. */
  gfsSurfaceRuntimeCapability?: (message: IncomingMessage) => GfsSurfaceRuntimeCapability
  logger: {
    info: (obj: Record<string, unknown>, msg: string) => void
    warn: (obj: Record<string, unknown>, msg: string) => void
  }
  /** Live session store for the first-message mode and the messaging command. */
  getConversationManager?: () => ConversationManager
  /**
   * Live ceiling, channel switch and approver policy. Read when a writer runs,
   * not at wiring time.
   */
  approvalSnapshot: () => ApprovalConfigSnapshot
}

const MESSAGING_CHANNELS = new Set(['telegram', 'email', 'slack', 'teams'])

function emailCommandText(message: IncomingMessage): string {
  const metadata = message.metadata
  if (metadata && (typeof metadata.subject === 'string' || typeof metadata.body === 'string')) {
    const subject = typeof metadata.subject === 'string' ? metadata.subject : ''
    const body = typeof metadata.body === 'string' ? metadata.body : ''
    return `${subject}\n${body}`
  }
  return message.content
}

/** rpc is never a command. Email matches the subject and body joined by a newline. */
function approvalCommand(message: IncomingMessage): ApprovalMode | null {
  if (message.channelType === 'rpc') return null
  const text = message.channelType === 'email' ? emailCommandText(message) : message.content
  return parseApprovalModeCommand(text)
}

function carriedApprovalMode(message: IncomingMessage): ApprovalMode | undefined {
  if (message.channelType !== 'rpc') return undefined
  const mode = message.approvalMode
  if (mode === 'manual' || mode === 'auto' || mode === 'allow_all') return mode
  return undefined
}

type ApprovalModeRefusal = 'channel' | ApproverPolicyRefusal

const APPROVAL_MODE_REFUSAL_TEXT: Record<ApprovalModeRefusal, string> = {
  channel: 'This channel is limited to manual.',
  policy_cli_only: "This Host's approval policy does not let a messaging channel raise the mode.",
  not_approver: 'Only a designated approver can raise the mode.',
  policy_invalid: "This Host's approval policy is not valid, so the mode cannot be raised.",
}

function approvalModeReply(
  stored: ApprovalMode,
  effective: ApprovalMode,
  refusal: ApprovalModeRefusal | null
): string {
  const base = `Approval mode is ${stored}. Effective mode is ${effective}.`
  return refusal ? `${base} ${APPROVAL_MODE_REFUSAL_TEXT[refusal]}` : base
}

/**
 * Log fields for a mode write that failed. The error's message can name the
 * conversation id (the SQLite store's persistApprovalMode does), so only the
 * error's class, a string code and the hashed session id are logged. The
 * session id is absent when the failure came before the session was read.
 */
function approvalModeStoreFailureFields(
  err: unknown,
  sessionLogId: string | undefined
): Record<string, unknown> {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return {
    errorClass: err instanceof Error ? err.constructor.name : typeof err,
    ...(typeof code === 'string' ? { code } : {}),
    ...(sessionLogId !== undefined ? { session: sessionLogId } : {}),
  }
}

function approvalModeStoreFailure(provider: string | undefined): MessageResponse {
  return {
    success: false,
    error: {
      code: LlmErrorCode.ApiCallFailed,
      message: 'The approval mode could not be stored.',
      retryable: true,
      provider: provider ?? 'unknown',
    },
  }
}

/**
 * The message a replayed delivery is dispatched with. Admission does not run
 * on a replay, so the fields only admission may set are cleared: a caller can
 * never supply a visual execution identity or file or location reference
 * resolutions.
 */
export function replayedIncomingMessage(message: IncomingMessage): IncomingMessage {
  return {
    ...message,
    imageModel: undefined,
    fileReferenceResolutions: undefined,
    locationReferenceResolutions: undefined,
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
    if (!validated.ok) {
      // R4-L10 — file attachments are refused before any image gate runs; log
      // the code so an operator can tell why a turn was dropped.
      deps.logger.info(
        {
          event: 'message_attachment_refused',
          userId: message.sender,
          chatId: message.threadId ?? null,
          code: validated.error.code,
        },
        'Host runtime event'
      )
      return { success: false, error: validated.error }
    }

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
      locationReferenceResolutions: undefined,
    }
    const fileReferences = message.fileReferences ?? []
    const locationReferences = message.locationReferences ?? []
    let acceptedFileReferenceIds: string[] = []
    let acceptedLocationReferenceIds: string[] = []
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

    const command = approvalCommand(normalizedMessage)
    if (command) {
      if (
        !normalizedMessage.channelId.trim() ||
        !MESSAGING_CHANNELS.has(normalizedMessage.channelType)
      ) {
        return {
          success: false,
          error: {
            code: 'INVALID_MESSAGE',
            message: 'The approval-mode command needs a known channel and channel id.',
            retryable: false,
            provider: deps.hostProvider() ?? 'unknown',
          },
        }
      }
      if (!deps.getConversationManager) return approvalModeStoreFailure(deps.hostProvider())
      return (async () => {
        let sessionLogId: string | undefined
        try {
          const manager = deps.getConversationManager!()
          const key = resolveCanonicalSessionKey(normalizedMessage)
          const { conversation } = await manager.getOrCreateDetailed(key, {
            userId: normalizedMessage.sender,
            channelType: normalizedMessage.channelType,
            channelId: normalizeSessionChannelId(
              normalizedMessage.channelType,
              normalizedMessage.channelId
            ),
            threadId: normalizedMessage.threadId,
            source: normalizedMessage.channelType,
          })
          sessionLogId = approvalLogId(conversation.id)
          const live = deps.approvalSnapshot()
          // The switch decides what the command stores and whether the reply
          // names the channel. The cap, which adds the approver policy for
          // this session's owner, decides the effective mode.
          const channelSwitch = readChannelSwitch(live, conversation.channel_type)
          const channelCap = readChannelCap(live, conversation.channel_type, conversation.user_id)
          const ceiling = readModeCeiling(live)
          const current = normalizeApprovalMode(conversation.approval_mode)
          const logCommandRefusal = (reason: ApprovalModeRefusal, outcome: string): void => {
            logger.info(
              {
                event: 'approval_mode_command_refused',
                session: approvalLogId(conversation.id),
                channel: normalizedMessage.channelType,
                requested: command,
                reason,
              },
              `Approval mode command refused; ${outcome}`
            )
          }
          // The command refuses a raise the approver policy does not allow,
          // after the channel check. A mode at or below the stored one, and
          // manual, always pass. The policy is the one in force (`effective`),
          // as notifications use, applied to the session's owner and stored
          // channel type exactly as `readChannelCap` applies it. A refused
          // raise stores nothing: the stored mode stays as it was. The policy
          // also caps the running mode, so the reply's effective mode reads
          // the cap.
          const sessionChannel = conversation.channel_type
          const policyRefusal =
            channelSwitch === 'allow_all' &&
            sessionChannel !== undefined &&
            raisesApprovalMode(current, command)
              ? approverPolicyRefusal(live.effective, {
                  userId: conversation.user_id,
                  channelType: sessionChannel,
                })
              : null
          if (policyRefusal === 'policy_invalid') {
            logger.warn(
              { event: 'approval_config_invalid', field: 'defaultPolicy' },
              'defaultPolicy is not cli_only, channel_users or designated_approvers; a messaging channel cannot raise the mode'
            )
          }
          if (policyRefusal) {
            logCommandRefusal(policyRefusal, 'stored mode unchanged')
            return {
              success: true,
              status: 'completed' as const,
              response: approvalModeReply(
                current,
                effectiveApprovalMode(current, ceiling, channelCap),
                policyRefusal
              ),
            }
          }
          const stored = await manager.setApprovalMode(
            conversation,
            command,
            { ceiling, cap: channelCap, channelSwitch },
            'command',
            normalizedMessage.sender
          )
          // With the channel switch off, the command stores manual.
          const refusal: ApprovalModeRefusal | null =
            command !== 'manual' && channelSwitch !== 'allow_all' ? 'channel' : null
          if (refusal) logCommandRefusal(refusal, 'stored manual')
          return {
            success: true,
            status: 'completed' as const,
            response: approvalModeReply(stored.approvalMode, stored.effectiveApprovalMode, refusal),
          }
        } catch (err) {
          logger.warn(
            approvalModeStoreFailureFields(err, sessionLogId),
            'Approval mode command could not be stored'
          )
          return approvalModeStoreFailure(deps.hostProvider())
        }
      })()
    }

    // A successful response names every attachment, file and location reference
    // the Host accepted, on the sync response and on the async ack alike. Their absence
    // on a send that carried them is how a client detects a Host that dropped
    // them.
    const withAcceptedAttachments = (response: MessageResponse): MessageResponse => {
      if (!response.success) return response
      if (validated.fileReferences.length) {
        // Logged once the message is accepted, after every refusal. Classes,
        // sizes and a digest prefix only: never the file name, the bytes or
        // any decoded text.
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
      return acceptedAttachmentIds.length ||
        acceptedFileReferenceIds.length ||
        acceptedLocationReferenceIds.length
        ? {
            ...response,
            ...(acceptedAttachmentIds.length ? { acceptedAttachmentIds } : {}),
            ...(acceptedFileReferenceIds.length ? { acceptedFileReferenceIds } : {}),
            ...(acceptedLocationReferenceIds.length ? { acceptedLocationReferenceIds } : {}),
          }
        : response
    }
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
        const key = resolveCanonicalSessionKey(normalizedMessage)
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
    const applyFirstMessageMode = async (): Promise<MessageResponse | undefined> => {
      const requested = carriedApprovalMode(normalizedMessage)
      if (!requested) return undefined
      if (!deps.getConversationManager) return approvalModeStoreFailure(deps.hostProvider())
      let sessionLogId: string | undefined
      try {
        const manager = deps.getConversationManager()
        const key = resolveCanonicalSessionKey({
          sender: normalizedMessage.sender,
          channelType: 'rpc',
          channelId: normalizedMessage.channelId,
          threadId: normalizedMessage.threadId,
        })
        const { conversation, created } = await manager.getOrCreateDetailed(key, {
          userId: normalizedMessage.sender,
          channelType: 'rpc',
          channelId: normalizedMessage.channelId,
          threadId: normalizedMessage.threadId,
          source: 'rpc',
          approvalMode: requested,
        })
        sessionLogId = approvalLogId(conversation.id)
        if (!created) return undefined
        const live = deps.approvalSnapshot()
        const ceiling = readModeCeiling(live)
        const cap = readChannelCap(live, conversation.channel_type, conversation.user_id)
        const effective = effectiveApprovalMode(requested, ceiling, cap)
        logger.info(
          {
            event: 'L1',
            session: approvalLogId(conversation.id),
            user: approvalLogId(conversation.user_id ?? ''),
            requested,
            ceiling,
            channelCap: cap,
            effectiveApprovalMode: effective,
            writer: 'first_message',
          },
          'Stored approval mode'
        )
        syncEffectiveMode(conversation, effective)
        return undefined
      } catch (err) {
        logger.warn(
          approvalModeStoreFailureFields(err, sessionLogId),
          'First-message approval mode could not be stored'
        )
        return approvalModeStoreFailure(deps.hostProvider())
      }
    }

    const admitAndRun = (): MessageResponse | Promise<MessageResponse> => {
      const piggybackModel = typeof message.model === 'string' ? message.model.trim() : ''
      const carried = carriedApprovalMode(normalizedMessage)
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
          const modeResult = await applyFirstMessageMode()
          if (modeResult) return modeResult
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

      if (carried) {
        // Refuse an unreadable image before the mode write, so a refused
        // first message does not leave a session.
        if (hasImageAttachments) {
          const admission = admitImageModel(deps.resolveTaskModel(undefined))
          if (!admission.ok) return admission.response
        }
        return (async () => {
          const modeResult = await applyFirstMessageMode()
          if (modeResult) return modeResult
          return runHandler()
        })()
      }

      return runHandler()
    }

    if (!fileReferences.length && !locationReferences.length) return admitAndRun()
    // Issue #666 — every reference is re-authorized under the Host principal
    // before the task exists. An unavailable file or folder is still a valid
    // turn: it is listed with its availability. Only a failure to ask gfsc
    // refuses it: a request to write into a folder must not run somewhere else.
    return (async () => {
      // Only a GFS reference needs the Host's GFS token; every location is one.
      const access: FileReferenceGfsAccess =
        locationReferences.length || fileReferences.some(ref => ref.source.kind === 'gfs')
          ? deps.fileReferenceGfs()
          : { status: 'unsupported' }
      const runtimeSurfaces = deps.gfsSurfaceRuntimeCapability?.(normalizedMessage) ?? {
        workspaceFile: false,
        localExecutor: false,
        visual: false,
      }
      const resolved: MessageReferenceResolutionResult =
        access.status === 'credentials_failed'
          ? { ok: false, failure: 'credentials', errorClass: access.errorClass }
          : await resolveMessageReferences(
              fileReferences,
              locationReferences,
              access.status === 'available' ? access.client : null,
              undefined,
              runtimeSurfaces
            )
      if (!resolved.ok) {
        deps.logger.warn(
          {
            event: 'file_reference_refused',
            channel: normalizedMessage.channelType,
            referenceCount: fileReferences.length,
            locationCount: locationReferences.length,
            failure: resolved.failure,
            errorClass: resolved.errorClass,
            status: resolved.status ?? null,
          },
          'Host runtime event'
        )
        return { success: false, error: fileReferenceFailure(resolved.failure) }
      }
      if (fileReferences.length) {
        normalizedMessage.fileReferenceResolutions = resolved.resolutions
        acceptedFileReferenceIds = resolved.resolutions.map(r => r.reference.id)
      }
      if (locationReferences.length) {
        normalizedMessage.locationReferenceResolutions = resolved.locationResolutions
        acceptedLocationReferenceIds = resolved.locationResolutions.map(r => r.reference.id)
      }
      // Classes, sizes and availabilities only: never a file or folder name.
      deps.logger.info(
        {
          event: 'file_reference_resolved',
          channel: normalizedMessage.channelType,
          referenceCount: resolved.resolutions.length,
          fileClasses: resolved.resolutions.map(r => r.reference.class),
          availabilities: resolved.resolutions.map(r => r.availability),
          byteLength: resolved.resolutions.reduce((sum, r) => sum + r.reference.byteLength, 0),
          locationCount: resolved.locationResolutions.length,
          locationAvailabilities: resolved.locationResolutions.map(r => r.availability),
        },
        'Host runtime event'
      )
      return admitAndRun()
    })()

    function fileReferenceFailure(failure: FileReferenceCheckFailure): TaskError {
      const provider = deps.hostProvider() ?? 'unknown'
      const folders = locationReferences.length === 1 ? 'folder' : 'folders'
      // The failure does not say which reference caused it, so the text names
      // every kind the message carried. The file-only texts are what clients
      // already show and must stay as they are.
      const messages: Record<FileReferenceCheckFailure, string> = !locationReferences.length
        ? {
            invalid: 'A referenced file does not match the file it names. Pick the file again.',
            transient: 'The referenced files could not be checked. Send the message again.',
            contract: 'The file service returned an unexpected answer for a referenced file.',
            credentials:
              'The Host could not authenticate to the file service to check the referenced files.',
          }
        : !fileReferences.length
          ? {
              invalid:
                'A referenced folder does not match the folder it names. Pick the folder again.',
              transient: `The referenced ${folders} could not be checked. Send the message again.`,
              contract: 'The file service returned an unexpected answer for a referenced folder.',
              credentials: `The Host could not authenticate to the file service to check the referenced ${folders}.`,
            }
          : {
              invalid: 'A referenced file or folder does not match what it names. Pick it again.',
              transient:
                'The referenced files and folders could not be checked. Send the message again.',
              contract:
                'The file service returned an unexpected answer for a referenced file or folder.',
              credentials:
                'The Host could not authenticate to the file service to check the referenced files and folders.',
            }
      if (failure === 'invalid')
        return {
          code: FileReferenceErrorCode.Invalid,
          message: messages.invalid,
          retryable: false,
          provider,
        }
      return {
        code: FileReferenceErrorCode.CheckFailed,
        message: messages[failure],
        retryable: failure === 'transient',
        provider,
      }
    }
  }
}
