import { describe, expect, it } from 'vitest'
import {
  IssuerSubjectClassError,
  assertIssuerMaySubject,
  isIssuerAllowedForSubject,
} from '../src/auth/issuerSubjectClass.js'

/**
 * P3-S01 — issuer→subject-class enforcement (CRITICAL). Each provisioner may
 * mint ONLY its own class: hcc→host:1st, wrc→host:3rd, session→user. Every
 * unauthorized cross is denied (deny-by-default).
 */

describe('assertIssuerMaySubject — allowed crosses', () => {
  it('hcc may mint a 1st-party host', () => {
    expect(() =>
      assertIssuerMaySubject({ issuer: 'hcc', subjectType: 'host', party: '1st' })
    ).not.toThrow()
  })
  it('wrc may mint a 3rd-party host', () => {
    expect(() =>
      assertIssuerMaySubject({ issuer: 'wrc', subjectType: 'host', party: '3rd' })
    ).not.toThrow()
  })
  it('session may mint a user', () => {
    expect(() => assertIssuerMaySubject({ issuer: 'session', subjectType: 'user' })).not.toThrow()
  })
})

describe('assertIssuerMaySubject — denied crosses (no identity escalation)', () => {
  const denied: Array<[string, Parameters<typeof assertIssuerMaySubject>[0]]> = [
    ['hcc → 3rd-party host', { issuer: 'hcc', subjectType: 'host', party: '3rd' }],
    ['hcc → user', { issuer: 'hcc', subjectType: 'user' }],
    ['wrc → 1st-party host', { issuer: 'wrc', subjectType: 'host', party: '1st' }],
    ['wrc → user', { issuer: 'wrc', subjectType: 'user' }],
    ['session → host', { issuer: 'session', subjectType: 'host', party: '1st' }],
  ]
  for (const [name, req] of denied) {
    it(`denies ${name}`, () => {
      expect(() => assertIssuerMaySubject(req)).toThrow(IssuerSubjectClassError)
      try {
        assertIssuerMaySubject(req)
      } catch (e) {
        expect((e as IssuerSubjectClassError).code).toBe('issuer_subject_forbidden')
      }
    })
  }
})

describe('assertIssuerMaySubject — guards', () => {
  it('requires a party for a host subject', () => {
    try {
      assertIssuerMaySubject({ issuer: 'hcc', subjectType: 'host' })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as IssuerSubjectClassError).code).toBe('party_required')
    }
  })
})

describe('isIssuerAllowedForSubject', () => {
  it('reports the mapping as booleans', () => {
    expect(isIssuerAllowedForSubject({ issuer: 'hcc', subjectType: 'host', party: '1st' })).toBe(
      true
    )
    expect(isIssuerAllowedForSubject({ issuer: 'wrc', subjectType: 'host', party: '1st' })).toBe(
      false
    )
    expect(isIssuerAllowedForSubject({ issuer: 'session', subjectType: 'user' })).toBe(true)
  })
})
