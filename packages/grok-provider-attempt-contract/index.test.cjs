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

test('does not import Codex LIMITS or Codex provider id', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8')
  assert.equal(src.includes("require('../llm-provider-attempt-contract"), false)
  assert.equal(contract.PROVIDER_ID, 'grok-subscription')
  assert.equal(contract.TICKET_TYP, 'grok-execution-ticket')
  assert.equal(contract.LIMITS.maxToolCalls, 64)
  assert.equal(contract.COMPLETIONS_ORIGIN, 'https://cli-chat-proxy.grok.com/v1/responses')
  assert.equal(src.includes('chatgpt.com'), false)
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
