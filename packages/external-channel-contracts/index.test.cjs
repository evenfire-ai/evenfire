'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const contracts = require('./index.cjs')

const {
  ADMISSION_REFUSAL_REASONS,
  CALLBACK_REFUSALS,
  CONVERSATION_KINDS,
  EXECUTION_PRINCIPAL_KINDS,
  PAUSE_ACTION_DECISIONS,
  PAUSE_ACTION_VALUE_PATTERN,
  PAUSE_OUTCOMES,
  PROVIDER_EVENT_RECEIPT_AUDIENCE,
  PROVIDER_EVENT_RECEIPT_HEADER_TYPE,
  PROVIDER_EVENT_RECEIPT_TTL_SECONDS,
  parsePauseActionValue,
  validateChannelAdmission,
  validateOriginRoute,
  validateProviderEventReceiptClaims,
  validateStage1ExecutionPrincipal,
} = contracts

const FIXTURES_DIR = path.join(__dirname, 'fixtures')
const fixtureNames = fs.readdirSync(FIXTURES_DIR).filter(name => name.endsWith('.json')).sort()
const load = name => JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8'))

const RECEIPT_ERROR = 'invalid_provider_event_receipt'
const ADMISSION_ERROR = 'invalid_channel_admission'
const ORIGIN_ERROR = 'invalid_origin_route'

// Every fixture file, its validator and its expected verdict. A fixture added
// to the directory without a row here fails the coverage test below.
const VALID = 'valid'
const FIXTURE_CASES = {
  'receipt.slack.message.json': [validateProviderEventReceiptClaims, VALID],
  'receipt.slack.action.approve.json': [validateProviderEventReceiptClaims, VALID],
  'receipt.slack.action.approve_always.json': [validateProviderEventReceiptClaims, VALID],
  'receipt.slack.action.deny.json': [validateProviderEventReceiptClaims, VALID],
  'receipt.slack.action.connect.json': [validateProviderEventReceiptClaims, VALID],
  'receipt.slack.action.other.json': [validateProviderEventReceiptClaims, VALID],
  'receipt.teams.message.json': [validateProviderEventReceiptClaims, VALID],
  'receipt.teams.action.json': [validateProviderEventReceiptClaims, VALID],
  'receipt.invalid.message-with-action.json': [validateProviderEventReceiptClaims, RECEIPT_ERROR],
  'admission.admitted.json': [validateChannelAdmission, VALID],
  ...Object.fromEntries(
    ADMISSION_REFUSAL_REASONS.map(reason => [`admission.refused.${reason}.json`, [validateChannelAdmission, VALID]])
  ),
  'admission.invalid.refused-without-event.json': [validateChannelAdmission, ADMISSION_ERROR],
  'origin.thread.json': [validateOriginRoute, VALID],
  'origin.conversation.json': [validateOriginRoute, VALID],
  'origin.quote.json': [validateOriginRoute, VALID],
  'origin.invalid.unknown-reply-style.json': [validateOriginRoute, ORIGIN_ERROR],
  'principal.member.json': [validateStage1ExecutionPrincipal, VALID],
  'principal.bot.json': [validateStage1ExecutionPrincipal, 'stage1_bot_principal'],
}

const assertDeepFrozen = value => {
  if (value === null || typeof value !== 'object') return
  assert.ok(Object.isFrozen(value), 'a returned contract value is not frozen')
  for (const child of Object.values(value)) assertDeepFrozen(child)
}

const assertRejects = (validator, value, code) =>
  assert.throws(() => validator(value), error => {
    assert.equal(error.code, code)
    return true
  })

const assertAccepts = (validator, value) => {
  const result = validator(value)
  assert.deepEqual(result, value)
  assert.notEqual(result, value, 'the validator returned the caller object instead of a copy')
  assertDeepFrozen(result)
  return result
}

it('keeps runtime exports aligned with the declaration file', () => {
  const declarations = fs.readFileSync(path.join(__dirname, 'index.d.ts'), 'utf8')
  const declared = Array.from(
    declarations.matchAll(/export declare (?:const|function)\s+([A-Za-z0-9_]+)/g),
    match => match[1]
  ).sort()
  assert.ok(declared.includes('validateChannelAdmission'), 'the declaration file was not read')
  assert.deepEqual(Object.keys(contracts).sort(), declared)
})

describe('constants', () => {
  it('ships the section 4 vocabularies as frozen arrays', () => {
    assert.deepEqual(ADMISSION_REFUSAL_REASONS, [
      'receipt_invalid', 'no_match', 'identity_quarantined', 'excluded',
      'not_eligible_guest', 'not_eligible_external', 'not_eligible_deactivated', 'not_eligible_bot',
      'lookup_permission_missing', 'eligibility_unavailable', 'audience_not_ready',
      'missing_agent_grant', 'missing_channel_grant',
    ])
    assert.deepEqual(PAUSE_OUTCOMES, ['approved', 'approved_always', 'denied', 'timed_out', 'cancelled', 'superseded'])
    assert.deepEqual(CALLBACK_REFUSALS, [
      'not_an_action', 'request_mismatch', 'decision_mismatch', 'unknown_request', 'already_decided',
      'expired', 'not_admitted', 'not_responder', 'wrong_conversation',
    ])
    assert.deepEqual(CONVERSATION_KINDS, ['direct', 'group', 'channel'])
    assert.deepEqual(PAUSE_ACTION_DECISIONS, ['approve', 'approve_always', 'deny', 'connect'])
    assert.deepEqual(EXECUTION_PRINCIPAL_KINDS, ['member', 'bot'])
    for (const list of [
      ADMISSION_REFUSAL_REASONS, PAUSE_OUTCOMES, CALLBACK_REFUSALS, CONVERSATION_KINDS,
      PAUSE_ACTION_DECISIONS, EXECUTION_PRINCIPAL_KINDS,
    ]) {
      assert.ok(Object.isFrozen(list))
    }
  })

  it('ships the receipt token parameters', () => {
    assert.equal(PROVIDER_EVENT_RECEIPT_AUDIENCE, 'evenfire-provider-event')
    assert.equal(PROVIDER_EVENT_RECEIPT_HEADER_TYPE, 'provider-event-receipt+jwt')
    assert.equal(PROVIDER_EVENT_RECEIPT_TTL_SECONDS, 600)
    assert.equal(PAUSE_ACTION_VALUE_PATTERN.source, '^tool:([aldc]):([A-Za-z0-9_-]{16,64})$')
  })
})

describe('fixtures', () => {
  it('every fixture file has a validator case and every case has a file', () => {
    assert.ok(fixtureNames.length > 0)
    assert.deepEqual(fixtureNames, Object.keys(FIXTURE_CASES).sort())
  })

  // 0-U1: per validator, its invalid fixtures are rejected with the fixed code
  // and its valid fixtures, checked in the same test, are accepted.
  const byValidator = new Map()
  for (const [name, [validator, expected]] of Object.entries(FIXTURE_CASES)) {
    if (!byValidator.has(validator)) byValidator.set(validator, [])
    byValidator.get(validator).push([name, expected])
  }
  for (const [validator, cases] of byValidator) {
    it(`0-U1 ${validator.name} rejects its invalid fixtures and accepts its valid ones`, () => {
      const valid = cases.filter(([, expected]) => expected === VALID)
      const invalid = cases.filter(([, expected]) => expected !== VALID)
      assert.ok(valid.length > 0 && invalid.length > 0)
      for (const [name, code] of invalid) assertRejects(validator, load(name), code)
      for (const [name] of valid) assertAccepts(validator, load(name))
    })
  }

  // 0-U2: exactly one refusal fixture per reason, compared as sets from the directory listing.
  it('0-U2 refusal fixtures cover exactly ADMISSION_REFUSAL_REASONS', () => {
    const reasons = fixtureNames
      .map(name => /^admission\.refused\.(.+)\.json$/.exec(name))
      .filter(Boolean)
      .map(match => match[1])
      .sort()
    assert.ok(reasons.length > 0)
    assert.equal(reasons.length, ADMISSION_REFUSAL_REASONS.length)
    assert.deepEqual(reasons, [...ADMISSION_REFUSAL_REASONS].sort())
    for (const reason of reasons) {
      const admission = assertAccepts(validateChannelAdmission, load(`admission.refused.${reason}.json`))
      assert.equal(admission.reason, reason)
      assert.equal(admission.event === null, reason === 'receipt_invalid')
    }
  })

  it('refusal fixtures carry the notice the admission steps assign to their reason', () => {
    // stage1-plan-r9.md:538
    const notice = {
      receipt_invalid: 'none', not_eligible_bot: 'none',
      lookup_permission_missing: 'origin_generic', eligibility_unavailable: 'origin_generic',
      audience_not_ready: 'origin_generic',
    }
    for (const reason of ADMISSION_REFUSAL_REASONS) {
      assert.equal(load(`admission.refused.${reason}.json`).notice, notice[reason] ?? 'private', reason)
    }
  })

  it('0-U3 action fixtures cover exactly PAUSE_ACTION_DECISIONS and parse back to their decision', () => {
    const decisions = fixtureNames
      .filter(name => name !== 'receipt.slack.action.other.json')
      .map(name => /^receipt\.slack\.action\.(.+)\.json$/.exec(name))
      .filter(Boolean)
      .map(match => match[1])
      .sort()
    assert.deepEqual(decisions, [...PAUSE_ACTION_DECISIONS].sort())
    const codes = { approve: 'a', approve_always: 'l', deny: 'd', connect: 'c' }
    for (const decision of decisions) {
      const claims = assertAccepts(validateProviderEventReceiptClaims, load(`receipt.slack.action.${decision}.json`))
      assert.equal(claims.action.decision, decision)
      assert.deepEqual(parsePauseActionValue(`tool:${codes[decision]}:${claims.action.token}`), claims.action)
    }
  })
})

describe('provider event receipt claims', () => {
  const message = load('receipt.slack.message.json')
  const action = load('receipt.slack.action.approve.json')
  const teams = load('receipt.teams.message.json')

  it('0-U3 rejects a message receipt that carries an action', () => {
    assertAccepts(validateProviderEventReceiptClaims, message)
    assertRejects(validateProviderEventReceiptClaims, load('receipt.invalid.message-with-action.json'), RECEIPT_ERROR)
  })

  it('accepts an action receipt whose clicked value is not a pause action', () => {
    assert.equal(assertAccepts(validateProviderEventReceiptClaims, load('receipt.slack.action.other.json')).action, null)
  })

  const rejected = {
    'an unknown key': { ...message, teamId: 'T0FIXTURE01' },
    'a missing key': (({ hostRef, ...rest }) => rest)(message),
    'another version': { ...message, ver: 2 },
    'an unknown medium': { ...message, medium: 'discord' },
    'a channelRef without a namespace': { ...message, channelRef: 'fixture-slack-channel' },
    'a lifetime other than 600 seconds': { ...message, exp: message.iat + 601 },
    'a fractional issue time': { ...message, iat: message.iat + 0.5, exp: message.exp + 0.5 },
    'a message without a conversation kind': { ...message, conversationKind: null },
    'an unknown conversation kind': { ...message, conversationKind: 'broadcast' },
    'an action with a conversation kind': { ...action, conversationKind: 'channel' },
    'an action with an unknown decision': { ...action, action: { decision: 'escalate', token: action.action.token } },
    'an action with a short token': { ...action, action: { decision: 'approve', token: 'fixture-short' } },
    'an action with an extra key': { ...action, action: { ...action.action, requestId: 'fixture-request' } },
    'a Slack receipt with a delivery alias': { ...message, deliveryAlias: '29:fixture-teams-from-id' },
    'a Teams receipt with an organization id': { ...teams, providerOrgId: 'E0FIXTURE01' },
    'a Teams conversation id that keeps its message id': {
      ...teams, conversationId: `${teams.conversationId};messageid=1763460300000`,
    },
    'an unknown attesting component': { ...message, attestedBy: 'channel-reader' },
    'an empty jti': { ...message, jti: '' },
    'an array': [message],
    'null': null,
  }
  for (const [label, value] of Object.entries(rejected)) {
    it(`rejects ${label}`, () => {
      assertAccepts(validateProviderEventReceiptClaims, message)
      assertRejects(validateProviderEventReceiptClaims, value, RECEIPT_ERROR)
    })
  }
})

describe('parsePauseActionValue', () => {
  const token16 = 'fixture-pause-01'
  const codes = { a: 'approve', l: 'approve_always', d: 'deny', c: 'connect' }

  it('0-U3 accepts the four codes with a 16-character token and with a UUID', () => {
    assert.equal(token16.length, 16)
    const uuid = randomUUID()
    for (const [code, decision] of Object.entries(codes)) {
      assert.deepEqual(parsePauseActionValue(`tool:${code}:${token16}`), { decision, token: token16 })
      assert.deepEqual(parsePauseActionValue(`tool:${code}:${uuid}`), { decision, token: uuid })
    }
    assert.ok(Object.isFrozen(parsePauseActionValue(`tool:a:${token16}`)))
  })

  it('0-U3 returns null for a fifth code, a 15-character token and surrounding text', () => {
    assert.deepEqual(parsePauseActionValue(`tool:a:${token16}`), { decision: 'approve', token: token16 })
    for (const value of [
      `tool:x:${token16}`,
      `tool:a:${token16.slice(0, 15)}`,
      `tool:a:${'t'.repeat(65)}`,
      ` tool:a:${token16}`,
      `tool:a:${token16} `,
      `Approve tool:a:${token16}`,
      `tool:a:${token16}\n`,
      `tool:a:fixture-pause/01x`,
      '',
      undefined,
      42,
    ]) {
      assert.equal(parsePauseActionValue(value), null, String(value))
    }
  })
})

describe('channel admission', () => {
  const admitted = load('admission.admitted.json')
  const refused = load('admission.refused.no_match.json')
  const rejected = {
    'an admitted answer with an extra key': { ...admitted, teamId: 'fixture-team' },
    'an admitted answer without a member': (({ memberId, ...rest }) => rest)(admitted),
    'an admitted answer in open mode': { ...admitted, audienceMode: 'open' },
    'an admitted answer without an event': { ...admitted, event: null },
    'a fractional policy version': { ...admitted, policyVersion: 1.5 },
    'a negative policy version': { ...admitted, policyVersion: -1 },
    'an event with an extra key': { ...admitted, event: { ...admitted.event, hostRef: 'fixture-host' } },
    'an event message that carries an action': {
      ...admitted, event: { ...admitted.event, action: { decision: 'deny', token: 'fixture-pause-request-0001' } },
    },
    'an unknown refusal reason': { ...refused, reason: 'rate_limited' },
    'an unknown notice': { ...refused, notice: 'public' },
    'a receipt_invalid refusal with an event': { ...load('admission.refused.receipt_invalid.json'), event: admitted.event },
    'an unknown outcome': { ...refused, outcome: 'deferred' },
  }
  for (const [label, value] of Object.entries(rejected)) {
    it(`rejects ${label}`, () => {
      assertAccepts(validateChannelAdmission, admitted)
      assertRejects(validateChannelAdmission, value, ADMISSION_ERROR)
    })
  }

  it('accepts policy version 0, the lowest non-negative integer', () => {
    assert.equal(assertAccepts(validateChannelAdmission, { ...admitted, policyVersion: 0 }).policyVersion, 0)
    const member = load('principal.member.json')
    assert.equal(assertAccepts(validateStage1ExecutionPrincipal, { ...member, policyVersion: 0 }).policyVersion, 0)
  })

  it('accepts a refusal of a click with its action event', () => {
    const value = assertAccepts(validateChannelAdmission, load('admission.refused.missing_channel_grant.json'))
    assert.equal(value.event.eventKind, 'action')
    assert.equal(value.event.action.decision, 'approve')
  })
})

describe('origin route', () => {
  const thread = load('origin.thread.json')
  const rejected = {
    'an extra key': { ...thread, teamId: 'fixture-team' },
    'a missing conversation kind': { ...thread, conversationKind: null },
    'an unknown medium': { ...thread, medium: 'email' },
    'a non-string quoted message id': { ...load('origin.quote.json'), quotedMessageId: 7 },
  }
  for (const [label, value] of Object.entries(rejected)) {
    it(`rejects ${label}`, () => {
      assertAccepts(validateOriginRoute, thread)
      assertRejects(validateOriginRoute, value, ORIGIN_ERROR)
    })
  }
})

describe('Stage 1 execution principal', () => {
  it('0-U4 accepts a member, refuses a bot and an unknown kind', () => {
    const member = assertAccepts(validateStage1ExecutionPrincipal, load('principal.member.json'))
    assert.equal(member.memberId, '00000000-0000-4000-8000-00000000a001')
    assertRejects(validateStage1ExecutionPrincipal, load('principal.bot.json'), 'stage1_bot_principal')
    assertRejects(validateStage1ExecutionPrincipal, { kind: 'guest' }, 'unknown_principal_kind')
  })

  it('rejects a malformed member', () => {
    const member = load('principal.member.json')
    assertAccepts(validateStage1ExecutionPrincipal, member)
    for (const value of [
      { ...member, teamId: 'fixture-team' },
      (({ identityId, ...rest }) => rest)(member),
      { ...member, conversationKind: null },
      null,
    ]) {
      assertRejects(validateStage1ExecutionPrincipal, value, 'invalid_execution_principal')
    }
  })
})
