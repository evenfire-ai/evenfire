import { createPublicKey } from 'node:crypto'

// The Host verifies edge assertions with the public half of control-api's RPC
// signing key, as deployed. Tests sign with the synthetic private key the
// shared setup file installs, so the Host gets its matching public key.
const rpcPrivateKey = process.env.CONTROL_API_RPC_JWT_PRIVATE_KEY
if (!rpcPrivateKey) {
  throw new Error('CONTROL_API_RPC_JWT_PRIVATE_KEY must be installed before the Host verifier key')
}
process.env.CLERUM_AUTH_JWT_PUBLIC_KEY = createPublicKey(rpcPrivateKey)
  .export({ type: 'spki', format: 'pem' })
  .toString()
