import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORIGINAL_ENV = { ...process.env }
let store: string

function seedSharedSessionVerifyingHalf(): string {
  const verifying = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).publicKey
  writeFileSync(join(store, 'session.public.pem'), verifying, { mode: 0o644 })
  return verifying
}

beforeEach(() => {
  vi.resetModules()
  process.env = { ...ORIGINAL_ENV }
  delete process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY
  process.env.CLERUM_DEV_MODE = 'true'
  store = mkdtempSync(join(tmpdir(), 'evenfire-ext-dev-keys-'))
  process.env.EVENFIRE_DEV_KEY_STORE = store
})

afterEach(() => {
  process.env = ORIGINAL_ENV
  rmSync(store, { recursive: true, force: true })
  vi.resetModules()
})

describe('external-rest-api shared dev key identity', () => {
  it('loads exactly the verifying half published by control-api', async () => {
    const published = seedSharedSessionVerifyingHalf()
    const { config } = await import('../src/config.js')
    expect(config.jwtPublicKey).toBe(published.trim())
  })

  it('fails loud when the shared store has not been created', async () => {
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /requires the control-api dev key store/
    )
  })

  it('prefers an explicit verifier env var over the shared store', async () => {
    seedSharedSessionVerifyingHalf()
    const explicit = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).publicKey
    process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY = explicit
    const { config } = await import('../src/config.js')
    expect(config.jwtPublicKey).toBe(explicit.trim())
  })
})
