import { generateKeyPairSync, randomBytes } from 'node:crypto'

/**
 * Test-only fixture for the values config.ts requires with no code default: a real,
 * randomly generated RSA public key and random secrets, so config suites exercise the
 * non-dev path. Suites that verify missing-value behavior delete the variable explicitly.
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

for (const name of [
  'RPC_PROXY_CONTROL_API_SERVICE_TOKEN',
  'RPC_PROXY_DESKTOP_COOKIE_SECRET',
  'RPC_PROXY_SANDBOX_UI_COOKIE_SECRET',
]) {
  if (!process.env[name]) process.env[name] = `test-${randomBytes(24).toString('hex')}`
}
