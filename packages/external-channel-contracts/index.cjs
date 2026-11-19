'use strict'

// Shared External Channels contracts. Every validator reads its input once: it
// takes a deep-frozen snapshot of the value's own enumerable data properties
// and of the nested records the contract names, checks the exact key set of
// that snapshot (unknown and missing keys are both rejected) and returns it. A
// record with an accessor, a symbol key or a non-enumerable own key is refused.
// Every validator throws an Error whose `code` is fixed per contract. Error
// messages name the field only, never its value: the values are provider and
// member identifiers.

const ADMISSION_REFUSAL_REASONS = Object.freeze([
  'receipt_invalid',
  'no_match',
  'identity_quarantined',
  'excluded',
  'not_eligible_guest',
  'not_eligible_external',
  'not_eligible_deactivated',
  'not_eligible_bot',
  'lookup_permission_missing',
  'eligibility_unavailable',
  'audience_not_ready',
  'missing_agent_grant',
  'missing_channel_grant',
])

const PAUSE_OUTCOMES = Object.freeze(['approved', 'approved_always', 'denied', 'timed_out', 'cancelled', 'superseded'])

const CALLBACK_REFUSALS = Object.freeze([
  'not_an_action',
  'request_mismatch',
  'decision_mismatch',
  'unknown_request',
  'already_decided',
  'expired',
  'not_admitted',
  'not_responder',
  'wrong_conversation',
])

const CONVERSATION_KINDS = Object.freeze(['direct', 'group', 'channel'])

const PROVIDER_EVENT_RECEIPT_AUDIENCE = 'evenfire-provider-event'
const PROVIDER_EVENT_RECEIPT_HEADER_TYPE = 'provider-event-receipt+jwt'
const PROVIDER_EVENT_RECEIPT_TTL_SECONDS = 600

const PAUSE_ACTION_DECISIONS = Object.freeze(['approve', 'approve_always', 'deny', 'connect'])

// a approve, l approve always, d deny (also Cancel on a Connect card), c connect
const PAUSE_ACTION_VALUE_PATTERN = /^tool:([aldc]):([A-Za-z0-9_-]{16,64})$/
const PAUSE_ACTION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const DECISION_BY_CODE = Object.freeze({ a: 'approve', l: 'approve_always', d: 'deny', c: 'connect' })

const EXECUTION_PRINCIPAL_KINDS = Object.freeze(['member', 'bot'])

const MEDIUMS = Object.freeze(['slack', 'teams'])
const EVENT_KINDS = Object.freeze(['message', 'action'])
const ATTESTING_COMPONENTS = Object.freeze(['control-api', 'approval-reader'])
const AUDIENCE_MODES = Object.freeze(['members', 'workspace'])
const REFUSAL_NOTICES = Object.freeze(['private', 'origin_generic', 'none'])
const REPLY_STYLES = Object.freeze(['thread', 'conversation', 'quote'])
const CHANNEL_REF_PATTERN = /^[^/\s]+\/[^/\s]+$/
const TEAMS_MESSAGE_ID_SUFFIX = ';messageid='

const RECEIPT_KEYS = Object.freeze([
  'ver',
  'medium',
  'channelRef',
  'hostRef',
  'providerScopeId',
  'providerOrgId',
  'providerAccountId',
  'deliveryAlias',
  'senderScopeId',
  'conversationId',
  'conversationKind',
  'threadRootId',
  'messageId',
  'eventId',
  'eventKind',
  'action',
  'attestedBy',
  'aud',
  'jti',
  'iat',
  'exp',
])
const ADMISSION_EVENT_KEYS = Object.freeze([
  'providerAccountId',
  'deliveryAlias',
  'conversationId',
  'conversationKind',
  'threadRootId',
  'messageId',
  'eventKind',
  'action',
])
const ADMITTED_KEYS = Object.freeze(['outcome', 'memberId', 'identityId', 'audienceMode', 'policyVersion', 'event'])
const REFUSED_KEYS = Object.freeze(['outcome', 'reason', 'notice', 'event'])
const ORIGIN_ROUTE_KEYS = Object.freeze([
  'medium',
  'channelRef',
  'conversationId',
  'conversationKind',
  'threadRootId',
  'replyStyle',
])
const MEMBER_PRINCIPAL_KEYS = Object.freeze(['kind', 'memberId', 'identityId', 'conversationKind', 'policyVersion'])
const PAUSE_ACTION_KEYS = Object.freeze(['decision', 'token'])

function contractError(code, field) {
  const error = new Error(`${code}: ${field}`)
  error.code = code
  return error
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isText(value) {
  return typeof value === 'string' && value.length > 0
}

function isTextOrNull(value) {
  return value === null || isText(value)
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

// The nested positions each contract names: only these records are snapshotted
// in turn, so the depth stays bounded whatever the input holds.
const NO_NESTED_RECORDS = Object.freeze({})
const RECEIPT_NESTED_RECORDS = Object.freeze({ action: NO_NESTED_RECORDS })
const ADMISSION_NESTED_RECORDS = Object.freeze({ event: RECEIPT_NESTED_RECORDS })

// Reads every own key once through its descriptor, never through [[Get]], so no
// getter and no Proxy get trap runs. A record with a symbol key, a key without a
// descriptor, a non-enumerable key or an accessor has no data snapshot and
// yields undefined, which every validator refuses at that position.
function frozenSnapshot(value, nested) {
  if (!isRecord(value)) return value
  const copy = {}
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return undefined
    }
    // defineProperty, not assignment: an own __proto__ key stays a key.
    Object.defineProperty(copy, key, {
      value: Object.hasOwn(nested, key) ? frozenSnapshot(descriptor.value, nested[key]) : descriptor.value,
      enumerable: true,
    })
  }
  return Object.freeze(copy)
}

function checker(code) {
  return (condition, field) => {
    if (!condition) throw contractError(code, field)
  }
}

function parsePauseActionValue(text) {
  if (typeof text !== 'string') return null
  const match = PAUSE_ACTION_VALUE_PATTERN.exec(text)
  if (!match) return null
  return Object.freeze({ decision: DECISION_BY_CODE[match[1]], token: match[2] })
}

function isPauseAction(value) {
  return (
    hasExactKeys(value, PAUSE_ACTION_KEYS) &&
    PAUSE_ACTION_DECISIONS.includes(value.decision) &&
    typeof value.token === 'string' &&
    PAUSE_ACTION_TOKEN_PATTERN.test(value.token)
  )
}

// Rules shared by the receipt and by the event block an admission copies from it.
function checkEventFields(value, check) {
  check(isText(value.providerAccountId), 'providerAccountId')
  check(isTextOrNull(value.deliveryAlias), 'deliveryAlias')
  check(isText(value.conversationId), 'conversationId')
  check(isTextOrNull(value.threadRootId), 'threadRootId')
  check(isText(value.messageId), 'messageId')
  check(EVENT_KINDS.includes(value.eventKind), 'eventKind')
  if (value.eventKind === 'message') {
    check(CONVERSATION_KINDS.includes(value.conversationKind), 'conversationKind')
    check(value.action === null, 'action')
  } else {
    check(value.conversationKind === null, 'conversationKind')
    check(value.action === null || isPauseAction(value.action), 'action')
  }
}

const checkReceipt = checker('invalid_provider_event_receipt')

function validateProviderEventReceiptClaims(input) {
  const value = frozenSnapshot(input, RECEIPT_NESTED_RECORDS)
  checkReceipt(hasExactKeys(value, RECEIPT_KEYS), 'keys')
  checkReceipt(value.ver === 1, 'ver')
  checkReceipt(MEDIUMS.includes(value.medium), 'medium')
  checkReceipt(isText(value.channelRef) && CHANNEL_REF_PATTERN.test(value.channelRef), 'channelRef')
  checkReceipt(isText(value.hostRef), 'hostRef')
  checkReceipt(isText(value.providerScopeId), 'providerScopeId')
  checkReceipt(isTextOrNull(value.providerOrgId), 'providerOrgId')
  checkReceipt(isTextOrNull(value.senderScopeId), 'senderScopeId')
  checkEventFields(value, checkReceipt)
  if (value.medium === 'slack') {
    checkReceipt(value.deliveryAlias === null, 'deliveryAlias')
  } else {
    checkReceipt(value.providerOrgId === null, 'providerOrgId')
    checkReceipt(!value.conversationId.includes(TEAMS_MESSAGE_ID_SUFFIX), 'conversationId')
  }
  checkReceipt(isText(value.eventId), 'eventId')
  checkReceipt(ATTESTING_COMPONENTS.includes(value.attestedBy), 'attestedBy')
  // A single string, equal to the audience constant: an array of audiences is refused.
  checkReceipt(value.aud === PROVIDER_EVENT_RECEIPT_AUDIENCE, 'aud')
  checkReceipt(isText(value.jti), 'jti')
  checkReceipt(isPositiveInteger(value.iat), 'iat')
  checkReceipt(isPositiveInteger(value.exp) && value.exp - value.iat === PROVIDER_EVENT_RECEIPT_TTL_SECONDS, 'exp')
  return value
}

const checkAdmission = checker('invalid_channel_admission')

function checkAdmissionEvent(event) {
  checkAdmission(hasExactKeys(event, ADMISSION_EVENT_KEYS), 'event')
  checkEventFields(event, (condition, field) => checkAdmission(condition, `event.${field}`))
}

function validateChannelAdmission(input) {
  const value = frozenSnapshot(input, ADMISSION_NESTED_RECORDS)
  checkAdmission(isRecord(value), 'value')
  if (value.outcome === 'admitted') {
    checkAdmission(hasExactKeys(value, ADMITTED_KEYS), 'keys')
    checkAdmission(isText(value.memberId), 'memberId')
    checkAdmission(isText(value.identityId), 'identityId')
    checkAdmission(AUDIENCE_MODES.includes(value.audienceMode), 'audienceMode')
    checkAdmission(Number.isSafeInteger(value.policyVersion) && value.policyVersion >= 0, 'policyVersion')
    checkAdmissionEvent(value.event)
  } else if (value.outcome === 'refused') {
    checkAdmission(hasExactKeys(value, REFUSED_KEYS), 'keys')
    checkAdmission(ADMISSION_REFUSAL_REASONS.includes(value.reason), 'reason')
    checkAdmission(REFUSAL_NOTICES.includes(value.notice), 'notice')
    // The event block is null only when the receipt itself did not verify.
    if (value.reason === 'receipt_invalid') {
      checkAdmission(value.event === null, 'event')
    } else {
      checkAdmissionEvent(value.event)
    }
  } else {
    throw contractError('invalid_channel_admission', 'outcome')
  }
  return value
}

const checkOrigin = checker('invalid_origin_route')

function validateOriginRoute(input) {
  const value = frozenSnapshot(input, NO_NESTED_RECORDS)
  const keys = isRecord(value) && Object.hasOwn(value, 'quotedMessageId')
    ? [...ORIGIN_ROUTE_KEYS, 'quotedMessageId']
    : ORIGIN_ROUTE_KEYS
  checkOrigin(hasExactKeys(value, keys), 'keys')
  checkOrigin(MEDIUMS.includes(value.medium), 'medium')
  checkOrigin(isText(value.channelRef) && CHANNEL_REF_PATTERN.test(value.channelRef), 'channelRef')
  checkOrigin(isText(value.conversationId), 'conversationId')
  checkOrigin(CONVERSATION_KINDS.includes(value.conversationKind), 'conversationKind')
  checkOrigin(isTextOrNull(value.threadRootId), 'threadRootId')
  checkOrigin(REPLY_STYLES.includes(value.replyStyle), 'replyStyle')
  if (Object.hasOwn(value, 'quotedMessageId')) checkOrigin(isText(value.quotedMessageId), 'quotedMessageId')
  return value
}

const checkPrincipal = checker('invalid_execution_principal')

function validateStage1ExecutionPrincipal(input) {
  const value = frozenSnapshot(input, NO_NESTED_RECORDS)
  checkPrincipal(isRecord(value), 'value')
  // The snapshot is taken first: a record with an accessor, a symbol key or a non-enumerable own key is refused with value.
  // On a snapshot the kind is discriminated before the shape, so a bot or an unknown kind is refused with its own code whatever other enumerable data properties it carries.
  if (value.kind === 'bot') throw contractError('stage1_bot_principal', 'kind')
  if (value.kind !== 'member') throw contractError('unknown_principal_kind', 'kind')
  checkPrincipal(hasExactKeys(value, MEMBER_PRINCIPAL_KEYS), 'keys')
  checkPrincipal(isText(value.memberId), 'memberId')
  checkPrincipal(isText(value.identityId), 'identityId')
  checkPrincipal(CONVERSATION_KINDS.includes(value.conversationKind), 'conversationKind')
  checkPrincipal(Number.isSafeInteger(value.policyVersion) && value.policyVersion >= 0, 'policyVersion')
  return value
}

module.exports = {
  ADMISSION_REFUSAL_REASONS,
  PAUSE_OUTCOMES,
  CALLBACK_REFUSALS,
  CONVERSATION_KINDS,
  PROVIDER_EVENT_RECEIPT_AUDIENCE,
  PROVIDER_EVENT_RECEIPT_HEADER_TYPE,
  PROVIDER_EVENT_RECEIPT_TTL_SECONDS,
  PAUSE_ACTION_DECISIONS,
  PAUSE_ACTION_VALUE_PATTERN,
  EXECUTION_PRINCIPAL_KINDS,
  parsePauseActionValue,
  validateProviderEventReceiptClaims,
  validateChannelAdmission,
  validateOriginRoute,
  validateStage1ExecutionPrincipal,
}
