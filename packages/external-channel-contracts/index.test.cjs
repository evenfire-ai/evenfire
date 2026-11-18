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

// Every fixture file, its validator and its expected verdict (for an invalid
// fixture, the error code and the field its message names). A fixture added
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
  'receipt.invalid.message-with-action.json': [validateProviderEventReceiptClaims, RECEIPT_ERROR, 'action'],
  'admission.admitted.json': [validateChannelAdmission, VALID],
  ...Object.fromEntries(
    ADMISSION_REFUSAL_REASONS.map(reason => [`admission.refused.${reason}.json`, [validateChannelAdmission, VALID]])
  ),
  'admission.invalid.refused-without-event.json': [validateChannelAdmission, ADMISSION_ERROR, 'event'],
  'origin.thread.json': [validateOriginRoute, VALID],
  'origin.conversation.json': [validateOriginRoute, VALID],
  'origin.quote.json': [validateOriginRoute, VALID],
  'origin.invalid.unknown-reply-style.json': [validateOriginRoute, ORIGIN_ERROR, 'replyStyle'],
  'principal.member.json': [validateStage1ExecutionPrincipal, VALID],
  'principal.bot.json': [validateStage1ExecutionPrincipal, 'stage1_bot_principal', 'kind'],
}

const assertDeepFrozen = value => {
  if (value === null || typeof value !== 'object') return
  assert.ok(Object.isFrozen(value), 'a returned contract value is not frozen')
  for (const child of Object.values(value)) assertDeepFrozen(child)
}

// The message names the field and never the value. `field` is required: a call
// that omits it compares against "<code>: undefined" and fails.
const assertRejects = (validator, value, code, field, label) =>
  assert.throws(() => validator(value), error => {
    assert.equal(error.code, code, label)
    assert.equal(error.message, `${code}: ${field}`, label)
    return true
  }, label)

// The pause token grammar, used by the receipt validator and by the parser so
// that the two patterns cannot drift apart: [label, token, accepted].
const PAUSE_TOKEN_ROWS = [
  ['15 characters', 'fixture-pause-0', false],
  ['16 characters', 'fixture-pause-01', true],
  ['64 characters', `fixture-pause-${'0'.repeat(50)}`, true],
  ['65 characters', `fixture-pause-${'0'.repeat(51)}`, false],
  ['an underscore', 'fixture_pause_01', true],
  ['upper case', 'FIXTURE-PAUSE-01', true],
  ['a slash', 'fixture-pause/01', false],
  ['a dot', 'fixture.pause.01', false],
  ['a space', 'fixture pause 01', false],
  ['a trailing newline', 'fixture-pause-01\n', false],
  ['a valid 16-character run, then a slash', 'fixture-pause-01/x', false],
]
// channelRef values that are not <namespace>/<name>, refused by both validators.
const CHANNEL_REF_REFUSED = [
  'fixture-slack-channel',
  'agents/fixture/extra',
  'agents/fixture slack',
  '/fixture-slack-channel',
  'agents/',
  ['agents/fixture-slack-channel'],
]
const assertChannelRefGrammar = (validator, valid, code) => {
  const accepted = assertAccepts(validator, valid)
  const parts = accepted.channelRef.split('/')
  assert.equal(parts.length, 2)
  assert.ok(parts.every(part => part.length > 0))
  for (const channelRef of CHANNEL_REF_REFUSED) {
    assertRejects(validator, { ...valid, channelRef }, code, 'channelRef', JSON.stringify(channelRef))
  }
}
const assertPauseTokenBoundaries = () => {
  const length = label => PAUSE_TOKEN_ROWS.find(([rowLabel]) => rowLabel === label)[1].length
  assert.deepEqual(
    ['15 characters', '16 characters', '64 characters', '65 characters'].map(length),
    [15, 16, 64, 65]
  )
}

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
    assert.equal(PAUSE_ACTION_VALUE_PATTERN.flags, '')
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
  for (const [name, [validator, expected, field]] of Object.entries(FIXTURE_CASES)) {
    if (!byValidator.has(validator)) byValidator.set(validator, [])
    byValidator.get(validator).push([name, expected, field])
  }
  for (const [validator, cases] of byValidator) {
    it(`0-U1 ${validator.name} rejects its invalid fixtures and accepts its valid ones`, () => {
      const valid = cases.filter(([, expected]) => expected === VALID)
      const invalid = cases.filter(([, expected]) => expected !== VALID)
      assert.ok(valid.length > 0 && invalid.length > 0)
      for (const [name, code, field] of invalid) assertRejects(validator, load(name), code, field, name)
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
    // The validator accepts any notice with any reason (index.cjs checks the two vocabularies independently); this table pins the notice each fixture carries, not a rule the validator enforces.
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
    assertRejects(validateProviderEventReceiptClaims, load('receipt.invalid.message-with-action.json'), RECEIPT_ERROR, 'action')
  })

  it('accepts an action receipt whose clicked value is not a pause action', () => {
    assert.equal(assertAccepts(validateProviderEventReceiptClaims, load('receipt.slack.action.other.json')).action, null)
  })

  it('refuses a channelRef that is not <namespace>/<name>', () => {
    assertChannelRefGrammar(validateProviderEventReceiptClaims, message, RECEIPT_ERROR)
  })

  it('pins the pause token grammar on action receipts', () => {
    assertPauseTokenBoundaries()
    for (const [label, token, accepted] of PAUSE_TOKEN_ROWS) {
      const value = { ...action, action: { decision: 'approve', token } }
      if (accepted) {
        assert.doesNotThrow(() => validateProviderEventReceiptClaims(value), label)
        assert.equal(assertAccepts(validateProviderEventReceiptClaims, value).action.token, token, label)
      } else {
        assertRejects(validateProviderEventReceiptClaims, value, RECEIPT_ERROR, 'action', label)
      }
    }
    const numberToken = { ...action, action: { decision: 'approve', token: 1234567890123456 } }
    assertRejects(validateProviderEventReceiptClaims, numberToken, RECEIPT_ERROR, 'action', 'a number as token')
  })

  // Each row: the refused value and the field the error message names.
  const rejected = {
    'an unknown key': [{ ...message, teamId: 'T0FIXTURE01' }, 'keys'],
    'a missing key': [(({ hostRef, ...rest }) => rest)(message), 'keys'],
    'another version': [{ ...message, ver: 2 }, 'ver'],
    'an unknown medium': [{ ...message, medium: 'discord' }, 'medium'],
    'a channelRef without a namespace': [{ ...message, channelRef: 'fixture-slack-channel' }, 'channelRef'],
    'a lifetime other than 600 seconds': [{ ...message, exp: message.iat + 601 }, 'exp'],
    'a lifetime of 599 seconds': [{ ...message, exp: message.iat + 599 }, 'exp'],
    'a zero lifetime': [{ ...message, exp: message.iat }, 'exp'],
    'a string expiry that coerces to a 600 second lifetime': [{ ...message, exp: String(message.iat + 600) }, 'exp'],
    'a fractional issue time': [{ ...message, iat: message.iat + 0.5, exp: message.exp + 0.5 }, 'iat'],
    'a message without a conversation kind': [{ ...message, conversationKind: null }, 'conversationKind'],
    'an unknown conversation kind': [{ ...message, conversationKind: 'broadcast' }, 'conversationKind'],
    'an action with a conversation kind': [{ ...action, conversationKind: 'channel' }, 'conversationKind'],
    'an action with an unknown decision': [
      { ...action, action: { decision: 'escalate', token: action.action.token } }, 'action',
    ],
    'an action with a short token': [{ ...action, action: { decision: 'approve', token: 'fixture-short' } }, 'action'],
    'an action with an extra key': [
      { ...action, action: { ...action.action, requestId: 'fixture-request' } }, 'action',
    ],
    'a Slack receipt with a delivery alias': [{ ...message, deliveryAlias: '29:fixture-teams-from-id' }, 'deliveryAlias'],
    'a Teams receipt with an organization id': [{ ...teams, providerOrgId: 'E0FIXTURE01' }, 'providerOrgId'],
    'a Teams conversation id that keeps its message id': [
      { ...teams, conversationId: `${teams.conversationId};messageid=1763460300000` }, 'conversationId',
    ],
    'an unknown attesting component': [{ ...message, attestedBy: 'channel-reader' }, 'attestedBy'],
    'an empty jti': [{ ...message, jti: '' }, 'jti'],
    'an array': [[message], 'keys'],
    'null': [null, 'keys'],
  }
  for (const [label, [value, field]] of Object.entries(rejected)) {
    it(`rejects ${label}`, () => {
      assertAccepts(validateProviderEventReceiptClaims, message)
      assertRejects(validateProviderEventReceiptClaims, value, RECEIPT_ERROR, field)
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

  it('returns null for another letter case and for non-strings that coerce to a valid value', () => {
    assert.deepEqual(parsePauseActionValue(`tool:a:${token16}`), { decision: 'approve', token: token16 })
    for (const value of [
      `TOOL:A:${token16}`,
      `tool:A:${token16}`,
      [`tool:a:${token16}`],
      { toString: () => `tool:a:${token16}` },
      new String(`tool:a:${token16}`),
    ]) {
      assert.equal(parsePauseActionValue(value), null, String(value))
    }
  })

  it('pins the same token grammar as the receipt validator', () => {
    assertPauseTokenBoundaries()
    for (const [label, token, accepted] of PAUSE_TOKEN_ROWS) {
      assert.deepEqual(parsePauseActionValue(`tool:a:${token}`), accepted ? { decision: 'approve', token } : null, label)
    }
  })
})

describe('channel admission', () => {
  const admitted = load('admission.admitted.json')
  const refused = load('admission.refused.no_match.json')
  // Each row: the refused value and the field the error message names.
  const rejected = {
    'an admitted answer with an extra key': [{ ...admitted, teamId: 'fixture-team' }, 'keys'],
    'an admitted answer without a member': [(({ memberId, ...rest }) => rest)(admitted), 'keys'],
    'an admitted answer in open mode': [{ ...admitted, audienceMode: 'open' }, 'audienceMode'],
    'an admitted answer without an event': [{ ...admitted, event: null }, 'event'],
    'a fractional policy version': [{ ...admitted, policyVersion: 1.5 }, 'policyVersion'],
    'a negative policy version': [{ ...admitted, policyVersion: -1 }, 'policyVersion'],
    'an event with an extra key': [{ ...admitted, event: { ...admitted.event, hostRef: 'fixture-host' } }, 'event'],
    'an event message that carries an action': [
      { ...admitted, event: { ...admitted.event, action: { decision: 'deny', token: 'fixture-pause-request-0001' } } },
      'event.action',
    ],
    'an unknown refusal reason': [{ ...refused, reason: 'rate_limited' }, 'reason'],
    'an unknown notice': [{ ...refused, notice: 'public' }, 'notice'],
    'a receipt_invalid refusal with an event': [
      { ...load('admission.refused.receipt_invalid.json'), event: admitted.event }, 'event',
    ],
    'an unknown outcome': [{ ...refused, outcome: 'deferred' }, 'outcome'],
  }
  for (const [label, [value, field]] of Object.entries(rejected)) {
    it(`rejects ${label}`, () => {
      assertAccepts(validateChannelAdmission, admitted)
      assertRejects(validateChannelAdmission, value, ADMISSION_ERROR, field)
    })
  }

  it('accepts policy version 0, the lowest non-negative integer', () => {
    assert.equal(assertAccepts(validateChannelAdmission, { ...admitted, policyVersion: 0 }).policyVersion, 0)
    const member = load('principal.member.json')
    assert.equal(assertAccepts(validateStage1ExecutionPrincipal, { ...member, policyVersion: 0 }).policyVersion, 0)
  })

  it('accepts the workspace audience mode', () => {
    const value = assertAccepts(validateChannelAdmission, { ...admitted, audienceMode: 'workspace' })
    assert.equal(value.audienceMode, 'workspace')
  })

  it('accepts a refusal of a click with its action event', () => {
    const value = assertAccepts(validateChannelAdmission, load('admission.refused.missing_channel_grant.json'))
    assert.equal(value.event.eventKind, 'action')
    assert.equal(value.event.action.decision, 'approve')
  })
})

describe('origin route', () => {
  const thread = load('origin.thread.json')
  // Each row: the refused value and the field the error message names.
  const rejected = {
    'an extra key': [{ ...thread, teamId: 'fixture-team' }, 'keys'],
    'a missing conversation kind': [{ ...thread, conversationKind: null }, 'conversationKind'],
    'an unknown medium': [{ ...thread, medium: 'email' }, 'medium'],
    'a non-string quoted message id': [{ ...load('origin.quote.json'), quotedMessageId: 7 }, 'quotedMessageId'],
  }
  for (const [label, [value, field]] of Object.entries(rejected)) {
    it(`rejects ${label}`, () => {
      assertAccepts(validateOriginRoute, thread)
      assertRejects(validateOriginRoute, value, ORIGIN_ERROR, field)
    })
  }

  it('refuses a channelRef that is not <namespace>/<name>', () => {
    assertChannelRefGrammar(validateOriginRoute, thread, ORIGIN_ERROR)
  })
})

describe('Stage 1 execution principal', () => {
  it('0-U4 accepts a member, refuses a bot and an unknown kind', () => {
    const member = assertAccepts(validateStage1ExecutionPrincipal, load('principal.member.json'))
    assert.equal(member.memberId, '00000000-0000-4000-8000-00000000a001')
    assertRejects(validateStage1ExecutionPrincipal, load('principal.bot.json'), 'stage1_bot_principal', 'kind')
    assertRejects(validateStage1ExecutionPrincipal, { kind: 'guest' }, 'unknown_principal_kind', 'kind')
  })

  it('rejects a malformed member', () => {
    const member = load('principal.member.json')
    assertAccepts(validateStage1ExecutionPrincipal, member)
    for (const [value, field] of [
      [{ ...member, teamId: 'fixture-team' }, 'keys'],
      [(({ identityId, ...rest }) => rest)(member), 'keys'],
      [{ ...member, conversationKind: null }, 'conversationKind'],
      [null, 'value'],
    ]) {
      assertRejects(validateStage1ExecutionPrincipal, value, 'invalid_execution_principal', field)
    }
  })
})

// One rejection row per field: every key of a valid value, set to a value of the
// wrong type, must be refused with the contract's code. Without these rows a
// single field check can be deleted while every invariant test stays green.
describe('per-field rejections', () => {
  const NOT_OBJECTS = [null, [], 'fixture-value', 7]
  // Each row is [label, value, code, field]: a wrong-type row names its own key.
  const wrongTypeRows = (label, valid, code, codeByKey = {}) =>
    Object.keys(valid).flatMap(key =>
      [true, ''].map(bad => [
        `${label}.${key}=${JSON.stringify(bad)}`, { ...valid, [key]: bad }, codeByKey[key] ?? code, key,
      ])
    )
  // fieldOf maps the nested key to the field the message names.
  const nestedRows = (label, valid, key, code, fieldOf) =>
    wrongTypeRows(`${label}.${key}`, valid[key], code).map(([rowLabel, nested, rowCode, childKey]) => [
      rowLabel,
      { ...valid, [key]: nested },
      rowCode,
      fieldOf(childKey),
    ])
  const checkRows = (validator, valid, rows) => {
    assert.ok(rows.length > 0)
    for (const [label, value, code, field] of rows) {
      assertAccepts(validator, valid)
      assertRejects(validator, value, code, field, label)
    }
  }

  it('provider event receipt claims', () => {
    const message = load('receipt.slack.message.json')
    const rows = [
      ...wrongTypeRows('slack.message', message, RECEIPT_ERROR),
      ...wrongTypeRows('slack.action', load('receipt.slack.action.approve.json'), RECEIPT_ERROR),
      ...wrongTypeRows('teams.message', load('receipt.teams.message.json'), RECEIPT_ERROR),
      ...nestedRows('slack.action', load('receipt.slack.action.approve.json'), 'action', RECEIPT_ERROR, () => 'action'),
      ['iat=0 with a 600 s lifetime', { ...message, iat: 0, exp: 600 }, RECEIPT_ERROR, 'iat'],
      ...NOT_OBJECTS.map(value => [`value=${JSON.stringify(value)}`, value, RECEIPT_ERROR, 'keys']),
    ]
    checkRows(validateProviderEventReceiptClaims, message, rows)
  })

  it('channel admission', () => {
    const admitted = load('admission.admitted.json')
    const refused = load('admission.refused.no_match.json')
    const refusedClick = load('admission.refused.missing_channel_grant.json')
    const eventField = key => `event.${key}`
    const rows = [
      ...wrongTypeRows('admitted', admitted, ADMISSION_ERROR),
      ...nestedRows('admitted', admitted, 'event', ADMISSION_ERROR, eventField),
      ...wrongTypeRows('refused', refused, ADMISSION_ERROR),
      ...nestedRows('refused', refused, 'event', ADMISSION_ERROR, eventField),
      ...nestedRows('refusedClick', refusedClick, 'event', ADMISSION_ERROR, eventField),
      ['refused with an extra key', { ...refused, memberId: admitted.memberId }, ADMISSION_ERROR, 'keys'],
      ...NOT_OBJECTS.map(value => [`value=${JSON.stringify(value)}`, value, ADMISSION_ERROR, 'value']),
    ]
    checkRows(validateChannelAdmission, admitted, rows)
  })

  it('origin route', () => {
    const thread = load('origin.thread.json')
    const rows = [
      ...wrongTypeRows('thread', thread, ORIGIN_ERROR),
      ...wrongTypeRows('quote', load('origin.quote.json'), ORIGIN_ERROR),
      ...NOT_OBJECTS.map(value => [`value=${JSON.stringify(value)}`, value, ORIGIN_ERROR, 'keys']),
    ]
    checkRows(validateOriginRoute, thread, rows)
  })

  it('Stage 1 execution principal', () => {
    const member = load('principal.member.json')
    const code = 'invalid_execution_principal'
    const rows = [
      ...wrongTypeRows('member', member, code, { kind: 'unknown_principal_kind' }),
      ['member.policyVersion=-1', { ...member, policyVersion: -1 }, code, 'policyVersion'],
      ['member.policyVersion=1.5', { ...member, policyVersion: 1.5 }, code, 'policyVersion'],
      ...NOT_OBJECTS.map(value => [`value=${JSON.stringify(value)}`, value, code, 'value']),
    ]
    checkRows(validateStage1ExecutionPrincipal, member, rows)
  })

  it('refuses integers above Number.MAX_SAFE_INTEGER and accepts the bound', () => {
    const message = load('receipt.slack.message.json')
    const admitted = load('admission.admitted.json')
    const member = load('principal.member.json')
    const MAX = Number.MAX_SAFE_INTEGER
    const accepted = assertAccepts(validateProviderEventReceiptClaims, { ...message, iat: MAX - 600, exp: MAX })
    assert.equal(accepted.exp, MAX)
    assert.equal(assertAccepts(validateChannelAdmission, { ...admitted, policyVersion: MAX }).policyVersion, MAX)
    assert.equal(assertAccepts(validateStage1ExecutionPrincipal, { ...member, policyVersion: MAX }).policyVersion, MAX)
    for (const [label, validator, value, code, field] of [
      ['receipt iat=2**53', validateProviderEventReceiptClaims, { ...message, iat: 2 ** 53, exp: 2 ** 53 + 600 }, RECEIPT_ERROR, 'iat'],
      ['receipt exp=MAX+1', validateProviderEventReceiptClaims, { ...message, iat: MAX - 599, exp: MAX + 1 }, RECEIPT_ERROR, 'exp'],
      ['admission policyVersion=2**53', validateChannelAdmission, { ...admitted, policyVersion: 2 ** 53 }, ADMISSION_ERROR, 'policyVersion'],
      ['principal policyVersion=2**53', validateStage1ExecutionPrincipal, { ...member, policyVersion: 2 ** 53 }, 'invalid_execution_principal', 'policyVersion'],
    ]) {
      assertRejects(validator, value, code, field, label)
    }
  })
})
