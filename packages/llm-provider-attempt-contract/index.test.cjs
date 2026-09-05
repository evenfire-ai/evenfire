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
