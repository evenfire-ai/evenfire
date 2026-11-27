/**
 * X4 — `POST /v1/runtime/channel-attachments/ingest` handler factory,
 * header parser, and drain-safe in-flight ingest tracker.
 *
 * Reusable across `main.ts` (Wave 2 wiring) and standalone route/handler tests.
 */
import {
  buildAttachmentFileReference,
  classifyBytes,
  parseFileReferenceV1,
} from '@clerum/gfs-interaction-policy'
import { config } from '../config'
import { DEFAULT_DOCUMENT_READ_LIMITS } from '../core/tools/documentRead/types'
import type {
  InsertChannelAttachmentResult,
  RetainedChannelAttachmentRow,
} from '../db/worker/protocol'
import {
  CHANNEL_ATTACHMENT_DEFAULT_TTL_HOURS,
  CHANNEL_ATTACHMENT_MAX_BYTES_CEILING,
  type ChannelAttachmentStore,
  ChannelAttachmentStoreError,
  normalizeChannelFilename,
  validateStrictChannelImageContainer,
} from '../internalTools/channelAttachmentStore'
import type { RuntimeLifecycleGate } from '../lifecycle/statelessHeartbeat'
import { logger } from '../logger'
import { resolveCanonicalSessionKey } from '../session/types'
import { classifyAuthorizationFailureDetailed } from '../workflow/channelIdentity'
import { resolveProviderWorkflowCallerContext } from '../workflow/providerWorkflowCallerContextClient'
import type {
  ChannelAttachmentIngestHandler,
  ChannelAttachmentIngestMetadataV1,
  ChannelAttachmentIngestResponse,
  ChannelAttachmentReceiptV1,
  IncomingMessage,
  ProviderIdentity,
} from './types'

export const CHANNEL_ATTACHMENT_META_MAX_ENCODED_BYTES = 16_384 // 16 KiB
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/
const EXTERNAL_CHANNELS = new Set(['telegram', 'slack', 'teams'])

/**
 * Tracks admitted in-flight `/v1/runtime/channel-attachments/ingest` streams
 * so `StatelessHeartbeat.getConditions().activeTask` stays `true` and
 * `flushFinalCheckpoint()` / `shutdown()` await active streams settling before
 * reporting `drained` (`R60`, `S60`, `SF9`).
 */
export class ChannelAttachmentIngestTracker {
  private readonly inFlight = new Set<Promise<void>>()

  get count(): number {
    return this.inFlight.size
  }

  hasActive(): boolean {
    return this.inFlight.size > 0
  }

  track<T>(fn: () => Promise<T>): Promise<T> {
    let resolveDone!: () => void
    const marker = new Promise<void>(resolve => {
      resolveDone = resolve
    })
    this.inFlight.add(marker)
    return fn().finally(() => {
      this.inFlight.delete(marker)
      resolveDone()
    })
  }

  async waitForAll(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight])
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseProviderIdentity(
  raw: unknown,
  expectedChannelType: 'telegram' | 'slack' | 'teams'
): ProviderIdentity | null {
  if (!isPlainObject(raw)) return null
  if (raw.medium !== expectedChannelType) return null
  if (typeof raw.providerUserId !== 'string' || !raw.providerUserId.trim()) return null
  if (typeof raw.providerChannelId !== 'string' || !raw.providerChannelId.trim()) return null
  if (
    (expectedChannelType === 'slack' || expectedChannelType === 'teams') &&
    (typeof raw.providerWorkspaceId !== 'string' || !raw.providerWorkspaceId.trim())
  ) {
    return null
  }
  if (
    raw.providerWorkspaceId !== undefined &&
    raw.providerWorkspaceId !== null &&
    typeof raw.providerWorkspaceId !== 'string'
  ) {
    return null
  }
  if (
    raw.providerChannelType !== undefined &&
    raw.providerChannelType !== null &&
    typeof raw.providerChannelType !== 'string'
  ) {
    return null
  }
  if (raw.providerEventId !== undefined && typeof raw.providerEventId !== 'string') {
    return null
  }

  let providerTarget: ProviderIdentity['providerTarget']
  if (raw.providerTarget !== undefined) {
    if (!isPlainObject(raw.providerTarget)) return null
    const t = raw.providerTarget
    if (
      typeof t.hostRef !== 'string' ||
      typeof t.communicationChannelNamespace !== 'string' ||
      typeof t.communicationChannelName !== 'string'
    ) {
      return null
    }
    providerTarget = {
      hostRef: t.hostRef,
      communicationChannelNamespace: t.communicationChannelNamespace,
      communicationChannelName: t.communicationChannelName,
      ...(typeof t.providerBotId === 'string' || t.providerBotId === null
        ? { providerBotId: t.providerBotId }
        : {}),
      ...(typeof t.providerBotUsername === 'string' || t.providerBotUsername === null
        ? { providerBotUsername: t.providerBotUsername }
        : {}),
    }
  }

  return {
    medium: expectedChannelType,
    providerUserId: raw.providerUserId,
    ...(raw.providerWorkspaceId !== undefined
      ? { providerWorkspaceId: raw.providerWorkspaceId }
      : {}),
    providerChannelId: raw.providerChannelId,
    ...(raw.providerChannelType !== undefined
      ? { providerChannelType: raw.providerChannelType }
      : {}),
    ...(raw.providerEventId !== undefined ? { providerEventId: raw.providerEventId } : {}),
    ...(providerTarget !== undefined ? { providerTarget } : {}),
  }
}

export function parseChannelAttachmentMetaHeader(
  rawHeader: unknown
): { ok: true; metadata: ChannelAttachmentIngestMetadataV1 } | { ok: false; message: string } {
  if (typeof rawHeader !== 'string' || rawHeader.trim().length === 0) {
    return { ok: false, message: 'x-clerum-attachment-meta header is required' }
  }
  const encoded = rawHeader.trim()
  if (Buffer.byteLength(encoded, 'utf8') > CHANNEL_ATTACHMENT_META_MAX_ENCODED_BYTES) {
    return {
      ok: false,
      message: `x-clerum-attachment-meta exceeds ${CHANNEL_ATTACHMENT_META_MAX_ENCODED_BYTES} bytes`,
    }
  }
  if (!BASE64URL_RE.test(encoded)) {
    return { ok: false, message: 'x-clerum-attachment-meta must be base64url encoded' }
  }

  let parsed: unknown
  try {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8')
    parsed = JSON.parse(decoded)
  } catch {
    return { ok: false, message: 'x-clerum-attachment-meta is not valid base64url UTF-8 JSON' }
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, message: 'x-clerum-attachment-meta must decode to a JSON object' }
  }

  const channelType = parsed.channelType
  if (typeof channelType !== 'string' || !EXTERNAL_CHANNELS.has(channelType)) {
    return { ok: false, message: 'channelType must be telegram, slack, or teams' }
  }
  const typedChannel = channelType as 'telegram' | 'slack' | 'teams'

  if (typeof parsed.channelId !== 'string') {
    return { ok: false, message: 'channelId must be a string' }
  }
  if (typeof parsed.sender !== 'string' || parsed.sender.trim().length === 0) {
    return { ok: false, message: 'sender must be a non-empty string' }
  }
  if (parsed.sessionThreadId !== undefined && typeof parsed.sessionThreadId !== 'string') {
    return { ok: false, message: 'sessionThreadId must be a string when present' }
  }
  if (typeof parsed.messageId !== 'string' || parsed.messageId.trim().length === 0) {
    return { ok: false, message: 'messageId must be a non-empty string' }
  }
  if (
    typeof parsed.providerAttachmentId !== 'string' ||
    parsed.providerAttachmentId.trim().length === 0
  ) {
    return { ok: false, message: 'providerAttachmentId must be a non-empty string' }
  }
  if (parsed.filename !== null && typeof parsed.filename !== 'string') {
    return { ok: false, message: 'filename must be a string or null' }
  }
  if (parsed.declaredMediaType !== null && typeof parsed.declaredMediaType !== 'string') {
    return { ok: false, message: 'declaredMediaType must be a string or null' }
  }

  const providerIdentity = parseProviderIdentity(parsed.providerIdentity, typedChannel)
  if (!providerIdentity) {
    return { ok: false, message: 'providerIdentity is missing or invalid' }
  }
  if (parsed.sender.trim() !== providerIdentity.providerUserId.trim()) {
    return { ok: false, message: 'sender must match providerIdentity.providerUserId' }
  }

  return {
    ok: true,
    metadata: {
      channelType: typedChannel,
      channelId: parsed.channelId,
      sender: parsed.sender,
      ...(parsed.sessionThreadId !== undefined ? { sessionThreadId: parsed.sessionThreadId } : {}),
      messageId: parsed.messageId,
      providerIdentity,
      providerAttachmentId: parsed.providerAttachmentId,
      filename: parsed.filename,
      declaredMediaType: parsed.declaredMediaType,
    },
  }
}

function receiptFromRow(
  row: RetainedChannelAttachmentRow,
  deduplicated: boolean
): ChannelAttachmentReceiptV1 | null {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(row.file_reference_json)
  } catch {
    return null
  }
  const parsedRef = parseFileReferenceV1(parsedJson)
  if (!parsedRef.ok) return null
  const fileReference = parsedRef.value
  const documentReadOverLimit =
    (fileReference.reader === 'pdf' || fileReference.reader === 'xlsx') &&
    row.byte_length > DEFAULT_DOCUMENT_READ_LIMITS.maxSourceBytes
  const isImageClass = fileReference.class === 'jpeg' || fileReference.class === 'png'
  return {
    ok: true,
    attachmentId: row.attachment_id,
    fileReference,
    expiresAt: new Date(row.expires_at * 1000).toISOString(),
    ...(row.width !== null ? { width: row.width } : {}),
    ...(row.height !== null ? { height: row.height } : {}),
    ...(isImageClass ? { visualValid: row.visual_valid === 1 } : {}),
    ...(documentReadOverLimit ? { documentReadOverLimit: true } : {}),
    ...(deduplicated ? { deduplicated: true } : {}),
  }
}

export interface CreateChannelAttachmentIngestHandlerDeps {
  store: ChannelAttachmentStore
  insertAttachment: (row: RetainedChannelAttachmentRow) => Promise<InsertChannelAttachmentResult>
  resolveCallerContext?: (message: IncomingMessage) => Promise<{ targetUserId?: string } | null>
  lifecycleGate?: RuntimeLifecycleGate | null
  tracker?: ChannelAttachmentIngestTracker
  maxBytes?: number
  ttlHours?: number
  sessionStoreMode?: 'memory' | 'sqlite' | 'dual'
  now?: () => number
}

export function createChannelAttachmentIngestHandler(
  deps: CreateChannelAttachmentIngestHandlerDeps
): ChannelAttachmentIngestHandler {
  const resolveCallerContext =
    deps.resolveCallerContext ?? (msg => resolveProviderWorkflowCallerContext(msg))
  const tracker = deps.tracker ?? new ChannelAttachmentIngestTracker()
  const now = deps.now ?? (() => Date.now())

  return async ({
    metadata,
    stream,
    contentLength,
    caller,
  }): Promise<ChannelAttachmentIngestResponse> => {
    if (deps.lifecycleGate?.isIntakeFenced()) {
      deps.lifecycleGate.noteFencedIntake()
      return {
        status: 503,
        body: {
          ok: false,
          error: {
            code: 'host_draining',
            message: 'Host is draining',
            retryable: true,
          },
        },
      }
    }

    // Register synchronously immediately after isIntakeFenced() === false so
    // StatelessHeartbeat.getConditions().activeTask observes this stream before
    // any await point (`R60`, `S60`).
    return tracker.track(async () => {
      deps.lifecycleGate?.noteIntakeActivity()

      const storeMode = deps.sessionStoreMode ?? config.sessionStoreMode
      if (storeMode === 'memory' || !deps.store.isAvailable()) {
        return {
          status: 503,
          body: {
            ok: false,
            error: {
              code: 'channel_attachment_store_unavailable',
              message: 'Channel attachment store is unavailable',
              retryable: false,
            },
          },
        }
      }

      const nowMs = now()
      const syntheticMessage: IncomingMessage = {
        content: '',
        channelType: metadata.channelType,
        channelId: metadata.channelId,
        sender: metadata.sender,
        timestamp: new Date(nowMs).toISOString(),
        messageId: metadata.messageId,
        hostRef: caller.hostRef ?? '',
        ...(metadata.sessionThreadId !== undefined ? { threadId: metadata.sessionThreadId } : {}),
        providerIdentity: metadata.providerIdentity,
      }

      let linkedUserId: string
      try {
        const resolved = await resolveCallerContext(syntheticMessage)
        const trimmedUserId = resolved?.targetUserId?.trim() ?? ''
        if (!trimmedUserId) {
          return {
            status: 403,
            body: {
              ok: false,
              error: {
                code: 'linked_user_unresolved',
                message: 'Sender account is not linked or authorized',
                retryable: false,
              },
            },
          }
        }
        linkedUserId = trimmedUserId
      } catch (err) {
        const kind = classifyAuthorizationFailureDetailed(err)
        if (kind === 'account_unresolved' || kind === 'channel_access_denied') {
          return {
            status: 403,
            body: {
              ok: false,
              error: {
                code: 'linked_user_unresolved',
                message: 'Sender account is not linked or authorized',
                retryable: false,
              },
            },
          }
        }
        logger.warn(
          {
            component: 'ChannelAttachmentIngest',
            channelType: metadata.channelType,
            err,
          },
          'Transient error resolving linked user for channel attachment ingest'
        )
        return {
          status: 503,
          body: {
            ok: false,
            error: {
              code: 'identity_check_unavailable',
              message: 'Unable to verify sender identity',
              retryable: true,
            },
          },
        }
      }

      const sessionKey = resolveCanonicalSessionKey({
        sender: metadata.sender,
        channelType: metadata.channelType,
        channelId: metadata.channelId,
        threadId: metadata.sessionThreadId,
      })

      const maxBytes = Math.min(
        Math.max(1, deps.maxBytes ?? config.channelAttachmentMaxBytes),
        CHANNEL_ATTACHMENT_MAX_BYTES_CEILING
      )

      let stored: Awaited<ReturnType<ChannelAttachmentStore['putStream']>>
      try {
        stored = await deps.store.putStream({
          stream,
          linkedUserId,
          declaredBytes: contentLength,
          maxBytes,
        })
      } catch (err) {
        if (err instanceof ChannelAttachmentStoreError) {
          switch (err.code) {
            case 'file_too_large':
              return {
                status: 413,
                body: {
                  ok: false,
                  error: { code: 'file_too_large', message: err.message, retryable: false },
                },
              }
            case 'disk_full':
            case 'quota_exceeded':
              return {
                status: 507,
                body: {
                  ok: false,
                  error: { code: err.code, message: err.message, retryable: true },
                },
              }
            case 'channel_attachment_store_unavailable':
              return {
                status: 503,
                body: {
                  ok: false,
                  error: { code: err.code, message: err.message, retryable: false },
                },
              }
            default:
              return {
                status: 500,
                body: {
                  ok: false,
                  error: { code: err.code, message: err.message, retryable: true },
                },
              }
          }
        }
        logger.error(
          { component: 'ChannelAttachmentIngest', err },
          'Unexpected failure storing channel attachment'
        )
        return {
          status: 500,
          body: {
            ok: false,
            error: {
              code: 'storage_write_failed',
              message: 'Failed to store channel attachment',
              retryable: true,
            },
          },
        }
      }

      try {
        const classification = classifyBytes({
          bytes: stored.bytes,
          totalByteLength: stored.byteLength,
          declaredMediaType: metadata.declaredMediaType,
          filename: metadata.filename,
        })
        const normalizedName = normalizeChannelFilename(
          metadata.filename,
          classification.class,
          stored.attachmentId
        )
        const fileRefResult = buildAttachmentFileReference({
          attachmentId: stored.attachmentId,
          messageId: metadata.messageId,
          name: normalizedName,
          declaredMediaType: metadata.declaredMediaType,
          byteLength: stored.byteLength,
          digestHex: stored.sha256,
          classification,
        })
        if (!fileRefResult.ok) {
          await deps.store.removeBlob(stored.storageRelPath)
          return {
            status: 400,
            body: {
              ok: false,
              error: {
                code: fileRefResult.code,
                message: fileRefResult.message,
                retryable: false,
              },
            },
          }
        }

        const imageCheck = validateStrictChannelImageContainer(stored.bytes, classification.class)
        const ttlHours =
          deps.ttlHours ?? config.channelAttachmentTtlHours ?? CHANNEL_ATTACHMENT_DEFAULT_TTL_HOURS
        const createdAtEpoch = nowMs / 1000
        const expiresAtEpoch = (nowMs + ttlHours * 3600 * 1000) / 1000
        const providerEventId =
          metadata.providerIdentity.providerEventId?.trim() || metadata.messageId

        const row: RetainedChannelAttachmentRow = {
          attachment_id: stored.attachmentId,
          session_key: sessionKey,
          linked_user_id: linkedUserId,
          provider_event_id: providerEventId,
          provider_attachment_id: metadata.providerAttachmentId,
          storage_rel_path: stored.storageRelPath,
          sha256: stored.sha256,
          byte_length: stored.byteLength,
          file_reference_json: JSON.stringify(fileRefResult.value),
          width: imageCheck.width,
          height: imageCheck.height,
          visual_valid: imageCheck.visualValid ? 1 : 0,
          created_at: createdAtEpoch,
          expires_at: expiresAtEpoch,
          status: 'ready',
        }

        const insertResult = await deps.insertAttachment(row)

        if (insertResult.deduplicated) {
          // Verify existing committed blob before returning idempotent receipt,
          // then remove the newly written duplicate blob (`S26`).
          try {
            await deps.store.readVerified(
              insertResult.record.storage_rel_path,
              insertResult.record.sha256
            )
          } catch (verifyErr) {
            await deps.store.removeBlob(stored.storageRelPath)
            logger.warn(
              {
                component: 'ChannelAttachmentIngest',
                attachmentId: insertResult.record.attachment_id,
                err: verifyErr,
              },
              'Deduplicated channel attachment failed integrity verification'
            )
            return {
              status: 500,
              body: {
                ok: false,
                error: {
                  code: 'attachment_integrity_failed',
                  message: 'Existing retained attachment failed integrity check',
                  retryable: true,
                },
              },
            }
          }
          if (insertResult.record.storage_rel_path !== stored.storageRelPath) {
            await deps.store.removeBlob(stored.storageRelPath)
          }
          const existingReceipt = receiptFromRow(insertResult.record, true)
          if (!existingReceipt) {
            return {
              status: 500,
              body: {
                ok: false,
                error: {
                  code: 'storage_write_failed',
                  message: 'Persisted file reference could not be parsed',
                  retryable: false,
                },
              },
            }
          }
          return { status: 200, body: existingReceipt }
        }

        if (
          insertResult.replacedStorageRelPath &&
          insertResult.replacedStorageRelPath !== stored.storageRelPath
        ) {
          await deps.store.removeBlob(insertResult.replacedStorageRelPath).catch(unlinkErr => {
            logger.warn(
              {
                component: 'ChannelAttachmentIngest',
                replacedStorageRelPath: insertResult.replacedStorageRelPath,
                err: unlinkErr,
              },
              'Failed to remove superseded channel attachment blob'
            )
          })
        }

        const documentReadOverLimit =
          (fileRefResult.value.reader === 'pdf' || fileRefResult.value.reader === 'xlsx') &&
          stored.byteLength > DEFAULT_DOCUMENT_READ_LIMITS.maxSourceBytes
        const isImageClass = classification.class === 'jpeg' || classification.class === 'png'

        logger.info(
          {
            component: 'ChannelAttachmentIngest',
            event: 'channel_attachment_ingested',
            channelType: metadata.channelType,
            attachmentId: stored.attachmentId,
            fileClass: classification.class,
            reader: fileRefResult.value.reader,
            byteLength: stored.byteLength,
            mismatch: classification.mismatch,
            ...(isImageClass ? { visualValid: imageCheck.visualValid } : {}),
            ...(documentReadOverLimit ? { documentReadOverLimit: true } : {}),
          },
          'Channel attachment ingested'
        )

        return {
          status: 200,
          body: {
            ok: true,
            attachmentId: stored.attachmentId,
            fileReference: fileRefResult.value,
            expiresAt: new Date(expiresAtEpoch * 1000).toISOString(),
            ...(imageCheck.width !== null ? { width: imageCheck.width } : {}),
            ...(imageCheck.height !== null ? { height: imageCheck.height } : {}),
            ...(isImageClass ? { visualValid: imageCheck.visualValid } : {}),
            ...(documentReadOverLimit ? { documentReadOverLimit: true } : {}),
          },
        }
      } catch (err) {
        await deps.store.removeBlob(stored.storageRelPath)
        logger.error(
          { component: 'ChannelAttachmentIngest', err },
          'Failed to persist channel attachment metadata'
        )
        return {
          status: 500,
          body: {
            ok: false,
            error: {
              code: 'storage_write_failed',
              message: 'Failed to persist channel attachment metadata',
              retryable: true,
            },
          },
        }
      }
    })
  }
}
