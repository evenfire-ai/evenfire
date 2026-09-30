import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  it('fails closed in production when the verifier env var is unset or blank', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.CLERUM_DEV_MODE
    process.env.RPC_PROXY_CORS_ORIGIN = 'http://localhost:3000'
    await expect(() => import('../config.js')).rejects.toThrow(
      /Missing required environment variable: RPC_PROXY_JWT_PUBLIC_KEY/
    )
    process.env.RPC_PROXY_JWT_PUBLIC_KEY = ''
    await expect(() => import('../config.js')).rejects.toThrow(
      /Missing required environment variable: RPC_PROXY_JWT_PUBLIC_KEY/
    )
  })

  it('fails closed outside dev mode when the verifier env var is unset', async () => {
    delete process.env.CLERUM_DEV_MODE
    await expect(() => import('../config.js')).rejects.toThrow(
      /Missing required environment variable: RPC_PROXY_JWT_PUBLIC_KEY/
    )
  })

  it('rejects CLERUM_DEV_MODE=true together with production', async () => {
    process.env.NODE_ENV = 'production'
    process.env.RPC_PROXY_CORS_ORIGIN = 'http://localhost:3000'
    await expect(() => import('../config.js')).rejects.toThrow(
      /CLERUM_DEV_MODE=true is not allowed with NODE_ENV=production/
    )
  })

  it('rejects a historically committed verifier public key even when supplied explicitly', async () => {
    process.env.RPC_PROXY_JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArCIYGHehMPpGKePxaKQa
rDX5yrzifU5i4fzpI3EtkKSU6s5ug7EkKxc2DdMekoqXe9vr7qKyVwiilUIusXLX
iW7KPMJlD/Fd5Bo7Qxt69wYiL5I4K37eDgCN6D3LduHySEnkhdI0GDpB4LM2ASOx
QkEabepekZTMQyExmCIn/dHJ15B+4A9tiiephYOQNr3GcnW9eDomMt6NJLypikbr
xJO6O7Ar0G+raTbflth8EQzWnGF+WgQW4iiM3wsFhpaE0mUlEbMGDGTMAZy1KfxA
RRu+QZm3Lo+5AiCaHkijDCglHsXLhqsYi2AdRiavD1Gk9LKP/ztKw7q/D6fYFzmO
QwIDAQAB
-----END PUBLIC KEY-----`
    await expect(() => import('../config.js')).rejects.toThrow(
      /must not use a historically committed dev JWT key/
    )
  })
})
