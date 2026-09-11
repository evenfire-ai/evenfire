import { createHash } from 'crypto'

/**
 * sha256 of the mirror Secret's base64 credential. Rotating the credential
 * changes this digest → pod template annotation → rolling restart onto the new
 * key.
 */
export function credentialsRevision(credentialB64: string): string {
  return createHash('sha256').update(credentialB64).digest('hex')
}
