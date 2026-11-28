import { describe, expect, it } from 'vitest'
import {
  OIDC_ELIGIBILITY_RESERVED_CLAIMS,
  OIDC_PROTOCOL_CLAIMS,
  hasDisallowedClaimCharacters,
  isAcceptableEvidenceClaimName,
} from '../src/oidc/claimNames.js'

describe('OIDC evidence claim names', () => {
  it('accepts an ordinary claim name and the claims eligibility collects', () => {
    for (const name of ['roles', 'groups', 'hd', 'tid', 'idp', 'acct', 'xms_edov']) {
      expect(isAcceptableEvidenceClaimName(name)).toBe(true)
    }
  })

  it('lists exactly the 14 OIDC protocol claims', () => {
    expect([...OIDC_PROTOCOL_CLAIMS].sort()).toEqual([
      'at_hash',
      'aud',
      'auth_time',
      'azp',
      'c_hash',
      'exp',
      'iat',
      'iss',
      'jti',
      'nbf',
      'nonce',
      's_hash',
      'sid',
      'sub',
    ])
  })

  it.each(['sub', 'nonce', 'auth_time'])('refuses the protocol claim %s', name => {
    expect(OIDC_PROTOCOL_CLAIMS.has(name)).toBe(true)
    expect(isAcceptableEvidenceClaimName(name)).toBe(false)
    // Positive control: only the exact protocol name is refused.
    expect(isAcceptableEvidenceClaimName(`${name}_group`)).toBe(true)
  })

  it('refuses a name over 128 characters', () => {
    expect(isAcceptableEvidenceClaimName('a'.repeat(129))).toBe(false)
    expect(isAcceptableEvidenceClaimName('a'.repeat(128))).toBe(true)
  })

  it('refuses an empty name', () => {
    expect(isAcceptableEvidenceClaimName('')).toBe(false)
  })

  it('refuses a name with a control character', () => {
    for (const name of ['ro\u0000les', 'roles\n', 'ro\tles', 'roles\u007f']) {
      expect(isAcceptableEvidenceClaimName(name)).toBe(false)
    }
    expect(isAcceptableEvidenceClaimName('roles')).toBe(true)
  })

  it('refuses a name with a format character', () => {
    // U+200B zero width space, U+200C zero width non-joiner, U+2060 word joiner, U+FEFF byte order mark.
    for (const name of [
      'groups\u200b',
      'gro\u200cups',
      '\u200bgroups',
      'groups\u2060',
      'groups\ufeff',
    ]) {
      expect(isAcceptableEvidenceClaimName(name)).toBe(false)
    }
    expect(hasDisallowedClaimCharacters('groups\u200b')).toBe(true)
    expect(hasDisallowedClaimCharacters('groups')).toBe(false)
    expect(isAcceptableEvidenceClaimName('groups')).toBe(true)
  })

  it('reserves the claims eligibility already reads, apart from roles', () => {
    expect([...OIDC_ELIGIBILITY_RESERVED_CLAIMS].sort()).toEqual([
      'acct',
      'email',
      'email_verified',
      'idp',
      'tid',
      'xms_edov',
    ])
  })
})
