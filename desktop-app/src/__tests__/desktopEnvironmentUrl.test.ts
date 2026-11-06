import { describe, expect, it } from 'vitest'
import { canonicalizeDesktopRestEndpoint, sameDesktopRestEndpoint } from '../desktopEnvironmentUrl'

describe('Desktop REST endpoint identity', () => {
  it('ignores trailing path slashes and URL fragments', () => {
    expect(
      canonicalizeDesktopRestEndpoint('https://api.example.test/external-rest-api/#tenant-section')
    ).toBe('https://api.example.test/external-rest-api')
    expect(
      sameDesktopRestEndpoint(
        'https://api.example.test/external-rest-api/',
        'https://api.example.test/external-rest-api'
      )
    ).toBe(true)
  })

  it('keeps different paths on the same REST host distinct', () => {
    expect(
      sameDesktopRestEndpoint(
        'https://api.example.test/external-rest-api/a',
        'https://api.example.test/external-rest-api/b'
      )
    ).toBe(false)
  })
})
