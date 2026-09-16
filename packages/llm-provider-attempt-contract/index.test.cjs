'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const contract = require('./index.cjs')

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/canonical-request-hashes.json'), 'utf8')
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
      assert.equal(contract.hashCodexCompletionRequestV1(other.value), digest, `${fixture.name} reorder`)
    }
    if (fixture.distinctRequest) {
      const other = contract.parseCodexCompletionRequestV1(fixture.distinctRequest)
      assert.equal(other.ok, true, `${fixture.name} distinct`)
      assert.notEqual(contract.hashCodexCompletionRequestV1(other.value), digest, `${fixture.name} array order`)
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
    const reordered = tools.map(({ name, description, parameters }) => ({ parameters, description, name }))
    const equivalent = contract.parseCodexCompletionRequestV1({ ...BASE, tools: reordered })
    assert.equal(equivalent.ok, true)
    assert.equal(contract.hashCodexCompletionRequestV1(parsed.value), contract.hashCodexCompletionRequestV1(equivalent.value))
    const changed = contract.parseCodexCompletionRequestV1({ ...BASE, tools: [...tools.slice(0, -1), { ...tools.at(-1), description: 'Changed capability' }] })
    assert.equal(changed.ok, true)
    assert.notEqual(contract.hashCodexCompletionRequestV1(parsed.value), contract.hashCodexCompletionRequestV1(changed.value))
  })
}

test('tool definition count never widens the independent assistant call limit', () => {
  assert.equal(contract.LIMITS.maxToolCalls, 32)
  assert.equal(Object.hasOwn(contract.LIMITS, 'maxTools'), false)
  for (const count of [32, 33]) {
    const parsed = contract.parseCodexCompletionRequestV1({
      ...BASE,
      tools: catalog(250),
      messages: [{ role: 'assistant', content: '', toolCalls: Array.from({ length: count }, (_, index) => ({
        id: `call-${index}`, name: `eventasks__read_${index}`, arguments: {},
      })) }],
    })
    assert.equal(parsed.ok, count === 32)
    if (!parsed.ok) assert.equal(parsed.message, 'messages[0].toolCalls exceed 32')
  }
})

test('large catalogs remain bounded by serialized request bytes including UTF-8', () => {
  const request = { ...BASE, tools: catalog(250) }
  const originalBytes = Buffer.byteLength(JSON.stringify(request), 'utf8')
  request.tools[249].description += 'x'.repeat(contract.LIMITS.maxRequestBodyBytes - originalBytes)
  assert.equal(Buffer.byteLength(JSON.stringify(request), 'utf8'), contract.LIMITS.maxRequestBodyBytes)
  assert.equal(contract.parseCodexCompletionRequestV1(request).ok, true)
  request.tools[249].description += 'é'
  assert.deepEqual(contract.parseCodexCompletionRequestV1(request), {
    ok: false, code: 'limit', message: 'request exceeds maxRequestBodyBytes',
  })
})

test('validates the last definition beyond the former count boundary', () => {
  for (const invalid of [{ name: 'invalid\u0000name' }, { parameters: { value: Infinity } }, { headers: {} }]) {
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
    assert.equal(contract.hashCodexCompletionRequestV1(parsed.value),
      crypto.createHash('sha256').update(contract.stableStringify(request)).digest('hex'))
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
  const request = { ...BASE, tools: [{ name: '工具', description: 'Read a record', parameters: {} }] }
  request.tools[0].name += 'x'.repeat(contract.LIMITS.maxRequestBodyBytes - Buffer.byteLength(JSON.stringify(request)))
  assert.equal(contract.parseCodexCompletionRequestV1(request).ok, true)
  request.tools[0].name += 'é'
  assert.deepEqual(contract.parseCodexCompletionRequestV1(request), {
    ok: false, code: 'limit', message: 'request exceeds maxRequestBodyBytes',
  })
})
