import { describe, expect, it } from 'vitest'
import { parseArtifactDownloadMaxBytes, parseSandboxUiAllowedPorts } from '../config.js'

describe('parseSandboxUiAllowedPorts', () => {
  it('accepts a single port', () => {
    const set = parseSandboxUiAllowedPorts('8080')
    expect(set.has(8080)).toBe(true)
    expect(set.size).toBe(1)
  })

  it('accepts a comma-separated list', () => {
    const set = parseSandboxUiAllowedPorts('80, 443, 8080')
    expect([...set].sort((a, b) => a - b)).toEqual([80, 443, 8080])
  })

  it('rejects an empty list', () => {
    expect(() => parseSandboxUiAllowedPorts('')).toThrow(/at least one port/)
  })

  it('rejects out-of-range', () => {
    expect(() => parseSandboxUiAllowedPorts('70000')).toThrow(/invalid port/)
  })

  it('rejects non-numeric', () => {
    expect(() => parseSandboxUiAllowedPorts('abc')).toThrow(/invalid port/)
  })
})

describe('parseArtifactDownloadMaxBytes', () => {
  it('converts megabytes to bytes', () => {
    expect(parseArtifactDownloadMaxBytes('50')).toBe(50 * 1024 * 1024)
  })

  it('accepts fractional megabytes for small local caps', () => {
    expect(parseArtifactDownloadMaxBytes('0.5')).toBe(512 * 1024)
  })

  it('rejects zero and negative values', () => {
    expect(() => parseArtifactDownloadMaxBytes('0')).toThrow(/must be > 0/)
    expect(() => parseArtifactDownloadMaxBytes('-1')).toThrow(/must be > 0/)
  })

  it('rejects non-numeric values', () => {
    expect(() => parseArtifactDownloadMaxBytes('big')).toThrow(/invalid value/)
  })
})
