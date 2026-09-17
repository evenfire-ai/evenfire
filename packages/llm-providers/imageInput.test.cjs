const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  parseImageInputCapability,
  normalizeImageInputCapability,
  resolveImageInputCapability,
} = require('./index.cjs')

const now = Date.parse('2026-09-16T12:00:00Z')
const evidence = {
  source: 'curated',
  reference: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
  checkedAt: '2026-09-16T00:00:00Z',
}
const supported = { state: 'supported', evidence }
const options = { transportSupported: true, policyAllowed: true, now }

test('legacy and malformed evidence remain unknown, without inventing support', () => {
  for (const value of [
    null,
    undefined,
    {},
    true,
    { state: 'supported' },
    { ...supported, extra: true },
    { state: 'supported', evidence: { ...evidence, checkedAt: '2026-02-30T00:00:00Z' } },
    { state: 'supported', evidence: { ...evidence, reference: 'https://localhost/path' } },
    {
      state: 'supported',
      evidence: { ...evidence, reference: 'https://example.com/path?private=value' },
    },
  ]) {
    assert.deepEqual(normalizeImageInputCapability(value), { state: 'unknown' })
  }
  assert.deepEqual(parseImageInputCapability({ state: 'unknown' }), { state: 'unknown' })
})

test('support is the intersection of model, transport, and policy', () => {
  for (const state of ['supported', 'unsupported', 'unknown']) {
    for (const transportSupported of [true, false]) {
      for (const policyAllowed of [true, false]) {
        const result = resolveImageInputCapability(
          { state, evidence },
          { now, transportSupported, policyAllowed }
        )
        const expected = !transportSupported || !policyAllowed ? 'unsupported' : state
        assert.equal(result.state, expected)
      }
    }
  }
})

test('expiry is evaluated at dispatch, including the exact boundary and future evidence', () => {
  const capability = { ...supported, evidence: { ...evidence, validUntil: '2026-09-16T12:00:00Z' } }
  assert.equal(
    resolveImageInputCapability(capability, { ...options, now: now - 1 }).state,
    'supported'
  )
  assert.equal(resolveImageInputCapability(capability, options).reason, 'evidence_expired')
  assert.equal(
    resolveImageInputCapability(supported, { ...options, now: 0 }).reason,
    'evidence_not_yet_valid'
  )
})

test('discovery cannot claim known support without a validity contract', () => {
  const discovery = { ...supported, evidence: { ...evidence, source: 'discovery' } }
  assert.equal(parseImageInputCapability(discovery), null)
  const dated = {
    ...discovery,
    evidence: { ...discovery.evidence, validUntil: '2026-10-01T00:00:00Z' },
  }
  assert.equal(resolveImageInputCapability(dated, options).state, 'supported')
  assert.deepEqual(parseImageInputCapability(supported), supported)
})
