'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const contract = require('./index.cjs')
const visualPayload = require('./visualPayload.cjs')
// Test-only: the Codex contract is the reference the V2 messages and the image
// validator copy must stay identical to. Production code never imports it.
const codexContract = require('../llm-provider-attempt-contract/index.cjs')
const codexVisualPayload = require('../llm-provider-attempt-contract/visualPayload.cjs')
const {
  declaredHeaderPng,
  declaredHeaderPngOfSize,
  jpegOfSize,
  realPng,
  realPngOfSize,
} = require('../llm-provider-attempt-contract/testImageFixtures.cjs')

const BASE = {
  schemaVersion: 'grok-completion-request.v1',
  requestId: 'req-001',
  idempotencyKey: 'idem-001',
  provider: 'grok-subscription',
  model: 'grok-4.6',
  messages: [{ role: 'user', content: 'hello' }],
}

test('runtime exports stay aligned with the declaration file', () => {
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const declared = Array.from(
    declarations.matchAll(/export declare (?:const|function)\s+([A-Za-z0-9_]+)/g),
    m => m[1]
  ).sort()
  assert.deepEqual(Object.keys(contract).sort(), declared)
})

// The check above compares export names only. `LIMITS` is declared with literal
// types, so a bound raised in the runtime module and left behind in the
// declaration file compiles every TypeScript consumer against the old number
// while the runtime accepts the new one.
test('declared LIMITS literals match the runtime values', () => {
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const block = declarations.match(/export declare const LIMITS: \{([\s\S]*?)\n\}/)
  assert.ok(block, 'index.d.ts must declare a LIMITS object literal')
  // Comments are stripped first, so a commented-out member cannot stand in for
  // a real one. Every remaining line must be a member with a plain integer
  // literal: a widened `number`, a decimal or a numeric separator fails here
  // rather than being skipped by the scrape.
  const members = block[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const declared = Object.fromEntries(
    members.map(line => {
      const m = /^readonly ([A-Za-z0-9_]+): (\d+)$/.exec(line)
      assert.ok(m, `LIMITS member must be "readonly <name>: <integer literal>": ${line}`)
      return [m[1], Number(m[2])]
    })
  )
  // fromEntries keeps the last of two members with the same name.
  assert.equal(Object.keys(declared).length, members.length, 'LIMITS declares a member twice')
  assert.deepEqual(declared, { ...contract.LIMITS })
})

// control-api signs Grok execution tickets for this long and derives its ticket
// TTL from this value; the proxy bounds its admission waits against it (#739).
test('LIMITS publishes the execution ticket TTL, declared as the same literal', () => {
  assert.equal(contract.LIMITS.executionTicketTtlMs, 60000)
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const block = declarations.match(/export declare const LIMITS: \{([\s\S]*?)\n\}/)
  // Witness: the declaration block was found and read.
  assert.ok(block, 'index.d.ts must declare a LIMITS object literal')
  assert.match(block[1], /^\s*readonly maxRequestBodyBytes: 8388608$/m)
  assert.match(block[1], /^\s*readonly executionTicketTtlMs: 60000$/m)
})

// The proxy, control-api and mcp-host all import this allowance instead of
// writing their own literal, so the declared literal type has to follow the
// runtime value too.
test('exports the 16 KiB envelope allowance with a matching declared literal', () => {
  assert.equal(contract.ENVELOPE_ALLOWANCE_BYTES, 16 * 1024)
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const declared = declarations.match(/export declare const ENVELOPE_ALLOWANCE_BYTES:\s*(\d+)\b/)
  assert.ok(declared, 'index.d.ts must declare ENVELOPE_ALLOWANCE_BYTES as a numeric literal')
  assert.equal(Number(declared[1]), contract.ENVELOPE_ALLOWANCE_BYTES)
})

test('does not import Codex LIMITS or Codex provider id', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8')
  assert.equal(src.includes("require('../llm-provider-attempt-contract"), false)
  // The image validator is a copy with Grok limits, not a re-export of the
  // Codex one. Witness: the file exists and holds its own decoder.
  const visualSrc = fs.readFileSync(path.join(__dirname, 'visualPayload.cjs'), 'utf8')
  assert.match(visualSrc, /function decodeStrictBase64\(/)
  assert.equal(visualSrc.includes('llm-provider-attempt-contract'), false)
  assert.equal(visualSrc.includes(['chatgpt', 'com'].join('.')), false)
  assert.equal(contract.PROVIDER_ID, 'grok-subscription')
  assert.equal(contract.TICKET_TYP, 'grok-execution-ticket')
  assert.equal(contract.LIMITS.maxToolCalls, 256)
  assert.equal(contract.COMPLETIONS_ORIGIN, 'https://cli-chat-proxy.grok.com/v1/responses')
  const chatgptHost = ['chatgpt', 'com'].join('.')
  assert.equal(src.includes(chatgptHost), false)
})

test('parses the bounded V1 request and hashes with SHA-256', () => {
  const parsed = contract.parseGrokCompletionRequestV1(BASE)
  assert.equal(parsed.ok, true)
  const digest = contract.hashGrokCompletionRequestV1(parsed.value)
  assert.match(digest, /^[a-f0-9]{64}$/)
})

test('rejects a Codex provider id on the Grok contract', () => {
  const parsed = contract.parseGrokCompletionRequestV1({
    ...BASE,
    provider: 'codex-subscription',
  })
  assert.equal(parsed.ok, false)
})

test('rejects NaN and Infinity before hashing', () => {
  const nanParsed = contract.parseGrokCompletionRequestV1({
    ...BASE,
    generation: { temperature: Number.NaN },
  })
  assert.equal(nanParsed.ok, false)
})

test('policy hash requires a non-reserved connectionKey', () => {
  assert.throws(() =>
    contract.computeGrokPolicyHash({
      model: 'grok-4.6',
      catalogRevision: 1,
      credentialRevision: 1,
    })
  )
  assert.throws(() =>
    contract.computeGrokPolicyHash({
      model: 'grok-4.6',
      catalogRevision: 1,
      credentialRevision: 1,
      connectionKey: 'deployment-default',
    })
  )
  const digest = contract.computeGrokPolicyHash({
    model: 'grok-4.6',
    catalogRevision: 1,
    credentialRevision: 1,
    connectionKey: 'grok-aaaaaaaaaaaaaaaa',
  })
  assert.match(digest, /^[a-f0-9]{64}$/)
})

test('parses Grok ticket claims and rejects Codex typ', () => {
  const claims = {
    jti: 'jti-1',
    typ: 'grok-execution-ticket',
    sub: 'default/host-a',
    hostRef: 'host-a',
    invocationId: 'inv-1',
    attemptGeneration: 1,
    providerAttemptId: 'att-1',
    providerAttemptIndex: 1,
    provider: 'grok-subscription',
    model: 'grok-4.6',
    requestHash: 'a'.repeat(64),
    policyRevision: 1,
    policyHash: 'b'.repeat(64),
    budgetReservationId: 'res-1',
    connectionRevision: 1,
    connectionId: 'conn-1',
  }
  const parsed = contract.parseGrokExecutionTicketClaims(claims)
  assert.equal(parsed.ok, true)
  const wrongTyp = contract.parseGrokExecutionTicketClaims({
    ...claims,
    typ: 'codex-execution-ticket',
  })
  assert.equal(wrongTyp.ok, false)
})

// ---------------------------------------------------------------------------
// Canonical hashing shared by mcp-host (client) and control-api/grok-llm-proxy
// (server), plus the structural depth cap.
// ---------------------------------------------------------------------------

const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/golden-request-hashes.json'), 'utf8')
)

function nest(depth, key, leaf = {}) {
  let value = leaf
  for (let i = 1; i < depth; i++) value = { [key]: value }
  return value
}

function nestArrays(depth) {
  let value = []
  for (let i = 1; i < depth; i++) value = [value]
  return value
}

/** What a JSON peer (control-api authorize, grok-llm-proxy) computes. */
function serverHash(wireRequest) {
  const onWire = JSON.parse(JSON.stringify({ request: wireRequest })).request
  const parsed = contract.parseGrokCompletionRequestV1(onWire)
  assert.equal(parsed.ok, true, parsed.message)
  return contract.hashGrokCompletionRequestV1(parsed.value)
}

test('golden digests: well-formed requests keep their pre-change hashes on every path', () => {
  const golden = [
    ...GOLDEN.cases,
    {
      name: 'parameters-at-max-depth-64',
      request: {
        ...BASE,
        requestId: 'req-golden',
        idempotencyKey: 'idem-golden',
        messages: [{ role: 'user', content: 'deep' }],
        tools: [{ name: 'deep', description: 'deep schema', parameters: nest(64, 'n') }],
      },
      sha256: GOLDEN.depthBoundaryDigests['parameters-at-max-depth-64'],
    },
    {
      name: 'arguments-at-max-depth-64',
      request: {
        ...BASE,
        requestId: 'req-golden',
        idempotencyKey: 'idem-golden',
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-deep', name: 'deep', arguments: nest(64, 'a') }],
          },
        ],
      },
      sha256: GOLDEN.depthBoundaryDigests['arguments-at-max-depth-64'],
    },
  ]
  assert.equal(golden.length, 6)
  for (const entry of golden) {
    const parsed = contract.parseGrokCompletionRequestV1(entry.request)
    assert.equal(parsed.ok, true, `${entry.name}: ${parsed.message}`)
    assert.equal(contract.hashGrokCompletionRequestV1(parsed.value), entry.sha256, entry.name)
    const canonical = contract.hashCanonicalGrokRequest(entry.request)
    assert.equal(canonical.ok, true, entry.name)
    assert.equal(canonical.value.requestHash, entry.sha256, entry.name)
    assert.equal(serverHash(canonical.value.request), entry.sha256, entry.name)
  }
})

const DIVERGENT_SHAPES = [
  ['empty generation from a non-enum tool_choice', { generation: {} }],
  ['empty tools array', { tools: [] }],
  ['empty transportHints', { transportHints: {} }],
  ['transportHints with an undefined cache key', { transportHints: { promptCacheKey: undefined } }],
  [
    'undefined optional message fields',
    { messages: [{ role: 'user', content: 'x', name: undefined, toolCallId: undefined }] },
  ],
  [
    'undefined leaves in assistant tool-call arguments',
    {
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 't', arguments: { a: undefined, b: [undefined] } }],
        },
      ],
    },
  ],
  [
    'a Date inside tool parameters (serialized by toJSON on the wire)',
    {
      tools: [{ name: 't', description: 'd', parameters: { type: 'object', since: new Date(0) } }],
    },
  ],
]

for (const [label, overrides] of DIVERGENT_SHAPES) {
  test(`hashCanonicalGrokRequest matches the server hash for ${label}`, () => {
    const raw = { ...BASE, ...overrides }
    const canonical = contract.hashCanonicalGrokRequest(raw)
    assert.equal(canonical.ok, true, canonical.message)
    assert.match(canonical.value.requestHash, /^[a-f0-9]{64}$/)
    // mcp-host sends the canonical request; a caller that still sent the raw
    // request must land on the same digest.
    assert.equal(serverHash(canonical.value.request), canonical.value.requestHash)
    assert.equal(serverHash(raw), canonical.value.requestHash)
  })
}

test('hashCanonicalGrokRequest drops empty optional containers from the canonical request', () => {
  const canonical = contract.hashCanonicalGrokRequest({
    ...BASE,
    generation: {},
    tools: [],
    transportHints: {},
  })
  assert.equal(canonical.ok, true)
  assert.deepEqual(Object.keys(canonical.value.request).sort(), Object.keys(BASE).sort())
})

test('hashCanonicalGrokRequest fails closed without throwing on invalid input', () => {
  const cases = [
    [{ ...BASE, generation: { temperature: 3 } }, 'invalid'],
    [{ ...BASE, provider: 'codex-subscription' }, 'invalid'],
    [{ ...BASE, headers: { authorization: 'x' } }, 'unknown-field'],
    [{ ...BASE, deadlineMs: 10n }, 'invalid'],
    ['not-an-object', 'invalid'],
  ]
  for (const [raw, code] of cases) {
    const result = contract.hashCanonicalGrokRequest(raw)
    assert.equal(result.ok, false)
    assert.equal(result.code, code)
  }
  const cyclic = { ...BASE, tools: [{ name: 't', description: 'd', parameters: {} }] }
  cyclic.tools[0].parameters.self = cyclic.tools[0].parameters
  const cyclicResult = contract.hashCanonicalGrokRequest(cyclic)
  assert.equal(cyclicResult.ok, false)
  assert.equal(cyclicResult.code, 'limit')
})

// The byte path and the element path, told apart. The Codex file has carried
// the two byte-boundary tests since the cap was introduced; this file had
// neither, so nothing here witnessed that the byte guard runs at all — which
// is what makes the element-bound test below meaningful rather than vacuous.

test('tool catalogs remain bounded by serialized request bytes including UTF-8', () => {
  const request = {
    ...BASE,
    tools: [{ name: 'eventasks__read', description: 'Read a record', parameters: {} }],
  }
  const originalBytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
  request.tools[0].description += 'x'.repeat(contract.LIMITS.maxRequestBodyBytes - originalBytes)
  assert.equal(
    Buffer.byteLength(JSON.stringify(request), 'utf8'),
    contract.LIMITS.maxRequestBodyBytes
  )
  assert.equal(contract.parseGrokCompletionRequestV1(request).ok, true)
  // One more character, two more bytes: the cap counts UTF-8 bytes, not code
  // units, so a single accented character crosses a boundary that was exact.
  request.tools[0].description += 'é'
  assert.deepEqual(contract.parseGrokCompletionRequestV1(request), {
    ok: false,
    code: 'limit',
    kind: 'size',
    message: 'request exceeds maxRequestBodyBytes',
  })
})

test('opaque canonical names remain bounded by serialized UTF-8 request bytes', () => {
  const request = { ...BASE, tools: [{ name: '工具', description: 'Read a record', parameters: {} }] }
  request.tools[0].name += 'x'.repeat(
    contract.LIMITS.maxRequestBodyBytes - Buffer.byteLength(JSON.stringify(request), 'utf8')
  )
  assert.equal(contract.parseGrokCompletionRequestV1(request).ok, true)
  request.tools[0].name += 'é'
  assert.deepEqual(contract.parseGrokCompletionRequestV1(request), {
    ok: false,
    code: 'limit',
    kind: 'size',
    message: 'request exceeds maxRequestBodyBytes',
  })
})

// A conversation whose size is data, not tools: tool calls answered by
// minified JSON exports, the shape that filled the subscription paths.
function dataHeavyConversation(targetBytes) {
  const row = JSON.stringify({ id: 'c_0001', company: 'Northwind Labs', score: 42.5, tags: ['saas', 'partner'] })
  const chunk = `[${new Array(Math.ceil((256 * 1024) / (row.length + 1))).fill(row).join(',')}]`
  const request = {
    ...BASE,
    tools: [{ name: 'crm__export', description: 'Export CRM rows', parameters: { type: 'object' } }],
    messages: [{ role: 'user', content: 'Summarize the CRM export.' }],
  }
  for (let i = 0; Buffer.byteLength(JSON.stringify(request), 'utf8') < targetBytes; i++) {
    const id = `call-${i}`
    request.messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name: 'crm__export', arguments: { page: i } }],
    })
    request.messages.push({ role: 'tool', content: chunk, toolCallId: id, name: 'crm__export' })
  }
  return request
}

// R3-1 (#731): the non-image request cap is 8 MiB, as in the Codex contract.
// The two byte-bound tests above derive their payload from LIMITS, so they
// keep pinning the exact boundary at the new value.
test('T-R3-1a-grok maxRequestBodyBytes is 8 MiB', () => {
  assert.equal(contract.LIMITS.maxRequestBodyBytes, 8 * 1024 * 1024)
})

test('T-R3-1b-grok a 4 MiB conversation of tool results is accepted', () => {
  const request = dataHeavyConversation(4 * 1024 * 1024)
  assert.ok(Buffer.byteLength(JSON.stringify(request), 'utf8') >= 4 * 1024 * 1024)
  const parsed = contract.parseGrokCompletionRequestV1(request)
  assert.equal(parsed.ok, true, parsed.message)
})

test('T-E2 the element bound reports itself distinctly from the byte bound', () => {
  // Same defect as the Codex contract's: before #731 the element count inside
  // `checkStructure` and the real byte measurement refused with the identical
  // sentence, so a user report of `request exceeds maxRequestBodyBytes` could
  // not name the guard that fired. Compaction is the remedy either way; the
  // distinct wording buys diagnosis, not a different fix (#731).
  //
  // The shape fits the byte bound; only the element count refuses it.
  const refused = contract.parseGrokCompletionRequestV1({
    ...BASE,
    messages: new Array(contract.LIMITS.maxRequestElements + 1).fill(0),
  })
  assert.deepEqual(refused, {
    ok: false,
    code: 'limit',
    kind: 'size',
    message: 'request exceeds maxRequestElements',
  })
})

// The proxy maps `kind: 'size'` to `payload_too_large` and every other
// contract failure to `invalid_request`, as the Codex transport does. Without
// the field both byte guards would reach the Host as a malformed request.
test("fail carries kind:'size' on the byte bound and the element bound", () => {
  const request = { ...BASE, tools: [{ name: 'eventasks__read', description: '', parameters: {} }] }
  request.tools[0].description = 'x'.repeat(
    contract.LIMITS.maxRequestBodyBytes + 1 - Buffer.byteLength(JSON.stringify(request), 'utf8')
  )
  assert.deepEqual(contract.hashCanonicalGrokRequest(request), {
    ok: false,
    code: 'limit',
    kind: 'size',
    message: 'request exceeds maxRequestBodyBytes',
  })
  const elements = contract.hashCanonicalGrokRequest({
    ...BASE,
    messages: new Array(contract.LIMITS.maxRequestElements + 1).fill(0),
  })
  assert.deepEqual(elements, {
    ok: false,
    code: 'limit',
    kind: 'size',
    message: 'request exceeds maxRequestElements',
  })
  // Witness: a failure that is not a size bound carries no kind.
  const wrongProvider = contract.hashCanonicalGrokRequest({ ...BASE, provider: 'codex-subscription' })
  assert.equal(wrongProvider.ok, false)
  assert.equal('kind' in wrongProvider, false)
})

// The V2 envelope ceiling: every image at its encoded maximum plus the whole
// non-image share, rounded up to a whole MiB. The visual cap takes no
// envelope allowance on top, following the Codex contract.
test('LIMITS.maxVisualRequestBodyBytes is 35 MiB, derived from the image and non-image budgets', () => {
  const visual = require('./visualPayload.cjs')
  assert.equal(contract.LIMITS.maxVisualRequestBodyBytes, 36700160)
  assert.equal(visual.GROK_VISUAL_LIMITS.maxTotalImageBytes, 20971520)
  assert.equal(visual.MAX_ENCODED_TOTAL_IMAGE_BYTES, 27962028)
  const mib = 1024 * 1024
  const floor = visual.MAX_ENCODED_TOTAL_IMAGE_BYTES + contract.LIMITS.maxRequestBodyBytes
  assert.equal(contract.LIMITS.maxVisualRequestBodyBytes, Math.ceil(floor / mib) * mib)
  // A full envelope of images, non-image data and allowance still fits.
  assert.ok(floor + contract.ENVELOPE_ALLOWANCE_BYTES <= contract.LIMITS.maxVisualRequestBodyBytes)
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const block = declarations.match(/export declare const LIMITS: \{([\s\S]*?)\n\}/)
  assert.ok(block, 'index.d.ts must declare a LIMITS object literal')
  assert.match(block[1], /^\s*readonly maxVisualRequestBodyBytes: 36700160$/m)
})

test('LIMITS publishes the nesting depth cap', () => {
  assert.equal(contract.LIMITS.maxNestingDepth, 64)
})

test('LIMITS publishes the id length cap', () => {
  assert.equal(contract.LIMITS.maxIdLength, 128)
})

// ID_PATTERN spells the id length out instead of reading LIMITS.maxIdLength,
// so this ties the two together: changing either one alone fails here.
test('request ids accept LIMITS.maxIdLength characters and reject one more', () => {
  const max = contract.LIMITS.maxIdLength
  assert.equal(contract.parseGrokCompletionRequestV1({ ...BASE, requestId: 'r'.repeat(max) }).ok, true)
  assert.deepEqual(contract.parseGrokCompletionRequestV1({ ...BASE, requestId: 'r'.repeat(max + 1) }), {
    ok: false,
    code: 'invalid',
    message: 'requestId is invalid',
  })
})

test('tool parameters accept depth 64 and reject depth 65 with a limit failure', () => {
  const at = contract.parseGrokCompletionRequestV1({
    ...BASE,
    tools: [{ name: 'deep', description: 'd', parameters: nest(64, 'n') }],
  })
  assert.equal(at.ok, true, at.message)
  const over = contract.parseGrokCompletionRequestV1({
    ...BASE,
    tools: [{ name: 'deep', description: 'd', parameters: nest(65, 'n') }],
  })
  assert.equal(over.ok, false)
  assert.equal(over.code, 'limit')
  assert.match(over.message, /nesting depth/)
})

test('assistant tool-call arguments accept depth 64 and reject depth 65', () => {
  const request = depth => ({
    ...BASE,
    messages: [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'deep', arguments: nest(depth, 'a') }],
      },
    ],
  })
  const at = contract.parseGrokCompletionRequestV1(request(64))
  assert.equal(at.ok, true, at.message)
  const over = contract.parseGrokCompletionRequestV1(request(65))
  assert.equal(over.ok, false)
  assert.equal(over.code, 'limit')
})

for (const depth of [5000, 150000]) {
  test(`a ${depth}-deep body returns a limit failure instead of a RangeError`, () => {
    const viaObjects = {
      ...BASE,
      tools: [{ name: 't', description: 'd', parameters: nest(depth, 'n') }],
    }
    const viaArrays = {
      ...BASE,
      tools: [{ name: 't', description: 'd', parameters: { x: nestArrays(depth) } }],
    }
    for (const raw of [viaObjects, viaArrays]) {
      const parsed = contract.parseGrokCompletionRequestV1(raw)
      assert.equal(parsed.ok, false)
      assert.equal(parsed.code, 'limit')
      const canonical = contract.hashCanonicalGrokRequest(raw)
      assert.equal(canonical.ok, false)
      assert.equal(canonical.code, 'limit')
    }
  })
}

test('stableStringify rejects over-deep values with a limit error, not a stack overflow', () => {
  for (const value of [nest(5000, 'n'), nestArrays(150000)]) {
    assert.throws(
      () => contract.stableStringify(value),
      err => err.code === 'limit' && !(err instanceof RangeError)
    )
  }
  // Any request the parser accepts stays serializable.
  assert.doesNotThrow(() =>
    contract.stableStringify({
      tools: [{ parameters: nest(64, 'n') }],
      m: [[{ a: nest(64, 'a') }]],
    })
  )
})

function catalog(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `eventasks__read_${index}`,
    description: 'Read an approved development record',
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
  }))
}

// The at-limit case is the only one that falsifies the bound this PR replaced:
// a turn of 64 calls was rejected before and is accepted now. A test that only
// checks the rejection above the limit passes identically against 64, 128 or
// 256. The catalog is there because the two counts are independent: a wide set
// of advertised definitions must not widen how many calls one assistant
// message may carry.
test('tool definition count never widens the independent assistant call limit', () => {
  assert.equal(contract.LIMITS.maxToolCalls, 256)
  assert.equal(Object.hasOwn(contract.LIMITS, 'maxTools'), false)
  for (const count of [256, 257]) {
    const parsed = contract.parseGrokCompletionRequestV1({
      ...BASE,
      tools: catalog(250),
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: Array.from({ length: count }, (_, index) => ({
            id: `call-${index}`,
            name: `eventasks__read_${index}`,
            arguments: {},
          })),
        },
      ],
    })
    assert.equal(parsed.ok, count === 256)
    if (!parsed.ok) assert.equal(parsed.message, 'messages[0].toolCalls exceed 256')
  }
})

test('message count is bounded at maxMessages', () => {
  assert.equal(contract.LIMITS.maxMessages, 1024)
  for (const count of [1024, 1025]) {
    const parsed = contract.parseGrokCompletionRequestV1({
      ...BASE,
      messages: Array.from({ length: count }, (_, index) => ({
        role: 'user',
        content: `m${index}`,
      })),
    })
    assert.equal(parsed.ok, count === 1024)
    if (!parsed.ok) assert.equal(parsed.message, 'messages exceed 1024')
  }
})

// ---------------------------------------------------------------------------
// V2 (grok-completion-request.v2): user image parts. The structure mirrors the
// Codex V2 contract; the limits are Grok's (xAI documentation for api.x.ai/v1:
// 20 MiB per image, jpeg/png only; 20 images and 20 MiB per request is a local
// product decision). There is no dimension or pixel limit.
// ---------------------------------------------------------------------------

const MIB = 1024 * 1024
const FIXTURE_V2 = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/canonical-request-hashes.v2.json'), 'utf8')
)
const VISUAL_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/visual-requests.json'), 'utf8')
)
const CODEX_VISUAL_FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../llm-provider-attempt-contract/fixtures/visual-requests.json'),
    'utf8'
  )
)
const IMAGE_DATA = {
  png: VISUAL_FIXTURE.png.messages[0].contentParts.find(part => part.type === 'image').data,
  jpeg: VISUAL_FIXTURE.jpeg.messages[0].contentParts.find(part => part.type === 'image').data,
}

/**
 * Fixture image parts carry `dataRef` (resolved from visual-requests.json) and
 * `mutate` for documented truncations, as in the Codex corpus. Resolution
 * returns a deep copy: a loaded fixture is never mutated in place.
 */
function resolveFixtureImages(value) {
  if (Array.isArray(value)) return value.map(resolveFixtureImages)
  if (value && typeof value === 'object') {
    if (typeof value.dataRef === 'string') {
      const source = IMAGE_DATA[value.dataRef]
      assert.ok(source, `unknown image ref ${value.dataRef}`)
      const bytes = Buffer.from(source, 'base64')
      let data = source
      if (value.mutate === 'strip-eoi') data = bytes.subarray(0, bytes.length - 2).toString('base64')
      else if (value.mutate === 'truncate-after-ihdr') data = bytes.subarray(0, 33).toString('base64')
      else assert.equal(value.mutate, undefined, `unknown mutate ${value.mutate}`)
      const clone = { ...value, data }
      delete clone.dataRef
      delete clone.mutate
      return clone
    }
    const out = {}
    for (const [key, inner] of Object.entries(value)) out[key] = resolveFixtureImages(inner)
    return out
  }
  return value
}

function imagePart(data, mimeType = 'image/png') {
  return {
    type: 'image',
    mimeType,
    data,
    source: { kind: 'tool', attachmentId: 'att_1700000000001_ff00aa11', toolCallId: 'call_abc123' },
  }
}

function v2WithMessages(messages) {
  return { ...BASE, schemaVersion: 'grok-completion-request.v2', messages }
}

function v2WithParts(parts, content = '') {
  return v2WithMessages([{ role: 'user', content, contentParts: parts }])
}

function v2TextRequest(content) {
  return v2WithMessages([{ role: 'user', content }])
}

/** The same request shape, addressed to the Codex contract. */
function asCodex(request) {
  return {
    ...request,
    schemaVersion: request.schemaVersion.replace('grok-', 'codex-'),
    provider: 'codex-subscription',
  }
}

const V2_EXPORTS = [
  'SCHEMA_VERSION_V2',
  'GROK_VISUAL_LIMITS',
  'requestBodyLimitBytes',
  'measureNonImageAuthorizeBytes',
  'measureNonImageCompletionBytes',
  'parseGrokCompletionRequestV2',
  'parseGrokCompletionRequest',
  'hashGrokCompletionRequest',
  'buildGrokProxyEnvelope',
]

test('v2 exports: every V2 name exists at runtime and in index.d.ts', () => {
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const declared = new Set(
    Array.from(
      declarations.matchAll(/export declare (?:const|function)\s+([A-Za-z0-9_]+)/g),
      m => m[1]
    )
  )
  for (const name of V2_EXPORTS) {
    assert.ok(name in contract, `runtime export ${name}`)
    assert.ok(declared.has(name), `declared export ${name}`)
  }
  assert.equal(contract.SCHEMA_VERSION_V2, 'grok-completion-request.v2')
  assert.match(
    declarations,
    /export declare const SCHEMA_VERSION_V2: 'grok-completion-request\.v2'/
  )
  assert.match(declarations, /export type ContractLimitKind = 'size' \| 'count'/)
})

test('GROK_VISUAL_LIMITS: 20 images, 20 MiB per image, 20 MiB total, no dimension or pixel key', () => {
  assert.deepEqual(
    { ...contract.GROK_VISUAL_LIMITS },
    { maxImages: 20, maxImageBytes: 20971520, maxTotalImageBytes: 20971520 }
  )
  assert.equal(contract.GROK_VISUAL_LIMITS, visualPayload.GROK_VISUAL_LIMITS)
  assert.equal(Object.isFrozen(contract.GROK_VISUAL_LIMITS), true)
  assert.equal(visualPayload.MAX_ENCODED_IMAGE_BYTES, 4 * Math.ceil(20971520 / 3))
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const block = declarations.match(/export declare const GROK_VISUAL_LIMITS: \{([\s\S]*?)\n\}/)
  assert.ok(block, 'index.d.ts must declare a GROK_VISUAL_LIMITS object literal')
  const members = block[1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const declared = Object.fromEntries(
    members.map(line => {
      const m = /^readonly ([A-Za-z0-9_]+): (\d+)$/.exec(line)
      assert.ok(m, `GROK_VISUAL_LIMITS member must be "readonly <name>: <integer>": ${line}`)
      return [m[1], Number(m[2])]
    })
  )
  assert.deepEqual(declared, { ...contract.GROK_VISUAL_LIMITS })
})

test('v2 fixture corpus: valid cases match frozen digests and distinct payloads differ', () => {
  assert.equal(FIXTURE_V2.cases.length, 6)
  for (const fixture of FIXTURE_V2.cases) {
    const request = resolveFixtureImages(fixture.request)
    const parsed = contract.parseGrokCompletionRequest(request)
    assert.equal(parsed.ok, true, `${fixture.name}: ${parsed.message}`)
    const direct = contract.parseGrokCompletionRequestV2(request)
    assert.deepEqual(parsed, direct, `${fixture.name} dispatcher parity`)
    const digest = contract.hashGrokCompletionRequest(parsed.value)
    assert.equal(digest, fixture.sha256, fixture.name)
    const canonical = contract.hashCanonicalGrokRequest(request)
    assert.equal(canonical.ok, true, fixture.name)
    assert.equal(canonical.value.requestHash, fixture.sha256, `${fixture.name} canonical`)
    if (fixture.distinctRequest) {
      const other = contract.parseGrokCompletionRequest(
        resolveFixtureImages(fixture.distinctRequest)
      )
      assert.equal(other.ok, true, `${fixture.name} distinct`)
      assert.notEqual(contract.hashGrokCompletionRequest(other.value), digest, fixture.name)
    }
  }
})

test('v2 fixture corpus: rejected payloads fail closed with the frozen code and message', () => {
  assert.equal(FIXTURE_V2.rejects.length, 16)
  for (const fixture of FIXTURE_V2.rejects) {
    const parsed = contract.parseGrokCompletionRequest(resolveFixtureImages(fixture.request))
    assert.equal(parsed.ok, false, fixture.name)
    assert.equal(parsed.code, fixture.reason, fixture.name)
    assert.equal(parsed.message, fixture.message, fixture.name)
    // The Codex contract refuses the same shape with the same message.
    const codex = codexContract.parseCodexCompletionRequest(
      asCodex(resolveFixtureImages(fixture.request))
    )
    assert.equal(codex.message, fixture.message, `${fixture.name} matches Codex`)
  }
})

test('v2 visual fixtures: inline png/jpeg requests parse and pin the Codex fixture octets', () => {
  assert.deepEqual(VISUAL_FIXTURE.imageSha256, CODEX_VISUAL_FIXTURE.imageSha256)
  for (const key of ['png', 'jpeg', 'pngImageOnly']) {
    const request = VISUAL_FIXTURE[key]
    assert.equal(request.schemaVersion, contract.SCHEMA_VERSION_V2, key)
    assert.equal(request.provider, 'grok-subscription', key)
    const imageParts = request.messages[0].contentParts.filter(part => part.type === 'image')
    assert.equal(imageParts.length, 1, key)
    const bytes = Buffer.from(imageParts[0].data, 'base64')
    const pinned = VISUAL_FIXTURE.imageSha256[imageParts[0].mimeType.replace('image/', '')]
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), pinned, key)
    const parsed = contract.parseGrokCompletionRequest(request)
    assert.equal(parsed.ok, true, `${key}: ${parsed.message}`)
    assert.deepEqual(
      parsed.value.messages[0].contentParts,
      request.messages[0].contentParts,
      `${key} projection`
    )
  }
})

test('dispatcher: v1 rejects contentParts, unknown versions fail closed, v1 hashes are unchanged', () => {
  const v1WithParts = { ...VISUAL_FIXTURE.png, schemaVersion: contract.SCHEMA_VERSION }
  const rejected = contract.parseGrokCompletionRequestV1(v1WithParts)
  assert.deepEqual(rejected, {
    ok: false,
    code: 'unknown-field',
    message: "messages[0] rejects field 'contentParts'",
  })
  assert.equal(contract.parseGrokCompletionRequest(v1WithParts).ok, false)
  // V1 keeps its own version message.
  assert.equal(
    contract.parseGrokCompletionRequestV1(v2TextRequest('hello')).message,
    'schemaVersion is not grok-completion-request.v1'
  )

  for (const schemaVersion of ['grok-completion-request.v3', undefined, null, 2]) {
    assert.deepEqual(contract.parseGrokCompletionRequest({ ...BASE, schemaVersion }), {
      ok: false,
      code: 'invalid',
      message: 'schemaVersion must be grok-completion-request.v1 or grok-completion-request.v2',
    })
  }
  assert.equal(contract.parseGrokCompletionRequest('not an object').ok, false)

  const v1 = contract.parseGrokCompletionRequest(BASE)
  const v2 = contract.parseGrokCompletionRequest(v2TextRequest('hello'))
  assert.equal(v1.ok, true)
  assert.equal(v2.ok, true)
  const withoutVersion = ({ schemaVersion, ...rest }) => rest
  assert.deepEqual(withoutVersion(v2.value), withoutVersion(v1.value), 'text-only v2 keeps v1 semantics')
  assert.notEqual(
    contract.hashGrokCompletionRequest(v2.value),
    contract.hashGrokCompletionRequest(v1.value)
  )
  // Every V1 golden request hashes identically through the version-generic path.
  assert.equal(GOLDEN.cases.length > 0, true)
  for (const entry of GOLDEN.cases) {
    const parsed = contract.parseGrokCompletionRequest(entry.request)
    assert.equal(parsed.ok, true, entry.name)
    assert.equal(contract.hashGrokCompletionRequest(parsed.value), entry.sha256, entry.name)
  }
})

test('pins the V2 refusal messages byte-identical to the Codex contract', () => {
  const template = message => message.replace(/\d+/g, 'N')
  const cases = [
    {
      name: 'non-image share',
      grok: v2TextRequest('x'.repeat(contract.LIMITS.maxRequestBodyBytes + 1)),
      codex: v2TextRequest('x'.repeat(codexContract.LIMITS.maxRequestBodyBytes + 1)),
      message: 'request exceeds maxRequestBodyBytes outside image data',
    },
    {
      name: 'per-image bytes',
      grok: v2WithParts([imagePart(Buffer.alloc(20971520 + 1).toString('base64'))]),
      codex: v2WithParts([
        imagePart(
          Buffer.alloc(codexContract.VISUAL_LIMITS.maxImageBytes + 1).toString('base64')
        ),
      ]),
      message: 'messages[0].contentParts[0]: image exceeds 20971520 decoded bytes',
    },
    {
      name: 'total image bytes',
      grok: v2WithParts([
        imagePart(declaredHeaderPngOfSize(10 * MIB).toString('base64')),
        imagePart(declaredHeaderPngOfSize(10 * MIB + 1).toString('base64')),
      ]),
      codex: v2WithParts([
        imagePart(declaredHeaderPngOfSize(10 * MIB).toString('base64')),
        imagePart(declaredHeaderPngOfSize(6 * MIB + 1).toString('base64')),
      ]),
      message: 'request exceeds 20971520 total image bytes',
    },
    {
      name: 'whole V2 body',
      grok: v2WithParts([imagePart('A'.repeat(contract.LIMITS.maxVisualRequestBodyBytes))]),
      codex: v2WithParts([
        imagePart('A'.repeat(codexContract.LIMITS.maxVisualRequestBodyBytes)),
      ]),
      message: 'request exceeds maxVisualRequestBodyBytes',
    },
  ]
  for (const entry of cases) {
    const grok = contract.parseGrokCompletionRequest(entry.grok)
    assert.deepEqual(
      grok,
      { ok: false, code: 'limit', kind: 'size', message: entry.message },
      entry.name
    )
    const codex = codexContract.parseCodexCompletionRequest(asCodex(entry.codex))
    assert.equal(codex.ok, false, `${entry.name}: Codex refuses its twin`)
    assert.equal(codex.kind, 'size', entry.name)
    assert.equal(template(codex.message), template(entry.message), `${entry.name} template`)
  }
})

test("accepts a 20 MiB PNG and refuses 20 MiB + 1 with kind:'size'", () => {
  const max = contract.GROK_VISUAL_LIMITS.maxImageBytes
  assert.equal(max, 20 * MIB)
  const atMax = realPngOfSize(max, 64, 48, 3)
  assert.equal(atMax.length, max)
  const accepted = contract.parseGrokCompletionRequest(v2WithParts([imagePart(atMax.toString('base64'))]))
  assert.equal(accepted.ok, true, accepted.message)
  const acceptedJpeg = contract.parseGrokCompletionRequest(
    v2WithParts([imagePart(jpegOfSize(max).toString('base64'), 'image/jpeg')])
  )
  assert.equal(acceptedJpeg.ok, true, acceptedJpeg.message)
  // Above the Codex per-image ceiling: the Grok budget is its own.
  assert.ok(max > codexContract.VISUAL_LIMITS.maxImageBytes)

  const overMax = realPngOfSize(max + 1, 64, 48, 3)
  assert.equal(overMax.length, max + 1)
  assert.deepEqual(
    contract.parseGrokCompletionRequest(v2WithParts([imagePart(overMax.toString('base64'))])),
    {
      ok: false,
      code: 'limit',
      kind: 'size',
      message: 'messages[0].contentParts[0]: image exceeds 20971520 decoded bytes',
    }
  )
  // Encoded length is bounded before decoding.
  const encoded = contract.parseGrokCompletionRequest(
    v2WithParts([imagePart('A'.repeat(visualPayload.MAX_ENCODED_IMAGE_BYTES + 4))])
  )
  assert.equal(encoded.code, 'limit')
  assert.equal(encoded.kind, 'size')
})

test("refuses 21 images with kind:'count', counted across the whole request", () => {
  const png = IMAGE_DATA.png
  const twenty = Array.from({ length: contract.GROK_VISUAL_LIMITS.maxImages }, () => imagePart(png))
  const accepted = contract.parseGrokCompletionRequest(v2WithParts(twenty))
  assert.equal(accepted.ok, true, accepted.message)
  const refusal = {
    ok: false,
    code: 'limit',
    kind: 'count',
    message: 'request exceeds 20 images',
  }
  assert.deepEqual(contract.parseGrokCompletionRequest(v2WithParts([...twenty, imagePart(png)])), refusal)
  // History counts: ten images in one message and eleven in another.
  const split = contract.parseGrokCompletionRequest(
    v2WithMessages([
      { role: 'user', content: '', contentParts: twenty.slice(0, 10) },
      { role: 'assistant', content: 'seen' },
      { role: 'user', content: '', contentParts: [...twenty.slice(0, 10), imagePart(png)] },
    ])
  )
  assert.deepEqual(split, refusal)
})

test('refuses a total over 20971520 image bytes', () => {
  const tenMiB = declaredHeaderPngOfSize(10 * MIB).toString('base64')
  const atTotal = contract.parseGrokCompletionRequest(
    v2WithParts([imagePart(tenMiB), imagePart(tenMiB)])
  )
  assert.equal(atTotal.ok, true, atTotal.message)
  assert.deepEqual(
    contract.parseGrokCompletionRequest(
      v2WithParts([
        imagePart(tenMiB),
        imagePart(declaredHeaderPngOfSize(10 * MIB + 1).toString('base64')),
      ])
    ),
    { ok: false, code: 'limit', kind: 'size', message: 'request exceeds 20971520 total image bytes' }
  )
})

test('refuses webp and gif; jpeg and png are the only image types', () => {
  // Witness: the same part is accepted as png.
  assert.equal(contract.parseGrokCompletionRequest(v2WithParts([imagePart(IMAGE_DATA.png)])).ok, true)
  for (const mimeType of ['image/webp', 'image/gif']) {
    assert.deepEqual(
      contract.parseGrokCompletionRequest(v2WithParts([imagePart(IMAGE_DATA.png, mimeType)])),
      { ok: false, code: 'invalid', message: 'messages[0].contentParts[0].mimeType is not allowed' },
      mimeType
    )
  }
  // Container and declared type must agree.
  assert.equal(
    contract.parseGrokCompletionRequest(v2WithParts([imagePart(IMAGE_DATA.png, 'image/jpeg')])).ok,
    false
  )
})

test('accepts a declared 9000x9000 PNG: there is no dimension or pixel limit', () => {
  const huge = declaredHeaderPng(9000, 9000).toString('base64')
  const accepted = contract.parseGrokCompletionRequest(v2WithParts([imagePart(huge)]))
  assert.equal(accepted.ok, true, accepted.message)
  assert.equal(accepted.value.messages[0].contentParts[0].data, huge)
  const wide = contract.parseGrokCompletionRequest(
    v2WithParts([imagePart(realPng(9000, 1, 5).toString('base64'))])
  )
  assert.equal(wide.ok, true, wide.message)
  // The input is meaningful: the Codex contract refuses the same image on its
  // dimension budget.
  const codex = codexContract.parseCodexCompletionRequest(asCodex(v2WithParts([imagePart(huge)])))
  assert.equal(codex.ok, false)
  assert.match(codex.message, /dimension/)
})

test('non-image share over maxRequestBodyBytes is refused outside image data', () => {
  const { maxRequestBodyBytes } = contract.LIMITS
  const overflow = {
    ok: false,
    code: 'limit',
    kind: 'size',
    message: 'request exceeds maxRequestBodyBytes outside image data',
  }
  // Text-only V2: the whole body is the non-image share. Exact boundary.
  const base = Buffer.byteLength(JSON.stringify(v2TextRequest('')), 'utf8')
  const exact = v2TextRequest('x'.repeat(maxRequestBodyBytes - base))
  assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), maxRequestBodyBytes)
  const atLimit = contract.parseGrokCompletionRequest(exact)
  assert.equal(atLimit.ok, true, atLimit.message)
  assert.deepEqual(
    contract.parseGrokCompletionRequest(v2TextRequest('x'.repeat(maxRequestBodyBytes - base + 1))),
    overflow
  )
  // Images do not buy text, and tool definitions share the same budget.
  const longText = 'x'.repeat(maxRequestBodyBytes + MIB)
  assert.deepEqual(
    contract.parseGrokCompletionRequest(
      v2WithParts([imagePart(IMAGE_DATA.png), { type: 'text', text: longText }], longText)
    ),
    overflow
  )
  assert.deepEqual(
    contract.parseGrokCompletionRequest({
      ...v2WithParts([imagePart(IMAGE_DATA.png)]),
      tools: [{ name: 'read', description: 'y'.repeat(maxRequestBodyBytes + MIB), parameters: {} }],
    }),
    overflow
  )
})

// The non-image check runs before the whole-body check, so text past the
// visual ceiling is reported as text, not as an attachment over budget. The
// whole-body message stays reachable only through image data.
test('text past the visual ceiling beside one small image is refused outside image data', () => {
  const text = 'x'.repeat(contract.LIMITS.maxVisualRequestBodyBytes)
  const request = v2WithParts([imagePart(IMAGE_DATA.png), { type: 'text', text }], text)
  assert.ok(Buffer.byteLength(JSON.stringify(request), 'utf8') > contract.LIMITS.maxVisualRequestBodyBytes)
  assert.deepEqual(contract.parseGrokCompletionRequest(request), {
    ok: false,
    code: 'limit',
    kind: 'size',
    message: 'request exceeds maxRequestBodyBytes outside image data',
  })
  assert.deepEqual(
    contract.parseGrokCompletionRequest(v2WithParts([imagePart('A'.repeat(contract.LIMITS.maxVisualRequestBodyBytes))])),
    { ok: false, code: 'limit', kind: 'size', message: 'request exceeds maxVisualRequestBodyBytes' }
  )
})

test('requestBodyLimitBytes: V2 declares 35 MiB; every other body keeps the 8 MiB ceiling', () => {
  for (const v2 of [VISUAL_FIXTURE.png, VISUAL_FIXTURE.jpeg, VISUAL_FIXTURE.pngImageOnly]) {
    assert.equal(contract.requestBodyLimitBytes(v2), 36700160)
  }
  for (const other of [
    BASE,
    { ...BASE, schemaVersion: 'grok-completion-request.v3' },
    { ...BASE, schemaVersion: 'codex-completion-request.v2' },
    { ...BASE, schemaVersion: undefined },
    {},
    null,
    undefined,
    'x',
    7,
    [],
  ]) {
    assert.equal(contract.requestBodyLimitBytes(other), 8388608, String(other))
  }
  // The same oversized shape parsed as V1 keeps the V1 ceiling and message.
  const oversized = v2WithParts([imagePart('A'.repeat(contract.LIMITS.maxVisualRequestBodyBytes))])
  assert.deepEqual(
    contract.parseGrokCompletionRequestV1({ ...oversized, schemaVersion: contract.SCHEMA_VERSION }),
    { ok: false, code: 'limit', kind: 'size', message: 'request exceeds maxRequestBodyBytes' }
  )
})

test('measureNonImageAuthorizeBytes keeps wrapper fields on the maxRequestBodyBytes budget', () => {
  const request = v2WithParts([{ type: 'text', text: 'look' }, imagePart(IMAGE_DATA.png)], 'look')
  const wrapper = { request, invocationId: 'invocation-1', attemptGeneration: 1, targetRef: 'grok-primary' }
  const whole = Buffer.byteLength(JSON.stringify(wrapper), 'utf8')
  const blanked = {
    ...wrapper,
    request: {
      ...request,
      messages: [
        { ...request.messages[0], contentParts: [{ type: 'text', text: 'look' }, { ...imagePart(''), data: '' }] },
      ],
    },
  }
  assert.equal(contract.measureNonImageAuthorizeBytes(wrapper), Buffer.byteLength(JSON.stringify(blanked), 'utf8'))
  assert.ok(whole > contract.measureNonImageAuthorizeBytes(wrapper))
  const stuffed = { ...wrapper, invocationId: 'x'.repeat(contract.LIMITS.maxRequestBodyBytes + MIB) }
  assert.ok(contract.measureNonImageAuthorizeBytes(stuffed) > contract.LIMITS.maxRequestBodyBytes)
  assert.equal(contract.requestBodyLimitBytes(stuffed.request), 36700160)
})

test('measureNonImageCompletionBytes omits the execution ticket', () => {
  const request = v2WithParts([{ type: 'text', text: 'look' }, imagePart(IMAGE_DATA.png)], 'look')
  const completion = {
    request,
    requestHash: 'a'.repeat(64),
    executionTicket: `header.${'a'.repeat(2048)}.sig`,
  }
  const { executionTicket, ...withoutTicket } = completion
  assert.ok(executionTicket.length > 2048)
  assert.equal(
    contract.measureNonImageCompletionBytes(completion),
    contract.measureNonImageAuthorizeBytes(withoutTicket)
  )
  assert.ok(
    contract.measureNonImageAuthorizeBytes(completion) >
      contract.measureNonImageCompletionBytes(completion) + 2048
  )
})

test('buildGrokProxyEnvelope: exact shape, no outer deadline, exact size boundary', () => {
  const parsed = contract.parseGrokCompletionRequest({ ...VISUAL_FIXTURE.png, deadlineMs: 15000 })
  assert.equal(parsed.ok, true, parsed.message)
  const requestHash = contract.hashGrokCompletionRequest(parsed.value)
  const built = contract.buildGrokProxyEnvelope({
    executionTicket: 'header.payload.signature',
    requestHash,
    request: parsed.value,
  })
  assert.equal(built.ok, true, built.message)
  assert.deepEqual(Object.keys(built.value), ['executionTicket', 'requestHash', 'request'])
  assert.equal('deadlineMs' in built.value, false, 'outer deadline is never emitted')
  assert.equal(built.value.request.deadlineMs, 15000)
  assert.equal(Object.isFrozen(built.value), true)

  // V2 exact boundary, moved by the ticket as the authorizer really does.
  const limit = contract.LIMITS.maxVisualRequestBodyBytes
  const sizeFor = ticketBytes =>
    Buffer.byteLength(
      JSON.stringify({ executionTicket: 't'.repeat(ticketBytes), requestHash, request: parsed.value }),
      'utf8'
    )
  const exactTicket = 8 + (limit - sizeFor(8))
  assert.equal(sizeFor(exactTicket), limit)
  const atLimit = contract.buildGrokProxyEnvelope({
    executionTicket: 't'.repeat(exactTicket),
    requestHash,
    request: parsed.value,
  })
  assert.equal(atLimit.ok, true, atLimit.message)
  assert.deepEqual(
    contract.buildGrokProxyEnvelope({
      executionTicket: 't'.repeat(exactTicket + 1),
      requestHash,
      request: parsed.value,
    }),
    { ok: false, code: 'limit', kind: 'size', message: 'proxy envelope exceeds maxVisualRequestBodyBytes' }
  )

  // V1 keeps the 8 MiB envelope ceiling and its own message.
  const v1 = contract.parseGrokCompletionRequest({ ...BASE, deadlineMs: 5000 })
  const v1Hash = contract.hashGrokCompletionRequest(v1.value)
  const v1Size = ticketBytes =>
    Buffer.byteLength(
      JSON.stringify({ executionTicket: 't'.repeat(ticketBytes), requestHash: v1Hash, request: v1.value }),
      'utf8'
    )
  const v1Ticket = 8 + (contract.LIMITS.maxRequestBodyBytes - v1Size(8))
  const v1Exact = contract.buildGrokProxyEnvelope({
    executionTicket: 't'.repeat(v1Ticket),
    requestHash: v1Hash,
    request: v1.value,
  })
  assert.equal(v1Exact.ok, true, v1Exact.message)
  assert.deepEqual(
    contract.buildGrokProxyEnvelope({
      executionTicket: 't'.repeat(v1Ticket + 1),
      requestHash: v1Hash,
      request: v1.value,
    }),
    { ok: false, code: 'limit', kind: 'size', message: 'proxy envelope exceeds maxRequestBodyBytes' }
  )
})

test('buildGrokProxyEnvelope: fails closed on hash mismatch, bad input and invalid requests', () => {
  const ticket = 'header.payload.signature'
  const parsed = contract.parseGrokCompletionRequest(VISUAL_FIXTURE.png)
  assert.equal(parsed.ok, true)
  const requestHash = contract.hashGrokCompletionRequest(parsed.value)
  // Witness: the well-formed envelope is accepted.
  assert.equal(
    contract.buildGrokProxyEnvelope({ executionTicket: ticket, requestHash, request: parsed.value }).ok,
    true
  )
  const cases = [
    ['hash-mismatch', { executionTicket: ticket, requestHash: 'a'.repeat(64), request: parsed.value }, 'request_hash_mismatch'],
    ['hash-shape', { executionTicket: ticket, requestHash: 'not-a-digest', request: parsed.value }, 'invalid'],
    ['unknown-envelope-field', { executionTicket: ticket, requestHash, request: parsed.value, deadlineMs: 1000 }, 'unknown-field'],
    ['short-ticket', { executionTicket: 'short', requestHash, request: parsed.value }, 'invalid'],
    ['ticket-control-character', { executionTicket: 'ticket\u0000value', requestHash, request: parsed.value }, 'invalid'],
    ['request-unknown-root-field', { executionTicket: ticket, requestHash, request: { ...VISUAL_FIXTURE.png, headers: { Authorization: 'Bearer x' } } }, 'unknown-field'],
    ['request-contradictory-parts', { executionTicket: ticket, requestHash, request: v2WithParts([{ type: 'text', text: 'actual' }], 'different') }, 'invalid'],
    ['codex-request', { executionTicket: ticket, requestHash, request: asCodex(VISUAL_FIXTURE.png) }, 'invalid'],
  ]
  for (const [name, input, code] of cases) {
    const result = contract.buildGrokProxyEnvelope(input)
    assert.equal(result.ok, false, name)
    assert.equal(result.code, code, name)
  }
  assert.equal(contract.buildGrokProxyEnvelope(null).code, 'invalid')
})

// The Grok validator is a copy of the Codex one with Grok limits and without
// the dimension/pixel budget. On images inside both budgets the two copies
// must return the same verdict, byte for byte.
test('parity: identical verdicts across both visualPayload copies, dimension limits excluded', () => {
  const png = Buffer.from(IMAGE_DATA.png, 'base64')
  const jpeg = Buffer.from(IMAGE_DATA.jpeg, 'base64')
  const corpus = [
    ['fixture png', 'image/png', IMAGE_DATA.png],
    ['fixture jpeg', 'image/jpeg', IMAGE_DATA.jpeg],
    ['real 64x48 png', 'image/png', realPng(64, 48, 7).toString('base64')],
    ['framed 4 KiB jpeg', 'image/jpeg', jpegOfSize(4096, 640, 480).toString('base64')],
    ['declared 2048x2048 png', 'image/png', declaredHeaderPng(2048, 2048).toString('base64')],
    ['jpeg without EOI', 'image/jpeg', jpeg.subarray(0, jpeg.length - 2).toString('base64')],
    ['png truncated after IHDR', 'image/png', png.subarray(0, 33).toString('base64')],
    ['png signature only', 'image/png', png.subarray(0, 8).toString('base64')],
    ['png declared as jpeg', 'image/jpeg', IMAGE_DATA.png],
    ['jpeg declared as png', 'image/png', IMAGE_DATA.jpeg],
    ['base64 without padding', 'image/png', 'abc'],
    ['base64 with non-canonical trailing bits', 'image/png', 'AB=='],
    ['base64 with a bad alphabet', 'image/png', '!!!!'],
    ['empty data', 'image/png', ''],
    ['non-string data', 'image/png', 42],
    ['gif type', 'image/gif', IMAGE_DATA.png],
    ['webp type', 'image/webp', IMAGE_DATA.png],
  ]
  assert.ok(corpus.length > 0)
  let accepted = 0
  let refused = 0
  for (const [name, mimeType, data] of corpus) {
    const grok = visualPayload.inspectVisualImage({ mimeType, data })
    const codex = codexVisualPayload.inspectVisualImage({ mimeType, data })
    assert.deepEqual(grok, codex, name)
    if (grok.ok) accepted += 1
    else refused += 1
  }
  assert.ok(accepted >= 1, 'the corpus contains accepted images')
  assert.ok(refused >= 1, 'the corpus contains refused images')

  // The one intended difference: dimensions beyond the Codex budget.
  const large = { mimeType: 'image/png', data: declaredHeaderPng(9000, 9000).toString('base64') }
  assert.equal(visualPayload.inspectVisualImage(large).ok, true)
  assert.equal(codexVisualPayload.inspectVisualImage(large).ok, false)
})

// Every branch of the copied container readers, one input each. Both copies
// must return the exact expected verdict, so a mutant cannot survive by
// changing the two copies the same way or by changing only one.
test('parity: every container-reader branch returns the same exact verdict in both copies', () => {
  const u32 = value => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
  // CRCs are not verified by either reader, so they are zero here.
  const chunk = (type, data = []) => [...u32(data.length), ...Buffer.from(type, 'latin1'), ...data, 0, 0, 0, 0]
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const ihdr = (width, height) => chunk('IHDR', [...u32(width), ...u32(height), 8, 6, 0, 0, 0])
  const idat = chunk('IDAT', [0x78, 0x9c])
  const iend = chunk('IEND')
  const SOI = [0xff, 0xd8]
  const EOI = [0xff, 0xd9]
  const sof = (marker, width, height) => [
    0xff, marker, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255,
    0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
  ]
  const sos = [0xff, 0xda, 0x00, 0x0c, 0x03, 1, 0, 2, 0x11, 3, 0x11, 0x00, 0x3f, 0x00]
  const scan = [0x12, 0x34]
  const invalid = message => ({ ok: false, code: 'invalid', message })
  const accepted = (bytes, width, height) => ({ ok: true, value: { bytes, width, height } })
  const png = bytes => ['image/png', bytes]
  const jpeg = bytes => ['image/jpeg', bytes]
  const validPng = [...SIG, ...ihdr(3, 2), ...idat, ...iend]
  const validJpeg = [...SOI, ...sof(0xc0, 8, 6), ...sos, ...scan, ...EOI]
  const corpus = [
    ['png, well formed', png(validPng), accepted(validPng.length, 3, 2)],
    ['png, zero width', png([...SIG, ...ihdr(0, 2), ...idat, ...iend]), invalid('PNG dimensions must be positive')],
    ['png, zero height', png([...SIG, ...ihdr(3, 0), ...idat, ...iend]), invalid('PNG dimensions must be positive')],
    [
      'png, first chunk is not IHDR',
      png([...SIG, ...idat, ...iend]),
      invalid('PNG first chunk must be a 13-byte IHDR'),
    ],
    [
      'png, repeated IHDR',
      png([...SIG, ...ihdr(3, 2), ...ihdr(3, 2), ...idat, ...iend]),
      invalid('PNG repeats IHDR'),
    ],
    [
      'png, non-empty IEND',
      png([...SIG, ...ihdr(3, 2), ...idat, ...chunk('IEND', [0])]),
      invalid('PNG IEND must be empty'),
    ],
    ['png, bytes after IEND', png([...validPng, 0]), invalid('PNG IEND must be the last chunk')],
    ['png, no IEND', png([...SIG, ...ihdr(3, 2), ...idat]), invalid('PNG has no IEND terminator')],
    ['png, no IDAT', png([...SIG, ...ihdr(3, 2), ...iend]), invalid('PNG has no IDAT image data')],
    ['png, truncated chunk header', png([...SIG, ...ihdr(3, 2), 0, 0, 0]), invalid('PNG chunk header is truncated')],
    [
      'png, chunk past the end',
      png([...SIG, ...ihdr(3, 2), ...u32(100), ...Buffer.from('IDAT', 'latin1')]),
      invalid('PNG chunk is truncated'),
    ],
    ['jpeg, well formed baseline', jpeg(validJpeg), accepted(validJpeg.length, 8, 6)],
    [
      'jpeg, progressive 0xC2',
      jpeg([...SOI, ...sof(0xc2, 8, 6), ...sos, ...scan, ...EOI]),
      accepted(validJpeg.length, 8, 6),
    ],
    [
      'jpeg, second SOI',
      jpeg([...SOI, ...SOI, ...sof(0xc0, 8, 6), ...sos, ...scan, ...EOI]),
      invalid('JPEG repeats SOI'),
    ],
    [
      'jpeg, 0xFF00 outside a scan',
      jpeg([...SOI, 0xff, 0x00, ...sof(0xc0, 8, 6), ...sos, ...scan, ...EOI]),
      invalid('JPEG marker framing is malformed'),
    ],
    [
      'jpeg, byte where a marker belongs',
      jpeg([...SOI, 0x00, ...sof(0xc0, 8, 6), ...sos, ...scan, ...EOI]),
      invalid('JPEG marker framing is malformed'),
    ],
    ['jpeg, short segment', jpeg([...SOI, 0xff, 0xe0, 0x00, 0x01, ...EOI]), invalid('JPEG segment is truncated')],
    [
      'jpeg, short frame header',
      jpeg([...SOI, 0xff, 0xc0, 0x00, 0x04, 0x08, 0x00, ...sos, ...scan, ...EOI]),
      invalid('JPEG frame header is truncated'),
    ],
    [
      'jpeg, zero width',
      jpeg([...SOI, ...sof(0xc0, 0, 6), ...sos, ...scan, ...EOI]),
      invalid('JPEG dimensions must be positive'),
    ],
    ['jpeg, no frame header', jpeg([...SOI, ...sos, ...scan, ...EOI]), invalid('JPEG has no frame header')],
    [
      'jpeg, no start of scan',
      jpeg([...SOI, ...sof(0xc0, 8, 6), ...EOI]),
      invalid('JPEG has no start-of-scan segment'),
    ],
    [
      'jpeg, empty scan',
      jpeg([...SOI, ...sof(0xc0, 8, 6), ...sos, ...EOI]),
      invalid('JPEG has no entropy-coded image data'),
    ],
  ]
  assert.ok(corpus.length > 0)
  for (const [name, [mimeType, bytes], expected] of corpus) {
    const input = { mimeType, data: Buffer.from(bytes).toString('base64') }
    assert.deepEqual(visualPayload.inspectVisualImage(input), expected, `grok: ${name}`)
    assert.deepEqual(codexVisualPayload.inspectVisualImage(input), expected, `codex: ${name}`)
  }
})

test('an attachment source with an invalid messageId is refused in both contracts', () => {
  const part = {
    ...imagePart(IMAGE_DATA.png),
    source: { kind: 'attachment', attachmentId: 'att_1700000000001_ff00aa11', messageId: 'not an id' },
  }
  const expected = { ok: false, code: 'invalid', message: 'messages[0].contentParts[0].source.messageId is invalid' }
  assert.deepEqual(contract.parseGrokCompletionRequest(v2WithParts([part])), expected)
  assert.deepEqual(codexContract.parseCodexCompletionRequest(asCodex(v2WithParts([part]))), expected)
  // Witness: the same part with a well-formed messageId is accepted.
  const valid = { ...part, source: { ...part.source, messageId: 'msg_1700000000001_ff00aa11' } }
  const parsed = contract.parseGrokCompletionRequest(v2WithParts([valid]))
  assert.equal(parsed.ok, true, parsed.message)
})

// A8: JSON.parse allocates one heap object per container, so a body can fit
// every byte bound and still exhaust the proxy heap. The contract bounds the
// container count of a request, and the proxies and control-api scan the raw
// body against the same bound before JSON.parse runs.

/** Containers (objects and arrays) in a parsed value, the root included. */
function countContainers(value) {
  let containers = 0
  const stack = [value]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || typeof node !== 'object') continue
    containers++
    for (const child of Object.values(node)) stack.push(child)
  }
  return containers
}

/** A valid request holding exactly `target` containers. */
function requestWithContainers(target) {
  const filler = []
  const request = {
    ...BASE,
    tools: [{ name: 'eventasks__read', description: 'd', parameters: { type: 'object', filler } }],
  }
  for (let count = countContainers(request); count < target; count++) filler.push([])
  assert.equal(countContainers(request), target)
  return request
}

test('LIMITS.maxRequestContainers is pinned and equal to the Codex contract', () => {
  assert.equal(contract.LIMITS.maxRequestContainers, 262144)
  assert.equal(contract.LIMITS.maxRequestContainers, codexContract.LIMITS.maxRequestContainers)
})

// Only the refusal fields are compared, so a regression that accepts the
// request fails with a short diff instead of inspecting a value that holds
// hundreds of thousands of containers.
function refusalOf(result) {
  return { ok: result.ok, code: result.code, kind: result.kind, message: result.message }
}

test("a request over maxRequestContainers is refused with kind:'size'", () => {
  const limit = contract.LIMITS.maxRequestContainers
  const at = requestWithContainers(limit)
  assert.equal(contract.parseGrokCompletionRequest(at).ok, true)
  assert.equal(contract.hashCanonicalGrokRequest(at).ok, true)
  const expected = {
    ok: false,
    code: 'limit',
    kind: 'size',
    message: 'request exceeds maxRequestContainers',
  }
  const over = requestWithContainers(limit + 1)
  // The refusal is the container bound, not a byte bound: the body is far
  // below maxRequestBodyBytes.
  assert.ok(Buffer.byteLength(JSON.stringify(over), 'utf8') < contract.LIMITS.maxRequestBodyBytes)
  assert.deepEqual(refusalOf(contract.parseGrokCompletionRequest(over)), expected)
  assert.deepEqual(refusalOf(contract.hashCanonicalGrokRequest(over)), expected)
  assert.deepEqual(
    refusalOf(contract.parseGrokCompletionRequest({ ...over, schemaVersion: 'grok-completion-request.v2' })),
    expected
  )
})

/** Object members in a parsed value, over every object in the tree. */
function countMembers(value) {
  let members = 0
  const stack = [value]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || typeof node !== 'object') continue
    if (!Array.isArray(node)) members += Object.keys(node).length
    for (const child of Object.values(node)) stack.push(child)
  }
  return members
}

/** A valid request holding exactly `target` object members. */
function requestWithMembers(target) {
  const filler = {}
  const request = {
    ...BASE,
    tools: [{ name: 'eventasks__read', description: 'd', parameters: { type: 'object', properties: filler } }],
  }
  for (let count = countMembers(request); count < target; count++) {
    filler[`m${String(count).padStart(7, '0')}`] = 0
  }
  assert.equal(countMembers(request), target)
  return request
}

test('LIMITS.maxRequestMembers is pinned and equal to the Codex contract', () => {
  assert.equal(contract.LIMITS.maxRequestMembers, 262144)
  assert.equal(contract.LIMITS.maxRequestMembers, codexContract.LIMITS.maxRequestMembers)
})

/** Count JSON values independently of the contract's structural pre-check. */
function countElements(value) {
  let elements = 1
  const stack = [value]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || typeof node !== 'object') continue
    const children = Array.isArray(node) ? node : Object.values(node)
    elements += children.length
    for (const child of children) if (child !== null && typeof child === 'object') stack.push(child)
  }
  return elements
}

function requestWithElements(target) {
  const filler = []
  const request = {
    ...BASE,
    tools: [{ name: 'eventasks__read', description: 'd', parameters: { type: 'object', enum: filler } }],
  }
  filler.length = target - countElements(request)
  filler.fill(0)
  assert.equal(countElements(request), target)
  return request
}

test('LIMITS.maxRequestElements is pinned and equal to the Codex contract', () => {
  assert.equal(contract.LIMITS.maxRequestElements, 1048576)
  assert.equal(contract.LIMITS.maxRequestElements, codexContract.LIMITS.maxRequestElements)
})

test("a request over maxRequestElements is refused with kind:'size'", () => {
  const limit = contract.LIMITS.maxRequestElements
  const at = requestWithElements(limit)
  assert.equal(contract.parseGrokCompletionRequest(at).ok, true)
  const over = requestWithElements(limit + 1)
  assert.ok(Buffer.byteLength(JSON.stringify(over), 'utf8') < contract.LIMITS.maxRequestBodyBytes)
  const expected = {
    ok: false,
    code: 'limit',
    kind: 'size',
    message: 'request exceeds maxRequestElements',
  }
  assert.deepEqual(refusalOf(contract.parseGrokCompletionRequest(over)), expected)
  assert.deepEqual(refusalOf(contract.hashCanonicalGrokRequest(over)), expected)
  assert.deepEqual(
    refusalOf(contract.parseGrokCompletionRequest({ ...over, schemaVersion: 'grok-completion-request.v2' })),
    expected
  )
})

test("a request over maxRequestMembers is refused with kind:'size'", () => {
  const limit = contract.LIMITS.maxRequestMembers
  const at = requestWithMembers(limit)
  assert.equal(contract.parseGrokCompletionRequest(at).ok, true)
  assert.equal(contract.hashCanonicalGrokRequest(at).ok, true)
  const expected = {
    ok: false,
    code: 'limit',
    kind: 'size',
    message: 'request exceeds maxRequestMembers',
  }
  const over = requestWithMembers(limit + 1)
  // The refusal is the member bound, not a byte bound.
  assert.ok(Buffer.byteLength(JSON.stringify(over), 'utf8') < contract.LIMITS.maxRequestBodyBytes)
  assert.deepEqual(refusalOf(contract.parseGrokCompletionRequest(over)), expected)
  assert.deepEqual(refusalOf(contract.hashCanonicalGrokRequest(over)), expected)
  assert.deepEqual(
    refusalOf(contract.parseGrokCompletionRequest({ ...over, schemaVersion: 'grok-completion-request.v2' })),
    expected
  )
})

test('bodyStructure.cjs is byte-identical in both contract packages', () => {
  const grok = fs.readFileSync(path.join(__dirname, 'bodyStructure.cjs'))
  const codex = fs.readFileSync(path.join(__dirname, '../llm-provider-attempt-contract/bodyStructure.cjs'))
  assert.ok(grok.length > 0)
  assert.equal(Buffer.compare(grok, codex), 0)
})

test('BODY_STRUCTURE_LIMITS derive from LIMITS and match the Codex contract', () => {
  const limits = contract.BODY_STRUCTURE_LIMITS
  assert.deepEqual(limits, {
    maxStructuralBytes: contract.LIMITS.maxRequestBodyBytes + contract.ENVELOPE_ALLOWANCE_BYTES,
    maxContainers: contract.LIMITS.maxRequestContainers + 16,
    maxDepth: contract.LIMITS.maxNestingDepth + 6,
    maxMembers: contract.LIMITS.maxRequestMembers + 64,
    maxElements: contract.LIMITS.maxRequestElements + 64,
  })
  assert.deepEqual(limits, {
    maxStructuralBytes: 8404992,
    maxContainers: 262160,
    maxDepth: 70,
    maxMembers: 262208,
    maxElements: 1048640,
  })
  assert.deepEqual(limits, codexContract.BODY_STRUCTURE_LIMITS)
  assert.equal(Object.isFrozen(limits), true)
})

/** What the scan must report, computed from the text and its parsed value. */
function referenceStructure(text) {
  const stripped = text.replace(/"(?:[^"\\]|\\.)*"/gs, '""')
  let structuralBytes = 0
  let members = 0
  for (const ch of stripped) if (!' \t\n\r'.includes(ch)) structuralBytes += Buffer.byteLength(ch)
  for (const ch of stripped) if (ch === ':') members++
  let containers = 0
  let deepest = 0
  let elements = 0
  const stack = [[JSON.parse(text), 1]]
  while (stack.length > 0) {
    const [node, depth] = stack.pop()
    elements++
    if (node === null || typeof node !== 'object') continue
    containers++
    if (depth > deepest) deepest = depth
    for (const child of Object.values(node)) stack.push([child, depth + 1])
  }
  return { structuralBytes, containers, deepest, members, elements }
}

test('the body scan matches a reference walk, escapes and whitespace included', () => {
  const values = [
    { a: 'quote " and [brackets] {inside}', b: [1, 2.5, { c: '\\', d: '\\"' }], e: 'é → 😀' },
    [[], {}, [[{}]], '', true, null],
    { deep: nest(10, 'n'), s: '\\\\\\"[{', t: '\u0000\u001f' },
    'a lone string',
    42,
  ]
  const texts = values.flatMap(value => [JSON.stringify(value), JSON.stringify(value, null, 2)])
  // Witnesses: the corpus has escaped quotes, backslash runs and containers.
  assert.ok(texts.some(text => text.includes('\\"')))
  assert.ok(texts.some(text => text.includes('\\\\\\\\')))
  let containersSeen = 0
  for (const text of texts) {
    const reference = referenceStructure(text)
    containersSeen += reference.containers
    assert.deepEqual(
      contract.scanJsonStructure(Buffer.from(text, 'utf8'), contract.BODY_STRUCTURE_LIMITS),
      reference,
      text
    )
  }
  assert.ok(containersSeen > 20)
})

test('the body scan refuses nesting past the request depth plus the envelope level', () => {
  const limits = contract.BODY_STRUCTURE_LIMITS
  const nested = depth => Buffer.from('['.repeat(depth) + ']'.repeat(depth))
  assert.equal(contract.scanJsonStructure(nested(limits.maxDepth), limits).deepest, limits.maxDepth)
  assert.throws(() => contract.scanJsonStructure(nested(limits.maxDepth + 1), limits), {
    name: 'BodyStructureError',
    status: 400,
    type: 'body.structure.too.deep',
  })
  // The deepest request the contract accepts, inside a proxy envelope, fits.
  const deepest = {
    ...BASE,
    messages: [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'deep', arguments: nest(contract.LIMITS.maxNestingDepth, 'a') }],
      },
    ],
  }
  assert.equal(contract.parseGrokCompletionRequest(deepest).ok, true)
  const envelope = Buffer.from(JSON.stringify({ executionTicket: 't', requestHash: 'h', request: deepest }))
  assert.equal(contract.scanJsonStructure(envelope, limits).deepest, limits.maxDepth)
})

test('the body scan bounds structural bytes and never counts whitespace or string contents', () => {
  const limits = { ...contract.BODY_STRUCTURE_LIMITS, maxElements: Number.MAX_SAFE_INTEGER }
  // `[` + `0,` x n + `00]` holds 2n + 4 structural bytes.
  const count = (limits.maxStructuralBytes - 4) / 2
  const atBound = Buffer.from(`[${'0,'.repeat(count)}00]`)
  assert.equal(contract.scanJsonStructure(atBound, limits).structuralBytes, limits.maxStructuralBytes)
  const dense = { name: 'BodyStructureError', status: 413, type: 'body.structure.too.dense' }
  assert.throws(() => contract.scanJsonStructure(Buffer.from(`[${'0,'.repeat(count)}000]`), limits), dense)
  // The closing quote of a string is the byte that crosses the bound.
  const quoted = Buffer.from(`[${'0,'.repeat(count + 1)}"x"]`)
  assert.throws(() => contract.scanJsonStructure(quoted, limits), dense)
  const padded = Buffer.from(`[${' \n'.repeat(limits.maxStructuralBytes)}"${'A'.repeat(limits.maxStructuralBytes)}"]`)
  assert.equal(contract.scanJsonStructure(padded, limits).structuralBytes, 4)
})

test('the body scan bounds object members and never counts string contents', () => {
  const limits = contract.BODY_STRUCTURE_LIMITS
  const atBound = Buffer.from(
    `{${Array.from({ length: limits.maxMembers }, (_, i) => `"m${i}":0`).join(',')}}`
  )
  assert.equal(contract.scanJsonStructure(atBound, limits).members, limits.maxMembers)
  assert.throws(
    () =>
      contract.scanJsonStructure(
        Buffer.from(`{${Array.from({ length: limits.maxMembers + 1 }, (_, i) => `"m${i}":0`).join(',')}}`),
        limits
      ),
    {
      name: 'BodyStructureError',
      status: 413,
      type: 'body.structure.too.many.members',
    }
  )
  // A colon inside a string is content, not a member.
  const quoted = Buffer.from(`["${':'.repeat(10)}"]`)
  assert.equal(contract.scanJsonStructure(quoted, limits).members, 0)
})

test('the body scan counts values exactly and bounds elements before JSON.parse', () => {
  const limits = contract.BODY_STRUCTURE_LIMITS
  for (const [json, elements] of [
    ['{"a":0}', 2],
    ['[{},{}]', 3],
    ['[ 0 , "x,[{}]", {"a": [1, 2]} ]', 7],
    ['{"a\\\"[,": "\\\\,]"}', 2],
  ]) {
    assert.equal(contract.scanJsonStructure(Buffer.from(json), limits).elements, elements, json)
  }
  const at = Buffer.from(`[${'0,'.repeat(limits.maxElements - 2)}0]`)
  assert.equal(contract.scanJsonStructure(at, limits).elements, limits.maxElements)
  const over = Buffer.from(`[${'0,'.repeat(limits.maxElements - 1)}0]`)
  assert.throws(() => contract.scanJsonStructure(over, limits), {
    name: 'BodyStructureError',
    status: 413,
    type: 'body.structure.too.many.elements',
  })
})

test('the body scan admits every request the contract admits, at each bound', () => {
  const limits = contract.BODY_STRUCTURE_LIMITS
  // Containers: the request at maxRequestContainers, inside a proxy envelope.
  const request = requestWithContainers(contract.LIMITS.maxRequestContainers)
  const envelope = Buffer.from(JSON.stringify({ executionTicket: 't', requestHash: 'h', request }))
  assert.equal(contract.scanJsonStructure(envelope, limits).containers, contract.LIMITS.maxRequestContainers + 1)
  const atMax = Buffer.from(`[${'[],'.repeat(limits.maxContainers - 2)}[]]`)
  assert.equal(contract.scanJsonStructure(atMax, limits).containers, limits.maxContainers)
  const tooMany = Buffer.from(`[${'[],'.repeat(limits.maxContainers - 1)}[]]`)
  assert.throws(() => contract.scanJsonStructure(tooMany, limits), {
    name: 'BodyStructureError',
    status: 413,
    type: 'body.structure.too.many.containers',
  })
  // Structural bytes: a V2 body's structure is at most its non-image share.
  // measureNonImageCompletionBytes drops the ticket member, whose structure
  // is the six bytes `"":"",`.
  const v2 = v2WithParts([imagePart(IMAGE_DATA.png)], '')
  const completion = { executionTicket: 'ticket', requestHash: 'hash', request: v2 }
  const scanned = contract.scanJsonStructure(Buffer.from(JSON.stringify(completion)), limits)
  assert.ok(scanned.structuralBytes <= contract.measureNonImageCompletionBytes(completion) + '"":"",'.length)
})

test('the verify hook refuses a charset other than UTF-8 and scans UTF-8 bodies', () => {
  const verify = contract.createBodyStructureVerify(contract.BODY_STRUCTURE_LIMITS)
  const body = Buffer.from('{"a":[1]}')
  assert.throws(() => verify({}, {}, body, 'utf-16le'), {
    name: 'BodyStructureError',
    status: 415,
    type: 'charset.unsupported',
  })
  assert.equal(verify({}, {}, body, 'utf-8'), undefined)
  // Witness that the UTF-8 path scans: a body past the depth bound throws.
  const deep = Buffer.from('['.repeat(71) + ']'.repeat(71))
  assert.throws(() => verify({}, {}, deep, 'utf-8'), { status: 400, type: 'body.structure.too.deep' })
})

test('the verify hook fails closed unless every bound is a positive safe integer', () => {
  const good = contract.BODY_STRUCTURE_LIMITS
  for (const name of ['maxStructuralBytes', 'maxContainers', 'maxDepth', 'maxMembers', 'maxElements']) {
    for (const value of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => contract.createBodyStructureVerify({ ...good, [name]: value }), TypeError)
    }
  }
  // Liveness witness: the contract's own bounds construct the hook.
  assert.equal(typeof contract.createBodyStructureVerify(good), 'function')
})
