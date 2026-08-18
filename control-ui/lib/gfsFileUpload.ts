import {
  GFS_FILE_UPLOAD_DEFAULT_CONCURRENCY,
  GFS_FILE_UPLOAD_DEFAULT_PRODUCT_MAX_BYTES,
  GFS_FILE_UPLOAD_FALLBACK_CONCURRENCY,
  GFS_FILE_UPLOAD_MAX_PART_BYTES,
  GFS_FILE_UPLOAD_PROTOCOL_MAX_BYTES,
} from '@constants/gfsFileUpload'
import { apiSend } from './api'

const API_BASE = process.env.NEXT_PUBLIC_CONTROL_API_BASE_URL || '/control-api'
const GFS_UPLOAD_DRIVE = 'main'
// Retry only transient transport/edge failures. 507 (storage exhausted) and
// other permanent 5xx responses are deliberately terminal: retrying them would
// amplify a capacity incident instead of giving the operator a durable error.
export const GFS_UPLOAD_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const GFS_UPLOAD_AMBIGUOUS_STATUS = new Set([408, 500, 502, 503, 504])
export const GFS_UPLOAD_DEFAULT_INSTABILITY_FAILURE_THRESHOLD = 3
const GFS_UPLOAD_MAX_INSTABILITY_FAILURE_THRESHOLD = 100
export const GFS_UPLOAD_RETRY_MAX_ATTEMPTS = 3
/**
 * A writer restart can keep the service endpoint unavailable for longer than
 * the ordinary application-error retry budget. Keep this separate from the
 * lifecycle budget so 502/503/504 recovery is longer but still bounded.
 */
export const GFS_UPLOAD_SERVICE_RETRY_MAX_ATTEMPTS = 6
export const GFS_UPLOAD_RETRY_AFTER_CAP_MS = 5_000
const GFS_UPLOAD_RETRY_BASE_DELAY_MS = 250
const GFS_UPLOAD_V2_PART_TIMEOUT_MS = 300_000
const GFS_UPLOAD_V2_RECONCILE_TIMEOUT_MS = 60_000
const GFS_UPLOAD_V2_RECONCILE_ATTEMPTS = 3

export function isRetryableUploadStatus(status: number): boolean {
  return GFS_UPLOAD_RETRYABLE_STATUS.has(status)
}

export function isAmbiguousUploadStatus(status: number): boolean {
  return GFS_UPLOAD_AMBIGUOUS_STATUS.has(status)
}

export interface GfsUploadTarget {
  operation: 'create' | 'replace'
  parentRid?: string
  resourceRid?: string
  ifMatch?: number
}

export interface GfsUploadProgress {
  uploadedBytes: number
  totalBytes: number
  partNumber: number
  partCount: number
}

export interface UploadReceipt {
  uploadId: string
  drive?: string
  operation?: 'create' | 'replace'
  expectedBytes: number
  partBytes: number
  partCount: number
  state: string
  contiguousBytes?: number
  committedBytes?: number
  committedPartCount?: number
  activePartCount: number
  activePartNumbers?: number[]
  expiresAt?: string
  resultResourceId?: string
  resultVersion?: number
  resultSha256?: string
}

export interface GfsUploadPartReceipt {
  partNumber: number
  offsetBytes: number
  lengthBytes: number
  sha256: string
}

export interface GfsUploadStatus {
  session: UploadReceipt
  parts: GfsUploadPartReceipt[]
  nextCursor?: string | null
}

export type GfsUploadJobState =
  | 'initiated'
  | 'uploading'
  | 'paused'
  | 'finalizing'
  | 'canceling'
  | 'completed'
  | 'aborted'
  | 'failed'

export interface GfsUploadJobSnapshot {
  state: GfsUploadJobState
  session: UploadReceipt | null
  uploadedBytes: number
  totalBytes: number
}

export interface GfsUploadJobInput {
  file: File
  name: string
  target: GfsUploadTarget
  signal?: AbortSignal
  resumeUploadId?: string
  onProgress?: (progress: GfsUploadProgress) => void
  onState?: (snapshot: GfsUploadJobSnapshot) => void
  /** Persist only bounded metadata; never persist file bytes. */
  onPersist?: (record: {
    uploadId: string
    fileName: string
    fileSize: number
    lastModified: number
    target: GfsUploadTarget
    name: string
    session: UploadReceipt
  }) => void | Promise<void>
  onPersistPending?: (record: {
    idempotencyKey: string
    fileName: string
    fileSize: number
    lastModified: number
    target: GfsUploadTarget
    name: string
  }) => void | Promise<void>
  onClearPersisted?: (uploadId: string) => void | Promise<void>
}

interface UploadCapabilities {
  upload?: {
    resumableV2?: {
      enabled?: boolean
      maxFileBytes?: number
      preferredChunkBytes?: number
      maxChunkBytes?: number
      maxConcurrentPartsPerSession?: number
      instabilityFailureThreshold?: number
      fallbackConcurrency?: number
    }
  }
}

export class GfsUploadCapabilityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'GfsUploadCapabilityError'
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseUploadCapabilities(value: unknown): NonNullable<UploadCapabilities['upload']> {
  if (!plainObject(value)) {
    throw new GfsUploadCapabilityError(
      'Invalid GFS upload capabilities response: expected a plain JSON object.'
    )
  }
  const upload = value.upload
  if (!plainObject(upload)) {
    throw new GfsUploadCapabilityError(
      'Invalid GFS upload capabilities response: missing upload object.'
    )
  }
  const resumableV2 = upload.resumableV2
  if (!plainObject(resumableV2)) {
    throw new GfsUploadCapabilityError(
      'Invalid GFS upload capabilities response: missing resumableV2 object.'
    )
  }
  if (typeof resumableV2.enabled !== 'boolean') {
    throw new GfsUploadCapabilityError(
      'Invalid GFS upload capabilities response: resumableV2.enabled must be Boolean.'
    )
  }
  return upload as NonNullable<UploadCapabilities['upload']>
}

export function normalizeUploadProductMaxBytes(value: unknown): number {
  if (value === undefined) return GFS_FILE_UPLOAD_DEFAULT_PRODUCT_MAX_BYTES
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > GFS_FILE_UPLOAD_PROTOCOL_MAX_BYTES
  ) {
    throw new GfsUploadCapabilityError(
      'Resumable GFS upload capabilities advertised an invalid file ceiling.'
    )
  }
  return value as number
}

export function normalizeInstabilityFailureThreshold(value: unknown): number {
  if (value === undefined) return GFS_UPLOAD_DEFAULT_INSTABILITY_FAILURE_THRESHOLD
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > GFS_UPLOAD_MAX_INSTABILITY_FAILURE_THRESHOLD
  ) {
    throw new GfsUploadCapabilityError(
      'Resumable GFS upload capabilities advertised an invalid instability threshold.'
    )
  }
  return value as number
}

export const GFS_LEGACY_UPLOAD_MAX_BYTES = 16 * 1024 * 1024

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return [...bytes]
    .map(
      (value, index) =>
        `${value.toString(16).padStart(2, '0')}${[3, 5, 7, 9].includes(index) ? '-' : ''}`
    )
    .join('')
}

function endpoint(path: string): string {
  return `${API_BASE}${path}`
}

function signalWithTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = window.setTimeout(
    () => controller.abort(new Error('GFS upload request timed out')),
    timeoutMs
  )
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    cancel: () => {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    },
  }
}

async function requestJson<T>(
  method: 'GET' | 'POST' | 'HEAD' | 'DELETE',
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs = 600_000
): Promise<{ data: T; response: Response }> {
  const timed = signalWithTimeout(signal, timeoutMs)
  try {
    const response = await fetch(endpoint(path), {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timed.signal,
    })
    if (!response.ok) throw await uploadError(response)
    const text = await response.text()
    return { data: (text ? JSON.parse(text) : undefined) as T, response }
  } finally {
    timed.cancel()
  }
}

async function uploadError(
  response: Response
): Promise<Error & { status?: number; code?: string; retryAfterMs?: number }> {
  const text = await response.text().catch(() => '')
  let message = text || response.statusText || 'GFS upload failed'
  let code: string | undefined
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown; code?: unknown }
    if (typeof parsed.message === 'string') message = parsed.message
    if (typeof parsed.error === 'string') code = parsed.error
    if (
      parsed.error &&
      typeof parsed.error === 'object' &&
      typeof (parsed.error as { code?: unknown }).code === 'string'
    ) {
      code = String((parsed.error as { code: string }).code)
      message =
        typeof (parsed.error as { message?: unknown }).message === 'string'
          ? String((parsed.error as { message: string }).message)
          : message
    }
  } catch {
    // Preserve the bounded upstream text for non-JSON proxy errors.
  }
  const error = new Error(`${response.status} ${message}`) as Error & {
    status?: number
    code?: string
    retryAfterMs?: number
  }
  error.status = response.status
  error.code = code
  error.retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
  return error
}

/** Parse an RFC 7231 Retry-After value and cap it before it reaches a timer. */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs = Date.now(),
  capMs = GFS_UPLOAD_RETRY_AFTER_CAP_MS
): number | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const seconds = Number(trimmed)
  let delayMs: number
  if (Number.isFinite(seconds) && seconds >= 0) {
    delayMs = seconds * 1_000
  } else {
    const dateMs = Date.parse(trimmed)
    if (!Number.isFinite(dateMs)) return undefined
    delayMs = Math.max(0, dateMs - nowMs)
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) return undefined
  return Math.min(capMs, delayMs)
}

function assertRetryable(error: unknown): boolean {
  if (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.message.startsWith('source_changed:') ||
      error.message.startsWith('upload_part_mismatch:') ||
      error.message.startsWith('upload_part_outcome_unknown:') ||
      error.message.startsWith('upload_completion_outcome_unknown:'))
  )
    return false
  const status =
    typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined
  return typeof status === 'number' ? isRetryableUploadStatus(status) : true
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = window.setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

function retryAfterOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as {
    retryAfterMs?: unknown
    retryAfter?: unknown
    headers?: { get?: (name: string) => string | null }
    response?: { headers?: { get?: (name: string) => string | null } }
  }
  if (typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs))
    return Math.min(GFS_UPLOAD_RETRY_AFTER_CAP_MS, Math.max(0, value.retryAfterMs))
  const header =
    typeof value.retryAfter === 'string'
      ? value.retryAfter
      : (value.headers?.get?.('retry-after') ?? value.response?.headers?.get?.('retry-after'))
  return parseRetryAfter(typeof header === 'string' ? header : undefined)
}

function ambiguousLifecycleError(error: unknown): boolean {
  const status = statusOf(error)
  // Transport failures have no HTTP status; keep them ambiguous so completion
  // reconciles durable state instead of assuming that the request was lost.
  if (typeof status !== 'number') return true
  return isAmbiguousUploadStatus(status)
}

function terminalReconciliationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return [
    'upload status changed during reconciliation',
    'upload_part_mismatch:',
    'source_changed:',
    'upload_completion_outcome_unknown:',
    'cannot reconcile ',
  ].some(prefix => error.message.startsWith(prefix))
}

interface LifecycleRecovery<T> {
  value: T
}

interface LifecycleRetryOptions<T> {
  signal?: AbortSignal
  attempts?: number
  reconcileOnError?: (error: unknown) => boolean
  reconcile?: (error: unknown) => Promise<LifecycleRecovery<T> | undefined>
}

/**
 * Bounded lifecycle retry primitive. It centralizes status classification,
 * capped Retry-After handling, abort propagation, and optional ambiguity
 * reconciliation for state-changing requests.
 */
async function requestWithLifecycleRetries<T>(
  operation: () => Promise<T>,
  options: LifecycleRetryOptions<T> = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? GFS_UPLOAD_RETRY_MAX_ATTEMPTS)
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (options.signal?.aborted) throw options.signal.reason ?? error
      const shouldReconcile = options.reconcile
        ? (options.reconcileOnError?.(error) ?? ambiguousLifecycleError(error))
        : false
      if (shouldReconcile) {
        try {
          const recovered = await options.reconcile!(error)
          if (recovered) return recovered.value
        } catch (reconcileError) {
          // A transient status/HEAD failure must not suppress the bounded
          // retry of the original request. Definitive geometry, auth, or
          // outcome-unknown errors remain terminal and are surfaced.
          if (terminalReconciliationError(reconcileError)) throw reconcileError
        }
      }
      if (!assertRetryable(error) || attempt + 1 >= attempts) throw error
      await delay(
        retryAfterOf(error) ??
          Math.min(GFS_UPLOAD_RETRY_AFTER_CAP_MS, GFS_UPLOAD_RETRY_BASE_DELAY_MS * 2 ** attempt),
        options.signal
      )
    }
  }
  throw lastError
}

function digestBase64(bytes: ArrayBuffer): string {
  let binary = ''
  const view = new Uint8Array(bytes)
  for (let index = 0; index < view.length; index += 0x8000)
    binary += String.fromCharCode(...view.subarray(index, index + 0x8000))
  return btoa(binary)
}

function digestHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('')
}

interface GfsPartChecksum {
  base64: string
  hex: string
}

async function sha256Part(blob: Blob): Promise<GfsPartChecksum> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return { base64: digestBase64(digest), hex: digestHex(digest) }
}

function indexCommittedParts(
  session: UploadReceipt,
  parts: readonly GfsUploadPartReceipt[]
): Map<number, GfsUploadPartReceipt> {
  const committed = new Map<number, GfsUploadPartReceipt>()
  for (const part of parts) {
    if (
      !Number.isSafeInteger(part.partNumber) ||
      part.partNumber < 0 ||
      part.partNumber >= session.partCount
    )
      throw new Error(
        `upload_part_mismatch: part number ${part.partNumber} is outside the upload geometry`
      )
    const expectedOffset = part.partNumber * session.partBytes
    const expectedLength = Math.min(session.partBytes, session.expectedBytes - expectedOffset)
    if (part.offsetBytes !== expectedOffset || part.lengthBytes !== expectedLength)
      throw new Error(
        `upload_part_mismatch: part ${part.partNumber} does not match the upload geometry`
      )
    if (committed.has(part.partNumber))
      throw new Error(`upload_part_mismatch: part ${part.partNumber} was returned more than once`)
    if (!/^[0-9a-f]{64}$/i.test(part.sha256))
      throw new Error(`upload_part_mismatch: part ${part.partNumber} has an invalid SHA-256 digest`)
    committed.set(part.partNumber, part)
  }
  return committed
}

async function loadUploadStatus(
  uploadId: string,
  expected: { expectedBytes: number; drive?: string; partBytes?: number; partCount?: number },
  signal?: AbortSignal,
  timeoutMs = 600_000,
  retryAttempts = GFS_UPLOAD_RETRY_MAX_ATTEMPTS
): Promise<{ status: GfsUploadStatus; head: Response }> {
  const head = await requestWithLifecycleRetries(
    () =>
      requestJson<undefined>(
        'HEAD',
        `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(uploadId)}`,
        undefined,
        signal,
        timeoutMs
      ),
    { signal, attempts: retryAttempts }
  )
  const declaredLengthHeader = head.response.headers.get('upload-length')
  if (declaredLengthHeader !== null) {
    const declaredLength = Number(declaredLengthHeader)
    if (Number.isSafeInteger(declaredLength) && declaredLength !== expected.expectedBytes)
      throw new Error('selected file size differs from the persisted upload session')
  }

  let cursor: string | undefined
  let session: UploadReceipt | null = null
  const parts: GfsUploadPartReceipt[] = []
  for (let page = 0; page < 8; page += 1) {
    const query = cursor ? `?limit=256&cursor=${encodeURIComponent(cursor)}` : '?limit=256'
    const response = await requestWithLifecycleRetries(
      () =>
        requestJson<{ ok: boolean; data: GfsUploadStatus }>(
          'GET',
          `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(uploadId)}/status${query}`,
          undefined,
          signal,
          timeoutMs
        ),
      { signal, attempts: retryAttempts }
    )
    const current = receiptFromResponse(response)
    session ??= current.session
    if (
      session.uploadId !== current.session.uploadId ||
      session.uploadId !== uploadId ||
      session.expectedBytes !== current.session.expectedBytes ||
      session.expectedBytes !== expected.expectedBytes ||
      (expected.drive !== undefined && current.session.drive !== expected.drive) ||
      session.partBytes !== current.session.partBytes ||
      session.partCount !== current.session.partCount ||
      (expected.partBytes !== undefined && current.session.partBytes !== expected.partBytes) ||
      (expected.partCount !== undefined && current.session.partCount !== expected.partCount)
    )
      throw new Error('upload status changed during reconciliation')
    parts.push(...current.parts)
    if (!current.nextCursor)
      return { status: { session, parts, nextCursor: null }, head: head.response }
    cursor = current.nextCursor
    if (page === 7) throw new Error('upload status pagination exceeded the bounded page limit')
  }
  throw new Error('upload status pagination did not terminate')
}

function ambiguousPartResponse(status: number | undefined): boolean {
  return status === undefined || isAmbiguousUploadStatus(status)
}

function partRetryAttempts(error: unknown): number {
  const status = statusOf(error)
  return status === undefined || status === 502 || status === 503 || status === 504
    ? GFS_UPLOAD_SERVICE_RETRY_MAX_ATTEMPTS
    : GFS_UPLOAD_RETRY_MAX_ATTEMPTS
}

function partOutcomeUnknown(partNumber: number, cause?: unknown): Error {
  return new Error(
    `upload_part_outcome_unknown: could not prove whether part ${partNumber} committed; resume the persisted session`,
    { cause }
  )
}

async function reconcileAmbiguousPart(
  file: File,
  session: UploadReceipt,
  part: { partNumber: number; offsetBytes: number; lengthBytes: number },
  checksum: GfsPartChecksum,
  signal?: AbortSignal
): Promise<'committed' | 'missing'> {
  let lastError: unknown
  for (let attempt = 0; attempt < GFS_UPLOAD_V2_RECONCILE_ATTEMPTS; attempt += 1) {
    let status: GfsUploadStatus
    try {
      status = (
        await loadUploadStatus(
          session.uploadId,
          {
            expectedBytes: file.size,
            drive: GFS_UPLOAD_DRIVE,
            partBytes: session.partBytes,
            partCount: session.partCount,
          },
          signal,
          GFS_UPLOAD_V2_RECONCILE_TIMEOUT_MS,
          1
        )
      ).status
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      lastError = error
      if (!assertRetryable(error) || attempt + 1 >= GFS_UPLOAD_V2_RECONCILE_ATTEMPTS)
        throw partOutcomeUnknown(part.partNumber, error)
      await delay(250 * 2 ** attempt, signal)
      continue
    }

    const committed = indexCommittedParts(status.session, status.parts).get(part.partNumber)
    if (committed) {
      if (committed.offsetBytes !== part.offsetBytes || committed.lengthBytes !== part.lengthBytes)
        throw new Error(
          `upload_part_mismatch: part ${part.partNumber} does not match the upload geometry`
        )
      if (committed.sha256.toLowerCase() !== checksum.hex)
        throw new Error(
          `source_changed: committed part ${part.partNumber} differs from the selected file`
        )
      return 'committed'
    }

    if (['aborted', 'canceling', 'failed', 'expired'].includes(status.session.state))
      throw new Error(`cannot reconcile upload part in ${status.session.state}`)
    const activePartCount = status.session.activePartCount
    if (!Number.isSafeInteger(activePartCount) || activePartCount < 0)
      throw partOutcomeUnknown(
        part.partNumber,
        new Error('writer returned an invalid activePartCount during reconciliation')
      )
    const activePartNumbers = status.session.activePartNumbers
    if (activePartCount === 0 && activePartNumbers === undefined) return 'missing'
    if (
      !Array.isArray(activePartNumbers) ||
      activePartNumbers.some(partNumber => !Number.isSafeInteger(partNumber) || partNumber < 0) ||
      new Set(activePartNumbers).size !== activePartNumbers.length ||
      activePartNumbers.length !== activePartCount
    ) {
      throw partOutcomeUnknown(
        part.partNumber,
        new Error('writer returned an invalid active part lease set during reconciliation')
      )
    }
    if (!activePartNumbers.includes(part.partNumber)) return 'missing'
    lastError = new Error(`writer still reports part ${part.partNumber} active`)
    if (attempt + 1 < GFS_UPLOAD_V2_RECONCILE_ATTEMPTS) await delay(250 * 2 ** attempt, signal)
  }
  throw partOutcomeUnknown(part.partNumber, lastError)
}

async function putPart(
  uploadId: string,
  file: File,
  part: { partNumber: number; offsetBytes: number; lengthBytes: number },
  partCount: number,
  blob: Blob,
  checksumBase64: string,
  signal: AbortSignal | undefined,
  onByteProgress?: (progress: GfsUploadProgress) => void
): Promise<void> {
  const timed = signalWithTimeout(signal, GFS_UPLOAD_V2_PART_TIMEOUT_MS)
  try {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const abort = () => xhr.abort()
      xhr.open(
        'PUT',
        endpoint(
          `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(uploadId)}/parts/${part.partNumber}`
        )
      )
      xhr.withCredentials = true
      xhr.setRequestHeader('Content-Type', 'application/offset+octet-stream')
      xhr.setRequestHeader('Upload-Part-Number', String(part.partNumber))
      xhr.setRequestHeader('Upload-Offset', String(part.offsetBytes))
      xhr.setRequestHeader('Upload-Chunk-Length', String(part.lengthBytes))
      xhr.setRequestHeader('Upload-Checksum', `sha256 ${checksumBase64}`)
      xhr.upload.onprogress = event => {
        if (!event.lengthComputable) return
        onByteProgress?.({
          uploadedBytes: part.offsetBytes + Math.min(part.lengthBytes, event.loaded),
          totalBytes: file.size,
          partNumber: part.partNumber,
          partCount,
        })
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve()
          return
        }
        const error = new Error(
          `${xhr.status} ${xhr.responseText || 'GFS upload failed'}`
        ) as Error & { status?: number; retryAfterMs?: number }
        error.status = xhr.status
        error.retryAfterMs = parseRetryAfter(xhr.getResponseHeader('retry-after'))
        reject(error)
      }
      xhr.onerror = () => reject(new Error('GFS upload network error'))
      xhr.onabort = () =>
        reject(
          signal?.aborted
            ? abortError('GFS upload request aborted')
            : new Error('GFS upload response timed out')
        )
      timed.signal.addEventListener('abort', abort, { once: true })
      xhr.send(blob)
    })
  } finally {
    timed.cancel()
  }
}

async function uploadPartWithRetries(
  session: UploadReceipt,
  file: File,
  part: { partNumber: number; offsetBytes: number; lengthBytes: number },
  partCount: number,
  signal: AbortSignal | undefined,
  onByteProgress: ((progress: GfsUploadProgress) => void) | undefined,
  onRetryableFailure?: () => void,
  onPartSuccess?: () => void
): Promise<void> {
  const blob = file.slice(part.offsetBytes, part.offsetBytes + part.lengthBytes)
  const checksum = await sha256Part(blob)
  let lastError: unknown
  let maxAttempts = GFS_UPLOAD_RETRY_MAX_ATTEMPTS
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await putPart(
        session.uploadId,
        file,
        part,
        partCount,
        blob,
        checksum.base64,
        signal,
        onByteProgress
      )
      onPartSuccess?.()
      return
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw signal.reason ?? error
      if (!assertRetryable(error)) throw error
      maxAttempts = Math.max(maxAttempts, partRetryAttempts(error))
      onRetryableFailure?.()
      if (ambiguousPartResponse(statusOf(error))) {
        const reconciled = await reconcileAmbiguousPart(file, session, part, checksum, signal)
        if (reconciled === 'committed') {
          onPartSuccess?.()
          return
        }
      }
      if (attempt + 1 >= maxAttempts) throw error
      await delay(
        retryAfterOf(error) ?? Math.min(1_000, GFS_UPLOAD_RETRY_BASE_DELAY_MS * 2 ** attempt),
        signal
      )
    }
  }
  throw lastError
}

async function runParts(
  session: UploadReceipt,
  file: File,
  parts: Array<{ partNumber: number; offsetBytes: number; lengthBytes: number }>,
  concurrency: number,
  signal: AbortSignal | undefined,
  shouldPause: () => boolean,
  onProgress?: (progress: GfsUploadProgress) => void,
  onByteProgress?: (progress: GfsUploadProgress) => void,
  onRetryableFailure?: (partNumber: number) => void,
  onPartFailure?: (partNumber: number) => void,
  fallbackConcurrency = GFS_FILE_UPLOAD_FALLBACK_CONCURRENCY,
  instabilityFailureThreshold = GFS_UPLOAD_DEFAULT_INSTABILITY_FAILURE_THRESHOLD
): Promise<{ failed: typeof parts; retryableFailures: number; paused: boolean }> {
  const initialConcurrency = Math.max(1, Math.min(concurrency, parts.length || 1))
  const effectiveFallback = Math.max(
    1,
    Math.min(
      initialConcurrency,
      Number.isSafeInteger(fallbackConcurrency) && fallbackConcurrency > 0
        ? fallbackConcurrency
        : GFS_FILE_UPLOAD_FALLBACK_CONCURRENCY
    )
  )
  let retryableFailures = 0
  let consecutiveRetryableFailures = 0
  let downgraded = false
  const failed = new Map<number, (typeof parts)[number]>()
  const retryableFailed = new Set<number>()
  const registerRetryableFailure = (): void => {
    retryableFailures += 1
    consecutiveRetryableFailures += 1
    if (
      !downgraded &&
      consecutiveRetryableFailures >= instabilityFailureThreshold &&
      initialConcurrency > effectiveFallback
    )
      downgraded = true
  }
  const registerPartSuccess = (): void => {
    consecutiveRetryableFailures = 0
  }
  const execute = async (work: typeof parts, workers: number): Promise<void> => {
    let next = 0
    const worker = async (workerIndex: number): Promise<void> => {
      for (;;) {
        if (signal?.aborted) throw signal.reason
        if (shouldPause()) {
          return
        }
        if (downgraded && workerIndex >= effectiveFallback) return
        const index = next++
        if (index >= work.length) return
        const part = work[index]!
        try {
          await uploadPartWithRetries(
            session,
            file,
            part,
            parts.length,
            signal,
            onByteProgress,
            () => {
              registerRetryableFailure()
              onRetryableFailure?.(part.partNumber)
            },
            registerPartSuccess
          )
          onProgress?.({
            uploadedBytes: part.offsetBytes + part.lengthBytes,
            totalBytes: file.size,
            partNumber: part.partNumber,
            partCount: parts.length,
          })
          failed.delete(part.partNumber)
          retryableFailed.delete(part.partNumber)
        } catch (error) {
          onPartFailure?.(part.partNumber)
          if (shouldPause()) {
            return
          }
          if (error instanceof DOMException && error.name === 'AbortError') throw error
          failed.set(part.partNumber, part)
          if (assertRetryable(error)) retryableFailed.add(part.partNumber)
        }
      }
    }
    await Promise.all(Array.from({ length: workers }, (_, workerIndex) => worker(workerIndex)))
  }
  await execute(parts, initialConcurrency)
  if (downgraded && retryableFailed.size > 0 && !shouldPause()) {
    await execute(
      parts.filter(part => retryableFailed.has(part.partNumber)),
      effectiveFallback
    )
  }
  return { failed: [...failed.values()], retryableFailures, paused: shouldPause() }
}

type ResponsePayload<T> = T extends { data: infer U } ? U : T

function receiptFromResponse<T>(value: { data: T }): ResponsePayload<T> {
  const data = value.data as unknown as { data?: T }
  return (
    data && typeof data === 'object' && 'data' in data && data.data !== undefined
      ? data.data
      : value.data
  ) as ResponsePayload<T>
}

function abortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function statusOf(error: unknown): number | undefined {
  const value = error as { status?: unknown } | null
  return value && typeof value.status === 'number' ? value.status : undefined
}

function errorCodeOf(error: unknown): string | undefined {
  const value = error as { code?: unknown } | null
  return value && typeof value.code === 'string' ? value.code : undefined
}

export class GfsUploadJob {
  private readonly abortController = new AbortController()
  private readonly idempotencyKey = uuid()
  private readonly inputSignalCleanup: (() => void) | undefined
  private session: UploadReceipt | null = null
  private state: GfsUploadJobState = 'initiated'
  private uploadedBytes = 0
  private pauseRequested = false
  private canceled = false
  private runPromise: Promise<UploadReceipt> | null = null

  constructor(private readonly input: GfsUploadJobInput) {
    if (input.signal) {
      const abort = () => this.abortController.abort(input.signal?.reason)
      input.signal.addEventListener('abort', abort, { once: true })
      this.inputSignalCleanup = () => input.signal?.removeEventListener('abort', abort)
    }
  }

  snapshot(): GfsUploadJobSnapshot {
    return {
      state: this.state,
      session: this.session,
      uploadedBytes: this.uploadedBytes,
      totalBytes: this.input.file.size,
    }
  }

  async start(): Promise<UploadReceipt> {
    if (this.runPromise) return this.runPromise
    this.runPromise = this.run()
    try {
      return await this.runPromise
    } finally {
      this.inputSignalCleanup?.()
      this.runPromise = null
    }
  }

  async pause(): Promise<UploadReceipt> {
    const session = await this.ensureSession()
    if (session.state === 'paused') {
      this.state = 'paused'
      this.emit()
      return session
    }
    if (['completed', 'aborted', 'failed'].includes(session.state)) {
      throw new Error(`cannot pause upload in ${session.state}`)
    }
    this.pauseRequested = true
    const paused = await requestWithLifecycleRetries(
      () =>
        requestJson<{ ok: boolean; data: UploadReceipt }>(
          'POST',
          `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(session.uploadId)}/pause`,
          {},
          this.abortController.signal
        ).then(receiptFromResponse),
      {
        signal: this.abortController.signal,
        reconcile: () => this.reconcileMutation(session, 'pause'),
      }
    )
    this.session = paused
    this.state = 'paused'
    this.emit()
    return paused
  }

  async resume(): Promise<UploadReceipt> {
    const session = await this.ensureSession()
    if (session.state === 'completed') return session
    if (session.state !== 'paused') {
      if (session.state === 'uploading' || session.state === 'initiated') return this.start()
      throw new Error(`cannot resume upload in ${session.state}`)
    }
    this.pauseRequested = false
    const resumed = await requestWithLifecycleRetries(
      () =>
        requestJson<{ ok: boolean; data: UploadReceipt }>(
          'POST',
          `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(session.uploadId)}/resume`,
          {},
          this.abortController.signal
        ).then(receiptFromResponse),
      {
        signal: this.abortController.signal,
        reconcile: () => this.reconcileMutation(session, 'resume'),
      }
    )
    this.session = resumed
    this.state = 'uploading'
    this.emit()
    return this.start()
  }

  async cancel(): Promise<void> {
    const session = this.session
    this.canceled = true
    this.pauseRequested = false
    this.abortController.abort(abortError('GFS upload canceled'))
    this.state = 'canceling'
    this.emit()
    if (session && !['completed', 'aborted'].includes(session.state)) {
      let reconciledCompleted: UploadReceipt | null = null
      try {
        await requestWithLifecycleRetries(
          () =>
            requestJson(
              'DELETE',
              `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(session.uploadId)}`,
              undefined,
              undefined
            ).then(() => undefined),
          {
            reconcileOnError: error =>
              ambiguousLifecycleError(error) ||
              statusOf(error) === 409 ||
              errorCodeOf(error) === 'upload_finalizing',
            reconcile: async error => {
              const observed = await this.observeSession(
                session,
                GFS_UPLOAD_RETRY_MAX_ATTEMPTS,
                undefined
              )
              this.session = observed
              if (observed.state === 'completed') {
                reconciledCompleted = observed
                return { value: undefined }
              }
              if (observed.state === 'aborted') return { value: undefined }
              if (observed.state === 'finalizing') throw error
              if (['initiated', 'uploading', 'paused'].includes(observed.state)) return undefined
              throw new Error(`cannot reconcile cancel upload in ${observed.state}`)
            },
          }
        )
      } catch (error) {
        this.canceled = false
        this.state = 'failed'
        this.emit()
        throw error
      }
      if (reconciledCompleted) {
        this.state = 'completed'
        this.canceled = false
        this.emit()
        await this.input.onClearPersisted?.(session.uploadId)
        return
      }
    }
    await this.runPromise?.catch(() => undefined)
    this.state = 'aborted'
    this.emit()
    if (session) await this.input.onClearPersisted?.(session.uploadId)
  }

  private emit(): void {
    this.input.onState?.(this.snapshot())
  }

  private async ensureSession(): Promise<UploadReceipt> {
    if (this.session) return this.session
    if (!this.runPromise) {
      // Calling pause/resume before start is a programming error in the UI;
      // starting here keeps the job deterministic for IPC callers.
      void this.start()
    }
    for (;;) {
      if (this.session) return this.session
      if (!this.runPromise) throw new Error('GFS upload session was not created')
      await Promise.race([this.runPromise.catch(() => undefined), delay(10)])
    }
  }

  private async observeSession(
    session: UploadReceipt,
    retryAttempts = GFS_UPLOAD_RETRY_MAX_ATTEMPTS,
    signal: AbortSignal | undefined = this.abortController.signal
  ): Promise<UploadReceipt> {
    return (
      await loadUploadStatus(
        session.uploadId,
        {
          expectedBytes: this.input.file.size,
          drive: GFS_UPLOAD_DRIVE,
          partBytes: session.partBytes,
          partCount: session.partCount,
        },
        signal,
        GFS_UPLOAD_V2_RECONCILE_TIMEOUT_MS,
        retryAttempts
      )
    ).status.session
  }

  private async reconcileMutation(
    session: UploadReceipt,
    action: 'pause' | 'resume'
  ): Promise<LifecycleRecovery<UploadReceipt> | undefined> {
    const observed = await this.observeSession(session)
    if (
      (action === 'pause' && observed.state === 'paused') ||
      (action === 'resume' && ['initiated', 'uploading', 'completed'].includes(observed.state))
    ) {
      return { value: observed }
    }
    if (
      (action === 'pause' && ['initiated', 'uploading'].includes(observed.state)) ||
      (action === 'resume' && observed.state === 'paused')
    ) {
      return undefined
    }
    throw new Error(`cannot reconcile ${action} upload in ${observed.state}`)
  }

  private async reconcileCompletion(
    session: UploadReceipt
  ): Promise<LifecycleRecovery<UploadReceipt> | undefined> {
    for (let attempt = 0; attempt < GFS_UPLOAD_V2_RECONCILE_ATTEMPTS; attempt += 1) {
      const observed = await this.observeSession(session, 1)
      if (observed.state === 'completed') return { value: observed }
      if (['initiated', 'uploading', 'paused'].includes(observed.state)) return undefined
      if (observed.state !== 'finalizing')
        throw new Error(`cannot reconcile upload completion in ${observed.state}`)
      if (attempt + 1 < GFS_UPLOAD_V2_RECONCILE_ATTEMPTS)
        await delay(GFS_UPLOAD_RETRY_BASE_DELAY_MS * 2 ** attempt, this.abortController.signal)
    }
    throw new Error(
      'upload_completion_outcome_unknown: finalization is still in progress; resume the persisted session'
    )
  }

  private async loadCapabilities(): Promise<UploadCapabilities['upload']> {
    let capabilityData: unknown
    try {
      const capabilities = await requestWithLifecycleRetries(
        () =>
          requestJson<unknown>(
            'GET',
            '/api/v1/gfs/proxy/v1/capabilities',
            undefined,
            this.abortController.signal
          ),
        { signal: this.abortController.signal }
      )
      capabilityData = capabilities.data
    } catch (error) {
      throw new GfsUploadCapabilityError('Resumable GFS upload capabilities are unavailable.', {
        cause: error,
      })
    }
    const upload = parseUploadCapabilities(capabilityData)
    if (!upload.resumableV2?.enabled)
      throw new GfsUploadCapabilityError('Resumable GFS uploads are not enabled on this writer.')
    return upload
  }

  private async createOrResume(): Promise<{
    session: UploadReceipt
    committed: Set<number>
    resumable: NonNullable<NonNullable<UploadCapabilities['upload']>['resumableV2']>
  }> {
    const upload = await this.loadCapabilities()
    const resumable = upload.resumableV2!
    const productMaxFileBytes = normalizeUploadProductMaxBytes(resumable.maxFileBytes)
    const resumeId = this.session?.uploadId ?? this.input.resumeUploadId
    if (resumeId) {
      const { session, parts } = (
        await loadUploadStatus(
          resumeId,
          { expectedBytes: this.input.file.size, drive: GFS_UPLOAD_DRIVE },
          this.abortController.signal
        )
      ).status
      if (['completed', 'aborted', 'failed'].includes(session.state))
        return { session, committed: new Set(), resumable }
      const committed = await this.validateCommittedParts(session, parts)
      return { session, committed, resumable }
    }
    if (this.input.file.size > productMaxFileBytes) {
      if (resumable.maxFileBytes === undefined) {
        throw new Error(
          'GFS uploads use the 200 MiB compatibility limit because the writer omitted maxFileBytes.'
        )
      }
      throw new Error(`GFS writer limit is ${productMaxFileBytes} bytes for this upload.`)
    }
    const createBody = {
      operation: this.input.target.operation,
      parentRid: this.input.target.parentRid,
      resourceRid: this.input.target.resourceRid,
      ifMatch: this.input.target.ifMatch,
      name: this.input.name,
      sizeBytes: this.input.file.size,
      idempotencyKey: this.idempotencyKey,
    }
    await this.input.onPersistPending?.({
      idempotencyKey: this.idempotencyKey,
      fileName: this.input.file.name,
      fileSize: this.input.file.size,
      lastModified: this.input.file.lastModified,
      target: this.input.target,
      name: this.input.name,
    })
    const create = await requestWithLifecycleRetries(
      () =>
        requestJson<{ ok: boolean; data: UploadReceipt }>(
          'POST',
          '/api/v1/gfs/proxy/v1/uploads',
          createBody,
          this.abortController.signal
        ),
      { signal: this.abortController.signal }
    )
    const session = receiptFromResponse(create)
    if (session.expectedBytes !== this.input.file.size)
      throw new Error('GFS upload session size changed before transfer')
    if (session.drive !== GFS_UPLOAD_DRIVE)
      throw new Error('upload_drive_mismatch: writer changed drive')
    return { session, committed: new Set<number>(), resumable }
  }

  private async validateCommittedParts(
    session: UploadReceipt,
    parts: GfsUploadPartReceipt[]
  ): Promise<Set<number>> {
    const committed = indexCommittedParts(session, parts)
    for (const part of committed.values()) {
      const checksum = await sha256Part(
        this.input.file.slice(part.offsetBytes, part.offsetBytes + part.lengthBytes)
      )
      if (checksum.hex !== part.sha256.toLowerCase())
        throw new Error(`upload part ${part.partNumber} does not match the selected file`)
    }
    return new Set(committed.keys())
  }

  private async run(): Promise<UploadReceipt> {
    assertGfsFileUploadSize(this.input.file.size)
    try {
      const prepared = await this.createOrResume()
      this.session = prepared.session
      if (prepared.session.state === 'completed') {
        this.state = 'completed'
        this.uploadedBytes = this.input.file.size
        this.emit()
        await this.input.onClearPersisted?.(prepared.session.uploadId)
        return prepared.session
      }
      if (prepared.session.state === 'aborted' || prepared.session.state === 'failed')
        throw new Error(`cannot resume upload in ${prepared.session.state}`)
      this.state = prepared.session.state === 'paused' ? 'paused' : 'uploading'
      this.uploadedBytes = prepared.session.committedBytes ?? prepared.session.contiguousBytes ?? 0
      this.emit()
      await this.input.onPersist?.({
        uploadId: prepared.session.uploadId,
        fileName: this.input.file.name,
        fileSize: this.input.file.size,
        lastModified: this.input.file.lastModified,
        target: this.input.target,
        name: this.input.name,
        session: prepared.session,
      })
      if (prepared.session.state === 'paused') return prepared.session
      const partBytes = prepared.session.partBytes
      if (
        !Number.isSafeInteger(partBytes) ||
        partBytes < 1 ||
        partBytes > GFS_FILE_UPLOAD_MAX_PART_BYTES
      )
        throw new Error('GFS server returned an invalid part size')
      const parts = Array.from({ length: prepared.session.partCount }, (_, partNumber) => ({
        partNumber,
        offsetBytes: partNumber * partBytes,
        lengthBytes: Math.min(partBytes, this.input.file.size - partNumber * partBytes),
      }))
      const allParts = parts
      const completedParts = new Set(prepared.committed)
      const inFlightLoaded = new Map<number, number>()
      const calculateUploadedBytes = (): number => {
        const committedBytes = allParts.reduce(
          (total, part) => total + (completedParts.has(part.partNumber) ? part.lengthBytes : 0),
          0
        )
        const inFlightBytes = [...inFlightLoaded.entries()].reduce(
          (total, [partNumber, loaded]) => total + (completedParts.has(partNumber) ? 0 : loaded),
          0
        )
        const observed = Math.min(this.input.file.size, committedBytes + inFlightBytes)
        // Part bytes are committed before the final resource publication. Do
        // not expose a visually complete bar until the complete receipt is
        // durable; the caller sets the exact total only after that response.
        return Math.min(Math.max(0, this.input.file.size - 1), observed)
      }
      const progress = (value: GfsUploadProgress) => {
        completedParts.add(value.partNumber)
        inFlightLoaded.delete(value.partNumber)
        this.uploadedBytes = calculateUploadedBytes()
        this.input.onProgress?.({
          ...value,
          uploadedBytes: this.uploadedBytes,
          partCount: allParts.length,
        })
        this.emit()
      }
      const byteProgress = (value: GfsUploadProgress) => {
        const part = allParts[value.partNumber]
        if (!part) return
        const loaded = Math.min(
          part.lengthBytes,
          Math.max(0, value.uploadedBytes - part.offsetBytes)
        )
        inFlightLoaded.set(
          value.partNumber,
          Math.max(inFlightLoaded.get(value.partNumber) ?? 0, loaded)
        )
        // A progress event is an observation of bytes sent, not a commit
        // receipt. Deduplicate each part's in-flight contribution, and remove
        // it when the worker reports a failed attempt so a retry cannot leave
        // the aggregate permanently overstated.
        this.uploadedBytes = calculateUploadedBytes()
        this.input.onProgress?.({
          ...value,
          uploadedBytes: this.uploadedBytes,
          partCount: allParts.length,
        })
        this.emit()
      }
      let pending = allParts.filter(part => !completedParts.has(part.partNumber))
      const advertisedConcurrency = Number(prepared.resumable.maxConcurrentPartsPerSession)
      const concurrency =
        Number.isSafeInteger(advertisedConcurrency) && advertisedConcurrency > 0
          ? Math.min(GFS_FILE_UPLOAD_DEFAULT_CONCURRENCY, advertisedConcurrency)
          : GFS_FILE_UPLOAD_DEFAULT_CONCURRENCY
      const fallbackConcurrency =
        Number(prepared.resumable.fallbackConcurrency) || GFS_FILE_UPLOAD_FALLBACK_CONCURRENCY
      const instabilityFailureThreshold = normalizeInstabilityFailureThreshold(
        prepared.resumable.instabilityFailureThreshold
      )
      const result = await runParts(
        prepared.session,
        this.input.file,
        pending,
        concurrency,
        this.abortController.signal,
        () => this.pauseRequested || this.canceled,
        progress,
        byteProgress,
        partNumber => {
          inFlightLoaded.delete(partNumber)
          this.uploadedBytes = calculateUploadedBytes()
          this.input.onProgress?.({
            uploadedBytes: this.uploadedBytes,
            totalBytes: this.input.file.size,
            partNumber,
            partCount: allParts.length,
          })
          this.emit()
        },
        partNumber => {
          inFlightLoaded.delete(partNumber)
          this.uploadedBytes = calculateUploadedBytes()
        },
        fallbackConcurrency,
        instabilityFailureThreshold
      )
      if (result.paused || this.pauseRequested) {
        this.state = 'paused'
        const paused = await requestWithLifecycleRetries(
          () =>
            requestJson<{ ok: boolean; data: GfsUploadStatus }>(
              'GET',
              `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(prepared.session.uploadId)}/status`,
              undefined,
              this.abortController.signal
            ).then(receiptFromResponse),
          { signal: this.abortController.signal }
        )
        this.session = paused.session
        this.emit()
        return this.session
      }
      if (result.failed.length > 0)
        throw new Error('One or more upload parts could not be committed.')
      this.state = 'finalizing'
      this.emit()
      const completed = await requestWithLifecycleRetries(
        () =>
          requestJson<{ ok: boolean; data: UploadReceipt }>(
            'POST',
            `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(prepared.session.uploadId)}/complete`,
            {},
            this.abortController.signal
          ).then(receiptFromResponse),
        {
          signal: this.abortController.signal,
          reconcileOnError: error =>
            ambiguousLifecycleError(error) || errorCodeOf(error) === 'upload_finalizing',
          reconcile: () => this.reconcileCompletion(prepared.session),
        }
      )
      if (completed.drive !== GFS_UPLOAD_DRIVE)
        throw new Error('upload_drive_mismatch: writer changed drive')
      this.session = completed
      this.state = 'completed'
      this.uploadedBytes = this.input.file.size
      this.input.onProgress?.({
        uploadedBytes: this.uploadedBytes,
        totalBytes: this.input.file.size,
        partNumber: Math.max(0, prepared.session.partCount - 1),
        partCount: prepared.session.partCount,
      })
      this.emit()
      await this.input.onClearPersisted?.(prepared.session.uploadId)
      return this.session
    } catch (error) {
      if (this.canceled) {
        this.state = 'aborted'
        this.emit()
        throw error
      }
      if (this.pauseRequested && this.session) {
        this.state = 'paused'
        this.emit()
        return this.session
      }
      this.state = 'failed'
      this.emit()
      throw error
    }
  }
}

export function createGfsUploadJob(input: GfsUploadJobInput): GfsUploadJob {
  return new GfsUploadJob(input)
}

export function assertGfsFileUploadSize(byteLength: number): void {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > GFS_FILE_UPLOAD_PROTOCOL_MAX_BYTES
  ) {
    throw new Error('GFS uploads cannot exceed the 1 GiB Upload v2 protocol maximum.')
  }
}

export async function uploadGfsFile(input: {
  file: File
  name: string
  target: GfsUploadTarget
  signal?: AbortSignal
  onProgress?: (progress: GfsUploadProgress) => void
}): Promise<UploadReceipt> {
  const job = createGfsUploadJob(input)
  return job.start()
}

/** Conservative compatibility path for a server that predates upload v2. */
export async function uploadGfsFileLegacy(input: {
  file: File
  name: string
  target: GfsUploadTarget
}): Promise<unknown> {
  if (input.file.size > GFS_LEGACY_UPLOAD_MAX_BYTES) {
    throw new Error(
      `This writer does not advertise resumable uploads; legacy GFS is limited to ${GFS_LEGACY_UPLOAD_MAX_BYTES} bytes.`
    )
  }
  const contentBase64 = digestBase64(await input.file.arrayBuffer())
  if (input.target.operation === 'create') {
    if (!input.target.parentRid) throw new Error('create upload target is required')
    return apiSend(
      'POST',
      `/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(input.target.parentRid)}/children`,
      { name: input.name, kind: 'file', contentBase64 }
    )
  }
  if (!input.target.resourceRid) throw new Error('replace upload target is required')
  return apiSend(
    'PUT',
    `/api/v1/gfs/proxy/v1/resources/${encodeURIComponent(input.target.resourceRid)}/content`,
    { contentBase64, ifMatch: input.target.ifMatch }
  )
}
