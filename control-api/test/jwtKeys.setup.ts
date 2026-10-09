import { generateKeyPairSync } from 'node:crypto'

/**
 * Shared test fixture: real, randomly generated RSA material for config-
 * dependent suites so Control API and imported RPC Proxy code exercise the
 * explicit-key path without implicit dev defaults or local dev-key storage.
 * Tests that verify missing-key failures delete these variables explicitly.
 */
function testKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

function testPublicKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).publicKey
}

const testKeys: Record<string, string> = {
  CONTROL_API_RPC_JWT_PRIVATE_KEY: testKey(),
  CONTROL_API_SESSION_JWT_PRIVATE_KEY: testKey(),
  CONTROL_API_ADMIN_JWT_PRIVATE_KEY: testKey(),
  RPC_PROXY_JWT_PUBLIC_KEY: testPublicKey(),
}

export const JWT_TEST_KEY_ENV_NAMES = Object.keys(testKeys) as readonly string[]

for (const [name, value] of Object.entries(testKeys)) {
  if (!process.env[name]) {
    process.env[name] = value
  }
}
