import { describe, expect, it } from 'vitest'
import { isValidK8sName, toK8sName } from '../k8sValidation'

describe('isValidK8sName', () => {
  it('accepts RFC 1123 DNS labels', () => {
    expect(isValidK8sName('test-oss-jose-helloo')).toBe(true)
    expect(isValidK8sName('a')).toBe(true)
    expect(isValidK8sName('a1-b2')).toBe(true)
  })
  it('rejects scoped registry names, edges, and over-length', () => {
    expect(isValidK8sName('@test-oss-jose/helloo')).toBe(false)
    expect(isValidK8sName('-lead')).toBe(false)
    expect(isValidK8sName('trail-')).toBe(false)
    expect(isValidK8sName('UPPER')).toBe(false)
    expect(isValidK8sName('a'.repeat(64))).toBe(false)
  })
})

describe('toK8sName', () => {
  it('derives a valid label from a scoped registry name', () => {
    expect(toK8sName('@test-oss-jose/helloo')).toBe('test-oss-jose-helloo')
  })

  it('lowercases, collapses invalid runs, and trims edge hyphens', () => {
    expect(toK8sName('@Acme//My Server!!')).toBe('acme-my-server')
    expect(toK8sName('__weird__')).toBe('weird')
    expect(toK8sName('a---b')).toBe('a-b')
  })

  it('caps at 63 chars with no trailing hyphen', () => {
    const out = toK8sName(`@${'x'.repeat(80)}`)
    expect(out.length).toBe(63)
    expect(out.endsWith('-')).toBe(false)
    expect(isValidK8sName(out)).toBe(true)
  })

  it('always yields a valid K8s name (or empty)', () => {
    for (const raw of ['@test-oss-jose/helloo', '@Acme//My Server!!', 'a---b']) {
      expect(isValidK8sName(toK8sName(raw))).toBe(true)
    }
    expect(toK8sName('@@@///')).toBe('') // no usable chars → empty (caller handles)
  })
})
