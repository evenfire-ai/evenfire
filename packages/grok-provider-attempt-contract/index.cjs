'use strict'

/**
 * @clerum/grok-provider-attempt-contract — see index.d.ts.
 * Pure module: no network, credentials, or Kubernetes.
 * Does not import the Codex attempt-contract LIMITS.
 */

const { createHash } = require('node:crypto')

const SCHEMA_VERSION = 'grok-completion-request.v1'
const RECEIPT_SCHEMA_VERSION = 'grok-attempt-receipt.v1'
const PROVIDER_ID = 'grok-subscription'
const TICKET_TYP = 'grok-execution-ticket'
const TRANSPORT_PROTOCOL_VERSION = 'grok-subscription-transport.v1'
const COMPLETIONS_ORIGIN = 'https://cli-chat-proxy.grok.com/v1/responses'
const CATALOG_ORIGIN = 'https://cli-chat-proxy.grok.com/v1/models'

const LIMITS = Object.freeze({
  maxRequestBodyBytes: 1048576,
  maxMessages: 128,
  // Grok's Responses tool list is larger than Codex's 32.
  maxToolCalls: 64,
  maxOutputTokens: 16384,
  maxDeadlineMs: 300000,
  maxIdLength: 128,
  // Free-form JSON trees (tool parameters, assistant tool-call arguments) may
  // nest at most this many containers. Bounds recursion before hashing.
  maxNestingDepth: 64,
})

// Deepest free-form tree root inside a request: request > messages[] >
// message > toolCalls[] > call > arguments. A request that nests deeper than
// this cannot pass the per-tree check, so the whole-request guard (which runs
// before any recursive JSON work) never rejects an acceptable request.
const REQUEST_ENVELOPE_DEPTH = 5
const MAX_REQUEST_DEPTH = LIMITS.maxNestingDepth + REQUEST_ENVELOPE_DEPTH

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
  return stableStringifyAt(value, 1)
}

function depthLimitError() {
  const err = new Error(`value exceeds maximum nesting depth ${MAX_REQUEST_DEPTH}`)
  err.code = 'limit'
  return err
}

function stableStringifyAt(value, depth) {
  if (value === null) return 'null'
  if (value === undefined) return 'null'
  const t = typeof value
  if (t === 'number') {
    return Number.isFinite(value) ? String(value) : 'null'
  }
  if (t === 'string' || t === 'boolean') {
    return JSON.stringify(value)
  }
  if (t === 'object' && depth > MAX_REQUEST_DEPTH) {
    throw depthLimitError()
  }
  if (Array.isArray(value)) {
    const items = value.map(item =>
      item === undefined ? 'null' : stableStringifyAt(item, depth + 1)
    )
    return `[${items.join(',')}]`
  }
  if (t === 'object') {
    const obj = value
    const keys = Object.keys(obj)
      .filter(k => obj[k] !== undefined)
      .sort()
    const body = keys
      .map(k => `${JSON.stringify(k)}:${stableStringifyAt(obj[k], depth + 1)}`)
      .join(',')
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

/**
 * Iterative structural pre-check, safe on arbitrarily deep or cyclic input.
 * Returns a failure when containers nest deeper than `maxDepth`, or when the
 * value holds more elements than a maxRequestBodyBytes JSON document can encode
 * (every encoded element takes at least one byte, so no acceptable request
 * reaches that count; shared references are counted per occurrence, as JSON
 * would serialize them).
 */
function checkStructure(value, maxDepth) {
  if (value === null || typeof value !== 'object') return null
  const stack = [value, 1]
  let elements = 1
  while (stack.length > 0) {
    const depth = stack.pop()
    const node = stack.pop()
    if (depth > maxDepth) {
      return fail('limit', `request exceeds maximum nesting depth ${LIMITS.maxNestingDepth}`)
    }
    const children = Array.isArray(node)
      ? node
      : Object.values(node).filter(child => child !== undefined)
    elements += children.length
    if (elements > LIMITS.maxRequestBodyBytes) {
      return fail('limit', 'request exceeds maxRequestBodyBytes')
    }
    for (const child of children) {
      if (child !== null && typeof child === 'object') stack.push(child, depth + 1)
    }
  }
  return null
}

function assertFiniteTree(value, label, depth = 1) {
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
  if (depth > LIMITS.maxNestingDepth) {
    return fail('limit', `${label} exceeds maximum nesting depth ${LIMITS.maxNestingDepth}`)
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const inner = assertFiniteTree(value[i], `${label}[${i}]`, depth + 1)
      if (inner) return inner
    }
    return null
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      const inner = assertFiniteTree(v, `${label}.${k}`, depth + 1)
      if (inner) return inner
    }
  }
  return null
}

function parseMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail('invalid', 'messages must be a non-empty array')
  }
  if (raw.length > LIMITS.maxMessages) {
    return fail('limit', `messages exceed ${LIMITS.maxMessages}`)
  }
  const messages = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (!isPlainObject(item)) return fail('invalid', `messages[${i}] must be an object`)
    const extra = rejectUnknown(item, MESSAGE_KEYS, `messages[${i}]`)
    if (extra) return extra
    if (!MESSAGE_ROLES.has(item.role)) return fail('invalid', `messages[${i}].role is not allowed`)
    if (typeof item.content !== 'string')
      return fail('invalid', `messages[${i}].content must be a string`)
    const message = { role: item.role, content: item.content }
    if (item.name !== undefined) {
      if (!isToolName(item.name)) return fail('invalid', `messages[${i}].name is invalid`)
      message.name = item.name
    }
    if (item.toolCallId !== undefined) {
      if (!isBoundedId(item.toolCallId))
        return fail('invalid', `messages[${i}].toolCallId is invalid`)
      message.toolCallId = item.toolCallId
    }
    if (item.toolCalls !== undefined) {
      if (item.role !== 'assistant') {
        return fail('invalid', `messages[${i}].toolCalls is only allowed on assistant`)
      }
      if (!Array.isArray(item.toolCalls) || item.toolCalls.length === 0) {
        return fail('invalid', `messages[${i}].toolCalls must be a non-empty array`)
      }
      if (item.toolCalls.length > LIMITS.maxToolCalls) {
        return fail('limit', `messages[${i}].toolCalls exceed ${LIMITS.maxToolCalls}`)
      }
      const toolCalls = []
      for (let j = 0; j < item.toolCalls.length; j++) {
        const call = item.toolCalls[j]
        if (!isPlainObject(call)) {
          return fail('invalid', `messages[${i}].toolCalls[${j}] must be an object`)
        }
        const callExtra = rejectUnknown(call, TOOL_CALL_KEYS, `messages[${i}].toolCalls[${j}]`)
        if (callExtra) return callExtra
        if (!isBoundedId(call.id)) {
          return fail('invalid', `messages[${i}].toolCalls[${j}].id is invalid`)
        }
        if (!isToolName(call.name)) {
          return fail('invalid', `messages[${i}].toolCalls[${j}].name is invalid`)
        }
        if (!isPlainObject(call.arguments)) {
          return fail('invalid', `messages[${i}].toolCalls[${j}].arguments must be an object`)
        }
        const finiteArgs = assertFiniteTree(
          call.arguments,
          `messages[${i}].toolCalls[${j}].arguments`
        )
        if (finiteArgs) return finiteArgs
        toolCalls.push({ id: call.id, name: call.name, arguments: call.arguments })
      }
      message.toolCalls = toolCalls
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

function parseGrokCompletionRequestV1(input) {
  if (!isPlainObject(input)) return fail('invalid', 'request must be an object')
  // Runs before JSON.stringify: a deeply nested body would otherwise throw a
  // RangeError out of the parser instead of failing closed.
  const structure = checkStructure(input, MAX_REQUEST_DEPTH)
  if (structure) return structure
  let encoded
  try {
    encoded = Buffer.byteLength(JSON.stringify(input), 'utf8')
  } catch {
    return fail('invalid', 'request is not JSON-serializable')
  }
  if (encoded > LIMITS.maxRequestBodyBytes) {
    return fail('limit', 'request exceeds maxRequestBodyBytes')
  }
  const extra = rejectUnknown(input, ROOT_KEYS, 'request')
  if (extra) return extra
  if (input.schemaVersion !== SCHEMA_VERSION) {
    return fail('invalid', 'schemaVersion is not grok-completion-request.v1')
  }
  if (!isBoundedId(input.requestId)) return fail('invalid', 'requestId is invalid')
  if (!isBoundedId(input.idempotencyKey)) return fail('invalid', 'idempotencyKey is invalid')
  if (input.provider !== PROVIDER_ID) return fail('invalid', 'provider must be grok-subscription')
  if (!isBoundedId(input.model)) return fail('invalid', 'model is invalid')

  const messages = parseMessages(input.messages)
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
    schemaVersion: SCHEMA_VERSION,
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

function hashGrokCompletionRequestV1(request) {
  return createHash('sha256').update(stableStringify(request)).digest('hex')
}

/**
 * Client-side canonical hashing. Serializes `raw` exactly as a JSON peer
 * receives it, parses that wire form with parseGrokCompletionRequestV1, and
 * hashes the validated projection — the same steps control-api authorize and
 * grok-llm-proxy perform. Callers send `value.request` with
 * `value.requestHash`, so shapes the parser normalizes away (empty
 * generation/tools/transportHints, undefined leaves) cannot make the two ends
 * disagree. Never throws; invalid input fails closed.
 */
function hashCanonicalGrokRequest(raw) {
  if (!isPlainObject(raw)) return fail('invalid', 'request must be an object')
  const structure = checkStructure(raw, MAX_REQUEST_DEPTH)
  if (structure) return structure
  let wire
  try {
    wire = JSON.parse(JSON.stringify(raw))
  } catch {
    return fail('invalid', 'request is not JSON-serializable')
  }
  const parsed = parseGrokCompletionRequestV1(wire)
  if (!parsed.ok) return parsed
  return ok(
    Object.freeze({
      request: parsed.value,
      requestHash: hashGrokCompletionRequestV1(parsed.value),
    })
  )
}

/**
 * Grant-binding digest for a Grok authorize attempt. connectionKey is
 * required; never aliases deployment-default.
 */
function computeGrokPolicyHash(input) {
  if (typeof input.connectionKey !== 'string' || input.connectionKey.length === 0) {
    throw new Error('computeGrokPolicyHash requires connectionKey')
  }
  if (input.connectionKey === 'deployment-default' || input.connectionKey === 'unassigned') {
    throw new Error('computeGrokPolicyHash rejects reserved connection keys')
  }
  return createHash('sha256')
    .update(
      stableStringify({
        catalogRevision: input.catalogRevision,
        connectionKey: input.connectionKey,
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

function parseGrokExecutionTicketClaims(input) {
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
  if (input.typ !== TICKET_TYP) return fail('invalid', 'typ must be grok-execution-ticket')
  if (input.provider !== PROVIDER_ID) return fail('invalid', 'provider must be grok-subscription')
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

function parseGrokAttemptReceiptV1(input) {
  if (!isPlainObject(input)) return fail('invalid', 'receipt must be an object')
  const extra = rejectUnknown(input, RECEIPT_KEYS, 'receipt')
  if (extra) return extra
  if (input.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    return fail('invalid', 'schemaVersion is not grok-attempt-receipt.v1')
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
  RECEIPT_SCHEMA_VERSION,
  PROVIDER_ID,
  TICKET_TYP,
  LIMITS,
  TRANSPORT_PROTOCOL_VERSION,
  COMPLETIONS_ORIGIN,
  CATALOG_ORIGIN,
  stableStringify,
  parseGrokCompletionRequestV1,
  hashGrokCompletionRequestV1,
  hashCanonicalGrokRequest,
  computeGrokPolicyHash,
  parseGrokExecutionTicketClaims,
  parseAuthorizeAttemptResponse,
  parseGrokAttemptReceiptV1,
}
