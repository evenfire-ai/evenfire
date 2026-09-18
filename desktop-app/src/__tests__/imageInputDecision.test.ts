import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  IMAGE_INPUT_LOCAL_REASON,
  type ImageInputDecision,
  canSendImagesWith,
  imageInputBlockMessage,
  normalizeImageInputDecision,
  resolveImageInputDecision,
  resolveModelImageInput,
} from '../imageInputDecision'

// The Host-side producer of the decisions this module validates. Loaded by
// relative path from the test only, so the fixtures are the producer's real
// output rather than hand-written copies of it.
const producer = require('../../../packages/llm-providers/imageInput.cjs') as {
  resolveImageInputCapability: (
    value: unknown,
    options: { now?: number; transportSupported?: boolean }
  ) => ImageInputDecision
}

describe('imageInputDecision — wire normalization', () => {
  it('treats a missing decision as unknown (legacy host, absent metadata)', () => {
    expect(normalizeImageInputDecision(undefined)).toEqual({
      state: 'unknown',
      reason: 'model_unknown',
    })
    expect(normalizeImageInputDecision(null)).toEqual({
      state: 'unknown',
      reason: 'model_unknown',
    })
  })

  it('normalizes malformed payloads to unknown instead of unsupported', () => {
    expect(normalizeImageInputDecision('supported')).toEqual({
      state: 'unknown',
      reason: 'model_unknown',
    })
    expect(normalizeImageInputDecision({ state: 'maybe' })).toEqual({
      state: 'unknown',
      reason: 'model_unknown',
    })
    expect(normalizeImageInputDecision({ state: 'supported', validUntil: 'not-a-date' })).toEqual({
      state: 'unknown',
      reason: 'model_unknown',
    })
  })

  it('preserves the host reason and state verbatim', () => {
    expect(
      normalizeImageInputDecision({ state: 'unsupported', reason: 'provider_text_only' })
    ).toEqual({ state: 'unsupported', reason: 'provider_text_only' })
    expect(normalizeImageInputDecision({ state: 'supported', reason: 'curated_2026_09' })).toEqual({
      state: 'supported',
      reason: 'curated_2026_09',
    })
  })
})

describe('imageInputDecision — freshness', () => {
  const now = Date.parse('2026-09-16T10:00:00.000Z')

  it('keeps a supported decision whose evidence is still valid', () => {
    const decision = resolveImageInputDecision(
      { state: 'supported', reason: 'curated', validUntil: '2026-09-17T00:00:00.000Z' },
      now
    )
    expect(decision.state).toBe('supported')
    expect(canSendImagesWith(decision)).toBe(true)
  })

  it('downgrades expired evidence to unknown at read time (no catalog change needed)', () => {
    const decision = resolveImageInputDecision(
      { state: 'supported', reason: 'curated', validUntil: '2026-09-15T00:00:00.000Z' },
      now
    )
    expect(decision).toEqual({
      state: 'unknown',
      reason: IMAGE_INPUT_LOCAL_REASON.evidenceExpired,
      validUntil: '2026-09-15T00:00:00.000Z',
    })
    expect(canSendImagesWith(decision)).toBe(false)
  })

  it('treats an expired denial as stale evidence (unknown, not a lasting denial)', () => {
    const decision = resolveImageInputDecision(
      { state: 'unsupported', reason: 'text_only', validUntil: '2026-09-01T00:00:00.000Z' },
      now
    )
    expect(decision).toEqual({
      state: 'unknown',
      reason: IMAGE_INPUT_LOCAL_REASON.evidenceExpired,
      validUntil: '2026-09-01T00:00:00.000Z',
    })
    expect(canSendImagesWith(decision)).toBe(false)
  })
})

describe('imageInputDecision — effective model resolution', () => {
  const models = [
    { name: 'glm-5.3', imageInput: { state: 'unsupported', reason: 'text_only' } },
    { name: 'glm-5.3-flash', imageInput: { state: 'supported', reason: 'curated' } },
    { name: 'legacy-model' },
  ]

  it('resolves the capability of the model that will be requested', () => {
    expect(resolveModelImageInput(models, 'glm-5.3-flash').state).toBe('supported')
    expect(resolveModelImageInput(models, 'glm-5.3').state).toBe('unsupported')
    expect(resolveModelImageInput(models, 'legacy-model')).toEqual({
      state: 'unknown',
      reason: 'model_unknown',
    })
  })

  it('never falls back to another model or provider', () => {
    expect(resolveModelImageInput(models, 'not-in-catalog')).toEqual({
      state: 'unknown',
      reason: 'model_unknown',
    })
    expect(resolveModelImageInput(models, '')).toEqual({
      state: 'unknown',
      reason: 'model_unknown',
    })
    expect(resolveModelImageInput(null, 'glm-5.3-flash')).toEqual({
      state: 'unknown',
      reason: 'model_unknown',
    })
  })
})

describe('imageInputDecision — user copy', () => {
  it.each([
    ['model_unsupported', 'unsupported', /not supported by model "glm-5\.3"/],
    ['model_unknown', 'unknown', /not verified for model "glm-5\.3"/],
    ['evidence_expired', 'unknown', /evidence for model "glm-5\.3" has expired/],
    ['evidence_not_yet_valid', 'unknown', /dated in the future/],
    ['transport_unsupported', 'unsupported', /provider transport/],
  ] as const)('explains the %s reason with its own message', (reason, state, expected) => {
    expect(imageInputBlockMessage('glm-5.3', { state, reason })).toMatch(expected)
  })

  it('treats a reason it does not know as unverified', () => {
    expect(
      imageInputBlockMessage('glm-5.3', { state: 'unsupported', reason: 'text_only' })
    ).toMatch(/not verified for model "glm-5\.3"/)
  })

  it('returns no message when images are allowed', () => {
    expect(imageInputBlockMessage('glm-5.3-flash', { state: 'supported', reason: 'curated' })).toBe(
      null
    )
  })
})

const PRODUCER_T0 = Date.parse('2026-09-01T00:00:00.000Z')
const isoAt = (ms: number) => new Date(ms).toISOString()

/** A decision exactly as the Host producer emits it for curated evidence. */
function producedDecision(state: 'supported' | 'unsupported'): ImageInputDecision {
  return producer.resolveImageInputCapability(
    {
      state,
      evidence: {
        source: 'curated',
        reference: 'evidence:glm-5.3-flash',
        checkedAt: isoAt(PRODUCER_T0),
        validUntil: isoAt(PRODUCER_T0 + 60_000),
      },
    },
    { now: PRODUCER_T0 + 1_000, transportSupported: true }
  )
}

describe('imageInputDecision — evidence produced by the Host', () => {
  const now = PRODUCER_T0 + 1_000

  it.each([
    ['supported', 'supported'],
    ['unsupported', 'model_unsupported'],
  ] as const)('round-trips valid %s evidence unchanged', (state, reason) => {
    const produced = producedDecision(state)
    // Witness: the fixture really carries evidence and the shared bound.
    expect(produced).toMatchObject({ state, reason, validUntil: isoAt(PRODUCER_T0 + 60_000) })
    expect(produced.evidence?.validUntil).toBe(produced.validUntil)

    expect(normalizeImageInputDecision(produced)).toEqual(produced)
    expect(resolveImageInputDecision(produced, now)).toEqual(produced)
  })

  it('rejects evidence whose validUntil differs from the decision bound', () => {
    const produced = producedDecision('supported')
    expect(resolveImageInputDecision(produced, now).state).toBe('supported')

    const mismatched = {
      ...produced,
      evidence: { ...produced.evidence, validUntil: isoAt(PRODUCER_T0 + 999_999) },
    }
    expect(normalizeImageInputDecision(mismatched)).toEqual({
      state: 'unknown',
      reason: IMAGE_INPUT_LOCAL_REASON.modelUnknown,
    })
  })

  it('rejects expiring evidence when the top-level validUntil is missing', () => {
    const { validUntil, ...withoutBound } = producedDecision('supported')
    // Witness: the bound existed and only the top-level copy was dropped.
    expect(validUntil).toBe(isoAt(PRODUCER_T0 + 60_000))
    expect(withoutBound.evidence?.validUntil).toBe(validUntil)

    expect(normalizeImageInputDecision(withoutBound)).toEqual({
      state: 'unknown',
      reason: IMAGE_INPUT_LOCAL_REASON.modelUnknown,
    })
  })

  it.each([
    ['checkedAt', { checkedAt: 'not-a-date' }],
    ['source', { source: 'manual' }],
  ] as const)('rejects evidence with an invalid %s', (_field, patch) => {
    const produced = producedDecision('supported')
    expect(normalizeImageInputDecision(produced).state).toBe('supported')

    const invalid = { ...produced, evidence: { ...produced.evidence, ...patch } }
    expect(normalizeImageInputDecision(invalid)).toEqual({
      state: 'unknown',
      reason: IMAGE_INPUT_LOCAL_REASON.modelUnknown,
    })
  })
})

describe('imageInputDecision — parity with the Host producer', () => {
  it('never authorizes what the producer would not, emits only producer reasons, and is idempotent', () => {
    const producerReasons = new Set<string>()
    const desktopReasons = new Set<string>()
    const seen = { supported: 0, expired: 0 }

    fc.assert(
      fc.property(
        fc.constantFrom('supported', 'unsupported', 'unknown'),
        fc.constantFrom('curated', 'discovery'),
        fc.constantFrom('evidence:glm-5.3', 'evidence:catalog/glm-5.3-flash'),
        fc.integer({ min: 1, max: 10_000 }),
        fc.option(fc.integer({ min: 1, max: 10_000 }), { nil: undefined }),
        fc.integer({ min: 0, max: 20_000 }),
        fc.integer({ min: 0, max: 20_000 }),
        fc.boolean(),
        (
          state,
          source,
          reference,
          checkedOffset,
          validOffset,
          hostOffset,
          desktopDelay,
          transportSupported
        ) => {
          const checkedAt = PRODUCER_T0 + checkedOffset
          const capability = {
            state,
            evidence: {
              source,
              reference,
              checkedAt: isoAt(checkedAt),
              ...(validOffset === undefined ? {} : { validUntil: isoAt(checkedAt + validOffset) }),
            },
          }
          const hostNow = PRODUCER_T0 + hostOffset
          // The desktop evaluates the Host's decision at or after the Host made it.
          const desktopNow = hostNow + desktopDelay

          const hostDecision = producer.resolveImageInputCapability(capability, {
            now: hostNow,
            transportSupported,
          })
          const desktopView = resolveImageInputDecision(hostDecision, desktopNow)
          const producerAtDesktopClock = producer.resolveImageInputCapability(capability, {
            now: desktopNow,
            transportSupported,
          })

          producerReasons.add(hostDecision.reason)
          producerReasons.add(producerAtDesktopClock.reason)
          desktopReasons.add(desktopView.reason)

          if (desktopView.state === 'supported') {
            seen.supported += 1
            expect(producerAtDesktopClock.state).toBe('supported')
          }
          if (desktopView.reason === IMAGE_INPUT_LOCAL_REASON.evidenceExpired) seen.expired += 1
          expect(resolveImageInputDecision(desktopView, desktopNow)).toEqual(desktopView)
        }
      ),
      { numRuns: 3000 }
    )

    // Witnesses: both the authorizing and the expiring branches were exercised.
    expect(seen.supported).toBeGreaterThan(0)
    expect(seen.expired).toBeGreaterThan(0)
    expect(desktopReasons.size).toBeGreaterThan(1)
    for (const reason of desktopReasons) expect(producerReasons).toContain(reason)
  })
})
