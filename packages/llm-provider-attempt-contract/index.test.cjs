'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const zlib = require('node:zlib')
const contract = require('./index.cjs')
const {
  declaredHeaderPng,
  declaredHeaderPngOfSize,
  jpegOfSize,
  realPng,
  realPngOfSize,
} = require('./testImageFixtures.cjs')

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/canonical-request-hashes.json'), 'utf8')
)

const FIXTURE_V2 = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/canonical-request-hashes.v2.json'), 'utf8')
)
const VISUAL_FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/visual-requests.json'), 'utf8')
)

const BASE = {
  schemaVersion: 'codex-completion-request.v1',
  requestId: 'req-001',
  idempotencyKey: 'idem-001',
  provider: 'codex-subscription',
  model: 'gpt-5.1',
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

test('parses the bounded V1 request and hashes with SHA-256', () => {
  const parsed = contract.parseCodexCompletionRequestV1(BASE)
  assert.equal(parsed.ok, true)
  const digest = contract.hashCodexCompletionRequestV1(parsed.value)
  assert.match(digest, /^[a-f0-9]{64}$/)
})

test('fixture corpus: valid cases match frozen hashes and equivalent reorderings', () => {
  for (const fixture of FIXTURE.cases) {
    const parsed = contract.parseCodexCompletionRequestV1(fixture.request)
    assert.equal(parsed.ok, true, fixture.name)
    const digest = contract.hashCodexCompletionRequestV1(parsed.value)
    assert.equal(digest, fixture.sha256, fixture.name)
    if (fixture.equivalentRequest) {
      const other = contract.parseCodexCompletionRequestV1(fixture.equivalentRequest)
      assert.equal(other.ok, true, `${fixture.name} equivalent`)
      assert.equal(
        contract.hashCodexCompletionRequestV1(other.value),
        digest,
        `${fixture.name} reorder`
      )
    }
    if (fixture.distinctRequest) {
      const other = contract.parseCodexCompletionRequestV1(fixture.distinctRequest)
      assert.equal(other.ok, true, `${fixture.name} distinct`)
      assert.notEqual(
        contract.hashCodexCompletionRequestV1(other.value),
        digest,
        `${fixture.name} array order`
      )
    }
  }
})

test('fixture corpus: rejected payloads fail closed', () => {
  for (const fixture of FIXTURE.rejects) {
    const parsed = contract.parseCodexCompletionRequestV1(fixture.request)
    assert.equal(parsed.ok, false, fixture.name)
    assert.equal(typeof parsed.code, 'string')
  }
})

test('rejects NaN and Infinity before hashing (stableStringify would coerce them to null)', () => {
  const nanParsed = contract.parseCodexCompletionRequestV1({
    ...BASE,
    generation: { temperature: Number.NaN },
  })
  assert.equal(nanParsed.ok, false)
  assert.match(nanParsed.code, /non-finite|invalid/)

  const infParsed = contract.parseCodexCompletionRequestV1({
    ...BASE,
    generation: { maxOutputTokens: Number.POSITIVE_INFINITY },
  })
  assert.equal(infParsed.ok, false)
  assert.match(infParsed.code, /non-finite|invalid/)
})

test('unknown fields, OAuth, account selector, URL/header/cookie/path and MCP/shell/browser are rejected', () => {
  const extras = [
    { headers: { Authorization: 'x' } },
    { authorization: 'Bearer x' },
    { accessToken: 'sk-x' },
    { refreshToken: 'rt-x' },
    { oauth: { code: 'x' } },
    { accountSelector: 'acct' },
    { accountId: 'acct' },
    { url: 'https://example.com' },
    { cookie: 'a=b' },
    { path: '/tmp' },
    { mcp: true },
    { shell: true },
    { browser: true },
  ]
  for (const extra of extras) {
    const parsed = contract.parseCodexCompletionRequestV1({ ...BASE, ...extra })
    assert.equal(parsed.ok, false, JSON.stringify(Object.keys(extra)))
  }
})

test('hash is SHA-256 of lexicographic stableStringify of the projection', () => {
  const parsed = contract.parseCodexCompletionRequestV1(BASE)
  assert.equal(parsed.ok, true)
  const expected = crypto
    .createHash('sha256')
    .update(contract.stableStringify(parsed.value))
    .digest('hex')
  assert.equal(contract.hashCodexCompletionRequestV1(parsed.value), expected)
})

test('computeCodexPolicyHash is SHA-256 of lexicographic stableStringify of the binding', () => {
  const binding = {
    catalogRevision: 4,
    connectionKey: 'deployment-default',
    credentialRevision: 3,
    model: 'gpt-5.1',
    provider: 'codex-subscription',
  }
  const expected = crypto
    .createHash('sha256')
    .update(contract.stableStringify(binding))
    .digest('hex')
  assert.equal(
    contract.computeCodexPolicyHash({
      model: 'gpt-5.1',
      catalogRevision: 4,
      credentialRevision: 3,
    }),
    expected
  )
  assert.equal(
    contract.computeCodexPolicyHash({
      credentialRevision: 3,
      catalogRevision: 4,
      model: 'gpt-5.1',
      connectionKey: 'deployment-default',
    }),
    expected
  )
  assert.notEqual(
    contract.computeCodexPolicyHash({
      model: 'gpt-5.6-luna',
      catalogRevision: 4,
      credentialRevision: 3,
    }),
    expected
  )
  assert.notEqual(
    contract.computeCodexPolicyHash({
      model: 'gpt-5.1',
      catalogRevision: 4,
      credentialRevision: 3,
      connectionKey: 'team-plus',
    }),
    expected
  )
})

test('stableStringify sorts object keys and drops undefined like control-api', () => {
  assert.equal(contract.stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(contract.stableStringify({ a: undefined, b: 1 }), '{"b":1}')
  assert.equal(contract.stableStringify([1, undefined, 2]), '[1,null,2]')
})

test('assistant toolCalls are hashed into the request and rejected on other roles', () => {
  const withTools = contract.parseCodexCompletionRequestV1({
    ...BASE,
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'echo', arguments: { x: 1 } }],
      },
      { role: 'tool', content: 'ok', toolCallId: 'call-1' },
    ],
  })
  assert.equal(withTools.ok, true)
  const digest = contract.hashCodexCompletionRequestV1(withTools.value)
  const without = contract.parseCodexCompletionRequestV1({
    ...BASE,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: 'ok', toolCallId: 'call-1' },
    ],
  })
  assert.equal(without.ok, true)
  assert.notEqual(contract.hashCodexCompletionRequestV1(without.value), digest)

  const onUser = contract.parseCodexCompletionRequestV1({
    ...BASE,
    messages: [
      {
        role: 'user',
        content: 'hi',
        toolCalls: [{ id: 'call-1', name: 'echo', arguments: {} }],
      },
    ],
  })
  assert.equal(onUser.ok, false)
})

test('ticket and receipt types stay credential-free at the contract boundary', () => {
  const claims = {
    jti: 'jti-1',
    typ: 'codex-execution-ticket',
    sub: 'host-a',
    hostRef: 'host-a',
    invocationId: 'inv-1',
    attemptGeneration: 1,
    providerAttemptId: 'att-1',
    providerAttemptIndex: 0,
    provider: 'codex-subscription',
    model: 'gpt-5.1',
    requestHash: 'a'.repeat(64),
    policyRevision: 1,
    policyHash: 'b'.repeat(64),
    budgetReservationId: 'bud-1',
    connectionRevision: 1,
  }
  const parsed = contract.parseCodexExecutionTicketClaims(claims)
  assert.equal(parsed.ok, true)
  assert.equal('accessToken' in parsed.value, false)

  const receipt = contract.parseCodexAttemptReceiptV1({
    schemaVersion: 'codex-attempt-receipt.v1',
    providerAttemptId: 'att-1',
    requestHash: 'a'.repeat(64),
    outcome: 'success',
    usage: { inputTokens: 3, outputTokens: 5 },
  })
  assert.equal(receipt.ok, true)
  assert.equal('accessToken' in receipt.value, false)
})

test('authorize response is metadata-only; redeem type is documented but not parsed here', () => {
  const authorize = contract.parseAuthorizeAttemptResponse({
    providerAttemptId: 'att-1',
    requestHash: 'a'.repeat(64),
    executionTicket: 'jwt.ticket',
    expiresAt: '2026-08-20T10:00:00.000Z',
  })
  assert.equal(authorize.ok, true)
  assert.equal('accessToken' in authorize.value, false)
  assert.equal('accountId' in authorize.value, false)
  assert.equal(typeof contract.RedeemAttemptResponseSensitive, 'undefined')
})

function catalog(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `eventasks__read_${index}`,
    description: 'Read an approved development record',
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
  }))
}

for (const count of [1, 32, 33, 83, 150, 250]) {
  test(`preserves every definition in a ${count}-tool approved catalog`, () => {
    const tools = catalog(count)
    const parsed = contract.parseCodexCompletionRequestV1({ ...BASE, tools })
    assert.equal(parsed.ok, true, parsed.message)
    assert.deepEqual(parsed.value.tools, tools)
    const reordered = tools.map(({ name, description, parameters }) => ({
      parameters,
      description,
      name,
    }))
    const equivalent = contract.parseCodexCompletionRequestV1({ ...BASE, tools: reordered })
    assert.equal(equivalent.ok, true)
    assert.equal(
      contract.hashCodexCompletionRequestV1(parsed.value),
      contract.hashCodexCompletionRequestV1(equivalent.value)
    )
    const changed = contract.parseCodexCompletionRequestV1({
      ...BASE,
      tools: [...tools.slice(0, -1), { ...tools.at(-1), description: 'Changed capability' }],
    })
    assert.equal(changed.ok, true)
    assert.notEqual(
      contract.hashCodexCompletionRequestV1(parsed.value),
      contract.hashCodexCompletionRequestV1(changed.value)
    )
  })
}

test('tool definition count never widens the independent assistant call limit', () => {
  assert.equal(contract.LIMITS.maxToolCalls, 32)
  assert.equal(Object.hasOwn(contract.LIMITS, 'maxTools'), false)
  for (const count of [32, 33]) {
    const parsed = contract.parseCodexCompletionRequestV1({
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
    assert.equal(parsed.ok, count === 32)
    if (!parsed.ok) assert.equal(parsed.message, 'messages[0].toolCalls exceed 32')
  }
})

test('large catalogs remain bounded by serialized request bytes including UTF-8', () => {
  const request = { ...BASE, tools: catalog(250) }
  const originalBytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
  request.tools[249].description += 'x'.repeat(contract.LIMITS.maxRequestBodyBytes - originalBytes)
  assert.equal(
    Buffer.byteLength(JSON.stringify(request), 'utf8'),
    contract.LIMITS.maxRequestBodyBytes
  )
  assert.equal(contract.parseCodexCompletionRequestV1(request).ok, true)
  request.tools[249].description += 'é'
  assert.deepEqual(contract.parseCodexCompletionRequestV1(request), {
    ok: false,
    code: 'limit',
    message: 'request exceeds maxRequestBodyBytes',
  })
})

test('validates the last definition beyond the former count boundary', () => {
  for (const invalid of [
    { name: 'invalid\u0000name' },
    { parameters: { value: Infinity } },
    { headers: {} },
  ]) {
    const tools = catalog(250)
    tools[249] = { ...tools[249], ...invalid }
    const parsed = contract.parseCodexCompletionRequestV1({ ...BASE, tools })
    assert.equal(parsed.ok, false)
    assert.match(parsed.message, /tools\[249\]/)
  }
})

function withCanonicalName(name) {
  return {
    ...BASE,
    tools: [{ name, description: 'Read a record', parameters: { type: 'object' } }],
    messages: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name, arguments: {} }] },
      { role: 'tool', content: 'ok', toolCallId: 'call-1', name },
    ],
  }
}

test('preserves opaque canonical names in definitions and assistant/tool history', () => {
  for (const name of ['read record', '工具@café', 'x'.repeat(129)]) {
    const request = withCanonicalName(name)
    const parsed = contract.parseCodexCompletionRequestV1(request)
    assert.equal(parsed.ok, true, parsed.message)
    assert.deepEqual(parsed.value, request)
    assert.equal(
      contract.hashCodexCompletionRequestV1(parsed.value),
      crypto.createHash('sha256').update(contract.stableStringify(request)).digest('hex')
    )
  }
})

test('rejects empty and control-bearing names at every canonical name location', () => {
  for (const name of ['', 'a\u0000b', 'a\nb', 'a\u007fb', 'a\u0085b', 'a\ud800b']) {
    for (const location of ['definition', 'assistant', 'result']) {
      const request = withCanonicalName('valid')
      if (location === 'definition') request.tools[0].name = name
      if (location === 'assistant') request.messages[0].toolCalls[0].name = name
      if (location === 'result') request.messages[1].name = name
      assert.equal(contract.parseCodexCompletionRequestV1(request).ok, false, location)
    }
  }
})

test('opaque tool name support retains strict request and call identifiers', () => {
  for (const value of ['read record', '工具@café', 'x'.repeat(129)]) {
    for (const location of ['requestId', 'idempotencyKey', 'callId', 'toolCallId']) {
      const request = withCanonicalName(value)
      if (location === 'callId') request.messages[0].toolCalls[0].id = value
      else if (location === 'toolCallId') request.messages[1].toolCallId = value
      else request[location] = value
      assert.equal(contract.parseCodexCompletionRequestV1(request).ok, false, location)
    }
  }
})

test('opaque canonical names remain bounded by serialized UTF-8 request bytes', () => {
  const request = {
    ...BASE,
    tools: [{ name: '工具', description: 'Read a record', parameters: {} }],
  }
  request.tools[0].name += 'x'.repeat(
    contract.LIMITS.maxRequestBodyBytes - Buffer.byteLength(JSON.stringify(request))
  )
  assert.equal(contract.parseCodexCompletionRequestV1(request).ok, true)
  request.tools[0].name += 'é'
  assert.deepEqual(contract.parseCodexCompletionRequestV1(request), {
    ok: false,
    code: 'limit',
    message: 'request exceeds maxRequestBodyBytes',
  })
})

// --- V2 (codex-completion-request.v2) -------------------------------------

const V2_REQUEST_KEYS = { schemaVersion: contract.SCHEMA_VERSION_V2 }
const IMAGE_DATA = {
  png: VISUAL_FIXTURE.png.messages[0].contentParts.find(part => part.type === 'image').data,
  jpeg: VISUAL_FIXTURE.jpeg.messages[0].contentParts.find(part => part.type === 'image').data,
}
const MAX_ENCODED_IMAGE_CHARS = 4 * Math.ceil(contract.VISUAL_LIMITS.maxImageBytes / 3)

/**
 * Fixture image parts carry `dataRef` (resolved from visual-requests.json) so
 * the frozen hash corpus stays readable, and `mutate` for documented
 * truncations. Resolution returns a deep copy: a loaded fixture is never
 * mutated in place.
 */
function resolveFixtureImages(value) {
  if (Array.isArray(value)) return value.map(resolveFixtureImages)
  if (value && typeof value === 'object') {
    if (typeof value.dataRef === 'string') {
      const source = IMAGE_DATA[value.dataRef]
      assert.ok(source, `unknown image ref ${value.dataRef}`)
      const bytes = Buffer.from(source, 'base64')
      let data = source
      if (value.mutate === 'strip-eoi')
        data = bytes.subarray(0, bytes.length - 2).toString('base64')
      else if (value.mutate === 'truncate-after-ihdr')
        data = bytes.subarray(0, 33).toString('base64')
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

function pngChunks(bytes) {
  const chunks = []
  let pos = 8
  while (pos < bytes.length) {
    const length = bytes.readUInt32BE(pos)
    chunks.push({
      type: bytes.toString('latin1', pos + 4, pos + 8),
      data: bytes.subarray(pos + 8, pos + 8 + length),
      crc: bytes.readUInt32BE(pos + 8 + length),
      crcInput: bytes.subarray(pos + 4, pos + 8 + length),
    })
    pos += 12 + length
  }
  return chunks
}

const MIB = 1024 * 1024
// The per-image ceiling this suite replaced. Kept as a literal so the tests
// prove the raise rather than restating the current constant.
const FORMER_IMAGE_CEILING = 524288

function imagePart(data, mimeType = 'image/png') {
  return {
    type: 'image',
    mimeType,
    data,
    source: { kind: 'tool', attachmentId: 'att_1700000000001_ff00aa11', toolCallId: 'call_abc123' },
  }
}

function v2WithMessages(messages) {
  return { ...BASE, ...V2_REQUEST_KEYS, messages }
}

function v2WithParts(parts, content = '') {
  return v2WithMessages([{ role: 'user', content, contentParts: parts }])
}

function v2TextRequest(content) {
  return v2WithMessages([{ role: 'user', content }])
}

test('v2 fixture corpus: valid cases match frozen digests and distinct payloads differ', () => {
  for (const fixture of FIXTURE_V2.cases) {
    const request = resolveFixtureImages(fixture.request)
    const parsed = contract.parseCodexCompletionRequest(request)
    assert.equal(parsed.ok, true, fixture.name)
    const direct = contract.parseCodexCompletionRequestV2(request)
    assert.equal(direct.ok, true, fixture.name)
    assert.deepEqual(parsed, direct, `${fixture.name} dispatcher parity`)
    const digest = contract.hashCodexCompletionRequest(parsed.value)
    assert.equal(digest, fixture.sha256, fixture.name)
    assert.equal(
      contract.hashCodexCompletionRequest(direct.value),
      digest,
      `${fixture.name} hash parity`
    )
    if (fixture.distinctRequest) {
      const other = contract.parseCodexCompletionRequest(
        resolveFixtureImages(fixture.distinctRequest)
      )
      assert.equal(other.ok, true, `${fixture.name} distinct`)
      assert.notEqual(contract.hashCodexCompletionRequest(other.value), digest, fixture.name)
    }
  }
})

test('v2 fixture corpus: rejected payloads fail closed with the frozen code and message', () => {
  for (const fixture of FIXTURE_V2.rejects) {
    const parsed = contract.parseCodexCompletionRequest(resolveFixtureImages(fixture.request))
    assert.equal(parsed.ok, false, fixture.name)
    assert.equal(parsed.code, fixture.reason, fixture.name)
    assert.equal(parsed.message, fixture.message, fixture.name)
  }
})

test('v2 visual fixtures: inline png/jpeg requests parse and pin the exact octets', () => {
  for (const key of ['png', 'jpeg', 'pngImageOnly']) {
    const request = VISUAL_FIXTURE[key]
    assert.equal(request.schemaVersion, contract.SCHEMA_VERSION_V2, key)
    const imageParts = request.messages[0].contentParts.filter(part => part.type === 'image')
    assert.equal(imageParts.length, 1, key)
    const bytes = Buffer.from(imageParts[0].data, 'base64')
    const pinned = VISUAL_FIXTURE.imageSha256[imageParts[0].mimeType.replace('image/', '')]
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), pinned, key)
    const parsed = contract.parseCodexCompletionRequest(request)
    assert.equal(parsed.ok, true, `${key}: ${parsed.message}`)
    assert.deepEqual(
      parsed.value.messages[0].contentParts,
      request.messages[0].contentParts,
      `${key} projection`
    )
  }

  const png = Buffer.from(IMAGE_DATA.png, 'base64')
  assert.deepEqual(
    [png.readUInt32BE(16), png.readUInt32BE(20)],
    [VISUAL_FIXTURE.expectedDimensions.png.width, VISUAL_FIXTURE.expectedDimensions.png.height]
  )
  const jpeg = Buffer.from(IMAGE_DATA.jpeg, 'base64')
  assert.deepEqual([jpeg[0], jpeg[1]], [0xff, 0xd8])
  assert.deepEqual([jpeg[jpeg.length - 2], jpeg[jpeg.length - 1]], [0xff, 0xd9])
  assert.ok(jpeg.includes(Buffer.from([0xff, 0xda])), 'jpeg carries a start-of-scan segment')
})

test('v2 fixture png is a real image: real CRCs and an inflatable scanline stream', () => {
  const bytes = Buffer.from(IMAGE_DATA.png, 'base64')
  const chunks = pngChunks(bytes)
  assert.deepEqual(
    chunks.map(chunk => chunk.type),
    ['IHDR', 'IDAT', 'IEND']
  )
  for (const chunk of chunks) {
    assert.equal(chunk.crc, zlib.crc32(chunk.crcInput) >>> 0, chunk.type)
  }
  const { width, height } = VISUAL_FIXTURE.expectedDimensions.png
  const raw = zlib.inflateSync(chunks[1].data)
  assert.equal(raw.length, height * (1 + width * 3))
  for (let row = 0; row < height; row++) {
    assert.equal(raw[row * (1 + width * 3)], 0, `scanline ${row} filter byte`)
  }
})

test('dispatcher: v1 rejects contentParts, unknown versions fail closed, one hash serves both', () => {
  const v1WithParts = { ...VISUAL_FIXTURE.png, schemaVersion: contract.SCHEMA_VERSION }
  const rejected = contract.parseCodexCompletionRequestV1(v1WithParts)
  assert.equal(rejected.ok, false)
  assert.equal(rejected.code, 'unknown-field')
  assert.match(rejected.message, /contentParts/)
  assert.equal(contract.parseCodexCompletionRequest(v1WithParts).ok, false)

  for (const schemaVersion of ['codex-completion-request.v3', undefined, null, 2]) {
    const parsed = contract.parseCodexCompletionRequest({ ...BASE, schemaVersion })
    assert.equal(parsed.ok, false, String(schemaVersion))
    assert.equal(parsed.code, 'invalid', String(schemaVersion))
  }
  assert.equal(contract.parseCodexCompletionRequest('not an object').ok, false)

  const v1 = contract.parseCodexCompletionRequest(BASE)
  const v2 = contract.parseCodexCompletionRequest(v2TextRequest('hello'))
  assert.equal(v1.ok, true)
  assert.equal(v2.ok, true)
  assert.equal(
    contract.hashCodexCompletionRequest(v1.value),
    contract.hashCodexCompletionRequestV1(v1.value)
  )
  const withoutVersion = ({ schemaVersion, ...rest }) => rest
  assert.deepEqual(
    withoutVersion(v2.value),
    withoutVersion(v1.value),
    'text-only v2 keeps v1 semantics'
  )
  assert.notEqual(
    contract.hashCodexCompletionRequest(v2.value),
    contract.hashCodexCompletionRequest(v1.value)
  )
})

test('dispatcher: v2 keeps every v1 root check instead of bypassing it', () => {
  for (const fixture of FIXTURE.rejects) {
    const asV1 = contract.parseCodexCompletionRequest(fixture.request)
    const asV2 = contract.parseCodexCompletionRequest({
      ...fixture.request,
      schemaVersion: contract.SCHEMA_VERSION_V2,
    })
    assert.equal(asV1.ok, false, fixture.name)
    assert.equal(asV2.ok, false, `${fixture.name} v2`)
    assert.equal(asV2.code, asV1.code, `${fixture.name} code`)
  }

  const roots = [
    { name: 'requestId', patch: { requestId: 'bad id' } },
    { name: 'idempotencyKey', patch: { idempotencyKey: 'é' } },
    { name: 'provider', patch: { provider: 'openai-api' } },
    { name: 'model', patch: { model: 'bad model' } },
    { name: 'deadline-low', patch: { deadlineMs: 0 }, code: 'limit' },
    {
      name: 'deadline-high',
      patch: { deadlineMs: contract.LIMITS.maxDeadlineMs + 1 },
      code: 'limit',
    },
    { name: 'deadline-fraction', patch: { deadlineMs: 1.5 }, code: 'non-finite' },
    {
      name: 'deadline-nonfinite',
      patch: { deadlineMs: Number.POSITIVE_INFINITY },
      code: 'non-finite',
    },
    { name: 'generation-unknown', patch: { generation: { topK: 5 } } },
    { name: 'generation-temperature', patch: { generation: { temperature: 3 } } },
    { name: 'transport-hints-unknown', patch: { transportHints: { cacheKey: 'x' } } },
    { name: 'messages-empty', patch: { messages: [] } },
    { name: 'message-role', patch: { messages: [{ role: 'human', content: 'x' }] } },
    { name: 'message-content-type', patch: { messages: [{ role: 'user', content: 5 }] } },
    {
      name: 'message-tool-calls-on-user',
      patch: {
        messages: [
          { role: 'user', content: 'x', toolCalls: [{ id: 'a', name: 'b', arguments: {} }] },
        ],
      },
    },
    { name: 'tool-description', patch: { tools: [{ name: 'a', description: 1, parameters: {} }] } },
    {
      name: 'tool-name-control',
      patch: { tools: [{ name: 'a\u0000b', description: 'x', parameters: {} }] },
    },
    {
      name: 'text-part-text-type',
      patch: {
        messages: [{ role: 'user', content: 'x', contentParts: [{ type: 'text', text: 5 }] }],
      },
    },
  ]
  for (const entry of roots) {
    const parsed = contract.parseCodexCompletionRequest({
      ...BASE,
      ...V2_REQUEST_KEYS,
      ...entry.patch,
    })
    assert.equal(parsed.ok, false, entry.name)
    if (entry.code) assert.equal(parsed.code, entry.code, entry.name)
  }
})

test('v2 projection preserves part order, source identity and the text projection verbatim', () => {
  const multi = resolveFixtureImages(
    FIXTURE_V2.cases.find(item => item.name === 'multi-image-order-significant').request
  )
  const parsed = contract.parseCodexCompletionRequest(multi)
  assert.equal(parsed.ok, true)
  assert.equal(Object.isFrozen(parsed.value), true)
  assert.deepEqual(parsed.value.messages[0].contentParts, multi.messages[0].contentParts)
  assert.deepEqual(
    parsed.value.messages[0].contentParts.map(part => part.type),
    ['text', 'image', 'image']
  )

  const compacted = resolveFixtureImages(
    FIXTURE_V2.cases.find(item => item.name === 'text-only-parts-after-compaction').request
  )
  const parsedCompacted = contract.parseCodexCompletionRequest(compacted)
  assert.equal(parsedCompacted.ok, true)
  const parts = parsedCompacted.value.messages[0].contentParts
  assert.ok(
    parts.every(part => part.type === 'text'),
    'text-only parts survive without an image'
  )
  assert.equal(parsedCompacted.value.messages[0].content, parts.map(part => part.text).join('\n'))

  const imageOnly = contract.parseCodexCompletionRequest(VISUAL_FIXTURE.pngImageOnly)
  assert.equal(imageOnly.ok, true)
  assert.equal(imageOnly.value.messages[0].content, '', 'an image-only message has empty text')
})

test('v2 limits: image count, encoder bound, per-image bytes, total bytes, dimensions and pixels', () => {
  const png = IMAGE_DATA.png
  const three = [imagePart(png), imagePart(png), imagePart(png)]
  assert.equal(
    contract.parseCodexCompletionRequest(v2WithParts(three)).ok,
    true,
    'three images fit'
  )
  const four = contract.parseCodexCompletionRequest(v2WithParts([...three, imagePart(png)]))
  assert.equal(four.ok, false)
  assert.equal(four.code, 'limit')
  assert.match(four.message, /3 images/)

  const encoded = contract.parseCodexCompletionRequest(
    v2WithParts([imagePart('A'.repeat(MAX_ENCODED_IMAGE_CHARS + 4))])
  )
  assert.equal(encoded.code, 'limit', 'encoded length is bounded before decoding')
  const decoded = contract.parseCodexCompletionRequest(
    v2WithParts([
      imagePart(Buffer.alloc(contract.VISUAL_LIMITS.maxImageBytes + 1).toString('base64')),
    ])
  )
  assert.equal(decoded.code, 'limit')

  // Above the ceiling this suite replaced, in both accepted containers.
  const pngOverFormerCeiling = declaredHeaderPngOfSize(FORMER_IMAGE_CEILING + 1)
  assert.equal(pngOverFormerCeiling.length, FORMER_IMAGE_CEILING + 1)
  const acceptedPng = contract.parseCodexCompletionRequest(
    v2WithParts([imagePart(pngOverFormerCeiling.toString('base64'))])
  )
  assert.equal(acceptedPng.ok, true, acceptedPng.message)
  const acceptedJpeg = contract.parseCodexCompletionRequest(
    v2WithParts([imagePart(jpegOfSize(FORMER_IMAGE_CEILING + 1).toString('base64'), 'image/jpeg')])
  )
  assert.equal(acceptedJpeg.ok, true, acceptedJpeg.message)
  const acceptedFiveMiBJpeg = contract.parseCodexCompletionRequest(
    v2WithParts([imagePart(jpegOfSize(5 * MIB).toString('base64'), 'image/jpeg')])
  )
  assert.equal(acceptedFiveMiBJpeg.ok, true, acceptedFiveMiBJpeg.message)

  // 3 MiB, and exactly the per-image ceiling, are inside the budget.
  const acceptedThreeMiB = contract.parseCodexCompletionRequest(
    v2WithParts([imagePart(declaredHeaderPngOfSize(3 * MIB).toString('base64'))])
  )
  assert.equal(acceptedThreeMiB.ok, true, acceptedThreeMiB.message)
  const acceptedCeiling = contract.parseCodexCompletionRequest(
    v2WithParts([
      imagePart(declaredHeaderPngOfSize(contract.VISUAL_LIMITS.maxImageBytes).toString('base64')),
    ])
  )
  assert.equal(acceptedCeiling.ok, true, acceptedCeiling.message)

  // One byte over the per-image ceiling, as a container that is otherwise valid.
  const overCeiling = contract.parseCodexCompletionRequest(
    v2WithParts([
      imagePart(
        declaredHeaderPngOfSize(contract.VISUAL_LIMITS.maxImageBytes + 1).toString('base64')
      ),
    ])
  )
  assert.equal(overCeiling.ok, false)
  assert.equal(overCeiling.code, 'limit')
  assert.match(overCeiling.message, /image exceeds/)
  assert.match(overCeiling.message, new RegExp(String(contract.VISUAL_LIMITS.maxImageBytes)))

  // A larger individual image does not increase the aggregate resource budget.
  const tenMiB = declaredHeaderPngOfSize(10 * MIB).toString('base64')
  const fiveMiB = declaredHeaderPngOfSize(5 * MIB).toString('base64')
  const combined = contract.parseCodexCompletionRequest(
    v2WithParts([imagePart(tenMiB), imagePart(fiveMiB)])
  )
  assert.equal(combined.ok, true, combined.message)
  const combinedWithJpeg = contract.parseCodexCompletionRequest(
    v2WithParts([imagePart(tenMiB), imagePart(jpegOfSize(5 * MIB).toString('base64'), 'image/jpeg')])
  )
  assert.equal(combinedWithJpeg.ok, true, combinedWithJpeg.message)
  const overAggregate = contract.parseCodexCompletionRequest(
    v2WithParts([
      imagePart(tenMiB),
      imagePart(declaredHeaderPngOfSize(5 * MIB + 1).toString('base64')),
    ])
  )
  assert.equal(overAggregate.ok, false)
  assert.equal(overAggregate.code, 'limit')
  assert.match(overAggregate.message, /total image bytes/)

  const atDimension = contract.parseCodexCompletionRequest(
    v2WithParts([
      imagePart(realPng(contract.VISUAL_LIMITS.maxImageDimension, 1, 9).toString('base64')),
    ])
  )
  assert.equal(atDimension.ok, true, atDimension.message)
  const overDimension = contract.parseCodexCompletionRequest(
    v2WithParts([
      imagePart(realPng(contract.VISUAL_LIMITS.maxImageDimension + 1, 1, 11).toString('base64')),
    ])
  )
  assert.equal(overDimension.code, 'limit')
  assert.match(overDimension.message, /dimension/)

  // A 48 MP phone capture (8064x6048) is the payload the raise exists for.
  const phonePixels = 8064 * 6048
  assert.ok(phonePixels < contract.VISUAL_LIMITS.maxImagePixels)
  const atPhoneShape = contract.parseCodexCompletionRequest(
    v2WithParts([imagePart(declaredHeaderPng(8064, 6048).toString('base64'))])
  )
  assert.equal(atPhoneShape.ok, true, atPhoneShape.message)

  // Exactly the pixel ceiling, then one row over it.
  const pixelsAtLimit = 8000
  assert.equal(pixelsAtLimit * pixelsAtLimit, contract.VISUAL_LIMITS.maxImagePixels)
  const atPixels = contract.parseCodexCompletionRequest(
    v2WithParts([imagePart(declaredHeaderPng(pixelsAtLimit, pixelsAtLimit).toString('base64'))])
  )
  assert.equal(atPixels.ok, true, atPixels.message)
  const overPixels = contract.parseCodexCompletionRequest(
    v2WithParts([imagePart(declaredHeaderPng(pixelsAtLimit, pixelsAtLimit + 1).toString('base64'))])
  )
  assert.equal(overPixels.code, 'limit')
  assert.match(overPixels.message, /pixel count/)

  // Both dimensions inside the dimension ceiling, product over the pixel
  // ceiling: isolates the pixel rule from the dimension rule.
  const squareOverPixels = contract.parseCodexCompletionRequest(
    v2WithParts([
      imagePart(
        declaredHeaderPng(
          contract.VISUAL_LIMITS.maxImageDimension,
          contract.VISUAL_LIMITS.maxImageDimension
        ).toString('base64')
      ),
    ])
  )
  assert.equal(squareOverPixels.code, 'limit')
  assert.match(squareOverPixels.message, /pixel count/)

  const wrongMime = contract.parseCodexCompletionRequest(
    v2WithParts([imagePart(png, 'image/jpeg')])
  )
  assert.equal(wrongMime.ok, false, 'mime and container signature must agree')
  const jpegAsPng = contract.parseCodexCompletionRequest(
    v2WithParts([imagePart(IMAGE_DATA.jpeg, 'image/png')])
  )
  assert.equal(jpegAsPng.ok, false)
})

test('v2 visual budgets are request-scoped across messages: three 5 MiB images fit, four do not', () => {
  const png = IMAGE_DATA.png
  const userWithImages = count => ({
    role: 'user',
    content: '',
    contentParts: Array.from({ length: count }, () => imagePart(png)),
  })

  // 2 + 2 images: every message is inside maxImages on its own, the request is not.
  const twoEach = contract.parseCodexCompletionRequest(
    v2WithMessages([userWithImages(2), userWithImages(2)])
  )
  assert.equal(twoEach.ok, false)
  assert.equal(twoEach.code, 'limit')
  assert.match(twoEach.message, /3 images/)

  // Boundary: exactly maxImages spread over three messages is accepted.
  const oneEach = contract.parseCodexCompletionRequest(
    v2WithMessages([userWithImages(1), userWithImages(1), userWithImages(1)])
  )
  assert.equal(oneEach.ok, true, oneEach.message)

  // Three 5 MiB images across messages fill the unchanged aggregate budget.
  const atCeiling = declaredHeaderPngOfSize(5 * MIB).toString('base64')
  const messageWith = encoded => ({
    role: 'user',
    content: '',
    contentParts: [imagePart(encoded)],
  })
  const oneEachAtCeiling = contract.parseCodexCompletionRequest(
    v2WithMessages([messageWith(atCeiling), messageWith(atCeiling), messageWith(atCeiling)])
  )
  assert.equal(oneEachAtCeiling.ok, true, oneEachAtCeiling.message)
  // Three ceiling images are the exact aggregate boundary, and the encoded body
  // is larger than the V1 ceiling — this is the request that needs the V2 budget.
  const ceilingBody = Buffer.byteLength(
    JSON.stringify(
      v2WithMessages([messageWith(atCeiling), messageWith(atCeiling), messageWith(atCeiling)])
    ),
    'utf8'
  )
  assert.ok(ceilingBody > contract.LIMITS.maxRequestBodyBytes)
  assert.ok(ceilingBody <= contract.LIMITS.maxVisualRequestBodyBytes)

  // A fourth ceiling image is refused before the count gate is reached: four
  // 5 MiB payloads encode to more than the 24 MiB body ceiling. The count rule
  // is exercised with small images above; this asserts which gate fires first
  // for maximum-size payloads.
  const fourMessages = contract.parseCodexCompletionRequest(
    v2WithMessages([
      messageWith(atCeiling),
      messageWith(atCeiling),
      messageWith(atCeiling),
      messageWith(atCeiling),
    ])
  )
  assert.equal(fourMessages.ok, false)
  assert.equal(fourMessages.code, 'limit')
  assert.equal(fourMessages.message, 'request exceeds maxVisualRequestBodyBytes')
})

/**
 * The request with every image payload replaced by an empty string — the
 * non-image share the V2 budget is defined on. Used to find an exact boundary;
 * the assertions below always check the contract's verdict, not this helper.
 */
function nonImageBytes(request) {
  return Buffer.byteLength(
    JSON.stringify({
      ...request,
      messages: request.messages.map(message =>
        Array.isArray(message.contentParts)
          ? {
              ...message,
              contentParts: message.contentParts.map(part =>
                part.type === 'image' ? { ...part, data: '' } : part
              ),
            }
          : message
      ),
    }),
    'utf8'
  )
}

test('requestBodyLimitBytes: V2 declares 24 MiB; every other body keeps the 1 MiB ceiling', () => {
  assert.equal(contract.LIMITS.maxRequestBodyBytes, 1048576)
  assert.equal(contract.LIMITS.maxVisualRequestBodyBytes, 25165824)
  assert.equal(contract.VISUAL_LIMITS.maxImages, 3)
  assert.equal(contract.VISUAL_LIMITS.maxImageBytes, 10485760)
  assert.equal(contract.VISUAL_LIMITS.maxTotalImageBytes, 15728640)
  assert.equal(contract.VISUAL_LIMITS.maxImageDimension, 8192)
  assert.equal(contract.VISUAL_LIMITS.maxImagePixels, 64000000)

  for (const v2 of [VISUAL_FIXTURE.png, VISUAL_FIXTURE.jpeg, VISUAL_FIXTURE.pngImageOnly]) {
    assert.equal(v2.schemaVersion, contract.SCHEMA_VERSION_V2)
    assert.equal(contract.requestBodyLimitBytes(v2), 25165824)
  }
  // A declaration is not a payload: unknown, missing and non-object bodies keep
  // the smaller ceiling so a caller cannot ask for the larger budget it has not
  // satisfied.
  for (const other of [
    BASE,
    { ...BASE, schemaVersion: 'codex-completion-request.v3' },
    { ...BASE, schemaVersion: undefined },
    {},
    null,
    undefined,
    'x',
    7,
    [],
  ]) {
    assert.equal(contract.requestBodyLimitBytes(other), 1048576, String(other))
  }
})

test('v2 preserves the non-image budget: text and tools stay on the 1 MiB ceiling', () => {
  const { maxRequestBodyBytes, maxVisualRequestBodyBytes } = contract.LIMITS
  const image = imagePart(IMAGE_DATA.png)
  const overflow = 'request exceeds maxRequestBodyBytes outside image data'
  const longText = 'x'.repeat(2 * MIB)

  // Images do not buy text: 2 MiB of content-class payload is refused far below
  // the 24 MiB ceiling the same body is allowed to use for image data.
  const textHeavy = contract.parseCodexCompletionRequest(
    v2WithParts([image, { type: 'text', text: longText }], longText)
  )
  assert.equal(textHeavy.ok, false)
  assert.equal(textHeavy.code, 'limit')
  assert.equal(textHeavy.message, overflow)

  // A text-only V2 body is not a 24 MiB allowance either.
  assert.deepEqual(contract.parseCodexCompletionRequest(v2TextRequest(longText)), {
    ok: false,
    code: 'limit',
    message: overflow,
  })

  // Tool definitions are on the same caller-controlled budget.
  const toolHeavy = contract.parseCodexCompletionRequest({
    ...v2WithParts([image]),
    tools: [{ name: 'read', description: 'y'.repeat(2 * MIB), parameters: {} }],
  })
  assert.equal(toolHeavy.ok, false)
  assert.equal(toolHeavy.code, 'limit')
  assert.equal(toolHeavy.message, overflow)

  // Exact boundary. The image is blanked out of the measurement, so the largest
  // accepted text still leaves the body far under the V2 ceiling, and one byte
  // more is refused by the non-image rule.
  const withImageAndText = length =>
    v2WithParts([image, { type: 'text', text: 'z'.repeat(length) }], 'z'.repeat(length))
  const base = nonImageBytes(withImageAndText(0))
  const growth = (nonImageBytes(withImageAndText(10)) - base) / 10
  assert.equal(growth, 2, 'content and its text part both carry the payload')
  const exactLength = Math.floor((maxRequestBodyBytes - base) / growth)
  const boundary = nonImageBytes(withImageAndText(exactLength))
  assert.ok(
    boundary <= maxRequestBodyBytes && boundary > maxRequestBodyBytes - growth,
    `non-image boundary landed at ${boundary}`
  )
  const bodyAtBoundary = Buffer.byteLength(JSON.stringify(withImageAndText(exactLength)), 'utf8')
  assert.ok(
    bodyAtBoundary < maxVisualRequestBodyBytes,
    'the non-image boundary is decided well below the V2 ceiling'
  )
  const atLimit = contract.parseCodexCompletionRequest(withImageAndText(exactLength))
  assert.equal(atLimit.ok, true, atLimit.message)
  const overLimit = contract.parseCodexCompletionRequest(withImageAndText(exactLength + 1))
  assert.equal(overLimit.ok, false)
  assert.equal(overLimit.code, 'limit')
  assert.equal(overLimit.message, overflow)
  assert.ok(
    nonImageBytes(withImageAndText(exactLength + 1)) > maxRequestBodyBytes,
    'the rejection is the non-image budget, not another gate'
  )
})

test('v2 total budget: the raw body is capped at 24 MiB and the three budgets stay consistent', () => {
  const { maxVisualRequestBodyBytes, maxRequestBodyBytes } = contract.LIMITS
  // The V2 ceiling must cover the largest legal image set (3 x 5 MiB decoded, so
  // ~21 MiB of canonical base64) plus the whole non-image share. Asserted so a
  // future change to any of the three image numbers is caught here.
  const aggregateEncoded = 4 * Math.ceil(contract.VISUAL_LIMITS.maxTotalImageBytes / 3) + 8
  assert.ok(aggregateEncoded + maxRequestBodyBytes < maxVisualRequestBodyBytes)

  // Over the ceiling is refused by the size gate, before any payload work.
  const oversized = v2WithParts([imagePart('A'.repeat(maxVisualRequestBodyBytes))])
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > maxVisualRequestBodyBytes)
  const refused = contract.parseCodexCompletionRequest(oversized)
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'limit')
  assert.equal(refused.message, 'request exceeds maxVisualRequestBodyBytes')

  // The same shape parsed as V1 keeps the V1 ceiling and its V1 message: the
  // larger budget is a property of the version, not of the payload.
  const asV1 = contract.parseCodexCompletionRequestV1({
    ...oversized,
    schemaVersion: contract.SCHEMA_VERSION,
  })
  assert.equal(asV1.ok, false)
  assert.equal(asV1.code, 'limit')
  assert.equal(asV1.message, 'request exceeds maxRequestBodyBytes')
})

test('large real PNG: CRCs and inflatable scanlines at 3 MiB and at the 10 MiB ceiling', () => {
  const cases = [
    ['3 MiB', 3 * MIB, 512, 512, 21],
    ['10 MiB ceiling', contract.VISUAL_LIMITS.maxImageBytes, 1150, 1150, 31],
  ]
  for (const [label, target, width, height, seed] of cases) {
    const png = realPngOfSize(target, width, height, seed)
    assert.equal(png.length, target, label)
    const chunks = pngChunks(png)
    assert.deepEqual(
      chunks.map(chunk => chunk.type),
      ['IHDR', 'IDAT', 'tEXt', 'IEND'],
      label
    )
    for (const chunk of chunks) {
      assert.equal(chunk.crc, zlib.crc32(chunk.crcInput) >>> 0, `${label} ${chunk.type} crc`)
    }
    const raw = zlib.inflateSync(chunks[1].data)
    assert.equal(raw.length, height * (1 + width * 3), label)
    const parsed = contract.parseCodexCompletionRequest(
      v2WithParts([imagePart(png.toString('base64'))])
    )
    assert.equal(parsed.ok, true, `${label}: ${parsed.message}`)
  }
})

test('buildCodexProxyEnvelope: exact shape, no outer deadline, exact size boundary', () => {
  const ticket = 'header.payload.signature'.repeat(3)
  const parsed = contract.parseCodexCompletionRequest({
    ...BASE,
    ...V2_REQUEST_KEYS,
    deadlineMs: 15000,
  })
  assert.equal(parsed.ok, true)
  const requestHash = contract.hashCodexCompletionRequest(parsed.value)
  const envelope = contract.buildCodexProxyEnvelope({
    executionTicket: ticket,
    requestHash,
    request: parsed.value,
  })
  assert.equal(envelope.ok, true, envelope.message)
  assert.deepEqual(Object.keys(envelope.value), ['executionTicket', 'requestHash', 'request'])
  assert.equal('deadlineMs' in envelope.value, false, 'outer deadline is never emitted')
  assert.equal(
    envelope.value.request.deadlineMs,
    15000,
    'deadline travels inside the hashed request'
  )
  assert.equal(Object.isFrozen(envelope.value), true)
  assert.equal(
    Buffer.byteLength(JSON.stringify(envelope.value), 'utf8') <=
      contract.requestBodyLimitBytes(envelope.value.request),
    true
  )

  const shifted = contract.parseCodexCompletionRequest({
    ...BASE,
    ...V2_REQUEST_KEYS,
    deadlineMs: 15001,
  })
  assert.notEqual(
    contract.hashCodexCompletionRequest(shifted.value),
    requestHash,
    'the deadline is bound by the request hash'
  )

  // V2 exact boundary. The request's own share is bounded (images at ~21 MiB
  // encoded, everything else at 1 MiB), so padding its text can no longer reach
  // the envelope ceiling — the ticket is the field that moves it, and the ticket
  // is what the authorizer really adds.
  const envelopeForTicket = ticketBytes => {
    const request = contract.parseCodexCompletionRequest(VISUAL_FIXTURE.png)
    assert.equal(request.ok, true, request.message)
    const hash = contract.hashCodexCompletionRequest(request.value)
    const executionTicket = 't'.repeat(ticketBytes)
    return {
      executionTicket,
      hash,
      request,
      size: Buffer.byteLength(
        JSON.stringify({ executionTicket, requestHash: hash, request: request.value }),
        'utf8'
      ),
    }
  }
  const limit = contract.requestBodyLimitBytes(parsed.value)
  assert.equal(limit, contract.LIMITS.maxVisualRequestBodyBytes)
  const probe = envelopeForTicket(8)
  const exactTicket = 8 + (limit - probe.size)
  const exact = envelopeForTicket(exactTicket)
  assert.equal(exact.size, limit)
  const atLimit = contract.buildCodexProxyEnvelope({
    executionTicket: exact.executionTicket,
    requestHash: exact.hash,
    request: exact.request.value,
  })
  assert.equal(atLimit.ok, true, atLimit.message)
  assert.equal(Buffer.byteLength(JSON.stringify(atLimit.value), 'utf8'), limit)

  const over = envelopeForTicket(exactTicket + 1)
  assert.equal(over.size, limit + 1)
  const refused = contract.buildCodexProxyEnvelope({
    executionTicket: over.executionTicket,
    requestHash: over.hash,
    request: over.request.value,
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'limit')
  assert.equal(refused.message, 'proxy envelope exceeds maxVisualRequestBodyBytes')

  // V1 keeps the 1 MiB envelope ceiling: same construction, exact boundary, and
  // the V1 failure message.
  const v1Request = contract.parseCodexCompletionRequest({ ...BASE, deadlineMs: 5000 })
  assert.equal(v1Request.ok, true)
  const v1Hash = contract.hashCodexCompletionRequest(v1Request.value)
  const v1Size = ticketBytes =>
    Buffer.byteLength(
      JSON.stringify({
        executionTicket: 't'.repeat(ticketBytes),
        requestHash: v1Hash,
        request: v1Request.value,
      }),
      'utf8'
    )
  const v1Ticket = 8 + (contract.LIMITS.maxRequestBodyBytes - v1Size(8))
  const v1Exact = contract.buildCodexProxyEnvelope({
    executionTicket: 't'.repeat(v1Ticket),
    requestHash: v1Hash,
    request: v1Request.value,
  })
  assert.equal(v1Exact.ok, true, v1Exact.message)
  assert.equal(Buffer.byteLength(JSON.stringify(v1Exact.value), 'utf8'), v1Size(v1Ticket))
  assert.equal(
    Buffer.byteLength(JSON.stringify(v1Exact.value), 'utf8'),
    contract.LIMITS.maxRequestBodyBytes
  )
  const v1Over = contract.buildCodexProxyEnvelope({
    executionTicket: 't'.repeat(v1Ticket + 1),
    requestHash: v1Hash,
    request: v1Request.value,
  })
  assert.equal(v1Over.ok, false)
  assert.equal(v1Over.code, 'limit')
  assert.equal(v1Over.message, 'proxy envelope exceeds maxRequestBodyBytes')
})

test('buildCodexProxyEnvelope: fails closed on hash mismatch, bad input and invalid requests', () => {
  const ticket = 'header.payload.signature'
  const parsed = contract.parseCodexCompletionRequest(VISUAL_FIXTURE.png)
  assert.equal(parsed.ok, true)
  const requestHash = contract.hashCodexCompletionRequest(parsed.value)
  const cases = [
    {
      name: 'hash-mismatch',
      input: { executionTicket: ticket, requestHash: 'a'.repeat(64), request: parsed.value },
      code: 'request_hash_mismatch',
    },
    {
      name: 'hash-shape',
      input: { executionTicket: ticket, requestHash: 'not-a-digest', request: parsed.value },
      code: 'invalid',
    },
    {
      name: 'unknown-envelope-field',
      input: { executionTicket: ticket, requestHash, request: parsed.value, deadlineMs: 1000 },
      code: 'unknown-field',
    },
    {
      name: 'short-ticket',
      input: { executionTicket: 'short', requestHash, request: parsed.value },
      code: 'invalid',
    },
    {
      name: 'ticket-control-character',
      input: { executionTicket: 'ticket\u0000value', requestHash, request: parsed.value },
      code: 'invalid',
    },
    {
      name: 'request-unknown-root-field',
      input: {
        executionTicket: ticket,
        requestHash,
        request: { ...VISUAL_FIXTURE.png, headers: { Authorization: 'Bearer x' } },
      },
      code: 'unknown-field',
    },
    {
      name: 'request-contradictory-parts',
      input: {
        executionTicket: ticket,
        requestHash,
        request: v2WithParts([{ type: 'text', text: 'actual' }], 'different'),
      },
      code: 'invalid',
    },
  ]
  for (const entry of cases) {
    const built = contract.buildCodexProxyEnvelope(entry.input)
    assert.equal(built.ok, false, entry.name)
    assert.equal(built.code, entry.code, entry.name)
  }
  assert.equal(contract.buildCodexProxyEnvelope(null).code, 'invalid')

  const v1 = contract.parseCodexCompletionRequest({ ...BASE, deadlineMs: 5000 })
  assert.equal(v1.ok, true)
  const v1Envelope = contract.buildCodexProxyEnvelope({
    executionTicket: ticket,
    requestHash: contract.hashCodexCompletionRequest(v1.value),
    request: v1.value,
  })
  assert.equal(v1Envelope.ok, true, v1Envelope.message)
  assert.deepEqual(Object.keys(v1Envelope.value), ['executionTicket', 'requestHash', 'request'])
  assert.equal('deadlineMs' in v1Envelope.value, false)
})
