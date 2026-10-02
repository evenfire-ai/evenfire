import { generateKeyPairSync } from 'node:crypto'

/**
 * Test-only fixture: a real, randomly generated RSA public key so config
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

if (!process.env.RPC_PROXY_JWT_PUBLIC_KEY) {
  process.env.RPC_PROXY_JWT_PUBLIC_KEY = testPublicKey()
}
