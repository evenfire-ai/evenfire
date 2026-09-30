import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import { BANNED_DEV_JWT_PUBLIC_KEYS as HISTORICAL } from './fixtures/bannedDevJwtPublicKeys.js'
import { applyProdEnv } from './fixtures/productionConfigEnv.js'

const ORIGINAL_ENV = { ...process.env }
const SLOT_ENV_NAMES = [
  'CONTROL_API_RPC_JWT_PRIVATE_KEY',
  'CONTROL_API_SESSION_JWT_PRIVATE_KEY',
  'CONTROL_API_ADMIN_JWT_PRIVATE_KEY',
] as const

const devProviderMocks = vi.hoisted(() => ({
  load: vi.fn(
    (slot: 'rpc' | 'session' | 'admin') =>
      generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey
  ),
}))

vi.mock('../src/devSigningKeys.js', () => ({
  loadOrGenerateDevJwtPrivateKey: devProviderMocks.load,
  defaultDevSigningKeyStoreDir: () => '/nonexistent-dev-key-store',
}))

function freshSigningMaterial(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey
}

function freshVerifyingMaterial(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).publicKey
}

/** First RSA-2048 signing PEM whose base64 body starts with the given prefix. */
function signingMaterialWithBodyPrefix(prefix: string): string {
  for (let attempt = 0; attempt < 300; attempt++) {
    const candidate = freshSigningMaterial()
    const body = candidate.split('\n')[1] ?? ''
    if (body.startsWith(prefix)) return candidate
  }
  throw new Error(`no RSA-2048 candidate produced body prefix ${prefix}`)
}

function resetEnv(): void {
  process.env = { ...ORIGINAL_ENV }
  delete process.env.NODE_ENV
  delete process.env.CLERUM_DEV_MODE
  delete process.env.CONTROL_API_RPC_JWT_PUBLIC_KEY
}

beforeEach(() => {
  vi.resetModules()
  devProviderMocks.load.mockClear()
  resetEnv()
})

afterEach(() => {
  resetEnv()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('config JWT hardening', () => {
  it('fails outside dev mode when any signing env var is missing', async () => {
    for (const name of SLOT_ENV_NAMES) {
      vi.resetModules()
      resetEnv()
      delete process.env[name]
      await expect(() => import('../src/config.js'), name).rejects.toThrow(
        new RegExp(`Missing required environment variable: ${name}`)
      )
    }
  })

  it('rejects CLERUM_DEV_MODE=true together with NODE_ENV=production before generation', async () => {
    for (const name of SLOT_ENV_NAMES) delete process.env[name]
    process.env.NODE_ENV = 'production'
    process.env.CLERUM_DEV_MODE = 'true'
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /CLERUM_DEV_MODE=true is not allowed with NODE_ENV=production/
    )
    expect(devProviderMocks.load).not.toHaveBeenCalled()
  })

  it('uses the dev provider for unset slots in dev mode', async () => {
    for (const name of SLOT_ENV_NAMES) delete process.env[name]
    process.env.CLERUM_DEV_MODE = 'true'
    const { config } = await import('../src/config.js')
    expect(devProviderMocks.load).toHaveBeenCalledTimes(3)
    expect(config.rpcJwtPrivateKey).toBeTruthy()
    expect(config.sessionJwtPrivateKey).toBeTruthy()
    expect(config.adminJwtPrivateKey).toBeTruthy()
  })

  it('rejects a historical verifier public key even with a fresh signing key', async () => {
    process.env.CONTROL_API_RPC_JWT_PUBLIC_KEY = HISTORICAL.rpc
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /effective RPC JWT verifier public key/
    )
  })

  it('rejects an explicit verifier override that does not match the signing key', async () => {
    process.env.CONTROL_API_RPC_JWT_PUBLIC_KEY = freshVerifyingMaterial()
    await expect(() => import('../src/config.js')).rejects.toThrow(/must correspond to/)
  })

  it('accepts an explicit verifier override derived from the signing key', async () => {
    const signing = process.env.CONTROL_API_RPC_JWT_PRIVATE_KEY ?? freshSigningMaterial()
    process.env.CONTROL_API_RPC_JWT_PRIVATE_KEY = signing
    process.env.CONTROL_API_RPC_JWT_PUBLIC_KEY = createPublicKey(signing)
      .export({ type: 'spki', format: 'pem' })
      .toString()
    await expect(import('../src/config.js')).resolves.toBeDefined()
  })

  it('accepts fresh RSA-2048 keys whose bodies start with the historical prefixes', async () => {
    applyProdEnv(process.env)
    process.env.CONTROL_API_RPC_JWT_PRIVATE_KEY = signingMaterialWithBodyPrefix('MIIEvA')
    process.env.CONTROL_API_SESSION_JWT_PRIVATE_KEY = signingMaterialWithBodyPrefix('MIIEvg')
    process.env.CONTROL_API_ADMIN_JWT_PRIVATE_KEY = signingMaterialWithBodyPrefix('MIIEvQ')
    const { config } = await import('../src/config.js')
    expect(config.rpcJwtPrivateKey).toContain('BEGIN')
    expect(config.sessionJwtPrivateKey).toContain('BEGIN')
    expect(config.adminJwtPrivateKey).toContain('BEGIN')
  })

  it('resolves with fully configured keys for non-production NODE_ENV values', async () => {
    for (const nodeEnv of ['test', 'development', undefined]) {
      vi.resetModules()
      resetEnv()
      if (nodeEnv) process.env.NODE_ENV = nodeEnv
      await expect(import('../src/config.js')).resolves.toBeDefined()
    }
  })

  it('performs no dev-key store I/O when every slot is configured', async () => {
    for (const devMode of [undefined, 'true']) {
      vi.resetModules()
      if (devMode) process.env.CLERUM_DEV_MODE = devMode
      else delete process.env.CLERUM_DEV_MODE
      await import('../src/config.js')
      expect(devProviderMocks.load).not.toHaveBeenCalled()
    }
  })

  it('rejects a historical verifier key even in explicit dev mode', async () => {
    process.env.CLERUM_DEV_MODE = 'true'
    process.env.CONTROL_API_RPC_JWT_PUBLIC_KEY = HISTORICAL.rpc
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /effective RPC JWT verifier public key/
    )
  })
})
