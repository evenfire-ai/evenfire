import { type ImageInputCapability, VISUAL_INPUT_LIMITS, VisualInputError } from './policy'

/** The only provider whose model metadata this module interrogates. */
export const OPENROUTER_PROVIDER = 'openrouter'
/** Fixed, bounded provenance string; upstream text never reaches this field. */
export const OPENROUTER_METADATA_EVIDENCE = 'openrouter-model-metadata'
/** The catalog changes slowly, so a resolved answer stays reusable for one minute. */
export const OPENROUTER_CAPABILITY_CACHE_MS = 60_000

/**
 * Fetches `GET /model/{author}/{slug}` relative to the provider's `/api/v1`
 * base. The caller supplies the authenticated transport, so this module reads
 * no key, no environment variable, and no socket of its own.
 */
export type OpenRouterMetadataReader = (path: string, signal: AbortSignal) => Promise<Response>

const UNKNOWN = Object.freeze({ status: 'unknown' as const })
const UNSUPPORTED = Object.freeze({ status: 'unsupported' as const })
const ABORTED = Symbol('openrouter-capability-aborted')

/**
 * Resolves whether one `author/slug` model accepts image input, using only the
 * injected authenticated reader. Every failure mode other than an explicit
 * modality list resolves to `unknown`, so a caller that cannot prove support
 * never treats the model as image-capable.
 */
export function createOpenRouterImageCapabilityResolver(
  model: string,
  readMetadata: OpenRouterMetadataReader
): (signal?: AbortSignal) => Promise<ImageInputCapability> {
  const path = buildModelPath(model)
  let cached: { value: ImageInputCapability; expiresAt: number } | undefined

  return async function resolveCapability(callerSignal) {
    if (callerSignal?.aborted) throw new VisualInputError('cancelled')
    if (path === undefined) return UNKNOWN

    const now = Date.now()
    if (cached !== undefined && cached.expiresAt > now) return cached.value

    const outcome = await resolveWithDeadline(model, path, readMetadata, callerSignal)
    if (outcome !== ABORTED && outcome.status !== 'unknown') {
      cached = { value: outcome, expiresAt: Date.now() + OPENROUTER_CAPABILITY_CACHE_MS }
    }
    // A caller that aborted never receives a value, even when one arrived first.
    if (callerSignal?.aborted) throw new VisualInputError('cancelled')
    return outcome === ABORTED ? UNKNOWN : outcome
  }
}

/**
 * OpenRouter model ids are exactly `author/slug`; anything else cannot be
 * requested at all. Each segment must stay a single printable-ASCII token, and
 * `encodeURIComponent` escapes the reserved characters that remain, such as the
 * `:` in `author/model:free`.
 */
function buildModelPath(model: string): string | undefined {
  const segments = model.split('/')
  if (segments.length !== 2) return undefined
  const [author, slug] = segments
  if (!isSafePathSegment(author) || !isSafePathSegment(slug)) return undefined
  return `/model/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`
}

function isSafePathSegment(segment: string): boolean {
  if (segment.length === 0 || segment === '.' || segment === '..') return false
  for (const character of segment) {
    const code = character.codePointAt(0)
    if (code === undefined || code < 0x21 || code > 0x7e) return false
  }
  return true
}

/**
 * Composes the caller's abort with one absolute per-call deadline. The transport
 * receives a signal this module owns, never the caller's, so concurrent readers
 * cannot abort each other.
 */
async function resolveWithDeadline(
  model: string,
  path: string,
  readMetadata: OpenRouterMetadataReader,
  callerSignal: AbortSignal | undefined
): Promise<ImageInputCapability | typeof ABORTED> {
  const controller = new AbortController()
  const onCallerAbort = () => controller.abort()
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  const deadline = setTimeout(() => controller.abort(), VISUAL_INPUT_LIMITS.validationTimeoutMs)

  try {
    return await Promise.race([
      requestCapability(model, path, readMetadata, controller.signal),
      aborted(controller.signal),
    ])
  } finally {
    clearTimeout(deadline)
    callerSignal?.removeEventListener('abort', onCallerAbort)
    // Retire the local signal, including its race listener. A transport that
    // returns late must observe a closed request and discard its body.
    controller.abort()
  }
}

/** Settles once the per-call controller aborts, so a stalled read cannot hang a turn. */
function aborted(signal: AbortSignal): Promise<typeof ABORTED> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve(ABORTED)
      return
    }
    signal.addEventListener('abort', () => resolve(ABORTED), { once: true })
  })
}

async function requestCapability(
  model: string,
  path: string,
  readMetadata: OpenRouterMetadataReader,
  signal: AbortSignal
): Promise<ImageInputCapability> {
  try {
    const response = await readMetadata(path, signal)
    if (signal.aborted) {
      cancelQuietly(response.body)
      return UNKNOWN
    }

    // A redirect leaves the requested model, and a non-200 carries no catalog entry.
    if (response.status !== 200 || response.redirected) {
      cancelQuietly(response.body)
      return UNKNOWN
    }

    const metadata = await readBoundedMetadata(response, signal)
    return metadata === undefined ? UNKNOWN : capabilityFromMetadata(metadata, model)
  } catch {
    // An unreadable transport, status, or body cannot prove support: fail closed.
    return UNKNOWN
  }
}

/**
 * Reads at most `VISUAL_INPUT_LIMITS.metadataBytes` of JSON text before parsing.
 * An oversized, unreadable, or non-UTF-8 body is `undefined` so the caller
 * reports `unknown` instead of parsing a truncated or replaced catalog entry.
 */
async function readBoundedMetadata(
  response: Response,
  signal: AbortSignal
): Promise<string | undefined> {
  const body = response.body
  if (!body) return undefined

  const reader = body.getReader()
  const onAbort = () => cancelQuietly(reader)
  signal.addEventListener('abort', onAbort, { once: true })

  const chunks: Uint8Array[] = []
  let received = 0
  try {
    if (signal.aborted) return undefined
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      received += value.byteLength
      if (received > VISUAL_INPUT_LIMITS.metadataBytes) {
        cancelQuietly(reader)
        return undefined
      }
      chunks.push(value)
    }
  } catch {
    cancelQuietly(reader)
    return undefined
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }

  if (signal.aborted) return undefined
  return decodeUtf8(chunks, received)
}

function decodeUtf8(chunks: readonly Uint8Array[], received: number): string | undefined {
  const joined = Buffer.concat(chunks, received)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(joined)
  } catch {
    return undefined
  }
}

/**
 * Reads only the documented catalog shape. Anything absent, mistyped, or
 * describing a different model leaves the answer `unknown`; an explicit
 * modality list without `image` is the single reachable `unsupported`.
 */
function capabilityFromMetadata(metadata: string, model: string): ImageInputCapability {
  let payload: unknown
  try {
    payload = JSON.parse(metadata)
  } catch {
    return UNKNOWN
  }
  if (typeof payload !== 'object' || payload === null) return UNKNOWN

  const data = (payload as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return UNKNOWN

  // An alias or a neighbouring id is not the requested model; never infer identity.
  const entry = data as { id?: unknown; architecture?: unknown }
  if (entry.id !== model) return UNKNOWN

  const architecture = entry.architecture
  if (typeof architecture !== 'object' || architecture === null) return UNKNOWN

  const modalities = (architecture as { input_modalities?: unknown }).input_modalities
  if (!Array.isArray(modalities) || !modalities.every(value => typeof value === 'string')) {
    return UNKNOWN
  }
  if (!modalities.includes('image')) return UNSUPPORTED

  // Frozen because the resolver hands this same instance back from its cache.
  return Object.freeze({
    status: 'supported' as const,
    provider: OPENROUTER_PROVIDER,
    model,
    evidence: OPENROUTER_METADATA_EVIDENCE,
  })
}

/** Releases a body this module refuses to read; an already-consumed body needs nothing. */
function cancelQuietly(stream: { cancel(): Promise<void> } | null): void {
  if (stream === null) return
  try {
    void stream.cancel().catch(() => undefined)
  } catch {
    // A locked or already-errored stream cannot be cancelled.
  }
}
