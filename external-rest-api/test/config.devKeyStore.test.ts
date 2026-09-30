import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  it('fails closed in production when the verifier env var is unset or blank', async () => {
    process.env.NODE_ENV = 'production'
    delete process.env.CLERUM_DEV_MODE
    process.env.EXTERNAL_REST_API_CORS_ORIGIN = 'http://localhost:3001'
    process.env.EXTERNAL_REST_API_GOOGLE_CLIENT_ID = 'test-client'
    process.env.EXTERNAL_REST_API_CONTROL_API_BASE_URL = 'http://localhost:8080'
    process.env.EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN = 'test-token'
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /Missing required environment variable: EXTERNAL_REST_API_JWT_PUBLIC_KEY/
    )
    process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY = ''
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /Missing required environment variable: EXTERNAL_REST_API_JWT_PUBLIC_KEY/
    )
  })

  it('fails closed outside dev mode when the verifier env var is unset', async () => {
    delete process.env.CLERUM_DEV_MODE
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /Missing required environment variable: EXTERNAL_REST_API_JWT_PUBLIC_KEY/
    )
  })

  it('rejects CLERUM_DEV_MODE=true together with production', async () => {
    process.env.NODE_ENV = 'production'
    process.env.EXTERNAL_REST_API_CORS_ORIGIN = 'http://localhost:3001'
    process.env.EXTERNAL_REST_API_GOOGLE_CLIENT_ID = 'test-client'
    process.env.EXTERNAL_REST_API_CONTROL_API_BASE_URL = 'http://localhost:8080'
    process.env.EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN = 'test-token'
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /CLERUM_DEV_MODE=true is not allowed with NODE_ENV=production/
    )
  })

  it('rejects a historically committed verifier public key even when supplied explicitly', async () => {
    process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwrZja9jS/r+e2YF1FqEQ
NMLsnffebYzXrZOb7uPMKhXBoKjJh/taR9v3kX2srfVtoikcKKr0Sfa7MMSLnZWd
ETmi7MvbeVD3HpsXpVejmw9D0zeYYSGZplLF/b6HY0Lz2XVM8WdJl3Dicyu+SZbZ
xeHZtMCMTTjvmoI/IYmmO4N3Pgz/SGi7V3EiwoALODP4OWDvd/1xFUiMPslLPgZU
EczQ5tIpAaD4e0om3gUNsyOKYc5igojm6ooVqI9T3TUGBVJ0uSZB7ntWxKQ39WyI
aH+oqnwDGbDcDLQ/wTuBtcn4brWTDgW1xA73HVBSImGFvvHCWBiQBiI1nvovUP0u
WQIDAQAB
-----END PUBLIC KEY-----`
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /must not use a historically committed dev JWT key/
    )
  })
})
