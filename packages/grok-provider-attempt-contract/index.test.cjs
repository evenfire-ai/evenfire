'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const contract = require('./index.cjs')

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
  // What makes the two guards separable here is ORDER, not size:
  // `checkStructure` runs before `JSON.stringify`, so the element count is
  // refused first. The payload below is also ~3x the byte cap once serialized
  // — by construction it has to be, since more elements than the byte cap
  // cannot encode under it — so without that ordering the byte bound would
  // claim it and this test would be pinning the wrong guard.
  const refused = contract.parseGrokCompletionRequestV1({
    ...BASE,
    messages: new Array(contract.LIMITS.maxRequestBodyBytes + 1).fill({}),
  })
  assert.deepEqual(refused, {
    ok: false,
    code: 'limit',
    message: 'request exceeds maxRequestBodyBytes element bound',
  })
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
