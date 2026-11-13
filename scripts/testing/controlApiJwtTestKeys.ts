import { createPublicKey, generateKeyPairSync } from 'node:crypto'

function generatePrivateKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

function publicKeyFor(privateKey: string): string {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString()
}

function normalizedPublicKey(publicKey: string): string {
  return createPublicKey(publicKey).export({ type: 'spki', format: 'pem' }).toString()
}

/** Provide explicit, matching signing/verifier material to cross-service tests. */
export function installControlApiJwtTestKeys(): void {
  const rpcPrivateKey = process.env.CONTROL_API_RPC_JWT_PRIVATE_KEY ?? generatePrivateKey()
  process.env.CONTROL_API_RPC_JWT_PRIVATE_KEY = rpcPrivateKey

  const rpcPublicKey = publicKeyFor(rpcPrivateKey)
  for (const name of ['CONTROL_API_RPC_JWT_PUBLIC_KEY', 'RPC_PROXY_JWT_PUBLIC_KEY']) {
    const configured = process.env[name]
    if (configured && normalizedPublicKey(configured) !== rpcPublicKey) {
      throw new Error(`${name} must match CONTROL_API_RPC_JWT_PRIVATE_KEY in cross-service tests`)
    }
    process.env[name] = configured ?? rpcPublicKey
  }

  for (const name of [
    'CONTROL_API_SESSION_JWT_PRIVATE_KEY',
    'CONTROL_API_ADMIN_JWT_PRIVATE_KEY',
  ]) {
    process.env[name] ??= generatePrivateKey()
  }
}
