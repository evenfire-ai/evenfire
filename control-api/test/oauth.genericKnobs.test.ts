import { describe, expect, it } from 'vitest'
import {
  GenericConfigSuggestionSchema,
  GenericOAuthKnobsSchema,
} from '../src/oauth/genericKnobs.js'

/**
 * S3-B4 — install-side knob schema. Mirror of the CRD generic fields + the runtime
 * routing shape (the compile-time `_KnobsMatchRuntime` equality in the module is the
 * lockstep guard; these tests cover the runtime validation behaviour).
 */

const VALID = {
  authorizationEndpoint: 'https://idp.example.com/authorize',
  tokenEndpoint: 'https://idp.example.com/token',
  tokenRequestFormat: 'form' as const,
  tokenAuthMethod: 'body' as const,
  scopeSeparator: 'space' as const,
  sendScope: true,
  usePkce: true,
  includeResponseType: true,
  supportsRefresh: true,
}

describe('GenericOAuthKnobsSchema', () => {
  it('accepts the 10 required knobs with no optionals', () => {
    const r = GenericOAuthKnobsSchema.safeParse(VALID)
    expect(r.success).toBe(true)
  })

  it('rejects when any required knob is missing', () => {
    for (const key of Object.keys(VALID)) {
      const { [key]: _drop, ...rest } = VALID as Record<string, unknown>
      expect(GenericOAuthKnobsSchema.safeParse(rest).success).toBe(false)
    }
  })

  it('rejects an unknown extra field (strict)', () => {
    expect(GenericOAuthKnobsSchema.safeParse({ ...VALID, provider: 'google' }).success).toBe(false)
    expect(GenericOAuthKnobsSchema.safeParse({ ...VALID, clientMode: 'public' }).success).toBe(
      false
    )
  })

  it('rejects a bad enum value', () => {
    expect(GenericOAuthKnobsSchema.safeParse({ ...VALID, tokenRequestFormat: 'xml' }).success).toBe(
      false
    )
    expect(GenericOAuthKnobsSchema.safeParse({ ...VALID, tokenAuthMethod: 'header' }).success).toBe(
      false
    )
  })

  it('accepts the optional knobs (refreshEndpoint, resource, extraAuthorizeParams)', () => {
    const r = GenericOAuthKnobsSchema.safeParse({
      ...VALID,
      refreshEndpoint: 'https://idp.example.com/refresh',
      resource: 'https://api.example.com',
      extraAuthorizeParams: { audience: 'aud-1' },
    })
    expect(r.success).toBe(true)
  })

  it('rejects more than 16 extra authorize params', () => {
    const many: Record<string, string> = {}
    for (let i = 0; i < 17; i++) many[`k${i}`] = 'v'
    expect(
      GenericOAuthKnobsSchema.safeParse({ ...VALID, extraAuthorizeParams: many }).success
    ).toBe(false)
  })

  it('rejects an extra param value longer than 1024 chars', () => {
    expect(
      GenericOAuthKnobsSchema.safeParse({
        ...VALID,
        extraAuthorizeParams: { big: 'x'.repeat(1025) },
      }).success
    ).toBe(false)
  })
})

describe('GenericConfigSuggestionSchema (E-19.6)', () => {
  it('accepts a partial suggestion (every knob optional)', () => {
    expect(GenericConfigSuggestionSchema.safeParse({ usePkce: false }).success).toBe(true)
    expect(GenericConfigSuggestionSchema.safeParse({}).success).toBe(true)
  })

  it('still rejects unknown keys and bad types', () => {
    expect(GenericConfigSuggestionSchema.safeParse({ provider: 'google' }).success).toBe(false)
    expect(GenericConfigSuggestionSchema.safeParse({ sendScope: 'yes' }).success).toBe(false)
  })
})
