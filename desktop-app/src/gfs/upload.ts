import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { type Readable, Transform } from 'node:stream'

const GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES = 200 * 1024 * 1024
const GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES = 1024 * 1024 * 1024
const GFS_UPLOAD_V2_PREFERRED_PART_BYTES = 8 * 1024 * 1024
const GFS_UPLOAD_V2_MAX_PART_BYTES = 16 * 1024 * 1024
const GFS_UPLOAD_V2_DEFAULT_CONCURRENCY = 4
const GFS_UPLOAD_V2_FALLBACK_CONCURRENCY = 2
const GFS_UPLOAD_V2_PART_TIMEOUT_MS = 5 * 60 * 1000
const GFS_UPLOAD_V2_RECONCILE_TIMEOUT_MS = 60 * 1000
const GFS_UPLOAD_V2_RECONCILE_ATTEMPTS = 3
// Retry only transient transport/edge failures. 507 (storage exhausted) and
// other permanent 5xx responses are deliberately terminal: retrying them would
// amplify a capacity incident instead of giving the operator a durable error.
export const GFS_UPLOAD_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const GFS_UPLOAD_AMBIGUOUS_STATUS = new Set([408, 500, 502, 503, 504])
export const GFS_UPLOAD_RETRY_MAX_ATTEMPTS = 3
/**
 * A writer restart can keep the service endpoint unavailable for longer than
 * the ordinary application-error retry budget. Keep this separate from the
 * lifecycle budget so 502/503/504 recovery is longer but still bounded.
 */
export const GFS_UPLOAD_SERVICE_RETRY_MAX_ATTEMPTS = 6
export const GFS_UPLOAD_RETRY_AFTER_CAP_MS = 5_000
const GFS_UPLOAD_RETRY_BASE_DELAY_MS = 250

export interface DesktopUploadSession {
  uploadId: string
  drive: string
  operation: 'create' | 'replace'
  expectedBytes: number
  partBytes: number
  partCount: number
  state: string
  contiguousBytes: number
  committedBytes: number
  committedPartCount: number
  activePartCount: number
  activePartNumbers?: number[]
  expiresAt: string
  resultResourceId?: string
  resultVersion?: number
  resultSha256?: string
}

export interface DesktopUploadPart {
  partNumber: number
  offsetBytes: number
  lengthBytes: number
  /** Canonical lowercase/uppercase-insensitive hex digest returned by status. */
  sha256: string
}

export interface DesktopUploadStatus {
  session: DesktopUploadSession
  parts: DesktopUploadPart[]
  nextCursor?: string | null
}

export type DesktopUploadJobState =
  | 'initiated'
  | 'uploading'
  | 'paused'
  | 'suspended_auth'
  | 'finalizing'
  | 'canceling'
  | 'completed'
  | 'aborted'
  | 'failed'

export interface DesktopUploadJobSnapshot {
  state: DesktopUploadJobState
  session: DesktopUploadSession | null
  uploadedBytes: number
  totalBytes: number
}

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: { code?: string; message?: string }
}

interface UploadPartResponse {
  status: number
  text: string
  retryAfter?: string
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

function parseUploadCapabilities(value: unknown): UploadCapabilities {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid GFS upload capabilities response: expected a plain JSON object')
  }
  const upload = (value as { upload?: unknown }).upload
  if (!upload || typeof upload !== 'object' || Array.isArray(upload)) {
    throw new Error('invalid GFS upload capabilities response: missing upload object')
  }
  const resumableV2 = (upload as { resumableV2?: unknown }).resumableV2
  if (!resumableV2 || typeof resumableV2 !== 'object' || Array.isArray(resumableV2)) {
    throw new Error('invalid GFS upload capabilities response: missing resumableV2 object')
  }
  if (typeof (resumableV2 as { enabled?: unknown }).enabled !== 'boolean') {
    throw new Error('invalid GFS upload capabilities response: resumableV2.enabled must be boolean')
  }
  return value as UploadCapabilities
}

export class DesktopUploadCapabilityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DesktopUploadCapabilityError'
  }
}

export function normalizeUploadProductMaxBytes(value: unknown): number {
  if (value === undefined) return GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES
  ) {
    throw new DesktopUploadCapabilityError(
      'GFS resumable capabilities advertised an invalid file ceiling'
    )
  }
  return value as number
}

export const GFS_UPLOAD_DEFAULT_INSTABILITY_FAILURE_THRESHOLD = 3
const GFS_UPLOAD_MAX_INSTABILITY_FAILURE_THRESHOLD = 100

export function normalizeInstabilityFailureThreshold(value: unknown): number {
  if (value === undefined) return GFS_UPLOAD_DEFAULT_INSTABILITY_FAILURE_THRESHOLD
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > GFS_UPLOAD_MAX_INSTABILITY_FAILURE_THRESHOLD
  ) {
    throw new DesktopUploadCapabilityError(
      'Resumable GFS upload capabilities advertised an invalid instability threshold.'
    )
  }
  return value as number
}

export interface DesktopUploadTransport {
  requestJson<T>(
    method: 'GET' | 'POST' | 'HEAD' | 'DELETE',
    url: string,
    options?: { token?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<T>
  requestPart(
    url: string,
    token: string,
    headers: Record<string, string>,
    body: Readable,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<UploadPartResponse>
}

export interface DesktopUploadInput {
  baseUrl: string
  token: string
  filePath: string
  name: string
  drive: string
  operation: 'create' | 'replace'
  parentRid?: string
  resourceRid?: string
  ifMatch?: number
  transport: DesktopUploadTransport
  onProgress?: (uploadedBytes: number, totalBytes: number) => void
  resumeUploadId?: string
  onState?: (snapshot: DesktopUploadJobSnapshot) => void
  onPersist?: (record: {
    uploadId: string
    filePath: string
    fileName: string
    fileSize: number
    target: {
      operation: 'create' | 'replace'
      parentRid?: string
      resourceRid?: string
      ifMatch?: number
    }
    name: string
    session: DesktopUploadSession
  }) => void | Promise<void>
  onClearPersisted?: (uploadId: string) => void | Promise<void>
  /**
   * Main-process authentication fence. It is evaluated immediately before
   * every network operation so a queued part can never reuse a token after
   * logout, team switch, or environment switch advanced the owning epoch.
   */
  assertAuthEpoch?: () => void
  /** Main-process-only source fence; never crosses the renderer boundary. */
  sourceIdentity?: DesktopUploadSourceIdentity
  advertisedConcurrency?: number
  instabilityFailureThreshold?: number
  fallbackConcurrency?: number
}

export interface DesktopUploadSourceIdentity {
  dev?: number
  ino?: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function canonicalDrive(value: string): string {
  const drive = String(value || '').trim()
  if (!drive) throw new Error('drive_required: resumable uploads require a canonical drive')
  return drive
}

function uploadPath(driveValue: string, path: string, query?: URLSearchParams): string {
  const params = query ? new URLSearchParams(query) : new URLSearchParams()
  params.set('drive', canonicalDrive(driveValue))
  return `${path}?${params.toString()}`
}

function assertAuthEpoch(input: DesktopUploadInput): void {
  input.assertAuthEpoch?.()
}

function unwrap<T>(value: unknown): T {
  const envelope = value as Envelope<T> | undefined
  if (!envelope || envelope.ok !== true || envelope.data === undefined) {
    const code = envelope?.error?.code ?? 'upload_failed'
    const message = envelope?.error?.message ?? 'GFS upload request failed'
    throw new Error(`${code}: ${message}`)
  }
  return envelope.data
}

export function isRetryableUploadStatus(status: number): boolean {
  return GFS_UPLOAD_RETRYABLE_STATUS.has(status)
}

export function isAmbiguousUploadStatus(status: number): boolean {
  return GFS_UPLOAD_AMBIGUOUS_STATUS.has(status)
}

function retryable(status: number): boolean {
  return isRetryableUploadStatus(status)
}

function retryableError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false
  if (error instanceof Error && error.message.startsWith('source_changed:')) return false
  if (error instanceof Error && error.message.startsWith('resume_part_mismatch:')) return false
  if (error instanceof Error && error.message.startsWith('stale_auth_epoch:')) return false
  if (error instanceof Error && error.message.startsWith('upload_part_outcome_unknown:'))
    return false
  if (error instanceof Error && error.message.startsWith('upload_completion_outcome_unknown:'))
    return false
  const status =
    error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
      ? Number((error as { status: number }).status)
      : undefined
  // A transport exception without an HTTP status is a network/timeout
  // failure. The caller still bounds it to the same two retries as a 5xx.
  return status === undefined || retryable(status)
}

function partRetryAttempts(error: unknown): number {
  const status =
    error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
      ? Number((error as { status: number }).status)
      : undefined
  return status === undefined || status === 502 || status === 503 || status === 504
    ? GFS_UPLOAD_SERVICE_RETRY_MAX_ATTEMPTS
    : GFS_UPLOAD_RETRY_MAX_ATTEMPTS
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

function retryAfterOf(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as {
    retryAfterMs?: unknown
    retryAfter?: unknown
    headers?: { get?: (name: string) => string | null }
    response?: { headers?: { get?: (name: string) => string | null } }
    bodyText?: unknown
  }
  if (typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs))
    return Math.min(GFS_UPLOAD_RETRY_AFTER_CAP_MS, Math.max(0, value.retryAfterMs))
  const header =
    typeof value.retryAfter === 'string'
      ? value.retryAfter
      : (value.headers?.get?.('retry-after') ?? value.response?.headers?.get?.('retry-after'))
  const parsedHeader = parseRetryAfter(typeof header === 'string' ? header : undefined)
  if (parsedHeader !== undefined) return parsedHeader
  if (typeof value.bodyText === 'string') {
    try {
      const parsed = JSON.parse(value.bodyText) as { retryAfterSeconds?: unknown }
      if (typeof parsed.retryAfterSeconds === 'number' && Number.isFinite(parsed.retryAfterSeconds))
        return Math.min(
          GFS_UPLOAD_RETRY_AFTER_CAP_MS,
          Math.max(0, parsed.retryAfterSeconds * 1_000)
        )
    } catch {
      // Preserve the transport's original error when its body is not JSON.
    }
  }
  return undefined
}

function ambiguousLifecycleError(error: unknown): boolean {
  const status =
    error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
      ? Number((error as { status: number }).status)
      : undefined
  // Transport failures have no HTTP status; keep them ambiguous so completion
  // reconciles durable state instead of assuming that the request was lost.
  if (typeof status !== 'number') return true
  return isAmbiguousUploadStatus(status)
}

function terminalReconciliationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return [
    'upload status changed during reconciliation',
    'resume_part_mismatch:',
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
 * Bounded lifecycle retry primitive. It keeps Retry-After handling, abort
 * propagation, and state-reconciliation hooks identical across Desktop
 * create/pause/resume/complete/cancel/status requests.
 */
async function requestWithLifecycleRetries<T>(
  input: DesktopUploadInput,
  operation: () => Promise<T>,
  options: LifecycleRetryOptions<T> = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? GFS_UPLOAD_RETRY_MAX_ATTEMPTS)
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    assertAuthEpoch(input)
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
      if (!retryableError(error) || attempt + 1 >= attempts) throw error
      await sleep(
        retryAfterOf(error) ??
          Math.min(GFS_UPLOAD_RETRY_AFTER_CAP_MS, GFS_UPLOAD_RETRY_BASE_DELAY_MS * 2 ** attempt),
        options.signal
      )
    }
  }
  throw lastError
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}

interface DesktopUploadPartChecksum {
  base64: string
  hex: string
}

async function checksumPart(
  filePath: string,
  start: number,
  end: number
): Promise<DesktopUploadPartChecksum> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath, {
    start,
    end,
    highWaterMark: 1024 * 1024,
  })) {
    hash.update(chunk as Buffer)
  }
  const digest = hash.digest()
  return { base64: digest.toString('base64'), hex: digest.toString('hex') }
}

async function validateResumedParts(
  filePath: string,
  session: DesktopUploadSession,
  parts: readonly DesktopUploadPart[]
): Promise<Set<number>> {
  const committed = indexCommittedParts(session, parts)
  for (const part of committed.values()) {
    const localChecksum = await checksumPart(
      filePath,
      part.offsetBytes,
      part.offsetBytes + part.lengthBytes - 1
    )
    if (localChecksum.hex !== part.sha256.toLowerCase()) {
      throw new Error(
        `source_changed: committed part ${part.partNumber} differs from the local file`
      )
    }
  }
  return new Set(committed.keys())
}

function indexCommittedParts(
  session: DesktopUploadSession,
  parts: readonly DesktopUploadPart[]
): Map<number, DesktopUploadPart> {
  const committed = new Map<number, DesktopUploadPart>()
  for (const part of parts) {
    if (
      !Number.isSafeInteger(part.partNumber) ||
      part.partNumber < 0 ||
      part.partNumber >= session.partCount
    ) {
      throw new Error(
        `resume_part_mismatch: committed part number ${part.partNumber} is outside the upload geometry`
      )
    }
    const expectedOffset = part.partNumber * session.partBytes
    const expectedLength = Math.min(session.partBytes, session.expectedBytes - expectedOffset)
    if (part.offsetBytes !== expectedOffset || part.lengthBytes !== expectedLength) {
      throw new Error(
        `resume_part_mismatch: committed part ${part.partNumber} does not match the upload geometry`
      )
    }
    if (committed.has(part.partNumber)) {
      throw new Error(
        `resume_part_mismatch: committed part ${part.partNumber} was returned more than once`
      )
    }
    if (!/^[0-9a-f]{64}$/i.test(part.sha256)) {
      throw new Error(
        `resume_part_mismatch: committed part ${part.partNumber} has an invalid SHA-256 digest`
      )
    }
    committed.set(part.partNumber, part)
  }
  return committed
}

async function sourceIdentity(filePath: string): Promise<DesktopUploadSourceIdentity> {
  const info = await stat(filePath)
  if (!info.isFile()) throw new Error('selected upload path is not a regular file')
  return {
    dev: typeof info.dev === 'number' ? info.dev : undefined,
    ino: typeof info.ino === 'number' ? info.ino : undefined,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  }
}

async function assertSourceIdentity(input: DesktopUploadInput): Promise<void> {
  if (!input.sourceIdentity) return
  const current = await sourceIdentity(input.filePath)
  const expected = input.sourceIdentity
  if (
    current.size !== expected.size ||
    current.mtimeMs !== expected.mtimeMs ||
    current.ctimeMs !== expected.ctimeMs ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  ) {
    throw new Error('source_changed: the selected file changed during upload')
  }
}

async function loadUploadStatus(
  input: DesktopUploadInput,
  uploadId: string,
  expected: {
    drive: string
    expectedBytes: number
    partBytes?: number
    partCount?: number
  },
  signal?: AbortSignal,
  timeoutMs = UPLOAD_TIMEOUT_MS,
  retryAttempts = GFS_UPLOAD_RETRY_MAX_ATTEMPTS
): Promise<DesktopUploadStatus> {
  assertAuthEpoch(input)
  await requestWithLifecycleRetries(
    input,
    () =>
      input.transport.requestJson<Envelope<undefined>>(
        'HEAD',
        joinUrl(
          input.baseUrl,
          uploadPath(expected.drive, `/api/v1/me/gfs/uploads/${encodeURIComponent(uploadId)}`)
        ),
        { token: input.token, timeoutMs, signal }
      ),
    { signal, attempts: retryAttempts }
  )

  let cursor: string | undefined
  let session: DesktopUploadSession | null = null
  const parts: DesktopUploadPart[] = []
  for (let page = 0; page < 8; page += 1) {
    assertAuthEpoch(input)
    const query = new URLSearchParams({ limit: '256' })
    if (cursor) query.set('cursor', cursor)
    const status = unwrap<DesktopUploadStatus>(
      await requestWithLifecycleRetries(
        input,
        () =>
          input.transport.requestJson<Envelope<DesktopUploadStatus>>(
            'GET',
            joinUrl(
              input.baseUrl,
              uploadPath(
                expected.drive,
                `/api/v1/me/gfs/uploads/${encodeURIComponent(uploadId)}/status`,
                query
              )
            ),
            { token: input.token, timeoutMs, signal }
          ),
        { signal, attempts: retryAttempts }
      )
    )
    session ??= status.session
    if (
      session.uploadId !== status.session.uploadId ||
      session.uploadId !== uploadId ||
      session.expectedBytes !== status.session.expectedBytes ||
      session.expectedBytes !== expected.expectedBytes ||
      session.drive !== status.session.drive ||
      session.drive !== expected.drive ||
      (expected.partBytes !== undefined && status.session.partBytes !== expected.partBytes) ||
      (expected.partCount !== undefined && status.session.partCount !== expected.partCount)
    ) {
      throw new Error('upload status changed during reconciliation')
    }
    parts.push(...status.parts)
    if (!status.nextCursor) return { session, parts, nextCursor: null }
    cursor = status.nextCursor
    if (page === 7) throw new Error('upload status pagination exceeded the bounded page limit')
  }
  throw new Error('upload status pagination did not terminate')
}

function ambiguousPartResponse(status: number | undefined): boolean {
  // A missing response, edge timeout, or proxy/server 5xx may occur after GFSC
  // committed the part.  425/429 are explicit admission outcomes and can retry
  // without an extra status round-trip.
  return status === undefined || isAmbiguousUploadStatus(status)
}

function partOutcomeUnknown(partNumber: number, cause?: unknown): Error {
  return new Error(
    `upload_part_outcome_unknown: could not prove whether part ${partNumber} committed; resume the persisted session`,
    { cause }
  )
}

async function reconcileAmbiguousPart(
  input: DesktopUploadInput,
  session: DesktopUploadSession,
  partNumber: number,
  start: number,
  length: number,
  checksum: DesktopUploadPartChecksum,
  signal?: AbortSignal
): Promise<'committed' | 'missing'> {
  let lastError: unknown
  for (let attempt = 0; attempt < GFS_UPLOAD_V2_RECONCILE_ATTEMPTS; attempt += 1) {
    let status: DesktopUploadStatus
    try {
      status = await loadUploadStatus(
        input,
        session.uploadId,
        {
          drive: session.drive,
          expectedBytes: session.expectedBytes,
          partBytes: session.partBytes,
          partCount: session.partCount,
        },
        signal,
        GFS_UPLOAD_V2_RECONCILE_TIMEOUT_MS,
        1
      )
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      lastError = error
      if (!retryableError(error) || attempt + 1 >= GFS_UPLOAD_V2_RECONCILE_ATTEMPTS)
        throw partOutcomeUnknown(partNumber, error)
      await sleep(
        retryAfterOf(error) ?? Math.min(1_000, GFS_UPLOAD_RETRY_BASE_DELAY_MS * 2 ** attempt),
        signal
      )
      continue
    }

    const committed = indexCommittedParts(status.session, status.parts).get(partNumber)
    if (committed) {
      if (committed.offsetBytes !== start || committed.lengthBytes !== length) {
        throw new Error(
          `resume_part_mismatch: committed part ${partNumber} does not match the upload geometry`
        )
      }
      if (committed.sha256.toLowerCase() !== checksum.hex) {
        throw new Error(`source_changed: committed part ${partNumber} differs from the local file`)
      }
      return 'committed'
    }

    if (['aborted', 'canceling', 'failed', 'expired'].includes(status.session.state)) {
      throw new Error(`cannot reconcile upload part in ${status.session.state}`)
    }
    const activePartNumbers = status.session.activePartNumbers
    if (status.session.activePartCount === 0 && activePartNumbers === undefined) return 'missing'
    if (
      !Array.isArray(activePartNumbers) ||
      activePartNumbers.some(active => !Number.isSafeInteger(active) || active < 0) ||
      new Set(activePartNumbers).size !== activePartNumbers.length ||
      activePartNumbers.length !== status.session.activePartCount
    ) {
      throw partOutcomeUnknown(
        partNumber,
        new Error('writer returned an invalid active part lease set during reconciliation')
      )
    }
    if (!activePartNumbers.includes(partNumber)) return 'missing'
    lastError = new Error(`writer still reports part ${partNumber} active`)
    if (attempt + 1 < GFS_UPLOAD_V2_RECONCILE_ATTEMPTS) await sleep(250 * 2 ** attempt)
  }
  throw partOutcomeUnknown(partNumber, lastError)
}

async function putPart(
  input: DesktopUploadInput,
  session: DesktopUploadSession,
  partNumber: number,
  start: number,
  length: number,
  signal?: AbortSignal,
  onByteProgress?: (loadedBytes: number) => void,
  onRetryableFailure?: () => void,
  onPartSuccess?: () => void
): Promise<void> {
  let attempt = 0
  let maxAttempts = GFS_UPLOAD_RETRY_MAX_ATTEMPTS
  for (;;) {
    assertAuthEpoch(input)
    await assertSourceIdentity(input)
    const checksum = await checksumPart(input.filePath, start, start + length - 1)
    await assertSourceIdentity(input)
    const source = createReadStream(input.filePath, {
      start,
      end: start + length - 1,
      highWaterMark: 1024 * 1024,
    })
    let loadedBytes = 0
    const body = new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        loadedBytes += buffer.length
        onByteProgress?.(Math.min(length, loadedBytes))
        callback(null, buffer)
      },
    })
    source.pipe(body)
    let response: UploadPartResponse
    try {
      assertAuthEpoch(input)
      response = await input.transport.requestPart(
        joinUrl(
          input.baseUrl,
          uploadPath(
            input.drive,
            `/api/v1/me/gfs/uploads/${encodeURIComponent(session.uploadId)}/parts/${partNumber}`
          )
        ),
        input.token,
        {
          'content-type': 'application/offset+octet-stream',
          'upload-part-number': String(partNumber),
          'upload-offset': String(start),
          'upload-chunk-length': String(length),
          'upload-checksum': `sha256 ${checksum.base64}`,
          'content-length': String(length),
        },
        body,
        GFS_UPLOAD_V2_PART_TIMEOUT_MS,
        signal
      )
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      if (!retryableError(error)) throw error
      maxAttempts = Math.max(maxAttempts, partRetryAttempts(error))
      onRetryableFailure?.()
      const reconciled = await reconcileAmbiguousPart(
        input,
        session,
        partNumber,
        start,
        length,
        checksum,
        signal
      )
      if (reconciled === 'committed') {
        onPartSuccess?.()
        return
      }
      if (attempt + 1 >= maxAttempts) throw error
      await sleep(
        retryAfterOf(error) ?? Math.min(1_000, GFS_UPLOAD_RETRY_BASE_DELAY_MS * 2 ** attempt),
        signal
      )
      attempt += 1
      continue
    }
    if (response.status >= 200 && response.status < 300) {
      onPartSuccess?.()
      return
    }
    if (!retryable(response.status)) {
      throw uploadPartError(response.status, response.text)
    }
    maxAttempts = Math.max(maxAttempts, partRetryAttempts(response))
    onRetryableFailure?.()
    if (ambiguousPartResponse(response.status)) {
      const reconciled = await reconcileAmbiguousPart(
        input,
        session,
        partNumber,
        start,
        length,
        checksum,
        signal
      )
      if (reconciled === 'committed') {
        onPartSuccess?.()
        return
      }
    }
    if (attempt + 1 >= maxAttempts) throw uploadPartError(response.status, response.text)
    await sleep(
      retryAfterOf(response) ?? Math.min(1_000, GFS_UPLOAD_RETRY_BASE_DELAY_MS * 2 ** attempt),
      signal
    )
    attempt += 1
  }
}

async function runParts(
  input: DesktopUploadInput,
  session: DesktopUploadSession,
  committedParts: ReadonlySet<number> = new Set(),
  signal?: AbortSignal,
  shouldPause: () => boolean = () => false
): Promise<{ paused: boolean; failed: number[]; retryableFailures: number }> {
  const parts = Array.from({ length: session.partCount }, (_, partNumber) => ({
    partNumber,
    offsetBytes: partNumber * session.partBytes,
    lengthBytes: Math.min(
      session.partBytes,
      session.expectedBytes - partNumber * session.partBytes
    ),
  }))
  const completedParts = new Set(committedParts)
  const failed = new Map<number, unknown>()
  const retryableFailed = new Set<number>()
  let retryableFailures = 0
  let consecutiveRetryableFailures = 0
  let downgraded = false
  const inFlightLoaded = new Map<number, number>()
  const advertisedConcurrency = Number(input.advertisedConcurrency)
  const concurrency = Math.min(
    GFS_UPLOAD_V2_DEFAULT_CONCURRENCY,
    Number.isSafeInteger(advertisedConcurrency) && advertisedConcurrency > 0
      ? advertisedConcurrency
      : GFS_UPLOAD_V2_DEFAULT_CONCURRENCY,
    session.partCount || 1
  )
  const configuredFallback = Number(input.fallbackConcurrency)
  const fallbackConcurrency = Math.max(
    1,
    Math.min(
      concurrency,
      Number.isSafeInteger(configuredFallback) && configuredFallback > 0
        ? configuredFallback
        : GFS_UPLOAD_V2_FALLBACK_CONCURRENCY
    )
  )
  const registerRetryableFailure = (): void => {
    retryableFailures += 1
    consecutiveRetryableFailures += 1
    if (
      !downgraded &&
      consecutiveRetryableFailures >=
        normalizeInstabilityFailureThreshold(input.instabilityFailureThreshold) &&
      concurrency > fallbackConcurrency
    )
      downgraded = true
  }
  const registerPartSuccess = (): void => {
    consecutiveRetryableFailures = 0
  }
  const calculateUploadedBytes = (): number => {
    const committedBytes = [...completedParts].reduce(
      (sum, number) =>
        sum + Math.min(session.partBytes, session.expectedBytes - number * session.partBytes),
      0
    )
    const inFlightBytes = [...inFlightLoaded.entries()].reduce(
      (sum, [number, loaded]) => (completedParts.has(number) ? sum : sum + loaded),
      0
    )
    const observed = Math.min(session.expectedBytes, committedBytes + inFlightBytes)
    // Part bytes are committed before the final resource publication. Do not
    // expose a visually complete bar until the complete receipt is durable.
    return Math.min(Math.max(0, session.expectedBytes - 1), observed)
  }
  const execute = async (work: typeof parts, workers: number): Promise<void> => {
    let next = 0
    const runWorker = async (workerIndex: number): Promise<void> => {
      for (;;) {
        if (signal?.aborted) throw signal.reason
        if (shouldPause()) return
        if (downgraded && workerIndex >= fallbackConcurrency) return
        const partNumber = next
        next += 1
        if (partNumber >= work.length) return
        const part = work[partNumber]!
        if (completedParts.has(part.partNumber)) continue
        try {
          await putPart(
            input,
            session,
            part.partNumber,
            part.offsetBytes,
            part.lengthBytes,
            signal,
            loaded => {
              inFlightLoaded.set(
                part.partNumber,
                Math.max(inFlightLoaded.get(part.partNumber) ?? 0, loaded)
              )
              input.onProgress?.(calculateUploadedBytes(), session.expectedBytes)
            },
            () => {
              registerRetryableFailure()
              inFlightLoaded.delete(part.partNumber)
              input.onProgress?.(calculateUploadedBytes(), session.expectedBytes)
            },
            registerPartSuccess
          )
          completedParts.add(part.partNumber)
          inFlightLoaded.delete(part.partNumber)
          failed.delete(part.partNumber)
          retryableFailed.delete(part.partNumber)
          input.onProgress?.(calculateUploadedBytes(), session.expectedBytes)
        } catch (error) {
          inFlightLoaded.delete(part.partNumber)
          input.onProgress?.(calculateUploadedBytes(), session.expectedBytes)
          if (shouldPause()) return
          if (
            signal?.aborted ||
            (error instanceof Error &&
              (error.name === 'AbortError' || error.message.startsWith('stale_auth_epoch:')))
          )
            throw error
          failed.set(part.partNumber, error)
          if (retryableError(error)) retryableFailed.add(part.partNumber)
        }
      }
    }
    await Promise.all(Array.from({ length: workers }, (_, workerIndex) => runWorker(workerIndex)))
  }
  await execute(parts, concurrency)
  if (downgraded && retryableFailed.size > 0 && !shouldPause()) {
    const retryParts = parts.filter(part => retryableFailed.has(part.partNumber))
    await execute(retryParts, fallbackConcurrency)
  }
  return { paused: shouldPause(), failed: [...failed.keys()], retryableFailures }
}

function uploadPartError(status: number, text: string): Error & { status: number } {
  const error = new Error(
    `GFS part request failed (${status}): ${text || 'request failed'}`
  ) as Error & { status: number }
  error.status = status
  return error
}

function errorCodeOf(error: unknown): string | undefined {
  const value = error as { code?: unknown } | null
  return value && typeof value.code === 'string' ? value.code : undefined
}

export class DesktopGfsUploadJob {
  private readonly abortController = new AbortController()
  private readonly authBoundaryController = new AbortController()
  private readonly controlOperations = new Set<Promise<unknown>>()
  private session: DesktopUploadSession | null = null
  private state: DesktopUploadJobState = 'initiated'
  private uploadedBytes = 0
  private totalBytes = 0
  private pauseRequested = false
  private canceled = false
  private suspendedForAuth = false
  private runPromise: Promise<DesktopUploadSession> | null = null

  constructor(private readonly input: DesktopUploadInput) {}

  snapshot(): DesktopUploadJobSnapshot {
    return {
      state: this.state,
      session: this.session,
      uploadedBytes: this.uploadedBytes,
      totalBytes: this.totalBytes,
    }
  }

  async start(): Promise<DesktopUploadSession> {
    if (this.runPromise) return this.runPromise
    this.runPromise = this.run()
    try {
      return await this.runPromise
    } finally {
      this.runPromise = null
    }
  }

  /** Resolve once the server has created or resumed the session, before parts finish. */
  async waitForSession(): Promise<DesktopUploadSession> {
    if (this.session) return this.session
    const run = this.runPromise ?? this.start()
    for (;;) {
      if (this.session) return this.session
      const outcome = await Promise.race([
        run.then(
          session => ({ done: true as const, session }),
          error => Promise.reject(error)
        ),
        new Promise<{ done: false }>(resolve => setTimeout(() => resolve({ done: false }), 10)),
      ])
      if (outcome.done) return outcome.session
    }
  }

  pause(): Promise<DesktopUploadSession> {
    return this.trackControlOperation(this.pauseOperation())
  }

  private async pauseOperation(): Promise<DesktopUploadSession> {
    this.assertAuthEpoch()
    const session = await this.ensureSession()
    if (['completed', 'aborted', 'failed'].includes(session.state))
      throw new Error(`cannot pause upload in ${session.state}`)
    this.pauseRequested = true
    this.assertAuthEpoch()
    const paused = await requestWithLifecycleRetries(
      this.input,
      async () =>
        unwrap<DesktopUploadSession>(
          await this.input.transport.requestJson<Envelope<DesktopUploadSession>>(
            'POST',
            joinUrl(
              this.input.baseUrl,
              uploadPath(
                this.input.drive,
                `/api/v1/me/gfs/uploads/${encodeURIComponent(session.uploadId)}/pause`
              )
            ),
            {
              token: this.input.token,
              body: {},
              timeoutMs: UPLOAD_TIMEOUT_MS,
              signal: this.authBoundaryController.signal,
            }
          )
        ),
      {
        signal: this.authBoundaryController.signal,
        reconcile: () => this.reconcileMutation(session, 'pause'),
      }
    )
    this.session = paused
    this.state = 'paused'
    this.emit()
    return paused
  }

  resume(): Promise<DesktopUploadSession> {
    return this.trackControlOperation(this.resumeOperation())
  }

  private async resumeOperation(): Promise<DesktopUploadSession> {
    this.assertAuthEpoch()
    const session = await this.ensureSession()
    if (session.state === 'completed') return session
    if (session.state !== 'paused') return this.start()
    this.pauseRequested = false
    this.assertAuthEpoch()
    const resumed = await requestWithLifecycleRetries(
      this.input,
      async () =>
        unwrap<DesktopUploadSession>(
          await this.input.transport.requestJson<Envelope<DesktopUploadSession>>(
            'POST',
            joinUrl(
              this.input.baseUrl,
              uploadPath(
                this.input.drive,
                `/api/v1/me/gfs/uploads/${encodeURIComponent(session.uploadId)}/resume`
              )
            ),
            {
              token: this.input.token,
              body: {},
              timeoutMs: UPLOAD_TIMEOUT_MS,
              signal: this.authBoundaryController.signal,
            }
          )
        ),
      {
        signal: this.authBoundaryController.signal,
        reconcile: () => this.reconcileMutation(session, 'resume'),
      }
    )
    this.session = resumed
    this.state = 'uploading'
    this.emit()
    return this.start()
  }

  cancel(): Promise<void> {
    return this.trackControlOperation(this.cancelOperation())
  }

  private async cancelOperation(): Promise<void> {
    this.assertAuthEpoch()
    this.canceled = true
    this.pauseRequested = false
    this.state = 'canceling'
    this.emit()
    this.abortController.abort(new Error('GFS upload canceled'))
    const session = this.session
    if (session && !['completed', 'aborted'].includes(session.state)) {
      let reconciledCompleted = false
      try {
        await requestWithLifecycleRetries(
          this.input,
          () =>
            this.input.transport
              .requestJson(
                'DELETE',
                joinUrl(
                  this.input.baseUrl,
                  uploadPath(
                    this.input.drive,
                    `/api/v1/me/gfs/uploads/${encodeURIComponent(session.uploadId)}`
                  )
                ),
                {
                  token: this.input.token,
                  timeoutMs: UPLOAD_TIMEOUT_MS,
                  signal: this.authBoundaryController.signal,
                }
              )
              .then(() => undefined),
          {
            signal: this.authBoundaryController.signal,
            reconcileOnError: error =>
              ambiguousLifecycleError(error) ||
              Boolean(
                error && typeof error === 'object' && (error as { status?: unknown }).status === 409
              ) ||
              errorCodeOf(error) === 'upload_finalizing',
            reconcile: async error => {
              const observed = await this.observeSession(
                session,
                GFS_UPLOAD_RETRY_MAX_ATTEMPTS,
                this.authBoundaryController.signal
              )
              this.session = observed
              if (observed.state === 'completed') {
                reconciledCompleted = true
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
        this.canceled = false
        this.state = 'completed'
        this.uploadedBytes = this.session?.expectedBytes ?? session.expectedBytes
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

  private trackControlOperation<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => {
      this.controlOperations.delete(tracked)
    })
    this.controlOperations.add(tracked)
    return tracked
  }

  /**
   * Authentication teardown is intentionally not a server-side cancel. The
   * local request is aborted, the bounded job settles, and its scoped record
   * remains inert for an explicit same-owner resume with a new token/epoch.
   */
  async suspendForAuth(): Promise<void> {
    if (this.state === 'suspended_auth') return
    if (
      ['completed', 'aborted', 'failed'].includes(this.state) &&
      this.controlOperations.size === 0
    )
      return
    this.suspendedForAuth = true
    this.pauseRequested = false
    this.state = 'suspended_auth'
    this.emit()
    const reason = new Error('GFS upload suspended by authentication fence')
    this.authBoundaryController.abort(reason)
    this.abortController.abort(reason)
    await Promise.all([
      this.runPromise?.catch(() => undefined),
      ...[...this.controlOperations].map(operation => operation.catch(() => undefined)),
    ])
    this.state = 'suspended_auth'
    this.emit()
  }

  private emit(): void {
    this.input.onState?.(this.snapshot())
  }

  private assertAuthEpoch(): void {
    if (this.suspendedForAuth)
      throw new Error('stale_auth_epoch: GFS upload is suspended pending re-authentication')
    assertAuthEpoch(this.input)
  }

  private async ensureSession(): Promise<DesktopUploadSession> {
    if (this.session) return this.session
    if (!this.runPromise) void this.start()
    for (;;) {
      if (this.session) return this.session
      if (!this.runPromise) throw new Error('GFS upload session was not created')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  private async observeSession(
    session: DesktopUploadSession,
    retryAttempts = GFS_UPLOAD_RETRY_MAX_ATTEMPTS,
    signal: AbortSignal | undefined = this.authBoundaryController.signal
  ): Promise<DesktopUploadSession> {
    return (
      await loadUploadStatus(
        this.input,
        session.uploadId,
        {
          drive: session.drive,
          expectedBytes: session.expectedBytes,
          partBytes: session.partBytes,
          partCount: session.partCount,
        },
        signal,
        GFS_UPLOAD_V2_RECONCILE_TIMEOUT_MS,
        retryAttempts
      )
    ).session
  }

  private async reconcileMutation(
    session: DesktopUploadSession,
    action: 'pause' | 'resume'
  ): Promise<LifecycleRecovery<DesktopUploadSession> | undefined> {
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

  private async reconcileCompletion(): Promise<
    LifecycleRecovery<DesktopUploadSession> | undefined
  > {
    const session = this.session
    if (!session) throw new Error('GFS upload session is unavailable during completion')
    for (let attempt = 0; attempt < GFS_UPLOAD_V2_RECONCILE_ATTEMPTS; attempt += 1) {
      const observed = await this.observeSession(session, 1)
      if (observed.state === 'completed') return { value: observed }
      if (['initiated', 'uploading', 'paused'].includes(observed.state)) return undefined
      if (observed.state !== 'finalizing')
        throw new Error(`cannot reconcile upload completion in ${observed.state}`)
      if (attempt + 1 < GFS_UPLOAD_V2_RECONCILE_ATTEMPTS)
        await sleep(
          GFS_UPLOAD_RETRY_BASE_DELAY_MS * 2 ** attempt,
          this.authBoundaryController.signal
        )
    }
    throw new Error(
      'upload_completion_outcome_unknown: finalization is still in progress; resume the persisted session'
    )
  }

  private async prepare(): Promise<{
    session: DesktopUploadSession
    committed: Set<number>
    resumable: NonNullable<NonNullable<UploadCapabilities['upload']>['resumableV2']>
  }> {
    this.assertAuthEpoch()
    const drive = canonicalDrive(this.input.drive)
    const identity = await sourceIdentity(this.input.filePath)
    const file = await stat(this.input.filePath)
    this.input.sourceIdentity = identity
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES
    ) {
      throw new Error('GFS files cannot exceed the 1 GiB Upload v2 protocol maximum')
    }
    this.totalBytes = file.size
    let capabilities: UploadCapabilities
    try {
      this.assertAuthEpoch()
      // GFSC capabilities are a plain JSON document. Only upload lifecycle
      // receipts use the { ok, data, error } envelope; accepting an envelope
      // here would hide drift between Desktop and the writer's public contract.
      capabilities = parseUploadCapabilities(
        await requestWithLifecycleRetries(
          this.input,
          () =>
            this.input.transport.requestJson<UploadCapabilities>(
              'GET',
              joinUrl(this.input.baseUrl, uploadPath(drive, '/api/v1/me/gfs/capabilities')),
              {
                token: this.input.token,
                timeoutMs: UPLOAD_TIMEOUT_MS,
                signal: this.abortController.signal,
              }
            ),
          { signal: this.abortController.signal }
        )
      )
    } catch (error) {
      throw new DesktopUploadCapabilityError('GFS resumable upload capabilities are unavailable', {
        cause: error,
      })
    }
    const resumable = capabilities.upload?.resumableV2
    if (!resumable?.enabled)
      throw new DesktopUploadCapabilityError(
        'Resumable GFS uploads are not enabled on this writer.'
      )
    const productMaxFileBytes = normalizeUploadProductMaxBytes(resumable.maxFileBytes)
    this.input.advertisedConcurrency = resumable.maxConcurrentPartsPerSession
    this.input.instabilityFailureThreshold = normalizeInstabilityFailureThreshold(
      resumable.instabilityFailureThreshold
    )
    this.input.fallbackConcurrency = resumable.fallbackConcurrency
    const resumeId = this.session?.uploadId ?? this.input.resumeUploadId
    if (resumeId) {
      const status = await loadUploadStatus(
        this.input,
        resumeId,
        { drive, expectedBytes: file.size },
        this.abortController.signal
      )
      const { session, parts } = status
      const committed =
        session.state === 'completed'
          ? new Set<number>()
          : await validateResumedParts(this.input.filePath, session, parts)
      return { session, committed, resumable }
    }
    if (file.size > productMaxFileBytes) {
      if (resumable.maxFileBytes === undefined) {
        throw new Error(
          'GFS files are limited to the 200 MiB compatibility limit because the writer omitted maxFileBytes'
        )
      }
      throw new Error(`GFS files are limited to ${productMaxFileBytes} bytes by the writer`)
    }
    const target = this.input.operation === 'create' ? this.input.parentRid : this.input.resourceRid
    if (!target) throw new Error(`${this.input.operation} upload target is required`)
    this.assertAuthEpoch()
    const createBody = {
      operation: this.input.operation,
      drive,
      sizeBytes: file.size,
      idempotencyKey: randomUUID(),
      ...(this.input.operation === 'create'
        ? { parentRid: target, name: this.input.name }
        : { resourceRid: target, ifMatch: this.input.ifMatch }),
    }
    const created = unwrap<DesktopUploadSession>(
      await requestWithLifecycleRetries(
        this.input,
        () =>
          this.input.transport.requestJson<Envelope<DesktopUploadSession>>(
            'POST',
            joinUrl(this.input.baseUrl, uploadPath(drive, '/api/v1/me/gfs/uploads')),
            {
              token: this.input.token,
              body: createBody,
              timeoutMs: UPLOAD_TIMEOUT_MS,
              signal: this.abortController.signal,
            }
          ),
        { signal: this.abortController.signal }
      )
    )
    if (created.drive !== drive) throw new Error('upload_drive_mismatch: writer changed drive')
    if (created.expectedBytes !== file.size)
      throw new Error('GFS upload session size changed before transfer')
    if (created.partBytes < 1 || created.partBytes > GFS_UPLOAD_V2_MAX_PART_BYTES)
      throw new Error('GFS server returned an invalid part size')
    return { session: created, committed: new Set(), resumable }
  }

  private async run(): Promise<DesktopUploadSession> {
    const prepared = await this.prepare()
    this.session = prepared.session
    this.uploadedBytes = prepared.session.committedBytes
    this.state = prepared.session.state === 'paused' ? 'paused' : 'uploading'
    this.emit()
    await this.input.onPersist?.({
      uploadId: prepared.session.uploadId,
      filePath: this.input.filePath,
      fileName: this.input.name,
      fileSize: prepared.session.expectedBytes,
      target: {
        operation: this.input.operation,
        parentRid: this.input.parentRid,
        resourceRid: this.input.resourceRid,
        ifMatch: this.input.ifMatch,
      },
      name: this.input.name,
      session: prepared.session,
    })
    if (prepared.session.state === 'completed') {
      this.state = 'completed'
      this.uploadedBytes = prepared.session.expectedBytes
      this.emit()
      await this.input.onClearPersisted?.(prepared.session.uploadId)
      return prepared.session
    }
    if (['aborted', 'canceling', 'failed', 'finalizing'].includes(prepared.session.state)) {
      throw new Error(`cannot resume upload in ${prepared.session.state}`)
    }
    if (prepared.session.state === 'paused') return prepared.session
    try {
      const result = await runParts(
        {
          ...this.input,
          onProgress: (uploadedBytes, totalBytes) => {
            this.uploadedBytes = uploadedBytes
            this.totalBytes = totalBytes
            this.emit()
            this.input.onProgress?.(uploadedBytes, totalBytes)
          },
        },
        prepared.session,
        prepared.committed,
        this.abortController.signal,
        () => this.pauseRequested || this.canceled
      )
      if (result.paused || this.pauseRequested) {
        this.state = 'paused'
        this.assertAuthEpoch()
        const status = unwrap<DesktopUploadStatus>(
          await requestWithLifecycleRetries(
            this.input,
            () =>
              this.input.transport.requestJson<Envelope<DesktopUploadStatus>>(
                'GET',
                joinUrl(
                  this.input.baseUrl,
                  uploadPath(
                    this.input.drive,
                    `/api/v1/me/gfs/uploads/${encodeURIComponent(prepared.session.uploadId)}/status`,
                    new URLSearchParams({ limit: '256' })
                  )
                ),
                {
                  token: this.input.token,
                  timeoutMs: UPLOAD_TIMEOUT_MS,
                  signal: this.authBoundaryController.signal,
                }
              ),
            { signal: this.authBoundaryController.signal }
          )
        )
        this.session = status.session
        this.uploadedBytes = status.session.committedBytes
        this.emit()
        return status.session
      }
      if (result.failed.length > 0)
        throw new Error('One or more upload parts could not be committed.')
      await assertSourceIdentity(this.input)
      this.assertAuthEpoch()
      this.state = 'finalizing'
      this.emit()
      const completed = await requestWithLifecycleRetries<DesktopUploadSession>(
        this.input,
        async () =>
          unwrap<DesktopUploadSession>(
            await this.input.transport.requestJson<Envelope<DesktopUploadSession>>(
              'POST',
              joinUrl(
                this.input.baseUrl,
                uploadPath(
                  this.input.drive,
                  `/api/v1/me/gfs/uploads/${encodeURIComponent(prepared.session.uploadId)}/complete`
                )
              ),
              {
                token: this.input.token,
                body: {},
                timeoutMs: UPLOAD_TIMEOUT_MS,
                signal: this.abortController.signal,
              }
            )
          ),
        {
          signal: this.abortController.signal,
          reconcileOnError: error =>
            ambiguousLifecycleError(error) || errorCodeOf(error) === 'upload_finalizing',
          reconcile: () => this.reconcileCompletion(),
        }
      )
      if (completed.drive !== canonicalDrive(this.input.drive))
        throw new Error('upload_drive_mismatch: completion changed drive')
      this.session = completed
      this.state = 'completed'
      this.uploadedBytes = completed.expectedBytes
      this.emit()
      await this.input.onClearPersisted?.(completed.uploadId)
      return completed
    } catch (error) {
      if (this.suspendedForAuth) {
        this.state = 'suspended_auth'
        this.emit()
        throw error
      }
      if (this.canceled) {
        this.state = 'aborted'
        this.emit()
        throw error
      }
      if (this.pauseRequested) {
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

export async function uploadLocalFile(input: DesktopUploadInput): Promise<DesktopUploadSession> {
  const job = new DesktopGfsUploadJob(input)
  return job.start()
}

export const desktopUploadDefaults = {
  preferredPartBytes: GFS_UPLOAD_V2_PREFERRED_PART_BYTES,
  maxPartBytes: GFS_UPLOAD_V2_MAX_PART_BYTES,
  concurrency: GFS_UPLOAD_V2_DEFAULT_CONCURRENCY,
  fallbackConcurrency: GFS_UPLOAD_V2_FALLBACK_CONCURRENCY,
}
