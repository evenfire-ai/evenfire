import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  decryptOAuthSecret,
  deriveOAuthEncryptionKey,
  encryptOAuthSecret,
} from '../src/oauth/encryption.js'

const KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

describe('deriveOAuthEncryptionKey (O3.2)', () => {
  it('returns a 32-byte buffer for a valid hex key', () => {
    const key = deriveOAuthEncryptionKey(KEY_HEX)
    expect(key.length).toBe(32)
  })

  it('rejects keys with the wrong hex length', () => {
    expect(() => deriveOAuthEncryptionKey('00112233')).toThrow(/64 hex chars/)
  })

  it('rejects non-hex characters', () => {
    expect(() => deriveOAuthEncryptionKey('zz' + KEY_HEX.slice(2))).toThrow(/hex-encoded/)
  })

  it('accepts uppercase hex', () => {
    const upper = KEY_HEX.toUpperCase()
    expect(deriveOAuthEncryptionKey(upper).length).toBe(32)
  })
})

describe('encryptOAuthSecret / decryptOAuthSecret (O3.2)', () => {
  const key = deriveOAuthEncryptionKey(KEY_HEX)

  it('round-trips a refresh token', () => {
    const plaintext = 'refresh-token-abc123def456'
    const ciphertext = encryptOAuthSecret(key, plaintext)
    expect(ciphertext.startsWith('v1.')).toBe(true)
    expect(decryptOAuthSecret(key, ciphertext)).toBe(plaintext)
  })

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    const plaintext = 'abc'
    const c1 = encryptOAuthSecret(key, plaintext)
    const c2 = encryptOAuthSecret(key, plaintext)
    expect(c1).not.toBe(c2)
  })

  it('handles unicode + multi-byte plaintext', () => {
    const plaintext = '🔑 refresh — Notion grant 2026'
    expect(decryptOAuthSecret(key, encryptOAuthSecret(key, plaintext))).toBe(plaintext)
  })

  it('rejects ciphertexts with the wrong version', () => {
    const ciphertext = encryptOAuthSecret(key, 'p').replace(/^v1\./, 'v9.')
    expect(() => decryptOAuthSecret(key, ciphertext)).toThrow(/unknown version v9/)
  })

  it('rejects malformed payloads', () => {
    expect(() => decryptOAuthSecret(key, 'v1.iv.cipher')).toThrow(/malformed payload/)
  })

  it('fails authentication when ciphertext is tampered', () => {
    const ciphertext = encryptOAuthSecret(key, 'plaintext-data')
    const parts = ciphertext.split('.')
    const cipherBytes = Buffer.from(parts[2], 'base64url')
    cipherBytes[0] ^= 0xff
    parts[2] = cipherBytes.toString('base64url')
    expect(() => decryptOAuthSecret(key, parts.join('.'))).toThrow()
  })

  it('rejects a key of the wrong length', () => {
    const shortKey = randomBytes(16)
    expect(() => encryptOAuthSecret(shortKey, 'p')).toThrow(/must be 32 bytes/)
  })
})
