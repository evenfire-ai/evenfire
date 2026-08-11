import {
  GFS_FILE_UPLOAD_DEFAULT_CONCURRENCY,
  GFS_FILE_UPLOAD_FALLBACK_CONCURRENCY,
  GFS_FILE_UPLOAD_MAX_BYTES,
  GFS_FILE_UPLOAD_MAX_MEGABYTES,
  GFS_FILE_UPLOAD_MAX_PART_BYTES,
} from '@constants/gfsFileUpload'
import { apiSend } from './api'

const API_BASE = process.env.NEXT_PUBLIC_CONTROL_API_BASE_URL || '/control-api'
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

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
  activePartCount?: number
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
      preferredPartBytes?: number
      maxPartBytes?: number
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
  signal?: AbortSignal
): Promise<{ data: T; response: Response }> {
  const timed = signalWithTimeout(signal, 600_000)
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
): Promise<Error & { status?: number; code?: string }> {
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
  }
  error.status = response.status
  error.code = code
  return error
}

function assertRetryable(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false
  const status =
    typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined
  return typeof status === 'number' ? RETRYABLE_STATUS.has(status) : true
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

function digestBase64(bytes: ArrayBuffer): string {
  let binary = ''
  const view = new Uint8Array(bytes)
  for (let index = 0; index < view.length; index += 0x8000)
    binary += String.fromCharCode(...view.subarray(index, index + 0x8000))
  return btoa(binary)
}

async function putPart(
  uploadId: string,
  file: File,
  part: { partNumber: number; offsetBytes: number; lengthBytes: number },
  partCount: number,
  signal: AbortSignal | undefined,
  onByteProgress?: (progress: GfsUploadProgress) => void
): Promise<void> {
  const blob = file.slice(part.offsetBytes, part.offsetBytes + part.lengthBytes)
  const checksum = digestBase64(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))
  const timed = signalWithTimeout(signal, 600_000)
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
      xhr.setRequestHeader('Upload-Checksum', `sha256 ${checksum}`)
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
        ) as Error & { status?: number }
        error.status = xhr.status
        reject(error)
      }
      xhr.onerror = () => reject(new Error('GFS upload network error'))
      xhr.onabort = () => reject(abortError('GFS upload request aborted'))
      timed.signal.addEventListener('abort', abort, { once: true })
      xhr.send(blob)
    })
  } finally {
    timed.cancel()
  }
}

async function uploadPartWithRetries(
  uploadId: string,
  file: File,
  part: { partNumber: number; offsetBytes: number; lengthBytes: number },
  partCount: number,
  signal: AbortSignal | undefined,
  onByteProgress: ((progress: GfsUploadProgress) => void) | undefined,
  onRetryableFailure?: () => void,
  onPartSuccess?: () => void
): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await putPart(uploadId, file, part, partCount, signal, onByteProgress)
      onPartSuccess?.()
      return
    } catch (error) {
      lastError = error
      if (!assertRetryable(error)) throw error
      onRetryableFailure?.()
      if (attempt === 2) throw error
      await delay(Math.min(1000, 150 * (attempt + 1)), signal)
    }
  }
  throw lastError
}

async function runParts(
  uploadId: string,
  file: File,
  parts: Array<{ partNumber: number; offsetBytes: number; lengthBytes: number }>,
  concurrency: number,
  signal: AbortSignal | undefined,
  shouldPause: () => boolean,
  onProgress?: (progress: GfsUploadProgress) => void,
  onByteProgress?: (progress: GfsUploadProgress) => void,
  fallbackConcurrency = GFS_FILE_UPLOAD_FALLBACK_CONCURRENCY
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
    if (!downgraded && consecutiveRetryableFailures >= 3 && initialConcurrency > effectiveFallback)
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
            uploadId,
            file,
            part,
            parts.length,
            signal,
            onByteProgress,
            registerRetryableFailure,
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
    const response = await requestJson<{ ok: boolean; data: UploadReceipt }>(
      'POST',
      `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(session.uploadId)}/pause`,
      {},
      undefined
    )
    const paused = receiptFromResponse(response)
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
    const response = await requestJson<{ ok: boolean; data: UploadReceipt }>(
      'POST',
      `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(session.uploadId)}/resume`,
      {},
      this.abortController.signal
    )
    this.session = receiptFromResponse(response)
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
      try {
        await requestJson(
          'DELETE',
          `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(session.uploadId)}`,
          undefined,
          undefined
        )
      } catch (error) {
        if (
          statusOf(error) === 409 ||
          (typeof error === 'object' &&
            error !== null &&
            (error as { code?: unknown }).code === 'upload_finalizing')
        ) {
          const reconciled = await requestJson<{ ok: boolean; data: GfsUploadStatus }>(
            'GET',
            `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(session.uploadId)}/status`,
            undefined,
            undefined
          )
          this.session = receiptFromResponse(reconciled).session
          if (this.session.state === 'completed') {
            this.state = 'completed'
            this.canceled = false
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

  private async loadCapabilities(): Promise<UploadCapabilities['upload']> {
    let capabilities: { data: UploadCapabilities }
    try {
      capabilities = await requestJson<UploadCapabilities>(
        'GET',
        '/api/v1/gfs/proxy/v1/capabilities',
        undefined,
        this.abortController.signal
      )
    } catch (error) {
      throw new GfsUploadCapabilityError('Resumable GFS upload capabilities are unavailable.', {
        cause: error,
      })
    }
    const upload = capabilities.data.upload
    if (!upload?.resumableV2?.enabled)
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
    const resumeId = this.session?.uploadId ?? this.input.resumeUploadId
    if (resumeId) {
      const head = await requestJson<undefined>(
        'HEAD',
        `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(resumeId)}`,
        undefined,
        this.abortController.signal
      )
      const length = Number(head.response.headers.get('upload-length'))
      if (Number.isSafeInteger(length) && length !== this.input.file.size)
        throw new Error('selected file size differs from the persisted upload session')
      let cursor: string | undefined
      let session: UploadReceipt | null = null
      const parts: GfsUploadPartReceipt[] = []
      for (let page = 0; page < 8; page += 1) {
        const query = cursor ? `?limit=256&cursor=${encodeURIComponent(cursor)}` : '?limit=256'
        const statusResponse = await requestJson<{ ok: boolean; data: GfsUploadStatus }>(
          'GET',
          `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(resumeId)}/status${query}`,
          undefined,
          this.abortController.signal
        )
        const status = receiptFromResponse(statusResponse)
        session ??= status.session
        if (
          session.uploadId !== status.session.uploadId ||
          session.expectedBytes !== status.session.expectedBytes
        )
          throw new Error('upload status changed during resume')
        parts.push(...status.parts)
        if (!status.nextCursor) break
        cursor = status.nextCursor
        if (page === 7) throw new Error('upload status pagination exceeded the bounded page limit')
      }
      if (!session || session.expectedBytes !== this.input.file.size)
        throw new Error('selected file size differs from the upload session')
      if (['completed', 'aborted', 'failed'].includes(session.state))
        return { session, committed: new Set(), resumable }
      await this.validateCommittedParts(session, parts)
      return { session, committed: new Set(parts.map(part => part.partNumber)), resumable }
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
    let create: { data: { ok: boolean; data: UploadReceipt }; response: Response }
    try {
      create = await requestJson<{ ok: boolean; data: UploadReceipt }>(
        'POST',
        '/api/v1/gfs/proxy/v1/uploads',
        createBody,
        this.abortController.signal
      )
    } catch (error) {
      // A response lost after POST is safe to replay because the key is fixed.
      if (statusOf(error) !== undefined) throw error
      create = await requestJson<{ ok: boolean; data: UploadReceipt }>(
        'POST',
        '/api/v1/gfs/proxy/v1/uploads',
        createBody,
        this.abortController.signal
      )
    }
    const session = receiptFromResponse(create)
    if (session.expectedBytes !== this.input.file.size)
      throw new Error('GFS upload session size changed before transfer')
    return { session, committed: new Set<number>(), resumable }
  }

  private async validateCommittedParts(
    session: UploadReceipt,
    parts: GfsUploadPartReceipt[]
  ): Promise<void> {
    for (const part of parts) {
      const expectedOffset = part.partNumber * session.partBytes
      const expectedLength = Math.min(session.partBytes, this.input.file.size - expectedOffset)
      if (
        part.offsetBytes !== expectedOffset ||
        part.lengthBytes !== expectedLength ||
        part.partNumber < 0 ||
        part.partNumber >= session.partCount
      ) {
        throw new Error('upload status contains invalid part geometry')
      }
      const checksum = digestBase64(
        await crypto.subtle.digest(
          'SHA-256',
          await this.input.file
            .slice(part.offsetBytes, part.offsetBytes + part.lengthBytes)
            .arrayBuffer()
        )
      )
      if (checksum !== part.sha256)
        throw new Error(`upload part ${part.partNumber} does not match the selected file`)
    }
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
      const progress = (value: GfsUploadProgress) => {
        completedParts.add(value.partNumber)
        this.uploadedBytes = allParts.reduce(
          (total, part) => total + (completedParts.has(part.partNumber) ? part.lengthBytes : 0),
          0
        )
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
      const result = await runParts(
        prepared.session.uploadId,
        this.input.file,
        pending,
        concurrency,
        this.abortController.signal,
        () => this.pauseRequested || this.canceled,
        progress,
        value => this.input.onProgress?.(value),
        fallbackConcurrency
      )
      if (result.paused || this.pauseRequested) {
        this.state = 'paused'
        const paused = await requestJson<{ ok: boolean; data: GfsUploadStatus }>(
          'GET',
          `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(prepared.session.uploadId)}/status`,
          undefined,
          undefined
        )
        this.session = receiptFromResponse(paused).session
        this.emit()
        return this.session
      }
      if (result.paused || this.pauseRequested) {
        this.state = 'paused'
        const paused = await requestJson<{ ok: boolean; data: GfsUploadStatus }>(
          'GET',
          `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(prepared.session.uploadId)}/status`,
          undefined,
          undefined
        )
        this.session = receiptFromResponse(paused).session
        this.emit()
        return this.session
      }
      if (result.failed.length > 0)
        throw new Error('One or more upload parts could not be committed.')
      this.state = 'finalizing'
      this.emit()
      const completedResponse = await requestJson<{ ok: boolean; data: UploadReceipt }>(
        'POST',
        `/api/v1/gfs/proxy/v1/uploads/${encodeURIComponent(prepared.session.uploadId)}/complete`,
        {},
        this.abortController.signal
      )
      this.session = receiptFromResponse(completedResponse)
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
  if (byteLength > GFS_FILE_UPLOAD_MAX_BYTES) {
    throw new Error(`GFS uploads are limited to ${GFS_FILE_UPLOAD_MAX_MEGABYTES} MB per file.`)
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
