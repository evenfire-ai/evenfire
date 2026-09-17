import { type ImageInputCapability, VISUAL_INPUT_LIMITS, VisualInputError } from './policy'

/** The provider name the OpenRouter catalog resolver reports. */
export const OPENROUTER_PROVIDER = 'openrouter'
/** Fixed, bounded provenance string; upstream text never reaches this field. */
export const OPENROUTER_METADATA_EVIDENCE = 'openrouter-model-metadata'

/**
 * The provider name the Anthropic Models API resolver reports. It matches
 * `getProviderType()` on the Claude provider, so an answer carries the same
 * identity the rest of the LLM layer uses.
 */
export const ANTHROPIC_PROVIDER = 'claude'
/** Fixed, bounded provenance string; upstream text never reaches this field. */
export const ANTHROPIC_METADATA_EVIDENCE = 'anthropic-model-metadata'

/** Both catalogs change slowly, so a resolved answer stays reusable for one minute. */
const CAPABILITY_CACHE_MS = 60_000

export const OPENROUTER_CAPABILITY_CACHE_MS = CAPABILITY_CACHE_MS
export const ANTHROPIC_CAPABILITY_CACHE_MS = CAPABILITY_CACHE_MS

/**
 * The only parts of one HTTP response this module reads. Native `Response`
 * satisfies it directly, and so does the `{status, redirected, body}` shape a
 * caller builds after bridging a Node stream into a Web stream.
 */
export interface ModelMetadataResponse {
  readonly status: number
  readonly redirected: boolean
  readonly body: ModelMetadataBody | null
}

/**
 * The subset of a Web `ReadableStream` this module consumes, declared
 * structurally because the fetch layer's `Response` typings and Node's
 * `Readable.toWeb` bridge do not always resolve to the same `ReadableStream`
 * declaration. A bounded read only needs `getReader()`, `read()`, `cancel()`,
 * and `releaseLock()`.
 */
export interface ModelMetadataBody {
  getReader(): ModelMetadataBodyReader
  cancel(): Promise<void>
}

export interface ModelMetadataBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel(): Promise<void>
  releaseLock(): void
}

/**
 * Fetches one provider-relative metadata path through the caller's authenticated
 * transport, so this module reads no key, no environment variable, and no socket
 * of its own. The caller resolves the provider base; the path is always relative.
 */
export type MetadataReader = (path: string, signal: AbortSignal) => Promise<ModelMetadataResponse>

/** OpenRouter's `GET /model/{author}/{slug}` reader. */
export type OpenRouterMetadataReader = MetadataReader

/** Anthropic's `GET /v1/models/{model_id}` reader. */
export type AnthropicMetadataReader = MetadataReader

const UNKNOWN = Object.freeze({ status: 'unknown' as const })
const UNSUPPORTED = Object.freeze({ status: 'unsupported' as const })
const ABORTED = Symbol('image-capability-aborted')

/** The provider-specific half of one resolver: path shape plus documented metadata shape. */
interface ImageCapabilitySource {
  /** Provider-relative request path for one model id, or undefined when it is not addressable. */
  buildPath(model: string): string | undefined
  /** Reads only the documented model shape; an explicit negative is the sole `unsupported`. */
  parse(metadata: string, model: string): ImageInputCapability
}

/**
 * Resolves whether one model accepts image input, using only the injected
 * authenticated reader. Every failure mode other than an explicit negative
 * resolves to `unknown`, so a caller that cannot prove support never treats the
 * model as image-capable. Both providers share this engine: one bounded read per
 * uncached call, one absolute per-call deadline, and one private per-resolver cache.
 */
function createImageCapabilityResolver(
  model: string,
  readMetadata: MetadataReader,
  source: ImageCapabilitySource
): (signal?: AbortSignal) => Promise<ImageInputCapability> {
  const path = source.buildPath(model)
  let cached: { value: ImageInputCapability; expiresAt: number } | undefined

  return async function resolveCapability(callerSignal) {
    if (callerSignal?.aborted) throw new VisualInputError('cancelled')
    if (path === undefined) return UNKNOWN

    const now = Date.now()
    if (cached !== undefined && cached.expiresAt > now) return cached.value

    const outcome = await resolveWithDeadline(callerSignal, signal =>
      requestCapability(path, readMetadata, signal, metadata => source.parse(metadata, model))
    )
    if (outcome !== ABORTED && outcome.status !== 'unknown') {
      cached = { value: outcome, expiresAt: Date.now() + CAPABILITY_CACHE_MS }
    }
    // A caller that aborted never receives a value, even when one arrived first.
    if (callerSignal?.aborted) throw new VisualInputError('cancelled')
    return outcome === ABORTED ? UNKNOWN : outcome
  }
}

/**
 * Resolves whether one `author/slug` OpenRouter model accepts image input, using
 * only the injected authenticated reader.
 */
export function createOpenRouterImageCapabilityResolver(
  model: string,
  readMetadata: OpenRouterMetadataReader
): (signal?: AbortSignal) => Promise<ImageInputCapability> {
  return createImageCapabilityResolver(model, readMetadata, OPENROUTER_SOURCE)
}

/**
 * Resolves whether one Anthropic model accepts image input, reading the
 * documented `capabilities.image_input.supported` flag. Vision is never inferred
 * from the model name: an absent, mismatched, or malformed flag is `unknown`, and
 * only an explicit `false` is `unsupported`.
 */
export function createAnthropicImageCapabilityResolver(
  model: string,
  readMetadata: AnthropicMetadataReader
): (signal?: AbortSignal) => Promise<ImageInputCapability> {
  return createImageCapabilityResolver(model, readMetadata, ANTHROPIC_SOURCE)
}

const OPENROUTER_SOURCE: ImageCapabilitySource = {
  buildPath: buildOpenRouterModelPath,
  parse: openRouterCapabilityFromMetadata,
}

const ANTHROPIC_SOURCE: ImageCapabilitySource = {
  buildPath: buildAnthropicModelPath,
  parse: anthropicCapabilityFromMetadata,
}

/**
 * OpenRouter model ids are exactly `author/slug`; anything else cannot be
 * requested at all. Each segment must stay a single printable-ASCII token, and
 * `encodeURIComponent` escapes the reserved characters that remain, such as the
 * `:` in `author/model:free`.
 */
function buildOpenRouterModelPath(model: string): string | undefined {
  const segments = model.split('/')
  if (segments.length !== 2) return undefined
  const [author, slug] = segments
  if (!isSafePathSegment(author) || !isSafePathSegment(slug)) return undefined
  return `/model/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`
}

/**
 * Anthropic model ids address exactly one resource, `GET /v1/models/{model_id}`.
 * The id must stay a single printable-ASCII token, and `encodeURIComponent`
 * escapes `/`, `?`, `#`, and `%` so they cannot introduce another path, query, or
 * fragment. A bare `.` or `..` is refused before encoding, because dots are
 * unreserved characters that `encodeURIComponent` would otherwise leave intact.
 */
function buildAnthropicModelPath(model: string): string | undefined {
  if (!isSafePathSegment(model)) return undefined
  return `/v1/models/${encodeURIComponent(model)}`
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
  callerSignal: AbortSignal | undefined,
  attempt: (signal: AbortSignal) => Promise<ImageInputCapability>
): Promise<ImageInputCapability | typeof ABORTED> {
  const controller = new AbortController()
  const onCallerAbort = () => controller.abort()
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  const deadline = setTimeout(() => controller.abort(), VISUAL_INPUT_LIMITS.validationTimeoutMs)

  try {
    return await Promise.race([attempt(controller.signal), aborted(controller.signal)])
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
  path: string,
  readMetadata: MetadataReader,
  signal: AbortSignal,
  parse: (metadata: string) => ImageInputCapability
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
    return metadata === undefined ? UNKNOWN : parse(metadata)
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
  response: ModelMetadataResponse,
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
 * Parses a metadata body only when it is one JSON object; anything else proves
 * nothing about the requested model.
 */
function parseJsonObject(metadata: string): Record<string, unknown> | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(metadata)
  } catch {
    return undefined
  }
  if (typeof payload !== 'object' || payload === null) return undefined
  return payload as Record<string, unknown>
}

/**
 * Reads only OpenRouter's documented catalog shape. Anything absent, mistyped, or
 * describing a different model leaves the answer `unknown`; an explicit modality
 * list without `image` is the single reachable `unsupported`.
 */
function openRouterCapabilityFromMetadata(metadata: string, model: string): ImageInputCapability {
  const payload = parseJsonObject(metadata)
  if (payload === undefined) return UNKNOWN

  const data = payload.data
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

/**
 * Reads only Anthropic's documented `GET /v1/models/{model_id}` shape. A missing
 * or mistyped `type`, a neighbouring id, a malformed capability tree, or a
 * non-boolean flag all prove nothing and stay `unknown`; the flag's boolean value
 * is the only thing that decides. Nothing is inferred from the model name.
 */
function anthropicCapabilityFromMetadata(metadata: string, model: string): ImageInputCapability {
  const payload = parseJsonObject(metadata)
  if (payload === undefined) return UNKNOWN

  // A neighbouring entry, an alias, or an error envelope is not the requested model.
  if (payload.type !== 'model' || payload.id !== model) return UNKNOWN

  const capabilities = payload.capabilities
  if (typeof capabilities !== 'object' || capabilities === null) return UNKNOWN

  const imageInput = (capabilities as { image_input?: unknown }).image_input
  if (typeof imageInput !== 'object' || imageInput === null) return UNKNOWN

  const supported = (imageInput as { supported?: unknown }).supported
  if (typeof supported !== 'boolean') return UNKNOWN
  if (!supported) return UNSUPPORTED

  // Frozen because the resolver hands this same instance back from its cache.
  return Object.freeze({
    status: 'supported' as const,
    provider: ANTHROPIC_PROVIDER,
    model,
    evidence: ANTHROPIC_METADATA_EVIDENCE,
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
