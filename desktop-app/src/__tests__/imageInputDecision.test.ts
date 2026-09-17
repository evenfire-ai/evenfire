import { describe, expect, it } from 'vitest'
import {
  IMAGE_INPUT_LOCAL_REASON,
  canSendImagesWith,
  imageInputBlockMessage,
  normalizeImageInputDecision,
  resolveImageInputDecision,
  resolveModelImageInput,
} from '../imageInputDecision'

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
  it('explains an unsupported model without implying a provider rule', () => {
    const message = imageInputBlockMessage('glm-5.3', {
      state: 'unsupported',
      reason: 'text_only',
    })
    expect(message).toMatch(/not supported by model "glm-5\.3"/)
  })

  it('distinguishes "not verified" from "not supported"', () => {
    const message = imageInputBlockMessage('legacy-model', {
      state: 'unknown',
      reason: 'model_unknown',
    })
    expect(message).toMatch(/not verified/)
  })

  it('returns no message when images are allowed', () => {
    expect(imageInputBlockMessage('glm-5.3-flash', { state: 'supported', reason: 'curated' })).toBe(
      null
    )
  })
})
