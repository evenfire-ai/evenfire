import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { withAbort } from '../core/adapters/abortableLlmPort'
import { logger } from '../logger'
import { type GfsImageSource, VisualInputError } from '../visualInput/policy'
import {
  type GfsContentRequest,
  assertContentHeaders,
  collect,
  metadataSnapshot,
  normalizeRid,
  requireOk,
} from './gfsContentRead'
import {
  type GfsDownloadReceipt,
  GfsDownloadStore,
  GfsDownloadStoreError,
  type GfsDownloadTransfer,
} from './gfsDownloadStore'
import { GFS_FILE_LIMITS } from './gfsFilePolicy'

const MAX_DOWNLOAD_TIME_MS = 600_000

export type GfsDownloadErrorCode =
  | 'cancelled'
  | 'identity_mismatch'
  | 'incomplete_response'
  | 'invalid_response'
  | 'limit_exceeded'
  | 'storage_write_failed'
  | 'timeout'
  | 'version_conflict'

export class GfsDownloadError extends Error {
  constructor(readonly code: GfsDownloadErrorCode) {
    super(`GFS download failed (${code})`)
    this.name = 'GfsDownloadError'
  }
}

export interface GfsDownloadOptions {
  store: GfsDownloadStore
  callerIdentity: string
  callerWorkspacePath: string
  signal?: AbortSignal
  timeoutMs?: number
  deadlineMs?: number
  expectedVersion?: number
}

export type GfsDownloadResult = GfsDownloadReceipt

function transferError(error: VisualInputError): GfsDownloadError {
  if (error.code === 'version_conflict') return new GfsDownloadError('version_conflict')
  if (error.code === 'identity_mismatch') return new GfsDownloadError('identity_mismatch')
  if (error.code === 'incomplete_response') return new GfsDownloadError('incomplete_response')
  if (error.code === 'limit_exceeded') return new GfsDownloadError('limit_exceeded')
  if (error.code === 'timeout') return new GfsDownloadError('timeout')
  if (error.code === 'cancelled') return new GfsDownloadError('cancelled')
  return new GfsDownloadError('invalid_response')
}

function requireDownloadContentHeaders(
  response: Response,
  source: GfsImageSource,
  size: number
): void {
  assertContentHeaders(response, source, size)
  const length = response.headers.get('content-length')
  if (
    length === null ||
    !/^\d+$/.test(length) ||
    !Number.isSafeInteger(Number(length)) ||
    Number(length) !== size
  )
    throw new GfsDownloadError('incomplete_response')
}

/** Stream an authenticated, version-bound GFS resource into the Host-owned store. */
export async function downloadGfsContent(
  request: GfsContentRequest,
  args: { drive: string; resourceId: string },
  options: GfsDownloadOptions
): Promise<GfsDownloadResult> {
  if (typeof args.drive !== 'string' || !args.drive || !normalizeRid(args.resourceId))
    throw new GfsDownloadError('invalid_response')
  if (options.signal?.aborted) throw new GfsDownloadError('cancelled')

  const startedAt = Date.now()
  const timeoutMs = Math.min(
    options.timeoutMs ?? MAX_DOWNLOAD_TIME_MS,
    MAX_DOWNLOAD_TIME_MS,
    options.deadlineMs === undefined ? Number.POSITIVE_INFINITY : options.deadlineMs - startedAt
  )
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new GfsDownloadError('timeout')
  const deadlineMs = startedAt + timeoutMs

  const controller = new AbortController()
  let expired = false
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, timeoutMs)
  const signal = controller.signal
  const resourcePath = `/v1/resources/${encodeURIComponent(args.resourceId)}`
  const query = `?drive=${encodeURIComponent(args.drive)}`
  const init: RequestInit = {
    signal,
    redirect: 'error',
    headers: { 'accept-encoding': 'identity' },
  }

  let transfer: GfsDownloadTransfer | undefined
  let destination: fs.FileHandle | undefined
  let response: Response | undefined
  let published = false
  try {
    const metadata = await withAbort(
      () => request(`${resourcePath}${query}`, init, deadlineMs),
      signal
    )
    await requireOk(metadata, signal)
    let source: GfsDownloadReceipt['source']
    let sizeBytes: number
    try {
      const snapshot = metadataSnapshot(
        await collect(metadata, GFS_FILE_LIMITS.metadataBytes, signal),
        args,
        options.expectedVersion
      )
      source = snapshot.source
      sizeBytes = snapshot.size
    } catch (error) {
      if (error instanceof VisualInputError) throw transferError(error)
      throw error
    }

    transfer = await options.store.createTransfer({
      callerIdentity: options.callerIdentity,
      callerWorkspacePath: options.callerWorkspacePath,
      source,
      sizeBytes,
      expiresAt: new Date(Date.now() + GFS_FILE_LIMITS.retentionMs).toISOString(),
    })
    const partialPath = path.join(options.callerWorkspacePath, transfer.partialPath)
    destination = await fs.open(partialPath, constants.O_WRONLY | constants.O_NOFOLLOW)
    const partialInfo = await destination.stat()
    if (
      !partialInfo.isFile() ||
      partialInfo.isSymbolicLink?.() ||
      partialInfo.size !== 0 ||
      partialInfo.mode & 0o077
    )
      throw new GfsDownloadError('storage_write_failed')

    response = await withAbort(
      () => request(`${resourcePath}/content${query}`, init, deadlineMs),
      signal
    )
    await requireOk(response, signal)
    requireDownloadContentHeaders(response, source, sizeBytes)

    const digest = createHash('sha256')
    let bytes = 0
    if (response.body) {
      const reader = response.body.getReader()
      const cancel = () => {
        void reader.cancel().catch(() => undefined)
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        for (;;) {
          if (signal.aborted) throw new GfsDownloadError('cancelled')
          const next = await reader.read()
          if (signal.aborted) throw new GfsDownloadError('cancelled')
          if (next.done) break
          if (next.value.byteLength > sizeBytes - bytes)
            throw new GfsDownloadError('limit_exceeded')
          let offset = 0
          while (offset < next.value.byteLength) {
            const written = await destination.write(
              next.value,
              offset,
              next.value.byteLength - offset
            )
            if (written.bytesWritten <= 0) throw new GfsDownloadError('storage_write_failed')
            offset += written.bytesWritten
          }
          digest.update(next.value)
          bytes += next.value.byteLength
        }
      } finally {
        signal.removeEventListener('abort', cancel)
        await reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    }

    if (bytes !== sizeBytes) throw new GfsDownloadError('incomplete_response')
    if (signal.aborted) throw new GfsDownloadError('cancelled')
    await destination.sync()
    await destination.close()
    destination = undefined
    const receipt = await options.store.publish(
      transfer.id,
      options.callerIdentity,
      digest.digest('hex')
    )
    published = true
    return receipt
  } catch (error) {
    if (signal.aborted) throw new GfsDownloadError(expired ? 'timeout' : 'cancelled')
    if (error instanceof GfsDownloadError) throw error
    if (error instanceof VisualInputError) throw transferError(error)
    if (error instanceof GfsDownloadStoreError) throw error
    if (
      (error as Error)?.name === 'GfscHttpError' ||
      /^gfsc \d{3}:/.test((error as Error)?.message ?? '')
    )
      throw error
    throw new GfsDownloadError('storage_write_failed')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    await destination?.close().catch(() => undefined)
    await response?.body?.cancel().catch(() => undefined)
    if (transfer && !published) {
      try {
        await options.store.fail(transfer.id, options.callerIdentity)
      } catch (cleanupError) {
        logger.warn(
          {
            component: 'GfsDownload',
            err: { code: (cleanupError as NodeJS.ErrnoException).code },
          },
          'GFS partial cleanup failed'
        )
      }
    }
  }
}
