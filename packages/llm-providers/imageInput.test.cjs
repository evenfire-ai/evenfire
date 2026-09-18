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
const options = { transportSupported: true, now }

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

test('support is the intersection of model and transport', () => {
  for (const state of ['supported', 'unsupported', 'unknown']) {
    for (const transportSupported of [true, false]) {
      const result = resolveImageInputCapability({ state, evidence }, { now, transportSupported })
      const expected = transportSupported ? state : 'unsupported'
      assert.equal(result.state, expected)
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
  // An unreadable clock is not itself evidence. Without evidence the truthful
  // reason is `model_unknown`; with evidence the same clock still cannot
  // validate it, which is the liveness witness that the branch stays reachable.
  assert.equal(
    resolveImageInputCapability({ state: 'unknown' }, { ...options, now: Number.NaN }).reason,
    'model_unknown'
  )
  assert.equal(
    resolveImageInputCapability(supported, { ...options, now: Number.NaN }).reason,
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

test('hostname policy compares the DNS root dot but preserves the exact reference', () => {
  const original = 'https://docs.z.ai./guides/vlm/glm-5.3-flash'
  const trailingDot = {
    ...supported,
    evidence: { ...evidence, reference: original },
  }
  // A public fully qualified hostname with the DNS root dot is still public.
  assert.deepEqual(parseImageInputCapability(trailingDot), trailingDot)
  assert.deepEqual(normalizeImageInputCapability(trailingDot), {
    state: 'supported',
    evidence: trailingDot.evidence,
  })
  assert.equal(resolveImageInputCapability(trailingDot, options).evidence.reference, original)

  // The trailing dot cannot make an intranet, private, or single-label form
  // pass, and old evidence stored with such a reference stays unknown.
  for (const reference of [
    'https://localhost./docs',
    'https://10.0.0.1./docs',
    'https://catalog.internal./docs',
    'https://docs.local./docs',
    'https://web./docs',
  ]) {
    assert.deepEqual(
      normalizeImageInputCapability({
        ...supported,
        evidence: { ...evidence, reference },
      }),
      { state: 'unknown' }
    )
  }
})
