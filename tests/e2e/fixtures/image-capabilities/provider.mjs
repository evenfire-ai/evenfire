/**
 * E2E_GUARDIAN_IPC_FLOW: transport fixture, not a browser journey. This module
 * never drives the Electron app and has no page, route, or renderer HTTP request
 * to await; the journey
 * `desktop-app/test/e2e-playwright/qa-recorder-image-capabilities.spec.ts` owns
 * the user-visible oracle, and this fixture's own contract is proven by
 * `provider.test.mjs`.
 *
 * Evenfire E2E fixture: the EXTERNAL ZAI OpenAI chat-completions boundary (issue #654).
 *
 * Scope. This module owns exactly one external boundary and nothing else:
 *
 *   POST https://api.z.ai/api/coding/paas/v4/chat/completions
 *
 * Everything else is either delegated untouched (internal cluster routes, where
 * this fixture must never read or rewrite auth) or refused (any other external
 * origin, so a misconfigured run can never reach a real provider from inside the
 * fixture). A refusal is always an explicit error response, never a synthetic
 * success.
 *
 * Why the answer is trustworthy. The journey's oracle is that the model names the
 * tile colors of a 2-column x 3-row PNG, and those colors appear nowhere in the
 * prompt or the file name. So this fixture must recover them from the actual
 * pixels: it decodes the PNG bytes carried in the request's image part and reads
 * the six tile centers. A run that never delivered the image cannot pass by
 * guessing, and a request that carries no image never receives a color list.
 *
 * Determinism and sanitation. Responses carry a synthetic completion id derived
 * from the run id, a fixed test usage block, `finish_reason: 'stop'`, and never a
 * tool call. Both accepted models answer a text-only request with
 * `IMAGE_FIXTURE_TEXT_OK`, so a legitimate title or summary call is never turned
 * into a false failure; only a delivered image can produce a color list. Evidence
 * is limited to the run id, counters, per-model counts, a per-call ledger
 * (model, nullable image digest, response kind), and SHA-256 digests of the
 * delivered image bytes. Headers, auth values, prompts, and raw image bytes are
 * never recorded.
 *
 * Authentication. This fixture never holds the runner's ZAI key. It holds only
 * the SHA-256 digest of that key, hashes the bearer token it receives, and
 * compares the two digests. The key itself lives in the Host's own Secret, so a
 * digest leak cannot be replayed as a credential.
 *
 * Injection note for the wiring. Shadowing `globalThis.fetch` is NOT sufficient
 * for mcp-host: `openai@4.104.0` resolves its transport from
 * `_shims/node-runtime.mjs` (`node-fetch`) under the node export condition, and
 * `shims.fetch !== globalThis.fetch`. The returned `fetch` is an ordinary
 * fetch-shaped function, so the caller must install it where the OpenAI client
 * actually reads its transport instead of assuming the global shadow is enough.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { crc32, inflateSync } from 'node:zlib'

/**
 * The environment-variable name that carries the SHA-256 digest of the runner's
 * own ephemeral ZAI key. Only the digest is published to this process; the key
 * stays in the Host's Secret. It is referenced symbolically, never by value.
 */
const FIXTURE_AUTH_ENV_KEY = 'IMAGE_CAPABILITIES_CREDENTIAL_SHA256'

/** A SHA-256 digest, as 64 hexadecimal characters in either case. */
const SHA256_HEX = /^[0-9a-f]{64}$/i

const PROVIDER_ORIGIN = 'https://api.z.ai'
const CHAT_COMPLETIONS_PATH = '/api/coding/paas/v4/chat/completions'

/** The only two models this fixture answers for. Anything else fails closed. */
const SUPPORTED_MODEL = 'glm-5.3-flash'
const UNSUPPORTED_MODEL = 'glm-5.3'

/** Text-only completion content. It names no image and no color. */
const TEXT_ONLY_CONTENT = 'IMAGE_FIXTURE_TEXT_OK'

/** Fixed OpenAI-compatible envelope values, so evidence is reproducible. */
const FIXTURE_CREATED = 1767225600
const FIXTURE_USAGE = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
const FIXTURE_SYSTEM_FINGERPRINT = 'fp_image_capabilities_fixture'
const COMPLETION_ID_PREFIX = 'chatcmpl-image-fixture-'

/** Bounds. Every one of these is checked before a decode or an inflate. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024
const MAX_PNG_BYTES = 6 * 1024 * 1024
const MAX_CHUNK_BYTES = 2 * 1024 * 1024
const MAX_DIMENSION = 2048
const MIN_TILE_EDGE = 2

/** The tile grid the journey's PNG helper paints. */
const GRID_COLUMNS = 2
const GRID_ROWS = 3

const PNG_DATA_URI_PREFIX = 'data:image/png;base64,'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** PNG colour type 2 (truecolor RGB) with 8 bits per sample. */
const PNG_COLOR_TYPE_TRUECOLOR = 2
const PNG_BIT_DEPTH_8 = 8
const PNG_BYTES_PER_PIXEL = 3

/**
 * Canonical tile palette. MUST stay identical to
 * `desktop-app/test/e2e-playwright/helpers/qaRecorderImageFixture.ts`
 * (`IMAGE_FIXTURE_RGB`). Tiles are matched by exact RGB against this table and
 * anything unmatched is refused, so palette drift fails loudly instead of
 * producing a plausible but wrong answer.
 */
const TILE_PALETTE = [
  ['red', 220, 30, 30],
  ['blue', 30, 70, 220],
  ['green', 30, 170, 60],
  ['yellow', 245, 220, 25],
  ['orange', 250, 140, 20],
  ['purple', 135, 60, 200],
  ['magenta', 230, 40, 190],
  ['cyan', 30, 205, 220],
  ['brown', 125, 80, 45],
  ['pink', 250, 160, 200],
  ['gray', 135, 135, 135],
  ['lime', 175, 235, 35],
]

const TILE_COLOR_NAMES = new Map(
  TILE_PALETTE.map(([name, red, green, blue]) => [`${red},${green},${blue}`, name])
)

/** A refusal with a stable machine-readable reason code for the evidence tally. */
class FixtureImageError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'FixtureImageError'
    this.code = code
  }
}

const malformedPng = message => new FixtureImageError('image-png-malformed', message)

function readPngHeader(data) {
  if (data.length !== 13) throw malformedPng('IHDR must be exactly 13 bytes')
  const width = data.readUInt32BE(0)
  const height = data.readUInt32BE(4)
  const bitDepth = data[8]
  const colorType = data[9]
  const compression = data[10]
  const filter = data[11]
  const interlace = data[12]

  if (width < GRID_COLUMNS * MIN_TILE_EDGE || height < GRID_ROWS * MIN_TILE_EDGE)
    throw malformedPng(
      `PNG ${width}x${height} is too small for the ${GRID_COLUMNS}x${GRID_ROWS} grid`
    )
  if (width > MAX_DIMENSION || height > MAX_DIMENSION)
    throw malformedPng(`PNG ${width}x${height} exceeds the ${MAX_DIMENSION}px bound`)
  if (width % GRID_COLUMNS !== 0 || height % GRID_ROWS !== 0)
    throw new FixtureImageError(
      'image-tile-grid-mismatch',
      `PNG ${width}x${height} does not divide into ${GRID_COLUMNS}x${GRID_ROWS} whole-pixel tiles`
    )
  if (
    bitDepth !== PNG_BIT_DEPTH_8 ||
    colorType !== PNG_COLOR_TYPE_TRUECOLOR ||
    compression !== 0 ||
    filter !== 0 ||
    interlace !== 0
  )
    throw new FixtureImageError(
      'image-png-unsupported-form',
      'PNG must be 8-bit truecolor, non-interlaced, compression 0, filter 0 ' +
        `(got bitDepth ${bitDepth}, colorType ${colorType}, compression ${compression}, ` +
        `filter ${filter}, interlace ${interlace})`
    )

  return { width, height }
}

/**
 * Decode the fixture PNG and return its six tile colors in reading order.
 *
 * Structural validation happens strictly BEFORE the IDAT stream is inflated:
 * the signature, every chunk's length/CRC and criticality, the IHDR field set,
 * the grid divisibility, and the inflated-length bound. A PNG in any other shape
 * is refused rather than approximated.
 */
function decodeTileColors(bytes) {
  if (bytes.length > MAX_PNG_BYTES)
    throw malformedPng(`PNG exceeds the ${MAX_PNG_BYTES}-byte bound`)
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    throw malformedPng('missing PNG signature')

  let offset = PNG_SIGNATURE.length
  let header = null
  const idat = []
  let idatClosed = false
  let ended = false

  while (offset < bytes.length) {
    if (ended) throw malformedPng('trailing data after IEND')
    if (offset + 8 > bytes.length) throw malformedPng('truncated chunk header')

    const length = bytes.readUInt32BE(offset)
    if (length > MAX_CHUNK_BYTES) throw malformedPng(`chunk length ${length} exceeds the bound`)
    const critical = (bytes[offset + 4] & 0x20) === 0
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length)
      throw malformedPng(`chunk ${type} runs past the end of the image`)

    const declaredCrc = bytes.readUInt32BE(dataEnd)
    const actualCrc = crc32(bytes.subarray(offset + 4, dataEnd)) >>> 0
    if (declaredCrc !== actualCrc) throw malformedPng(`chunk ${type} failed its CRC check`)

    const data = bytes.subarray(dataStart, dataEnd)
    if (type !== 'IDAT' && idat.length > 0) idatClosed = true

    if (type === 'IHDR') {
      if (header || offset !== PNG_SIGNATURE.length)
        throw malformedPng('IHDR must be the first and only IHDR chunk')
      header = readPngHeader(data)
    } else if (type === 'IDAT') {
      if (!header) throw malformedPng('IDAT appeared before IHDR')
      if (idatClosed) throw malformedPng('IDAT chunks must be consecutive')
      idat.push(data)
    } else if (type === 'IEND') {
      if (data.length !== 0) throw malformedPng('IEND must be empty')
      ended = true
    } else if (critical) {
      throw new FixtureImageError(
        'image-png-unsupported-form',
        `unsupported critical chunk ${type}`
      )
    }

    offset = dataEnd + 4
  }

  if (!header) throw malformedPng('missing IHDR')
  if (!ended) throw malformedPng('missing IEND')
  if (idat.length === 0) throw malformedPng('missing IDAT')

  const { width, height } = header
  const stride = width * PNG_BYTES_PER_PIXEL + 1
  const expectedRawLength = stride * height

  let raw
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedRawLength })
  } catch (error) {
    throw malformedPng(
      `IDAT did not inflate within the expected bound: ${String(error?.message ?? error)}`
    )
  }
  if (raw.length !== expectedRawLength)
    throw malformedPng(`inflated IDAT is ${raw.length} bytes, expected ${expectedRawLength}`)

  for (let y = 0; y < height; y += 1) {
    const filterByte = raw[y * stride]
    if (filterByte !== 0)
      throw new FixtureImageError(
        'image-png-unsupported-form',
        `scanline ${y} uses PNG filter ${filterByte}; only filter 0 (None) is supported`
      )
  }

  const tileWidth = width / GRID_COLUMNS
  const tileHeight = height / GRID_ROWS
  const colors = []
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const x = column * tileWidth + Math.floor(tileWidth / 2)
      const y = row * tileHeight + Math.floor(tileHeight / 2)
      const start = y * stride + 1 + x * PNG_BYTES_PER_PIXEL
      const red = raw[start]
      const green = raw[start + 1]
      const blue = raw[start + 2]
      const name = TILE_COLOR_NAMES.get(`${red},${green},${blue}`)
      if (!name)
        throw new FixtureImageError(
          'image-pixel-not-a-tile-color',
          `tile ${row * GRID_COLUMNS + column + 1} center is rgb(${red}, ${green}, ${blue}), ` +
            'which is not a canonical fixture tile color'
        )
      colors.push(name)
    }
  }

  return colors
}

/**
 * Extract the single canonical PNG data URI from an OpenAI chat message list.
 *
 * The fixture requires exactly the canonical form the host serializes
 * (`data:image/png;base64,<padded standard base64>`). JPEG, URL references,
 * multiple image parts, and unpadded or non-base64 payloads are refused.
 */
function extractPngBytes(messages) {
  const imageParts = []
  for (const message of messages) {
    if (!message || typeof message !== 'object' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part && typeof part === 'object' && part.type === 'image_url') imageParts.push(part)
    }
  }

  if (imageParts.length === 0) return null
  if (imageParts.length > 1)
    throw new FixtureImageError(
      'image-part-count',
      `exactly one image part is supported, received ${imageParts.length}`
    )

  const imageUrl = imageParts[0].image_url
  const url = imageUrl && typeof imageUrl === 'object' ? imageUrl.url : undefined
  if (typeof url !== 'string')
    throw new FixtureImageError(
      'image-not-png-data-uri',
      'image part must carry image_url.url as a string'
    )
  if (!url.startsWith(PNG_DATA_URI_PREFIX))
    throw new FixtureImageError(
      'image-not-png-data-uri',
      `image must be a ${PNG_DATA_URI_PREFIX} data URI`
    )

  const payload = url.slice(PNG_DATA_URI_PREFIX.length)
  if (payload.length === 0 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload))
    throw new FixtureImageError(
      'image-not-png-data-uri',
      'image data URI payload is not canonical base64'
    )

  return Buffer.from(payload, 'base64')
}

const INTERNAL_HOST_SUFFIXES = [
  '.svc.cluster.local',
  '.svc',
  '.cluster.local',
  '.localhost',
  '.local',
]

const INTERNAL_CLUSTER_NAMESPACES = new Set([
  'channels',
  'control-plane',
  'default',
  'gfs',
  'ingress',
  'kube-system',
  'llm-hooks',
  'mcp-host',
  'mcp-server',
  'profiles',
  'rpc-proxy',
  'sandbox-recipes',
  'sandbox-ui',
  'webhook-ingress',
])

function isInternalHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '')
  if (!host) return false
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true
  if (INTERNAL_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) return true
  if (!host.includes('.')) return true
  const labels = host.split('.')
  return labels.length === 2 && INTERNAL_CLUSTER_NAMESPACES.has(labels[1])
}

function requestUrl(input) {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input && typeof input === 'object' && typeof input.url === 'string'
          ? input.url
          : null
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function headerValue(headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name)
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (Array.isArray(entry) && String(entry[0]).toLowerCase() === name) return entry[1]
    }
    return null
  }
  if (typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) return headers[key]
    }
  }
  return null
}

/**
 * Match the request's presented value against the published digest.
 *
 * The comparison is constant time over equal-length hex digests, and the
 * presented value is discarded immediately: only its digest is ever compared,
 * and only the digest is held. A digest therefore cannot be replayed as a key.
 */
function authorize(header, expectedDigest) {
  if (typeof header !== 'string') return false
  const match = /^Bearer +(.+)$/i.exec(header.trim())
  if (!match) return false
  const received = Buffer.from(createHash('sha256').update(match[1]).digest('hex'))
  const wanted = Buffer.from(String(expectedDigest).toLowerCase())
  if (received.length !== wanted.length) return false
  return timingSafeEqual(received, wanted)
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Every refusal is an explicit, non-retryable error response. */
function fixtureErrorResponse(status, code, message) {
  return jsonResponse({ error: { message, type: 'fixture_error', param: null, code } }, status)
}

function completionBody(completionId, model, content) {
  return {
    id: completionId,
    object: 'chat.completion',
    created: FIXTURE_CREATED,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: FIXTURE_USAGE,
    system_fingerprint: FIXTURE_SYSTEM_FINGERPRINT,
  }
}

function streamResponse(completionId, model, content) {
  const chunk = (delta, finishReason, withUsage) => ({
    id: completionId,
    object: 'chat.completion.chunk',
    created: FIXTURE_CREATED,
    model,
    system_fingerprint: FIXTURE_SYSTEM_FINGERPRINT,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(withUsage ? { usage: FIXTURE_USAGE } : {}),
  })
  const body =
    [
      chunk({ role: 'assistant', content: '' }, null, false),
      chunk({ content }, null, false),
      chunk({}, 'stop', true),
    ]
      .map(frame => `data: ${JSON.stringify(frame)}\n\n`)
      .join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/**
 * Refuse to start unless this process is the isolated, branch-owned fixture.
 *
 * The guard covers every binding the fixture depends on: a test node process,
 * the explicit fixture flag, this journey's run id, a valid Minikube profile
 * that IS the real-PostgreSQL context, and the published digest of the runner's
 * ephemeral ZAI key. A missing or malformed digest is a missing binding, never a
 * placeholder the fixture accepts.
 */
export function validateFixtureEnvironment(env) {
  if (
    env.NODE_ENV !== 'test' ||
    env.EVENFIRE_IMAGE_CAPABILITIES_FIXTURE !== '1' ||
    !/^image-capabilities-[a-f0-9]{12}$/.test(env.IMAGE_CAPABILITIES_RUN_ID ?? '') ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(env.MINIKUBE_PROFILE ?? '') ||
    env.MINIKUBE_PROFILE !== env.CONTROL_API_REAL_PG_CONTEXT ||
    typeof env[FIXTURE_AUTH_ENV_KEY] !== 'string' ||
    !SHA256_HEX.test(env[FIXTURE_AUTH_ENV_KEY])
  )
    throw new Error(
      'image-capabilities fixture requires its isolated test environment: ' +
        'NODE_ENV must be test, EVENFIRE_IMAGE_CAPABILITIES_FIXTURE must be 1, ' +
        'IMAGE_CAPABILITIES_RUN_ID must be image-capabilities-<12 hex>, ' +
        'MINIKUBE_PROFILE must equal CONTROL_API_REAL_PG_CONTEXT, and ' +
        'IMAGE_CAPABILITIES_CREDENTIAL_SHA256 must be the runner key digest'
    )
}

/**
 * Wrap `delegate` with the synthetic ZAI chat-completions boundary.
 *
 * The options object carries the run id, the SHA-256 digest of the runner's own
 * ephemeral ZAI key (compared against the digest of the request's authorisation
 * header and never recorded), and an optional evidence sink invoked with a fresh
 * snapshot after every provider-boundary decision.
 */
export function createImageFixtureFetch(
  delegate,
  { runId, credentialHash: IMAGE_CAPABILITIES_CREDENTIAL_SHA256, onEvidence } = {}
) {
  if (typeof delegate !== 'function')
    throw new Error('image-capabilities fixture requires a delegate fetch')
  if (!/^image-capabilities-[a-f0-9]{12}$/.test(runId ?? ''))
    throw new Error('image-capabilities fixture requires its run id')
  if (
    typeof IMAGE_CAPABILITIES_CREDENTIAL_SHA256 !== 'string' ||
    !SHA256_HEX.test(IMAGE_CAPABILITIES_CREDENTIAL_SHA256)
  )
    throw new Error('image-capabilities fixture requires the runner key digest')

  const state = {
    runId,
    counters: {
      totalAttempts: 0,
      imageAttempts: 0,
      textAttempts: 0,
      rejectedAttempts: 0,
      tileColorResponses: 0,
      textOnlyResponses: 0,
      textModelImageRefusals: 0,
      blockedEgress: 0,
      imageDecodeFailures: 0,
      unauthorizedAttempts: 0,
    },
    attempts: [],
  }
  let sequence = 0

  const snapshot = () => structuredClone(state)
  const publish = () => {
    if (onEvidence) onEvidence(snapshot())
  }
  /**
   * One ledger row per provider-boundary attempt. `model` is null when the
   * request was refused before its body was parsed, and `imageSha256` is null
   * whenever the attempt carried no usable image.
   */
  const recordCall = (model, imageSha256, responseKind) => {
    state.attempts.push({ model, imageSha256, responseKind })
  }
  const refuse = (model, reason, { status = 400, code = reason, imageSha256 = null } = {}) => {
    state.counters.rejectedAttempts += 1
    recordCall(model, imageSha256, 'rejected')
    publish()
    return fixtureErrorResponse(status, code, reason)
  }
  const answer = (model, content, responseKind, { imageSha256 = null, stream = false } = {}) => {
    sequence += 1
    const completionId = `${COMPLETION_ID_PREFIX}${runId.slice(-12)}-${sequence}`
    recordCall(model, imageSha256, responseKind)
    publish()
    return stream
      ? streamResponse(completionId, model, content)
      : jsonResponse(completionBody(completionId, model, content))
  }

  const handleProviderRequest = (input, init, target) => {
    state.counters.totalAttempts += 1

    // The host calls the SDK with a URL string plus init. Any other form (a
    // Request with a consumable body, or a different method) is refused instead
    // of being read or forwarded to the real provider.
    if (typeof input !== 'string')
      return refuse(null, 'provider-request-form-unsupported', { code: 'unsupported_request_form' })
    if (target.pathname !== CHAT_COMPLETIONS_PATH || target.search || target.hash)
      return refuse(null, 'provider-path-not-captured', { code: 'path_not_captured' })
    if (String(init?.method ?? '').toUpperCase() !== 'POST')
      return refuse(null, 'provider-method-unsupported', { code: 'method_not_supported' })

    if (
      !authorize(headerValue(init?.headers, 'authorization'), IMAGE_CAPABILITIES_CREDENTIAL_SHA256)
    ) {
      state.counters.unauthorizedAttempts += 1
      return refuse(null, 'provider-auth-mismatch', { status: 401, code: 'unauthorized' })
    }

    if (typeof init.body !== 'string')
      return refuse(null, 'provider-body-unsupported', { code: 'unsupported_body' })
    if (Buffer.byteLength(init.body) > MAX_REQUEST_BYTES)
      return refuse(null, 'provider-body-unsupported', { code: 'body_too_large' })

    let body
    try {
      body = JSON.parse(init.body)
    } catch {
      return refuse(null, 'provider-body-invalid', { code: 'invalid_json' })
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return refuse(null, 'provider-body-invalid', { code: 'invalid_body' })
    if (typeof body.model !== 'string' || !Array.isArray(body.messages))
      return refuse(null, 'provider-body-invalid', { code: 'missing_model_or_messages' })

    const model = body.model
    const stream = body.stream === true

    let imageBytes = null
    try {
      imageBytes = extractPngBytes(body.messages)
    } catch (error) {
      if (!(error instanceof FixtureImageError)) throw error
      // An image part was present but unusable, so it is still an image attempt.
      state.counters.imageAttempts += 1
      state.counters.imageDecodeFailures += 1
      return refuse(model, error.code, { code: error.code })
    }

    if (!imageBytes) {
      state.counters.textAttempts += 1
      // No image was delivered. Every accepted model answers with the text
      // marker so a legitimate text or title request cannot fail here, and no
      // request without pixels can ever receive a color list.
      if (model !== UNSUPPORTED_MODEL && model !== SUPPORTED_MODEL)
        return refuse(model, 'unsupported-model', { code: 'unsupported_model' })
      state.counters.textOnlyResponses += 1
      return answer(model, TEXT_ONLY_CONTENT, 'text-only', { stream })
    }

    state.counters.imageAttempts += 1

    if (model === UNSUPPORTED_MODEL) {
      // The text-only model must refuse an image on the wire. This is the
      // fixture-side half of the journey's capability guard.
      state.counters.textModelImageRefusals += 1
      return refuse(model, 'text-model-image-incompatible', {
        code: 'image_not_supported_by_model',
      })
    }
    if (model !== SUPPORTED_MODEL)
      return refuse(model, 'unsupported-model', { code: 'unsupported_model' })

    let colors
    try {
      colors = decodeTileColors(imageBytes)
    } catch (error) {
      if (!(error instanceof FixtureImageError)) throw error
      state.counters.imageDecodeFailures += 1
      return refuse(model, error.code, { code: error.code })
    }

    const imageSha256 = createHash('sha256').update(imageBytes).digest('hex')
    state.counters.tileColorResponses += 1
    // The list is derived from the decoded pixels and from nothing else: the
    // prompt, the file name, and the request body never contribute a color.
    return answer(model, colors.join(', '), 'tile-colors', { imageSha256, stream })
  }

  return {
    fetch: async (input, init = {}) => {
      const target = requestUrl(input)
      if (!target) return delegate(input, init)

      if (target.origin === PROVIDER_ORIGIN) return handleProviderRequest(input, init, target)

      // Non-HTTP schemes are not egress; let the delegate decide their fate.
      if (target.protocol !== 'http:' && target.protocol !== 'https:') return delegate(input, init)
      // Internal cluster traffic is delegated byte-for-byte, including its auth.
      if (isInternalHost(target.hostname)) return delegate(input, init)

      // Any other external origin would be real egress to a provider this
      // fixture does not own. Refuse it loudly rather than delegating.
      state.counters.blockedEgress += 1
      publish()
      return fixtureErrorResponse(
        403,
        'egress_blocked',
        'external-egress-blocked: this fixture only reaches the captured provider origin'
      )
    },
    getEvidence: snapshot,
  }
}
