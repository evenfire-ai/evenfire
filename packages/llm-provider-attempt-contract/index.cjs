'use strict'

/**
 * @clerum/llm-provider-attempt-contract — see index.d.ts.
 * Pure module: no network, credentials, or Kubernetes.
 */

const { createHash } = require('node:crypto')

const { VISUAL_LIMITS, inspectVisualImage } = require('./visualPayload.cjs')

const SCHEMA_VERSION = 'codex-completion-request.v1'
const SCHEMA_VERSION_V2 = 'codex-completion-request.v2'
const RECEIPT_SCHEMA_VERSION = 'codex-attempt-receipt.v1'
const PROVIDER_ID = 'codex-subscription'
const TICKET_TYP = 'codex-execution-ticket'

const LIMITS = Object.freeze({
  // V1 ceiling, and the V2 ceiling for everything that is not image data. The
  // measurement that enforces the second half lives in
  // `measureNonImageRequestBytes` below.
  maxRequestBodyBytes: 1048576,
  /**
   * V2 request/envelope ceiling. It is deliberately larger than
   * `maxRequestBodyBytes` because a V2 body carries base64 image payloads, and
   * it is deliberately larger than one hard-ceiling image (16 MiB decoded ≈
   * 21.3 MiB encoded) plus the 1 MiB non-image share. Typical 5 / 9 requests
   * fit in 14 MiB (`VISUAL_LIMITS.typicalEnvelopeBytes`); this 24 MiB number is
   * the HTTP/nginx hard envelope, not the usual product target. It is not a
   * text/tool allowance: `measureNonImageRequestBytes` keeps that share on the
   * V1 ceiling.
   */
  maxVisualRequestBodyBytes: 25165824,
  maxMessages: 128,
  // Bound calls in each assistant message independently of advertised definitions.
  maxToolCalls: 32,
  maxOutputTokens: 16384,
  maxDeadlineMs: 300000,
  maxIdLength: 128,
})

const ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/
const SHA256_HEX = /^[a-f0-9]{64}$/
const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool'])
const TOOL_CHOICES = new Set(['auto', 'none', 'required'])
const RECEIPT_OUTCOMES = new Set(['success', 'canceled', 'error', 'unknown'])

const ROOT_KEYS = new Set([
  'schemaVersion',
  'requestId',
  'idempotencyKey',
  'provider',
  'model',
  'messages',
  'tools',
  'generation',
  'deadlineMs',
  'transportHints',
])
const MESSAGE_KEYS = new Set(['role', 'content', 'name', 'toolCallId', 'toolCalls'])
const TOOL_CALL_KEYS = new Set(['id', 'name', 'arguments'])
const TOOL_KEYS = new Set(['name', 'description', 'parameters'])
const GENERATION_KEYS = new Set(['temperature', 'maxOutputTokens', 'toolChoice'])
const HINT_KEYS = new Set(['promptCacheKey'])

/**
 * V2 (codex-completion-request.v2) adds typed visual parts to user messages.
 * The root field set is deliberately the same closed set as V1: V2 must not
 * become a looser schema at the root.
 */
const MESSAGE_KEYS_V2 = new Set([
  'role',
  'content',
  'contentParts',
  'name',
  'toolCallId',
  'toolCalls',
])
const CONTENT_PART_TEXT_KEYS = new Set(['type', 'text'])
const CONTENT_PART_IMAGE_KEYS = new Set(['type', 'mimeType', 'data', 'source'])
const IMAGE_SOURCE_ATTACHMENT_KEYS = new Set(['kind', 'attachmentId', 'messageId'])
const IMAGE_SOURCE_TOOL_KEYS = new Set(['kind', 'attachmentId', 'toolCallId'])
const ENVELOPE_KEYS = new Set(['executionTicket', 'requestHash', 'request'])

const CLAIMS_KEYS = new Set([
  'jti',
  'typ',
  'sub',
  'hostRef',
  'recipeNamespace',
  'recipeName',
  'invocationId',
  'attemptGeneration',
  'providerAttemptId',
  'providerAttemptIndex',
  'provider',
  'model',
  'requestHash',
  'policyRevision',
  'policyHash',
  'budgetReservationId',
  'connectionRevision',
  'connectionId',
])
const AUTHORIZE_KEYS = new Set(['providerAttemptId', 'requestHash', 'executionTicket', 'expiresAt'])
const RECEIPT_KEYS = new Set([
  'schemaVersion',
  'providerAttemptId',
  'requestHash',
  'outcome',
  'usage',
])
const USAGE_KEYS = new Set(['inputTokens', 'outputTokens'])

function fail(code, message) {
  return { ok: false, code, message }
}

function ok(value) {
  return { ok: true, value }
}

/**
 * Canonical JSON serialization for deterministic hashing.
 * Copied to stay compatible with control-api/src/utils/stableStringify.ts.
 * Validation rejects non-finite numbers before this runs.
 */
function stableStringify(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'null'
  const t = typeof value
  if (t === 'number') {
    return Number.isFinite(value) ? String(value) : 'null'
  }
  if (t === 'string' || t === 'boolean') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const items = value.map(item => (item === undefined ? 'null' : stableStringify(item)))
    return `[${items.join(',')}]`
  }
  if (t === 'object') {
    const obj = value
    const keys = Object.keys(obj)
      .filter(k => obj[k] !== undefined)
      .sort()
    const body = keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')
    return `{${body}}`
  }
  return 'null'
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unknownKeys(obj, allowed) {
  return Object.keys(obj).filter(k => !allowed.has(k))
}

/**
 * Request/envelope byte ceiling for a schema version. V2 raises the ceiling so
 * a body can carry image payloads; every other value keeps the V1 ceiling, so a
 * missing, unknown or lower version can never buy the larger budget.
 */
function schemaRequestBodyLimit(schemaVersion) {
  return schemaVersion === SCHEMA_VERSION_V2
    ? LIMITS.maxVisualRequestBodyBytes
    : LIMITS.maxRequestBodyBytes
}

/**
 * Ceiling for a request body, or for the envelope that carries it, BEFORE
 * parsing. Callers that must size an HTTP body — the client, the authorizer and
 * the proxy — only have the declared document at that point, so this keys off
 * the declaration and falls back to the V1 ceiling for anything else.
 */
function requestBodyLimitBytes(request) {
  return schemaRequestBodyLimit(isPlainObject(request) ? request.schemaVersion : undefined)
}

/**
 * UTF-8 length of a request with every image payload replaced by an empty
 * string: the caller-controlled text/tool share of the body.
 *
 * V2's larger ceiling exists for image data only, so this share stays on the V1
 * budget and declaring V2 never buys 24 MiB of text or tool definitions. The
 * measurement builds a detached shadow — the input's key order, shallow copies,
 * only image `data` blanked — measures it and discards it. The original
 * request, its hash and its projection are never touched, so this cannot change
 * what is authorized or signed.
 */
function blankImagePayloadsInMessages(messages) {
  if (!Array.isArray(messages)) return messages
  return messages.map(message => {
    const parts = isPlainObject(message) ? message.contentParts : undefined
    if (!Array.isArray(parts)) return message
    return {
      ...message,
      contentParts: parts.map(part =>
        isPlainObject(part) && part.type === 'image' ? { ...part, data: '' } : part
      ),
    }
  })
}

function measureNonImageRequestBytes(input) {
  return Buffer.byteLength(
    JSON.stringify({ ...input, messages: blankImagePayloadsInMessages(input.messages) }),
    'utf8'
  )
}

/**
 * Authorize JSON is a different document from a Codex request or proxy
 * envelope. `requestBodyLimitBytes(body.request)` still gates the whole
 * wrapper (24 MiB only when the nested request declares V2). This helper
 * blanks image payloads inside `body.request` so wrapper fields — ids,
 * hashes, ticket links — stay on the 1 MiB non-image budget.
 */
function measureNonImageAuthorizeBytes(body) {
  if (!isPlainObject(body)) {
    return Buffer.byteLength(JSON.stringify(body ?? null), 'utf8')
  }
  const request = body.request
  if (!isPlainObject(request)) {
    return Buffer.byteLength(JSON.stringify(body), 'utf8')
  }
  return Buffer.byteLength(
    JSON.stringify({
      ...body,
      request: { ...request, messages: blankImagePayloadsInMessages(request.messages) },
    }),
    'utf8'
  )
}

function isBoundedId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

// Tool names are opaque registry keys, not authorization/request identifiers.
// Their size is bounded by maxRequestBodyBytes; transport aliases apply later.
function isToolName(value) {
  return typeof value === 'string' && value.length > 0 && !/[\p{Cc}\p{Cs}]/u.test(value)
}

function rejectUnknown(obj, allowed, label) {
  const extra = unknownKeys(obj, allowed)
  if (extra.length === 0) return null
  return fail('unknown-field', `${label} rejects field '${extra[0]}'`)
}

function assertFiniteTree(value, label) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return fail('non-finite', `${label} must be finite`)
    }
    return null
  }
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return null
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    return fail('invalid', `${label} has an unsupported type`)
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const inner = assertFiniteTree(value[i], `${label}[${i}]`)
      if (inner) return inner
    }
    return null
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      const inner = assertFiniteTree(v, `${label}.${k}`)
      if (inner) return inner
    }
  }
  return null
}

/**
 * One message parser for every request version. `messageKeys` is the closed
 * field set for that version (V2 adds `contentParts`); a version without that
 * key rejects the field as unknown before this function can project it.
 * `visualBudget` is a single request-scoped accumulator: image count and total
 * image bytes bound the entire request, not one message.
 */
function parseMessages(raw, messageKeys, visualBudget) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail('invalid', 'messages must be a non-empty array')
  }
  if (raw.length > LIMITS.maxMessages) {
    return fail('limit', `messages exceed ${LIMITS.maxMessages}`)
  }
  const messages = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    const label = `messages[${i}]`
    if (!isPlainObject(item)) return fail('invalid', `${label} must be an object`)
    const extra = rejectUnknown(item, messageKeys, label)
    if (extra) return extra
    if (!MESSAGE_ROLES.has(item.role)) return fail('invalid', `${label}.role is not allowed`)
    if (typeof item.content !== 'string')
      return fail('invalid', `${label}.content must be a string`)
    const message = { role: item.role, content: item.content }
    if (item.name !== undefined) {
      if (!isToolName(item.name)) return fail('invalid', `${label}.name is invalid`)
      message.name = item.name
    }
    if (item.toolCallId !== undefined) {
      if (!isBoundedId(item.toolCallId)) return fail('invalid', `${label}.toolCallId is invalid`)
      message.toolCallId = item.toolCallId
    }
    if (item.toolCalls !== undefined) {
      if (item.role !== 'assistant') {
        return fail('invalid', `${label}.toolCalls is only allowed on assistant`)
      }
      if (!Array.isArray(item.toolCalls) || item.toolCalls.length === 0) {
        return fail('invalid', `${label}.toolCalls must be a non-empty array`)
      }
      if (item.toolCalls.length > LIMITS.maxToolCalls) {
        return fail('limit', `${label}.toolCalls exceed ${LIMITS.maxToolCalls}`)
      }
      const toolCalls = []
      for (let j = 0; j < item.toolCalls.length; j++) {
        const call = item.toolCalls[j]
        if (!isPlainObject(call)) {
          return fail('invalid', `${label}.toolCalls[${j}] must be an object`)
        }
        const callExtra = rejectUnknown(call, TOOL_CALL_KEYS, `${label}.toolCalls[${j}]`)
        if (callExtra) return callExtra
        if (!isBoundedId(call.id)) {
          return fail('invalid', `${label}.toolCalls[${j}].id is invalid`)
        }
        if (!isToolName(call.name)) {
          return fail('invalid', `${label}.toolCalls[${j}].name is invalid`)
        }
        if (!isPlainObject(call.arguments)) {
          return fail('invalid', `${label}.toolCalls[${j}].arguments must be an object`)
        }
        const finiteArgs = assertFiniteTree(call.arguments, `${label}.toolCalls[${j}].arguments`)
        if (finiteArgs) return finiteArgs
        toolCalls.push({ id: call.id, name: call.name, arguments: call.arguments })
      }
      message.toolCalls = toolCalls
    }
    if (item.contentParts !== undefined) {
      if (item.role !== 'user') {
        return fail('invalid', `${label}.contentParts is only allowed on user`)
      }
      const parts = parseContentParts(item.contentParts, `${label}.contentParts`, visualBudget)
      if (!parts.ok) return parts
      if (parts.value.text !== item.content) {
        return fail('invalid', `${label}.content must equal the text parts joined by '\\n'`)
      }
      message.contentParts = parts.value.parts
    }
    messages.push(message)
  }
  return ok(messages)
}

function parseTools(raw) {
  if (raw === undefined) return ok(undefined)
  if (!Array.isArray(raw)) return fail('invalid', 'tools must be an array')
  if (raw.length === 0) return ok(undefined)
  // The complete request is byte-bounded before parsing; definition count is
  // not an access limit for an approved connector catalog.
  const tools = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (!isPlainObject(item)) return fail('invalid', `tools[${i}] must be an object`)
    const extra = rejectUnknown(item, TOOL_KEYS, `tools[${i}]`)
    if (extra) return extra
    if (!isToolName(item.name)) return fail('invalid', `tools[${i}].name is invalid`)
    if (typeof item.description !== 'string') {
      return fail('invalid', `tools[${i}].description must be a string`)
    }
    if (!isPlainObject(item.parameters)) {
      return fail('invalid', `tools[${i}].parameters must be an object`)
    }
    const finite = assertFiniteTree(item.parameters, `tools[${i}].parameters`)
    if (finite) return finite
    tools.push({
      name: item.name,
      description: item.description,
      parameters: item.parameters,
    })
  }
  return ok(tools)
}

function parseGeneration(raw) {
  if (raw === undefined) return ok(undefined)
  if (!isPlainObject(raw)) return fail('invalid', 'generation must be an object')
  const extra = rejectUnknown(raw, GENERATION_KEYS, 'generation')
  if (extra) return extra
  const generation = {}
  if (raw.temperature !== undefined) {
    if (typeof raw.temperature !== 'number' || !Number.isFinite(raw.temperature)) {
      return fail('non-finite', 'generation.temperature must be finite')
    }
    if (raw.temperature < 0 || raw.temperature > 2) {
      return fail('invalid', 'generation.temperature is out of range')
    }
    generation.temperature = raw.temperature
  }
  if (raw.maxOutputTokens !== undefined) {
    if (
      typeof raw.maxOutputTokens !== 'number' ||
      !Number.isFinite(raw.maxOutputTokens) ||
      !Number.isInteger(raw.maxOutputTokens)
    ) {
      return fail('non-finite', 'generation.maxOutputTokens must be a finite integer')
    }
    if (raw.maxOutputTokens < 1 || raw.maxOutputTokens > LIMITS.maxOutputTokens) {
      return fail('limit', 'generation.maxOutputTokens is out of range')
    }
    generation.maxOutputTokens = raw.maxOutputTokens
  }
  if (raw.toolChoice !== undefined) {
    if (!TOOL_CHOICES.has(raw.toolChoice)) {
      return fail('invalid', 'generation.toolChoice is not allowed')
    }
    generation.toolChoice = raw.toolChoice
  }
  return ok(Object.keys(generation).length > 0 ? generation : undefined)
}

function parseTransportHints(raw) {
  if (raw === undefined) return ok(undefined)
  if (!isPlainObject(raw)) return fail('invalid', 'transportHints must be an object')
  const extra = rejectUnknown(raw, HINT_KEYS, 'transportHints')
  if (extra) return extra
  if (raw.promptCacheKey === undefined) return ok(undefined)
  if (!isBoundedId(raw.promptCacheKey)) {
    return fail('invalid', 'transportHints.promptCacheKey is invalid')
  }
  return ok({ promptCacheKey: raw.promptCacheKey })
}

/**
 * One root parser for every request version: the same closed root field set,
 * the same ordered checks and the same projection. Only the schema version
 * literal and the message field set differ, so a new version cannot become a
 * looser root by accident.
 *
 * Two size gates run first, before any key, id or payload work:
 *   1. the whole body against this version's ceiling (24 MiB for V2, 1 MiB
 *      otherwise), then
 *   2. for V2 only, the body with every image payload blanked against the V1
 *      ceiling — the images, not the text, are what the larger budget buys.
 * Both are pure measurements, so the projected value and its hash are
 * unaffected by them.
 */
function parseCodexCompletionRequestRoot(input, schemaVersion, messageKeys) {
  if (!isPlainObject(input)) return fail('invalid', 'request must be an object')
  const visualSchema = schemaVersion === SCHEMA_VERSION_V2
  const encoded = Buffer.byteLength(JSON.stringify(input), 'utf8')
  if (encoded > schemaRequestBodyLimit(schemaVersion)) {
    return fail(
      'limit',
      visualSchema
        ? 'request exceeds maxVisualRequestBodyBytes'
        : 'request exceeds maxRequestBodyBytes'
    )
  }
  if (visualSchema && measureNonImageRequestBytes(input) > LIMITS.maxRequestBodyBytes) {
    return fail('limit', 'request exceeds maxRequestBodyBytes outside image data')
  }
  const extra = rejectUnknown(input, ROOT_KEYS, 'request')
  if (extra) return extra
  if (input.schemaVersion !== schemaVersion) {
    return fail('invalid', `schemaVersion is not ${schemaVersion}`)
  }
  if (!isBoundedId(input.requestId)) return fail('invalid', 'requestId is invalid')
  if (!isBoundedId(input.idempotencyKey)) return fail('invalid', 'idempotencyKey is invalid')
  if (input.provider !== PROVIDER_ID) return fail('invalid', 'provider must be codex-subscription')
  if (!isBoundedId(input.model)) return fail('invalid', 'model is invalid')

  const messages = parseMessages(input.messages, messageKeys, { images: 0, totalBytes: 0 })
  if (!messages.ok) return messages
  const tools = parseTools(input.tools)
  if (!tools.ok) return tools
  const generation = parseGeneration(input.generation)
  if (!generation.ok) return generation
  const transportHints = parseTransportHints(input.transportHints)
  if (!transportHints.ok) return transportHints

  let deadlineMs
  if (input.deadlineMs !== undefined) {
    if (
      typeof input.deadlineMs !== 'number' ||
      !Number.isFinite(input.deadlineMs) ||
      !Number.isInteger(input.deadlineMs)
    ) {
      return fail('non-finite', 'deadlineMs must be a finite integer')
    }
    if (input.deadlineMs < 1 || input.deadlineMs > LIMITS.maxDeadlineMs) {
      return fail('limit', 'deadlineMs is out of range')
    }
    deadlineMs = input.deadlineMs
  }

  const projected = {
    schemaVersion,
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    provider: PROVIDER_ID,
    model: input.model,
    messages: messages.value,
  }
  if (tools.value) projected.tools = tools.value
  if (generation.value) projected.generation = generation.value
  if (deadlineMs !== undefined) projected.deadlineMs = deadlineMs
  if (transportHints.value) projected.transportHints = transportHints.value
  return ok(Object.freeze(projected))
}

function parseCodexCompletionRequestV1(input) {
  return parseCodexCompletionRequestRoot(input, SCHEMA_VERSION, MESSAGE_KEYS)
}

function hashCodexCompletionRequestV1(request) {
  return createHash('sha256').update(stableStringify(request)).digest('hex')
}

/**
 * Minimal image provenance for V2. Closed union: an attachment that arrived
 * with a user message, or one produced by a tool call. It is hashed with the
 * rest of the part and never becomes model text.
 *
 * Identifier shape reuses the existing bounded ID pattern. Evidence from the
 * current producers: attachment ids are `att_<epoch>_<rand>`
 * (mcp-host/src/core/tools/desktop/screenshotUtil.ts), channel message ids are
 * values such as `telegram:tg-chat-1:42` or `1700000001.000001`
 * (mcp-host/src/workflow/providerWorkflowCallerContextClient.test.ts), and
 * tool-call ids come from the assistant tool call. All fit
 * `[A-Za-z0-9._:/-]{1,128}`; no producer needs a different alphabet.
 */
function parseImageSource(raw, label) {
  if (!isPlainObject(raw)) return fail('invalid', `${label} must be an object`)
  if (raw.kind !== 'attachment' && raw.kind !== 'tool') {
    return fail('invalid', `${label}.kind is not allowed`)
  }
  const fromAttachment = raw.kind === 'attachment'
  const extra = rejectUnknown(
    raw,
    fromAttachment ? IMAGE_SOURCE_ATTACHMENT_KEYS : IMAGE_SOURCE_TOOL_KEYS,
    label
  )
  if (extra) return extra
  if (!isBoundedId(raw.attachmentId)) return fail('invalid', `${label}.attachmentId is invalid`)
  const ownerKey = fromAttachment ? 'messageId' : 'toolCallId'
  if (!isBoundedId(raw[ownerKey])) return fail('invalid', `${label}.${ownerKey} is invalid`)
  if (fromAttachment) {
    return ok({ kind: 'attachment', attachmentId: raw.attachmentId, messageId: raw.messageId })
  }
  return ok({ kind: 'tool', attachmentId: raw.attachmentId, toolCallId: raw.toolCallId })
}

/**
 * Ordered content parts. Order is significant and preserved verbatim; nothing
 * is merged, reordered or dropped. Text parts must agree with the message
 * `content` string, so the textual projection and the part projection cannot
 * contradict each other. Parts are optional and may be text-only (a compacted
 * message that no longer carries an image is valid); images are bounded by
 * count, per-image bytes, total bytes, dimension and pixel budgets.
 */
function parseContentParts(raw, label, visualBudget) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail('invalid', `${label} must be a non-empty array`)
  }
  const parts = []
  const textBits = []
  for (let i = 0; i < raw.length; i++) {
    const part = raw[i]
    const partLabel = `${label}[${i}]`
    if (!isPlainObject(part)) return fail('invalid', `${partLabel} must be an object`)
    if (part.type === 'text') {
      const extra = rejectUnknown(part, CONTENT_PART_TEXT_KEYS, partLabel)
      if (extra) return extra
      if (typeof part.text !== 'string') {
        return fail('invalid', `${partLabel}.text must be a string`)
      }
      parts.push({ type: 'text', text: part.text })
      textBits.push(part.text)
      continue
    }
    if (part.type === 'image') {
      const extra = rejectUnknown(part, CONTENT_PART_IMAGE_KEYS, partLabel)
      if (extra) return extra
      if (part.mimeType !== 'image/jpeg' && part.mimeType !== 'image/png') {
        return fail('invalid', `${partLabel}.mimeType is not allowed`)
      }
      const source = parseImageSource(part.source, `${partLabel}.source`)
      if (!source.ok) return source
      const image = inspectVisualImage({ mimeType: part.mimeType, data: part.data })
      if (!image.ok) return fail(image.code, `${partLabel}: ${image.message}`)
      // Request-scoped budgets: history can carry more messages than one, so a
      // per-message counter would let a request exceed the declared limits.
      visualBudget.images += 1
      if (visualBudget.images > VISUAL_LIMITS.maxImages) {
        return fail('limit', `request exceeds ${VISUAL_LIMITS.maxImages} images`)
      }
      visualBudget.totalBytes += image.value.bytes
      if (visualBudget.totalBytes > VISUAL_LIMITS.maxTotalImageBytes) {
        return fail(
          'limit',
          `request exceeds ${VISUAL_LIMITS.maxTotalImageBytes} total image bytes`
        )
      }
      parts.push({
        type: 'image',
        mimeType: part.mimeType,
        data: part.data,
        source: source.value,
      })
      continue
    }
    return fail('invalid', `${partLabel}.type is not allowed`)
  }
  return ok({ parts, text: textBits.join('\n') })
}

/**
 * V2 root: the shared root parser with the V2 schema version and the message
 * field set that additionally allows `contentParts`.
 */
function parseCodexCompletionRequestV2(input) {
  return parseCodexCompletionRequestRoot(input, SCHEMA_VERSION_V2, MESSAGE_KEYS_V2)
}

/**
 * Single dispatcher for every supported version. It only selects the version
 * and defers all validation to that version's parser, so an unknown or missing
 * schemaVersion fails closed instead of falling through to a loose path.
 */
function parseCodexCompletionRequest(input) {
  if (!isPlainObject(input)) return fail('invalid', 'request must be an object')
  if (input.schemaVersion === SCHEMA_VERSION) return parseCodexCompletionRequestV1(input)
  if (input.schemaVersion === SCHEMA_VERSION_V2) return parseCodexCompletionRequestV2(input)
  return fail(
    'invalid',
    'schemaVersion must be codex-completion-request.v1 or codex-completion-request.v2'
  )
}

function hashCodexCompletionRequest(request) {
  return createHash('sha256').update(stableStringify(request)).digest('hex')
}

/**
 * Exact proxy request envelope shared by the authorizer and the proxy.
 *
 * The outer `deadlineMs` is never emitted: a V2 request carries its deadline in
 * `request.deadlineMs`, already bound by the request hash, and a caller must
 * not be able to add an independent deadline after the envelope was measured.
 *
 * The returned envelope is re-parsed and re-hashed here, so it cannot carry a
 * request the contract rejects or a hash that disagrees with the request it
 * carries. Its exact UTF-8 byte length (JSON.stringify minus whitespace, the
 * same serialization the transport sends) must fit the ceiling of the schema it
 * carries — `requestBodyLimitBytes(request)`, i.e. 24 MiB for V2 and 1 MiB
 * otherwise — which is the number the proxy enforces through
 * CODEX_LLM_PROXY_MAX_BODY_BYTES. A deployment that lowers that proxy limit
 * below the contract limit is not covered by this measurement.
 *
 * The request inside the envelope already passed the V2 non-image budget, so
 * the V2 headroom here can only be spent by the ticket and the digest the
 * authorizer produced; a caller cannot reach this ceiling with text.
 */
function buildCodexProxyEnvelope(input) {
  if (!isPlainObject(input)) return fail('invalid', 'proxy envelope must be an object')
  const extra = rejectUnknown(input, ENVELOPE_KEYS, 'proxy envelope')
  if (extra) return extra
  const ticket = input.executionTicket
  if (typeof ticket !== 'string' || ticket.length < 8 || /[\p{Cc}\p{Cs}]/u.test(ticket)) {
    return fail('invalid', 'executionTicket is invalid')
  }
  if (typeof input.requestHash !== 'string' || !SHA256_HEX.test(input.requestHash)) {
    return fail('invalid', 'requestHash must be a SHA-256 hex digest')
  }
  const parsed = parseCodexCompletionRequest(input.request)
  if (!parsed.ok) return parsed
  const requestHash = hashCodexCompletionRequest(parsed.value)
  if (requestHash !== input.requestHash) {
    return fail('request_hash_mismatch', 'requestHash does not match the request')
  }
  const envelope = { executionTicket: ticket, requestHash, request: parsed.value }
  const visualSchema = parsed.value.schemaVersion === SCHEMA_VERSION_V2
  const encoded = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
  if (encoded > requestBodyLimitBytes(parsed.value)) {
    return fail(
      'limit',
      visualSchema
        ? 'proxy envelope exceeds maxVisualRequestBodyBytes'
        : 'proxy envelope exceeds maxRequestBodyBytes'
    )
  }
  return ok(Object.freeze(envelope))
}

/**
 * Grant-binding digest for a Codex authorize attempt. Must match
 * control-api's expected hash: SHA-256 of lexicographic stableStringify of
 * { catalogRevision, connectionKey, credentialRevision, model, provider }.
 */
function computeCodexPolicyHash(input) {
  return createHash('sha256')
    .update(
      stableStringify({
        catalogRevision: input.catalogRevision,
        connectionKey: input.connectionKey || 'deployment-default',
        credentialRevision: input.credentialRevision,
        model: input.model,
        provider: PROVIDER_ID,
      })
    )
    .digest('hex')
}

function requireId(obj, key) {
  if (!isBoundedId(obj[key])) return fail('invalid', `${key} is invalid`)
  return null
}

function requireHex64(obj, key) {
  if (typeof obj[key] !== 'string' || !SHA256_HEX.test(obj[key])) {
    return fail('invalid', `${key} must be a SHA-256 hex digest`)
  }
  return null
}

function requireInt(obj, key, min) {
  const value = obj[key]
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < min
  ) {
    return fail('non-finite', `${key} must be a finite integer`)
  }
  return null
}

function parseCodexExecutionTicketClaims(input) {
  if (!isPlainObject(input)) return fail('invalid', 'ticket claims must be an object')
  const extra = rejectUnknown(input, CLAIMS_KEYS, 'ticket claims')
  if (extra) return extra
  for (const key of [
    'jti',
    'sub',
    'hostRef',
    'invocationId',
    'providerAttemptId',
    'budgetReservationId',
    'model',
  ]) {
    const bad = requireId(input, key)
    if (bad) return bad
  }
  if (input.typ !== TICKET_TYP) return fail('invalid', 'typ must be codex-execution-ticket')
  if (input.provider !== PROVIDER_ID) return fail('invalid', 'provider must be codex-subscription')
  const hashErr = requireHex64(input, 'requestHash') || requireHex64(input, 'policyHash')
  if (hashErr) return hashErr
  const ints =
    requireInt(input, 'attemptGeneration', 0) ||
    requireInt(input, 'providerAttemptIndex', 0) ||
    requireInt(input, 'policyRevision', 0) ||
    requireInt(input, 'connectionRevision', 0)
  if (ints) return ints
  const claims = {
    jti: input.jti,
    typ: TICKET_TYP,
    sub: input.sub,
    hostRef: input.hostRef,
    invocationId: input.invocationId,
    attemptGeneration: input.attemptGeneration,
    providerAttemptId: input.providerAttemptId,
    providerAttemptIndex: input.providerAttemptIndex,
    provider: PROVIDER_ID,
    model: input.model,
    requestHash: input.requestHash,
    policyRevision: input.policyRevision,
    policyHash: input.policyHash,
    budgetReservationId: input.budgetReservationId,
    connectionRevision: input.connectionRevision,
  }
  if (input.connectionId !== undefined) {
    if (!isBoundedId(input.connectionId)) return fail('invalid', 'connectionId is invalid')
    claims.connectionId = input.connectionId
  }
  if (input.recipeNamespace !== undefined) {
    if (!isBoundedId(input.recipeNamespace)) return fail('invalid', 'recipeNamespace is invalid')
    claims.recipeNamespace = input.recipeNamespace
  }
  if (input.recipeName !== undefined) {
    if (!isBoundedId(input.recipeName)) return fail('invalid', 'recipeName is invalid')
    claims.recipeName = input.recipeName
  }
  return ok(Object.freeze(claims))
}

function parseAuthorizeAttemptResponse(input) {
  if (!isPlainObject(input)) return fail('invalid', 'authorize response must be an object')
  const extra = rejectUnknown(input, AUTHORIZE_KEYS, 'authorize response')
  if (extra) return extra
  const idErr = requireId(input, 'providerAttemptId')
  if (idErr) return idErr
  const hashErr = requireHex64(input, 'requestHash')
  if (hashErr) return hashErr
  if (typeof input.executionTicket !== 'string' || input.executionTicket.length < 8) {
    return fail('invalid', 'executionTicket is invalid')
  }
  if (typeof input.expiresAt !== 'string' || Number.isNaN(Date.parse(input.expiresAt))) {
    return fail('invalid', 'expiresAt is invalid')
  }
  return ok(
    Object.freeze({
      providerAttemptId: input.providerAttemptId,
      requestHash: input.requestHash,
      executionTicket: input.executionTicket,
      expiresAt: input.expiresAt,
    })
  )
}

function parseCodexAttemptReceiptV1(input) {
  if (!isPlainObject(input)) return fail('invalid', 'receipt must be an object')
  const extra = rejectUnknown(input, RECEIPT_KEYS, 'receipt')
  if (extra) return extra
  if (input.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    return fail('invalid', 'schemaVersion is not codex-attempt-receipt.v1')
  }
  const idErr = requireId(input, 'providerAttemptId')
  if (idErr) return idErr
  const hashErr = requireHex64(input, 'requestHash')
  if (hashErr) return hashErr
  if (!RECEIPT_OUTCOMES.has(input.outcome)) return fail('invalid', 'outcome is not allowed')
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    providerAttemptId: input.providerAttemptId,
    requestHash: input.requestHash,
    outcome: input.outcome,
  }
  if (input.usage !== undefined) {
    if (!isPlainObject(input.usage)) return fail('invalid', 'usage must be an object')
    const usageExtra = rejectUnknown(input.usage, USAGE_KEYS, 'usage')
    if (usageExtra) return usageExtra
    const usage = {}
    for (const key of USAGE_KEYS) {
      if (input.usage[key] === undefined) continue
      const bad = requireInt(input.usage, key, 0)
      if (bad) return bad
      usage[key] = input.usage[key]
    }
    if (Object.keys(usage).length > 0) receipt.usage = usage
  }
  return ok(Object.freeze(receipt))
}

module.exports = {
  SCHEMA_VERSION,
  SCHEMA_VERSION_V2,
  RECEIPT_SCHEMA_VERSION,
  PROVIDER_ID,
  TICKET_TYP,
  LIMITS,
  VISUAL_LIMITS,
  requestBodyLimitBytes,
  measureNonImageAuthorizeBytes,
  isBoundedId,
  stableStringify,
  parseCodexCompletionRequestV1,
  parseCodexCompletionRequestV2,
  parseCodexCompletionRequest,
  hashCodexCompletionRequestV1,
  hashCodexCompletionRequest,
  buildCodexProxyEnvelope,
  computeCodexPolicyHash,
  parseCodexExecutionTicketClaims,
  parseAuthorizeAttemptResponse,
  parseCodexAttemptReceiptV1,
}
