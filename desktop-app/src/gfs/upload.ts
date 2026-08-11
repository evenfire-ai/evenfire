import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { Readable } from 'node:stream'

const GFS_UPLOAD_V2_PRODUCT_MAX_BYTES = 200 * 1024 * 1024
const GFS_UPLOAD_V2_PREFERRED_PART_BYTES = 8 * 1024 * 1024
const GFS_UPLOAD_V2_MAX_PART_BYTES = 16 * 1024 * 1024
const GFS_UPLOAD_V2_DEFAULT_CONCURRENCY = 4
const GFS_UPLOAD_V2_FALLBACK_CONCURRENCY = 2

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
  expiresAt: string
  resultResourceId?: string
  resultVersion?: number
  resultSha256?: string
}

export interface DesktopUploadPart {
  partNumber: number
  offsetBytes: number
  lengthBytes: number
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
}

interface UploadCapabilities {
  upload?: {
    resumableV2?: {
      enabled?: boolean
      maxFileBytes?: number
      preferredChunkBytes?: number
      maxChunkBytes?: number
      maxConcurrentPartsPerSession?: number
      fallbackConcurrency?: number
    }
  }
}

export class DesktopUploadCapabilityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DesktopUploadCapabilityError'
  }
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

function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function retryableError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false
  if (error instanceof Error && error.message.startsWith('source_changed:')) return false
  if (error instanceof Error && error.message.startsWith('stale_auth_epoch:')) return false
  const status =
    error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number'
      ? Number((error as { status: number }).status)
      : undefined
  // A transport exception without an HTTP status is a network/timeout
  // failure. The caller still bounds it to the same two retries as a 5xx.
  return status === undefined || retryable(status)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function checksumPart(filePath: string, start: number, end: number): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath, {
    start,
    end,
    highWaterMark: 1024 * 1024,
  })) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('base64')
}

async function validateResumedParts(
  filePath: string,
  session: DesktopUploadSession,
  parts: readonly DesktopUploadPart[]
): Promise<Set<number>> {
  const committed = new Set<number>()
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
    const localChecksum = await checksumPart(
      filePath,
      part.offsetBytes,
      part.offsetBytes + part.lengthBytes - 1
    )
    if (localChecksum !== part.sha256) {
      throw new Error(
        `source_changed: committed part ${part.partNumber} differs from the local file`
      )
    }
    committed.add(part.partNumber)
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

async function putPart(
  input: DesktopUploadInput,
  session: DesktopUploadSession,
  partNumber: number,
  start: number,
  length: number,
  signal?: AbortSignal,
  onRetryableFailure?: () => void,
  onPartSuccess?: () => void
): Promise<void> {
  let attempt = 0
  for (;;) {
    assertAuthEpoch(input)
    await assertSourceIdentity(input)
    const checksum = await checksumPart(input.filePath, start, start + length - 1)
    await assertSourceIdentity(input)
    const body = createReadStream(input.filePath, {
      start,
      end: start + length - 1,
      highWaterMark: 1024 * 1024,
    })
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
          'upload-checksum': `sha256 ${checksum}`,
          'content-length': String(length),
        },
        body,
        UPLOAD_TIMEOUT_MS,
        signal
      )
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      if (!retryableError(error) || attempt >= 2) throw error
      onRetryableFailure?.()
      await sleep(250 * 2 ** attempt)
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
    onRetryableFailure?.()
    if (attempt >= 2) throw uploadPartError(response.status, response.text)
    await sleep(250 * 2 ** attempt)
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
  const advertisedConcurrency = Number(input.advertisedConcurrency)
  const concurrency = Math.min(
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
    if (!downgraded && consecutiveRetryableFailures >= 3 && concurrency > fallbackConcurrency)
      downgraded = true
  }
  const registerPartSuccess = (): void => {
    consecutiveRetryableFailures = 0
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
            registerRetryableFailure,
            registerPartSuccess
          )
          completedParts.add(part.partNumber)
          failed.delete(part.partNumber)
          retryableFailed.delete(part.partNumber)
          const completedBytes = [...completedParts].reduce(
            (sum, number) =>
              sum + Math.min(session.partBytes, session.expectedBytes - number * session.partBytes),
            0
          )
          input.onProgress?.(completedBytes, session.expectedBytes)
        } catch (error) {
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
    const paused = unwrap<DesktopUploadSession>(
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
    const resumed = unwrap<DesktopUploadSession>(
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
      try {
        this.assertAuthEpoch()
        await this.input.transport.requestJson(
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
      } catch (error) {
        const status =
          error &&
          typeof error === 'object' &&
          typeof (error as { status?: unknown }).status === 'number'
            ? Number((error as { status: number }).status)
            : undefined
        if (status === 409) {
          this.assertAuthEpoch()
          const observed = unwrap<DesktopUploadStatus>(
            await this.input.transport.requestJson<Envelope<DesktopUploadStatus>>(
              'GET',
              joinUrl(
                this.input.baseUrl,
                uploadPath(
                  this.input.drive,
                  `/api/v1/me/gfs/uploads/${encodeURIComponent(session.uploadId)}/status`,
                  new URLSearchParams({ limit: '256' })
                )
              ),
              {
                token: this.input.token,
                timeoutMs: UPLOAD_TIMEOUT_MS,
                signal: this.authBoundaryController.signal,
              }
            )
          )
          this.session = observed.session
          if (observed.session.state === 'completed') {
            this.canceled = false
            this.state = 'completed'
            this.uploadedBytes = observed.session.expectedBytes
            this.emit()
            await this.input.onClearPersisted?.(session.uploadId)
            return
          }
        }
        this.canceled = false
        this.state = 'failed'
        this.emit()
        throw error
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
    if (!Number.isSafeInteger(file.size) || file.size > GFS_UPLOAD_V2_PRODUCT_MAX_BYTES)
      throw new Error(`GFS files are limited to ${GFS_UPLOAD_V2_PRODUCT_MAX_BYTES} bytes`)
    this.totalBytes = file.size
    let capabilities: UploadCapabilities
    try {
      this.assertAuthEpoch()
      capabilities = unwrap<UploadCapabilities>(
        await this.input.transport.requestJson<Envelope<UploadCapabilities>>(
          'GET',
          joinUrl(this.input.baseUrl, uploadPath(drive, '/api/v1/me/gfs/capabilities')),
          {
            token: this.input.token,
            timeoutMs: UPLOAD_TIMEOUT_MS,
            signal: this.abortController.signal,
          }
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
    if (typeof resumable.maxFileBytes === 'number' && file.size > resumable.maxFileBytes)
      throw new Error(`GFS files are limited to ${resumable.maxFileBytes} bytes by the writer`)
    this.input.advertisedConcurrency = resumable.maxConcurrentPartsPerSession
    this.input.fallbackConcurrency = resumable.fallbackConcurrency
    const resumeId = this.session?.uploadId ?? this.input.resumeUploadId
    if (resumeId) {
      this.assertAuthEpoch()
      await this.input.transport.requestJson<Envelope<undefined>>(
        'HEAD',
        joinUrl(
          this.input.baseUrl,
          uploadPath(drive, `/api/v1/me/gfs/uploads/${encodeURIComponent(resumeId)}`)
        ),
        {
          token: this.input.token,
          timeoutMs: UPLOAD_TIMEOUT_MS,
          signal: this.abortController.signal,
        }
      )
      let cursor: string | undefined
      let session: DesktopUploadSession | null = null
      const parts: DesktopUploadPart[] = []
      for (let page = 0; page < 8; page += 1) {
        this.assertAuthEpoch()
        const query = new URLSearchParams({ limit: '256' })
        if (cursor) query.set('cursor', cursor)
        const status = unwrap<DesktopUploadStatus>(
          await this.input.transport.requestJson<Envelope<DesktopUploadStatus>>(
            'GET',
            joinUrl(
              this.input.baseUrl,
              uploadPath(
                drive,
                `/api/v1/me/gfs/uploads/${encodeURIComponent(resumeId)}/status`,
                query
              )
            ),
            {
              token: this.input.token,
              timeoutMs: UPLOAD_TIMEOUT_MS,
              signal: this.abortController.signal,
            }
          )
        )
        session ??= status.session
        if (
          session.uploadId !== status.session.uploadId ||
          session.expectedBytes !== status.session.expectedBytes ||
          status.session.drive !== drive
        )
          throw new Error('upload status changed during resume')
        parts.push(...status.parts)
        if (!status.nextCursor) break
        cursor = status.nextCursor
        if (page === 7) throw new Error('upload status pagination exceeded the bounded page limit')
      }
      if (!session || session.expectedBytes !== file.size || session.drive !== drive)
        throw new Error('selected file size differs from the upload session')
      const committed =
        session.state === 'completed'
          ? new Set<number>()
          : await validateResumedParts(this.input.filePath, session, parts)
      return { session, committed, resumable }
    }
    const target = this.input.operation === 'create' ? this.input.parentRid : this.input.resourceRid
    if (!target) throw new Error(`${this.input.operation} upload target is required`)
    this.assertAuthEpoch()
    const created = unwrap<DesktopUploadSession>(
      await this.input.transport.requestJson<Envelope<DesktopUploadSession>>(
        'POST',
        joinUrl(this.input.baseUrl, uploadPath(drive, '/api/v1/me/gfs/uploads')),
        {
          token: this.input.token,
          body: {
            operation: this.input.operation,
            drive,
            sizeBytes: file.size,
            idempotencyKey: randomUUID(),
            ...(this.input.operation === 'create'
              ? { parentRid: target, name: this.input.name }
              : { resourceRid: target, ifMatch: this.input.ifMatch }),
          },
          timeoutMs: UPLOAD_TIMEOUT_MS,
          signal: this.abortController.signal,
        }
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
        this.input,
        prepared.session,
        prepared.committed,
        this.abortController.signal,
        () => this.pauseRequested || this.canceled
      )
      if (result.paused || this.pauseRequested) {
        this.state = 'paused'
        this.assertAuthEpoch()
        const status = unwrap<DesktopUploadStatus>(
          await this.input.transport.requestJson<Envelope<DesktopUploadStatus>>(
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
      const completed = unwrap<DesktopUploadSession>(
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
