import { generateKeyPairSync } from 'node:crypto'
import { installControlApiJwtTestKeys } from '../../scripts/testing/controlApiJwtTestKeys.js'

/**
 * Shared test fixture: a real, randomly generated RSA public key so config
 * suites exercise the non-dev path without the removed historical default.
 * Suites that verify missing-key behavior delete this variable explicitly.
 */
function testPublicKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).publicKey
}

installControlApiJwtTestKeys()

if (!process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY) {
  process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY = testPublicKey()
}
