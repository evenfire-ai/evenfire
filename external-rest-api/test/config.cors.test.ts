import { describe, expect, it } from 'vitest'
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
    expect(config.profileSessionCookieTtlSeconds).toBe(60 * 60)
  })
})
