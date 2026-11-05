import { afterEach, describe, expect, it, vi } from 'vitest'
import { config, parseCorsOrigin } from '../src/config.js'

describe('parseCorsOrigin', () => {
  it('splits a comma-separated list and trims whitespace', () => {
    expect(parseCorsOrigin('https://a.example, https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ])
  })

  it('returns a single-element array for one origin', () => {
    expect(parseCorsOrigin('https://only.example')).toEqual(['https://only.example'])
  })

  it("returns the literal '*' for a wildcard", () => {
    expect(parseCorsOrigin('*')).toBe('*')
  })

  it('drops empty entries from trailing or doubled commas', () => {
    expect(parseCorsOrigin('https://a.example,,')).toEqual(['https://a.example'])
  })
})

describe('config', () => {
  it('uses the configured profile session cookie TTL default', () => {
    expect(config.profileSessionCookieTtlSeconds).toBe(604_800)
  })

  it('preserves an explicit profile session cookie TTL override', async () => {
    vi.stubEnv('EXTERNAL_REST_API_PROFILE_SESSION_COOKIE_TTL_SECONDS', '7200')
    vi.resetModules()
    try {
      const overridden = await import('../src/config.js')
      expect(overridden.config.profileSessionCookieTtlSeconds).toBe(7_200)
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it('uses the approved independent GFS edge backstop defaults', () => {
    expect(config.externalGfsEdgeAggregateRlPerMin).toBe(1_800)
    expect(config.externalGfsEdgeAuthenticatedIpRlPerMin).toBe(1_200)
    expect(config.externalGfsEdgeTokenIpRlPerMin).toBe(600)
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})
