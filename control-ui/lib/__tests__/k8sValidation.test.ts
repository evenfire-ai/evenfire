import { describe, expect, it } from 'vitest'
import { getAgentNameError, isValidDNSSubdomain, isValidK8sName, toK8sName } from '../k8sValidation'

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

describe('isValidDNSSubdomain', () => {
  it('accepts plain labels and dot-separated subdomains', () => {
    expect(isValidDNSSubdomain('chatllm-api-keys')).toBe(true)
    expect(isValidDNSSubdomain('team.primary')).toBe(true)
    expect(isValidDNSSubdomain('a.b.c')).toBe(true)
    expect(isValidDNSSubdomain('team-1.primary-2.keys')).toBe(true)
  })

  it('enforces DNS-label rules inside every dot-separated label', () => {
    expect(isValidDNSSubdomain('Team.Primary')).toBe(false)
    expect(isValidDNSSubdomain('team._primary')).toBe(false)
    expect(isValidDNSSubdomain('team.-primary')).toBe(false)
    expect(isValidDNSSubdomain('team.primary-')).toBe(false)
    expect(isValidDNSSubdomain('team..primary')).toBe(false)
    expect(isValidDNSSubdomain('.team')).toBe(false)
    expect(isValidDNSSubdomain('team.')).toBe(false)
    expect(isValidDNSSubdomain('')).toBe(false)
  })

  it('caps each label at 63 characters', () => {
    expect(isValidDNSSubdomain('a'.repeat(63))).toBe(true)
    expect(isValidDNSSubdomain('a'.repeat(64))).toBe(false)
    expect(isValidDNSSubdomain(`${'a'.repeat(63)}.b`)).toBe(true)
    expect(isValidDNSSubdomain(`${'a'.repeat(64)}.b`)).toBe(false)
  })

  it('caps the complete name at 253 characters', () => {
    // 4 labels of 63/63/63/61 chars + 3 dots = 253 exactly.
    const atLimit = `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(61)}`
    expect(atLimit.length).toBe(253)
    expect(isValidDNSSubdomain(atLimit)).toBe(true)
    // Same shape with one more character (254 total) is over the limit.
    const overLimit = `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(62)}`
    expect(overLimit.length).toBe(254)
    expect(isValidDNSSubdomain(overLimit)).toBe(false)
  })
})

describe('getAgentNameError', () => {
  it('accepts a valid agent name', () => {
    expect(getAgentNameError('my-agent')).toBe('')
    expect(getAgentNameError('abc')).toBe('')
    expect(getAgentNameError('a'.repeat(63))).toBe('')
  })

  it('requires a name', () => {
    expect(getAgentNameError('')).toBe('Agent name is required.')
    expect(getAgentNameError('   ')).toBe('Agent name is required.')
  })

  it('rejects invalid characters', () => {
    expect(getAgentNameError('my_agent')).not.toBe('')
    expect(getAgentNameError('MyAgent')).not.toBe('')
  })

  it('requires a leading letter', () => {
    expect(getAgentNameError('1agent')).toBe('Agent name must start with a letter.')
    expect(getAgentNameError('-agent')).toBe('Agent name must start with a letter.')
  })

  it('requires an alphanumeric end', () => {
    expect(getAgentNameError('agent-')).toBe('Agent name must end with a letter or number.')
  })

  it('enforces the 3-63 character range', () => {
    expect(getAgentNameError('ab')).toBe('Agent name must be at least 3 characters long.')
    expect(getAgentNameError('a'.repeat(64))).toBe('Agent name must be 63 characters or fewer.')
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
