import { describe, expect, it } from 'vitest'
import {
  isValidUserHomeName,
  normalizeUserHomeName,
  userHomeNameCandidates,
  userHomeRetryNameCandidates,
} from '../src/gfs/userHomeNaming.js'

const userId = '12345678-1234-4567-89ab-123456789abc'
const otherId = '87654321-1234-4567-89ab-123456789abc'

describe('user home naming policy', () => {
  it('normalizes case, Unicode, separators and forbidden controls', () => {
    expect(normalizeUserHomeName('  ALICE / Team\\Docs--.. ')).toBe('alice-team-docs')
    expect(normalizeUserHomeName('A\u0301B')).toBe(normalizeUserHomeName('\u00c1B'))
    expect(normalizeUserHomeName('al\u202eice\u200b\u0000')).toBe('alice')
    expect(normalizeUserHomeName('..')).toBe('')
  })

  it('keeps accented letters as their base letter instead of dropping them', () => {
    expect(normalizeUserHomeName('José García')).toBe('jose-garcia')
    expect(normalizeUserHomeName('Ñandú')).toBe('nandu')
    expect(normalizeUserHomeName('Zoë')).toBe('zoe')
    expect(normalizeUserHomeName('jose-garcia')).toBe('jose-garcia')
  })

  it('rejects reserved and foreign UUID names while allowing the owner UUID', () => {
    for (const reserved of ['users', 'shared', 'system', 'org', 'admin', 'root', 'public']) {
      expect(isValidUserHomeName(reserved, userId)).toBe(false)
      expect(isValidUserHomeName(`${reserved}-folder`, userId)).toBe(true)
    }
    expect(isValidUserHomeName(otherId, userId)).toBe(false)
    expect(isValidUserHomeName(userId, userId)).toBe(true)
  })

  it('uses a stable base, deterministic suffix, and the UUID as final candidate', () => {
    const first = userHomeNameCandidates({ id: userId, name: 'Same Name', email: 'a@x.test' })
    const second = userHomeNameCandidates({ id: otherId, name: 'Same Name', email: 'b@x.test' })
    expect(first).toEqual(['same-name', 'same-name-12345678', userId])
    expect(second).toEqual(['same-name', 'same-name-87654321', otherId])
    expect(first[1]).not.toBe(second[1])
  })

  it('uses email when the display name is unusable and UUID when neither works', () => {
    expect(
      userHomeNameCandidates({ id: userId, name: '.', email: 'Long.Name@example.test' })[0]
    ).toBe('long.name')
    expect(userHomeNameCandidates({ id: userId, name: '.', email: 'x@example.test' })).toEqual([
      userId,
    ])
  })

  it('keeps every candidate within the byte limits and never ends the truncated base in punctuation', () => {
    for (const name of [
      'a'.repeat(100),
      `${'a'.repeat(47)}.more`,
      'é'.repeat(80),
      '𐀀'.repeat(80),
    ]) {
      const candidates = userHomeNameCandidates({ id: userId, name, email: 'backup@example.test' })
      expect(candidates.length).toBeGreaterThan(0)
      for (const candidate of candidates) {
        expect(Buffer.byteLength(candidate, 'utf8')).toBeLessThanOrEqual(64)
        expect(isValidUserHomeName(candidate, userId)).toBe(true)
      }
      if (candidates[0] !== userId)
        expect(Buffer.byteLength(candidates[0]!, 'utf8')).toBeLessThanOrEqual(48)
    }
  })

  it('keeps a valid retry name first and applies the normal suffix and UUID collision order', () => {
    expect(userHomeRetryNameCandidates(userId, 'x')).toEqual(['x', 'x-12345678', userId])
    const longName = 'a'.repeat(64)
    expect(userHomeRetryNameCandidates(userId, longName)).toEqual([
      longName,
      `${'a'.repeat(48)}-12345678`,
      userId,
    ])
    expect(userHomeRetryNameCandidates(userId, userId)[0]).toBe(userId)
  })
})
