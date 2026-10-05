import { describe, expect, it } from 'vitest'
import { buildCimdDocument } from '../src/oauth/cimd.js'
import { MAX_CLIENT_ID_LENGTH, isCimdClientId } from '../src/oauth/cimdIdentity.js'

describe('isCimdClientId', () => {
  it('matches the served CIMD client_id and its routed spellings, on any origin', () => {
    const served = buildCimdDocument('https://control.example.com').client_id
    expect(isCimdClientId(served)).toBe(true)
    expect(isCimdClientId(`${served}/`)).toBe(true)
    expect(isCimdClientId(served.toUpperCase())).toBe(true)
    expect(isCimdClientId(buildCimdDocument('https://old.example.org').client_id)).toBe(true)
  })

  it('rejects other ids, non-strings and non-URLs', () => {
    for (const value of [
      'client-abc',
      '',
      undefined,
      42,
      'https://control.example.com/.well-known/evenfire-mcp-client',
      'https://control.example.com/api/v1/.well-known/evenfire-mcp-client/extra',
    ]) {
      expect(isCimdClientId(value)).toBe(false)
    }
  })

  it('the cap is the CRD maxLength of spec.oauth.id (512): at it still matches, above it never', () => {
    expect(MAX_CLIENT_ID_LENGTH).toBe(512)
    const served = buildCimdDocument('https://control.example.com').client_id
    const atCap = `${served}?${'x'.repeat(MAX_CLIENT_ID_LENGTH - served.length - 1)}`
    expect(atCap.length).toBe(MAX_CLIENT_ID_LENGTH)
    expect(isCimdClientId(atCap)).toBe(true)
    expect(isCimdClientId(`${atCap}x`)).toBe(false)
  })

  // A run of slashes before a non-slash made the trailing-slash pattern backtrack
  // quadratically on attacker-supplied ids (a DCR response or an operator client_id).
  it('answers a 200k-slash id quickly', () => {
    const hostile = `https://as.example.com/${'/'.repeat(200_000)}a`
    const started = performance.now()
    expect(isCimdClientId(hostile)).toBe(false)
    expect(performance.now() - started).toBeLessThan(200)
  })
})
