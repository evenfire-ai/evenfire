import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Symmetric encryption helper for OAuth refresh tokens stored at rest. Uses
 * AES-256-GCM. Key is supplied via `CONTROL_API_OAUTH_ENCRYPTION_KEY` (32
 * raw bytes, hex-encoded → 64 hex chars). The encrypted payload format is
 * `v1.<iv>.<ciphertext>.<authTag>` (each part base64url) so we can rotate
 * the algorithm/version cleanly later.
 *
 * Spec §9.9 / Decision 20 — refresh tokens never leave control-api in
 * plaintext; only access tokens cross the rpc-proxy boundary.
 */

const ENCRYPTION_VERSION = 'v1'
const KEY_BYTES = 32
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

export type Aes256GcmEnvelope = { nonce: Buffer; ciphertext: Buffer }

export function encryptAes256Gcm(key: Buffer, plaintext: Buffer, aad?: Buffer): Aes256GcmEnvelope {
  if (key.length !== KEY_BYTES) throw new Error(`AES-256-GCM key must be ${KEY_BYTES} bytes`)
  const nonce = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  if (aad) cipher.setAAD(aad)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  return { nonce, ciphertext: encrypted }
}

export function decryptAes256Gcm(key: Buffer, envelope: Aes256GcmEnvelope, aad?: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new Error(`AES-256-GCM key must be ${KEY_BYTES} bytes`)
  if (envelope.nonce.length !== IV_BYTES || envelope.ciphertext.length < AUTH_TAG_BYTES + 1) {
    throw new Error('Malformed AES-256-GCM envelope')
  }
  const authTag = envelope.ciphertext.subarray(envelope.ciphertext.length - AUTH_TAG_BYTES)
  const ciphertext = envelope.ciphertext.subarray(0, -AUTH_TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, envelope.nonce)
  if (aad) decipher.setAAD(aad)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

export function deriveAes256GcmKey(hexKey: string): Buffer {
  if (typeof hexKey !== 'string') {
    throw new Error('OAuth encryption key must be a hex string')
  }
  if (!/^[0-9a-fA-F]+$/.test(hexKey)) {
    throw new Error('OAuth encryption key must be hex-encoded')
  }
  if (hexKey.length !== KEY_BYTES * 2) {
    throw new Error(`OAuth encryption key must be ${KEY_BYTES * 2} hex chars (${KEY_BYTES} bytes)`)
  }
  return Buffer.from(hexKey, 'hex')
}

export const deriveOAuthEncryptionKey = deriveAes256GcmKey

export function encryptOAuthSecret(key: Buffer, plaintext: string): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`encryptOAuthSecret: key must be ${KEY_BYTES} bytes`)
  }
  const { nonce: iv, ciphertext: sealed } = encryptAes256Gcm(key, Buffer.from(plaintext, 'utf8'))
  const ciphertext = sealed.subarray(0, -AUTH_TAG_BYTES)
  const authTag = sealed.subarray(-AUTH_TAG_BYTES)
  return [
    ENCRYPTION_VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    authTag.toString('base64url'),
  ].join('.')
}

export function decryptOAuthSecret(key: Buffer, payload: string): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`decryptOAuthSecret: key must be ${KEY_BYTES} bytes`)
  }
  const parts = payload.split('.')
  if (parts.length !== 4) {
    throw new Error('decryptOAuthSecret: malformed payload')
  }
  const [version, ivB64, ciphertextB64, authTagB64] = parts
  if (version !== ENCRYPTION_VERSION) {
    throw new Error(`decryptOAuthSecret: unknown version ${version}`)
  }
  const iv = Buffer.from(ivB64, 'base64url')
  const ciphertext = Buffer.from(ciphertextB64, 'base64url')
  const authTag = Buffer.from(authTagB64, 'base64url')
  if (iv.length !== IV_BYTES) {
    throw new Error('decryptOAuthSecret: invalid iv length')
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error('decryptOAuthSecret: invalid auth tag length')
  }
  const plaintext = decryptAes256Gcm(key, {
    nonce: iv,
    ciphertext: Buffer.concat([ciphertext, authTag]),
  })
  return plaintext.toString('utf8')
}
