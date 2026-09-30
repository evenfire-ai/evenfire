import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORIGINAL_ENV = { ...process.env }
let store: string

function seedSharedRpcVerifyingHalf(): string {
  const verifying = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).publicKey
  writeFileSync(join(store, 'rpc.public.pem'), verifying, { mode: 0o644 })
  return verifying
}

beforeEach(() => {
  vi.resetModules()
  process.env = { ...ORIGINAL_ENV }
  delete process.env.RPC_PROXY_JWT_PUBLIC_KEY
  process.env.CLERUM_DEV_MODE = 'true'
  store = mkdtempSync(join(tmpdir(), 'evenfire-rpc-dev-keys-'))
  process.env.EVENFIRE_DEV_KEY_STORE = store
})

afterEach(() => {
  process.env = ORIGINAL_ENV
  rmSync(store, { recursive: true, force: true })
  vi.resetModules()
})

describe('rpc-proxy shared dev key identity', () => {
  it('loads exactly the verifying half published by control-api', async () => {
    const published = seedSharedRpcVerifyingHalf()
    const { config } = await import('../config.js')
    expect(config.jwtPublicKey).toBe(published.trim())
  })

  it('fails loud when the shared store has not been created', async () => {
    await expect(() => import('../config.js')).rejects.toThrow(
      /requires the control-api dev key store/
    )
  })

  it('prefers an explicit verifier env var over the shared store', async () => {
    seedSharedRpcVerifyingHalf()
    const explicit = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).publicKey
    process.env.RPC_PROXY_JWT_PUBLIC_KEY = explicit
    const { config } = await import('../config.js')
    expect(config.jwtPublicKey).toBe(explicit.trim())
  })
})
