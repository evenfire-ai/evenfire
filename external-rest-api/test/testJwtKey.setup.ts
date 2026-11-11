import { generateKeyPairSync, randomBytes } from 'node:crypto'

/**
 * Shared test fixture for the values config.ts requires with no code default: a real,
 * randomly generated RSA public key and a random control-api service token, so config
 * suites exercise the non-dev path. Suites that verify missing-value behavior delete the
 * variable explicitly.
 */
function testPublicKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).publicKey
}

if (!process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY) {
  process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY = testPublicKey()
}

if (!process.env.EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN) {
  process.env.EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN = `test-${randomBytes(24).toString('hex')}`
}
