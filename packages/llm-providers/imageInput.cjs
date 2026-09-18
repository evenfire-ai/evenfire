'use strict'

// Model evidence is independent of transport implementation and authorization.
// Invalid/legacy metadata must never become affirmative support.
const STATES = new Set(['supported', 'unsupported', 'unknown'])
const SOURCES = new Set(['curated', 'discovery'])

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.includes(key))
}

function validDate(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return false
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return false
  const canonical = date.toISOString()
  return value === canonical || value === canonical.replace('.000Z', 'Z')
}

function validReference(value) {
  if (typeof value !== 'string' || value.length > 1024) return false
  if (/^evidence:[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(value)) return true
  try {
    const url = new URL(value)
    // A DNS root dot is not part of the hostname. Policy decisions compare the
    // normalized form so a trailing dot cannot bypass intranet rejection, while
    // the caller's exact reference string is preserved for storage and output.
    const hostname = url.hostname.replace(/\.+$/, '')
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/[\s\u0000-\u001f\u007f]/.test(value) &&
      hostname !== '' &&
      !/^(?:localhost|[\d.]+|\[)/i.test(hostname) &&
      !/\.(?:local|internal|localhost)$/i.test(hostname) &&
      hostname.includes('.')
    )
  } catch {
    return false
  }
}

function parseImageInputCapability(value) {
  if (!record(value) || !onlyKeys(value, ['state', 'evidence']) || !STATES.has(value.state))
    return null
  if (value.evidence === undefined) return value.state === 'unknown' ? { state: 'unknown' } : null
  const evidence = value.evidence
  if (
    !record(evidence) ||
    !onlyKeys(evidence, ['source', 'reference', 'checkedAt', 'validUntil']) ||
    !SOURCES.has(evidence.source) ||
    !validReference(evidence.reference) ||
    !validDate(evidence.checkedAt)
  )
    return null
  if (
    evidence.validUntil !== undefined &&
    (!validDate(evidence.validUntil) ||
      Date.parse(evidence.validUntil) <= Date.parse(evidence.checkedAt))
  )
    return null
  // Discovery has no inherent freshness guarantee. Known support requires an
  // explicit validity bound; merely downloading an old snapshot is not proof.
  if (value.state !== 'unknown' && evidence.source === 'discovery' && !evidence.validUntil)
    return null
  return {
    state: value.state,
    evidence: {
      source: evidence.source,
      reference: evidence.reference,
      checkedAt: evidence.checkedAt,
      ...(evidence.validUntil === undefined ? {} : { validUntil: evidence.validUntil }),
    },
  }
}

function normalizeImageInputCapability(value) {
  return parseImageInputCapability(value) ?? { state: 'unknown' }
}

function resolveImageInputCapability(value, options) {
  const capability = normalizeImageInputCapability(value)
  const now = options.now ?? Date.now()
  const validity = capability.evidence?.validUntil
  const dates = {
    ...(capability.evidence ? { evidence: capability.evidence } : {}),
    ...(validity ? { validUntil: validity } : {}),
  }
  if (options.policyAllowed !== true)
    return { state: 'unsupported', reason: 'policy_denied', ...dates }
  if (options.transportSupported !== true)
    return { state: 'unsupported', reason: 'transport_unsupported', ...dates }
  // A non-finite clock cannot validate evidence, but it is not itself a reason
  // to claim evidence exists: without evidence the truthful answer is
  // `model_unknown`, reached below.
  if (
    capability.evidence &&
    (!Number.isFinite(now) || Date.parse(capability.evidence.checkedAt) > now)
  ) {
    return { state: 'unknown', reason: 'evidence_not_yet_valid', ...dates }
  }
  if (validity && Date.parse(validity) <= now)
    return { state: 'unknown', reason: 'evidence_expired', ...dates }
  if (capability.state === 'unknown') return { state: 'unknown', reason: 'model_unknown', ...dates }
  return {
    state: capability.state,
    reason: capability.state === 'supported' ? 'supported' : 'model_unsupported',
    ...dates,
  }
}

module.exports = {
  parseImageInputCapability,
  normalizeImageInputCapability,
  resolveImageInputCapability,
}
