import {
  type GfsImageSource,
  type MemoryReservation,
  VISUAL_INPUT_LIMITS,
  VisualInputBudget,
  VisualInputError,
} from '../visualInput/policy'
import type { GfsFileContent, GfsReadOptions } from './gfsReadTypes'

export type GfsContentRequest = (
  path: string,
  init: RequestInit,
  deadlineMs: number
) => Promise<Response>

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body) void body.cancel().catch(() => undefined)
}

/** Bounded consumption also observes cancellation for injected/local streams. */
async function collect(
  response: Response,
  maximum: number,
  signal: AbortSignal,
  onChunk?: (size: number) => void
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) throw new VisualInputError('cancelled')
    for (;;) {
      const next = await reader.read()
      if (signal.aborted) throw new VisualInputError('cancelled')
      if (next.done) break
      // Transport work counts even when this chunk exceeds the file snapshot.
      onChunk?.(next.value.byteLength)
      if (next.value.byteLength > maximum - size) throw new VisualInputError('limit_exceeded')
      size += next.value.byteLength
      chunks.push(next.value)
    }
    return Buffer.concat(chunks, size)
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    if (error instanceof VisualInputError) throw error
    throw new VisualInputError('incomplete_response')
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

export async function boundedGfsErrorDetail(
  response: Response,
  signal: AbortSignal
): Promise<string> {
  try {
    return (await collect(response, VISUAL_INPUT_LIMITS.errorBytes, signal)).toString('utf8')
  } catch {
    if (signal.aborted) throw new VisualInputError('cancelled')
    // An oversized error must not obscure the authoritative HTTP denial.
    return ''
  }
}

async function requireOk(response: Response, signal: AbortSignal): Promise<void> {
  if (response.redirected) {
    cancelBody(response.body)
    throw new VisualInputError('invalid_response')
  }
  if (response.status === 200) return
  if (response.ok) {
    cancelBody(response.body)
    throw new VisualInputError('invalid_response')
  }
  const detail = await boundedGfsErrorDetail(response, signal)
  throw new Error(`gfsc ${response.status}: ${detail || response.statusText}`)
}

/** A resource id as gfsc names it: 32 lowercase hex digits, without dashes. */
export function normalizeRid(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/-/g, '').toLowerCase()
  return /^[a-f0-9]{32}$/.test(normalized) ? normalized : null
}

function metadataSnapshot(
  bytes: Buffer,
  args: { drive: string; resourceId: string }
): { source: GfsImageSource; size: number } {
  let envelope: { ok?: unknown; data?: unknown }
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new VisualInputError('invalid_response')
  }
  if (!envelope || envelope.ok !== true || !envelope.data || typeof envelope.data !== 'object')
    throw new VisualInputError('invalid_response')
  const data = envelope.data as Record<string, unknown>
  const rid = normalizeRid(args.resourceId)
  if (
    !rid ||
    normalizeRid(data.resourceId) !== rid ||
    data.rid !== rid ||
    data.drive !== args.drive ||
    data.gfsUri !== `gfs://${args.drive}/${rid}` ||
    typeof data.name !== 'string' ||
    data.name.length === 0 ||
    data.name.length > 1024 ||
    !Number.isSafeInteger(data.version) ||
    (data.version as number) < 0 ||
    !Number.isSafeInteger(data.bytes) ||
    (data.bytes as number) < 0
  )
    throw new VisualInputError('invalid_response')
  if (data.kind !== 'file') throw new VisualInputError('unsupported_format')
  if ((data.bytes as number) > VISUAL_INPUT_LIMITS.fileBytes)
    throw new VisualInputError('limit_exceeded')
  return {
    source: {
      kind: 'gfs',
      drive: args.drive,
      resourceId: rid,
      gfsUri: data.gfsUri as string,
      name: data.name,
      version: data.version as number,
    },
    size: data.bytes as number,
  }
}

function assertContentHeaders(response: Response, source: GfsImageSource, size: number): void {
  // Content for another resource is not a newer version of this one.
  if (response.headers.get('x-gfs-uri') !== source.gfsUri)
    throw new VisualInputError('identity_mismatch')
  if (response.headers.get('x-gfs-version') !== String(source.version))
    throw new VisualInputError('version_conflict')
  const encoding = response.headers.get('content-encoding')
  if (encoding && encoding.toLowerCase() !== 'identity')
    throw new VisualInputError('invalid_response')
  const length = response.headers.get('content-length')
  if (
    length !== null &&
    (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) !== size)
  )
    throw new VisualInputError('incomplete_response')
}

/** One identity/version-bound read with an absolute deadline spanning both requests. */
export async function readGfsContent(
  request: GfsContentRequest,
  args: { drive: string; resourceId: string },
  options: GfsReadOptions
): Promise<GfsFileContent> {
  // Standalone reads own one operation. Chat and workflow callers supply their
  // turn/step budget explicitly; a shared HTTP client must not own that lifetime.
  const budget = options.budget ?? new VisualInputBudget()
  if (options.signal?.aborted) throw new VisualInputError('cancelled')
  if (budget.isClosed || budget.remainingReadBytes === 0)
    throw new VisualInputError('limit_exceeded')
  const startedAt = Date.now()
  const timeoutMs = Math.min(
    options.timeoutMs ?? VISUAL_INPUT_LIMITS.readTimeoutMs,
    VISUAL_INPUT_LIMITS.readTimeoutMs,
    options.deadlineMs === undefined ? Number.POSITIVE_INFINITY : options.deadlineMs - startedAt
  )
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new VisualInputError('timeout')
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
  let reservation: MemoryReservation | undefined
  let handedOff = false
  const path = `/v1/resources/${encodeURIComponent(args.resourceId)}`
  const query = `?drive=${encodeURIComponent(args.drive)}`
  const init: RequestInit = {
    signal,
    redirect: 'error',
    headers: { 'accept-encoding': 'identity' },
  }
  try {
    const metadataReservation = budget.reserve(2 * VISUAL_INPUT_LIMITS.metadataBytes)
    let snapshot: ReturnType<typeof metadataSnapshot>
    try {
      const metadata = await request(`${path}${query}`, init, deadlineMs)
      await requireOk(metadata, signal)
      snapshot = metadataSnapshot(
        await collect(metadata, VISUAL_INPUT_LIMITS.metadataBytes, signal),
        args
      )
    } finally {
      metadataReservation.release()
    }
    if (signal.aborted) throw new VisualInputError('cancelled')
    if (
      options.expectedVersion !== undefined &&
      snapshot.source.version !== options.expectedVersion
    )
      throw new VisualInputError('version_conflict')
    if (snapshot.size > budget.remainingReadBytes) throw new VisualInputError('limit_exceeded')
    // The source snapshot provides an exact bound: chunks and concatenation can
    // coexist, so reserve twice that size before beginning the content request.
    reservation = budget.reserve(2 * snapshot.size + 2 * VISUAL_INPUT_LIMITS.errorBytes)
    const response = await request(`${path}/content${query}`, init, deadlineMs)
    await requireOk(response, signal)
    try {
      assertContentHeaders(response, snapshot.source, snapshot.size)
    } catch (error) {
      cancelBody(response.body)
      throw error
    }
    const bytes = await collect(response, snapshot.size, signal, size => budget.consumeRead(size))
    if (signal.aborted) throw new VisualInputError('cancelled')
    if (bytes.byteLength !== snapshot.size) throw new VisualInputError('incomplete_response')
    handedOff = true
    return { source: snapshot.source, bytes, reservation }
  } catch (error) {
    if (signal.aborted) throw new VisualInputError(expired ? 'timeout' : 'cancelled')
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    if (!handedOff) reservation?.release()
  }
}
