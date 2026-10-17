import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { buildGfsResourceDeepLink, normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import { normalizeProfileOrigin, parseGfsResourceLink } from '../gfsResourceLinks'

const uri = 'gfs://main/0123456789abcdef0123456789abcdef'

describe('parseGfsResourceLink', () => {
  it('recognizes exact canonical and Desktop deep links', () => {
    expect(parseGfsResourceLink(uri)).toBe(uri)
    expect(
      parseGfsResourceLink(
        'evenfire://files?uri=gfs%3A%2F%2Fmain%2F0123456789abcdef0123456789abcdef'
      )
    ).toBe(uri)
  })

  it('preserves canonical resource identity through normalization and Desktop-link parsing', () => {
    const driveArbitrary = fc.constantFrom('main', 'Drive_2', 'A', 'work-drive')
    const resourceIdArbitrary = fc
      .array(fc.constantFrom(...'0123456789abcdef'), { minLength: 32, maxLength: 32 })
      .map(characters => characters.join(''))

    fc.assert(
      fc.property(driveArbitrary, resourceIdArbitrary, (drive, resourceId) => {
        const rawUri = `gfs://${drive}/${resourceId.toUpperCase()}`
        const canonicalUri = `gfs://${drive}/${resourceId}`
        expect(normalizeGfsResourceUri(rawUri)).toBe(canonicalUri)
        expect(parseGfsResourceLink(rawUri)).toBe(canonicalUri)
        expect(parseGfsResourceLink(buildGfsResourceDeepLink(rawUri))).toBe(canonicalUri)
      })
    )
  })

  it('accepts Profile links only at the configured origin and exact route', () => {
    const profileOrigin = 'https://profile.example.net'
    expect(
      parseGfsResourceLink(
        `https://profile.example.net/open/files?uri=${encodeURIComponent(uri)}`,
        profileOrigin
      )
    ).toBe(uri)
    expect(
      parseGfsResourceLink(
        `https://attacker.example/open/files?uri=${encodeURIComponent(uri)}`,
        profileOrigin
      )
    ).toBeNull()
    expect(
      parseGfsResourceLink(
        `https://profile.example.net/open/files/other?uri=${encodeURIComponent(uri)}`,
        profileOrigin
      )
    ).toBeNull()
    expect(
      parseGfsResourceLink(
        `https://profile.example.net/open/files?uri=${encodeURIComponent(uri)}&next=https://evil.test`,
        profileOrigin
      )
    ).toBeNull()
  })

  it('fails closed for ambiguous, malformed, or unsupported links', () => {
    expect(parseGfsResourceLink(`https://profile.example.net/open/files?uri=${uri}`)).toBeNull()
    expect(
      parseGfsResourceLink(`https://profile.example.net/open/files?uri=${uri}`, null)
    ).toBeNull()
    expect(parseGfsResourceLink('javascript:alert(1)')).toBeNull()
    expect(parseGfsResourceLink('gfs://main/../../secret')).toBeNull()
    expect(
      parseGfsResourceLink(
        'https://api.example.net/open/files?uri=not-a-gfs-uri',
        'https://api.example.net'
      )
    ).toBeNull()
  })

  it('accepts only canonical HTTP(S) origins from the main-process trust source', () => {
    expect(normalizeProfileOrigin('https://profile.example.net')).toBe(
      'https://profile.example.net'
    )
    expect(normalizeProfileOrigin('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001')
    expect(normalizeProfileOrigin('https://profile.example.net/path')).toBeNull()
    expect(normalizeProfileOrigin('https://profile.example.net?tenant=other')).toBeNull()
    expect(normalizeProfileOrigin('https://user:pass@profile.example.net')).toBeNull()
    expect(normalizeProfileOrigin('javascript:alert(1)')).toBeNull()
  })
})
