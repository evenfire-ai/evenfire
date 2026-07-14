import { describe, expect, it } from 'vitest'
import { parseK8sApiCidrs, parseNodeLocalDnsCidr } from '../src/k8sApiCidrs'

describe('parseK8sApiCidrs', () => {
  it('returns [] for undefined', () => {
    expect(parseK8sApiCidrs(undefined)).toEqual([])
  })

  it('returns [] for empty / whitespace-only', () => {
    expect(parseK8sApiCidrs('')).toEqual([])
    expect(parseK8sApiCidrs('   ')).toEqual([])
  })

  it('accepts a single /32', () => {
    expect(parseK8sApiCidrs('203.0.113.10/32')).toEqual(['203.0.113.10/32'])
  })

  it('accepts two CIDRs and trims whitespace', () => {
    expect(parseK8sApiCidrs(' 203.0.113.10/32 , 10.128.0.2/32 ')).toEqual([
      '203.0.113.10/32',
      '10.128.0.2/32',
    ])
  })

  it('accepts the /24 boundary', () => {
    expect(parseK8sApiCidrs('10.128.0.0/24')).toEqual(['10.128.0.0/24'])
  })

  it('rejects a missing prefix', () => {
    expect(() => parseK8sApiCidrs('203.0.113.10')).toThrow(/missing prefix/)
  })

  it('rejects an invalid IP', () => {
    expect(() => parseK8sApiCidrs('999.1.1.1/32')).toThrow(/invalid IP/)
  })

  it('rejects a non-numeric prefix', () => {
    expect(() => parseK8sApiCidrs('10.0.0.1/xx')).toThrow(/invalid prefix/)
  })

  it('rejects a prefix out of range', () => {
    expect(() => parseK8sApiCidrs('10.0.0.1/33')).toThrow(/out of range/)
  })

  it('rejects 0.0.0.0/0 as over-broad', () => {
    expect(() => parseK8sApiCidrs('0.0.0.0/0')).toThrow(/over-broad/)
  })

  it('rejects an IPv4 prefix wider than /24', () => {
    expect(() => parseK8sApiCidrs('10.0.0.0/8')).toThrow(/over-broad/)
    expect(() => parseK8sApiCidrs('10.128.0.0/23')).toThrow(/over-broad/)
  })

  it('rejects ::/0 as over-broad', () => {
    expect(() => parseK8sApiCidrs('::/0')).toThrow(/over-broad/)
  })

  it('throws if any entry in a list is bad (no partial accept)', () => {
    expect(() => parseK8sApiCidrs('203.0.113.10/32,0.0.0.0/0')).toThrow(/over-broad/)
  })
})

describe('parseNodeLocalDnsCidr', () => {
  it('returns empty string for undefined or empty input', () => {
    expect(parseNodeLocalDnsCidr(undefined)).toBe('')
    expect(parseNodeLocalDnsCidr('')).toBe('')
    expect(parseNodeLocalDnsCidr('   ')).toBe('')
  })

  it('accepts a single IPv4 /32 kube-dns Service CIDR', () => {
    expect(parseNodeLocalDnsCidr(' 203.0.113.10/32 ')).toBe('203.0.113.10/32')
  })

  it('rejects a missing prefix', () => {
    expect(() => parseNodeLocalDnsCidr('203.0.113.10')).toThrow(/missing prefix/)
  })

  it('rejects multiple entries', () => {
    expect(() => parseNodeLocalDnsCidr('203.0.113.10/32,169.254.20.10/32')).toThrow(
      /expected exactly one CIDR/
    )
  })

  it('rejects non-IPv4 CIDRs', () => {
    expect(() => parseNodeLocalDnsCidr('fd00::a/128')).toThrow(/expected IPv4/)
  })

  it('rejects ranges wider than a single service IP', () => {
    expect(() => parseNodeLocalDnsCidr('34.118.224.0/24')).toThrow(/expected \/32/)
  })
})
