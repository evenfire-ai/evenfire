import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BANNED_DEV_JWT_PUBLIC_KEYS as HISTORICAL } from './fixtures/bannedDevJwtPublicKeys.js'
import { applyProdEnv } from './fixtures/productionConfigEnv.js'

const ORIGINAL_ENV = { ...process.env }
const SLOT_ENV_NAMES = [
  'CONTROL_API_RPC_JWT_PRIVATE_KEY',
  'CONTROL_API_SESSION_JWT_PRIVATE_KEY',
  'CONTROL_API_ADMIN_JWT_PRIVATE_KEY',
] as const

const fixtureApi = createRequire(import.meta.url)(
  '../../packages/jwt-key-policy/test/crypto-fixtures.cjs'
) as {
  encodings: (material: string) => Record<string, string>
  certificate: (material: KeyObject) => string
}
const rsaPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const rsa4096Pair = generateKeyPairSync('rsa', { modulusLength: 4096 })
const caseIdentity2048 = createHash('sha256')
  .update(rsaPair.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex')
const caseIdentity4096 = createHash('sha256')
  .update(rsa4096Pair.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex')
const signingCasePem = rsaPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim()
const signingCasePublic = rsaPair.publicKey
  .export({ type: 'spki', format: 'pem' })
  .toString()
  .trim()
const signingCaseCertificate = fixtureApi.certificate(rsaPair.privateKey)
const decoyCasePem = freshSigningMaterial()
const otherCertificate = fixtureApi.certificate(
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
)
const signingCases = [
  ...Object.entries(fixtureApi.encodings(signingCasePem)).map(([name, material]) => ({
    name,
    material,
    reason: undefined,
  })),
  {
    name: 'pkcs1',
    material: rsaPair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    reason: undefined,
  },
  {
    name: 'rsa4096',
    material: rsa4096Pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    reason: undefined,
  },
  {
    name: 'rsa1024',
    material: generateKeyPairSync('rsa', { modulusLength: 1024 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    reason: 'undersized_rsa_key',
  },
  {
    name: 'encrypted',
    material: rsaPair.privateKey
      .export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: randomUUID() })
      .toString(),
    reason: 'encrypted_private_key',
  },
  { name: 'malformed', material: 'malformed operator key material', reason: 'invalid_pem' },
  { name: 'public', material: signingCasePublic, reason: 'wrong_key_role' },
  {
    name: 'ec',
    material: generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    reason: 'non_rsa_key',
  },
  ...Object.entries({
    privateThenPrivate: `${signingCasePem}\n${decoyCasePem}`,
    publicThenPrivate: `${signingCasePublic}\n${signingCasePem}`,
    privateThenPublic: `${signingCasePem}\n${signingCasePublic}`,
    certificateThenPrivate: `${signingCaseCertificate}\n${signingCasePem}`,
    privateThenCertificate: `${signingCasePem}\n${signingCaseCertificate}`,
    certificateThenCertificate: `${signingCaseCertificate}\n${otherCertificate}`,
    escapedCertificateThenPrivate: `${signingCaseCertificate}\n${signingCasePem}`.replace(
      /\n/g,
      '\\n'
    ),
  }).map(([name, material]) => ({ name, material, reason: 'multiple_pem_objects' })),
]

let providerLoad: MockInstance<
  typeof import('../src/devSigningKeys.js').loadOrCreateDevJwtSigningMaterial
>
let fixtureRoot: string
let fixtureStore: string

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
  delete process.env.CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY
}

beforeEach(async () => {
  vi.resetModules()
  resetEnv()
  fixtureRoot = mkdtempSync(join(tmpdir(), 'evenfire-config-jwt-'))
  fixtureStore = join(fixtureRoot, '.dev-keys')
  process.env.EVENFIRE_DEV_KEY_STORE = fixtureStore
  const provider = await import('../src/devSigningKeys.js')
  providerLoad = vi.spyOn(provider, 'loadOrCreateDevJwtSigningMaterial')
})

afterEach(() => {
  resetEnv()
  vi.restoreAllMocks()
  vi.resetModules()
  rmSync(fixtureRoot, { recursive: true, force: true })
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
    expect(providerLoad).not.toHaveBeenCalled()
    expect(existsSync(fixtureStore)).toBe(false)
  })

  it('uses the dev provider for unset slots in dev mode', async () => {
    for (const name of SLOT_ENV_NAMES) delete process.env[name]
    process.env.CLERUM_DEV_MODE = 'true'
    const { config } = await import('../src/config.js')
    expect(providerLoad).toHaveBeenCalledTimes(3)
    expect(readdirSync(fixtureStore).sort()).toEqual([
      'admin.pem',
      'admin.public.pem',
      'rpc.pem',
      'rpc.public.pem',
      'session.pem',
      'session.public.pem',
    ])
    expect(
      createPublicKey(config.rpcJwtPrivateKey)
        .export({ type: 'spki', format: 'pem' })
        .toString()
        .trim() === config.rpcJwtPublicKey
    ).toBe(true)
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
    expect(config.rpcJwtPrivateKey.includes('BEGIN')).toBe(true)
    expect(config.sessionJwtPrivateKey.includes('BEGIN')).toBe(true)
    expect(config.adminJwtPrivateKey.includes('BEGIN')).toBe(true)
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
      expect(providerLoad).not.toHaveBeenCalled()
      expect(existsSync(fixtureStore)).toBe(false)
    }
  })

  it('rejects a historical verifier key even in explicit dev mode', async () => {
    process.env.CLERUM_DEV_MODE = 'true'
    process.env.CONTROL_API_RPC_JWT_PUBLIC_KEY = HISTORICAL.rpc
    await expect(() => import('../src/config.js')).rejects.toThrow(
      /effective RPC JWT verifier public key/
    )
  })

  for (const name of [
    ...SLOT_ENV_NAMES,
    'CONTROL_API_RPC_JWT_PUBLIC_KEY',
    'CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY',
  ]) {
    it(`validates explicit ${name} before generating any missing dev slot`, async () => {
      for (const slot of SLOT_ENV_NAMES) delete process.env[slot]
      process.env.CLERUM_DEV_MODE = 'true'
      process.env[name] = 'malformed operator material'
      await expect(import('../src/config.js')).rejects.toMatchObject({
        code: 'ERR_JWT_KEY_INVALID',
      })
      expect(providerLoad).not.toHaveBeenCalled()
      expect(existsSync(fixtureStore)).toBe(false)
    })
  }

  it('keeps fully configured identity independent of an unused relative store override', async () => {
    process.env.CLERUM_DEV_MODE = 'true'
    process.env.EVENFIRE_DEV_KEY_STORE = 'unused-relative-store'
    const { config } = await import('../src/config.js')
    expect(config.rpcJwtPublicKey.includes('PUBLIC KEY')).toBe(true)
    expect(providerLoad).not.toHaveBeenCalled()
    expect(existsSync(fixtureStore)).toBe(false)
  })

  for (const [slot, envName] of [
    ['rpc', SLOT_ENV_NAMES[0]],
    ['session', SLOT_ENV_NAMES[1]],
    ['admin', SLOT_ENV_NAMES[2]],
  ] as const) {
    it(`rejects a generated denied ${slot} identity before its actual consumer signs`, async () => {
      const policy = await import('@clerum/jwt-key-policy')
      const offender = freshSigningMaterial()
      const denied = policy.publicKeyPemFingerprint(
        createPublicKey(offender).export({ type: 'spki', format: 'pem' }).toString()
      )
      const parse = policy.parseSigningMaterial
      vi.spyOn(policy, 'parseSigningMaterial').mockImplementation((raw, source, options) =>
        parse(raw, source, { ...options, fingerprints: [denied] })
      )
      process.env[envName] = offender
      const loadConsumer =
        slot === 'rpc'
          ? () => import('../src/utils/auth/rpcAuthToken.js')
          : slot === 'session'
            ? () => import('../src/utils/auth/externalSessionAuthToken.js')
            : () => import('../src/utils/auth/adminAuthToken.js')
      await expect(loadConsumer()).rejects.toMatchObject({
        code: 'ERR_JWT_KEY_BANNED',
        reason: 'banned_identity',
      })
      expect(providerLoad).not.toHaveBeenCalled()
      expect(existsSync(fixtureStore)).toBe(false)
    })
  }

  it('signs and verifies through actual admin, session, and RPC consumers after canonicalization', async () => {
    const material = freshSigningMaterial()
    const escapedCr = material.replace(/\n/g, '\\r')
    for (const name of SLOT_ENV_NAMES) process.env[name] = escapedCr
    const admin = await import('../src/utils/auth/adminAuthToken.js')
    const session = await import('../src/utils/auth/externalSessionAuthToken.js')
    const rpc = await import('../src/utils/auth/rpcAuthToken.js')
    expect(admin.verifyAdminToken(admin.signAdminToken('contract-admin'))?.sub).toBe(
      'contract-admin'
    )
    const sessionResult = session.verifyExternalSessionToken(
      session.signExternalSessionToken({
        userId: 'contract-user',
        email: 'contract@example.invalid',
        teamId: null,
        role: 'member',
        authGeneration: 1,
      })
    )
    expect(sessionResult?.userId).toBe('contract-user')
    expect(
      rpc.verifyRpcAccessToken(
        rpc.signRpcAccessToken({
          sub: 'contract-rpc',
          typ: 'user',
          teamId: null,
          accessScope: 'user',
          scopes: ['host:health:read'],
          hostRefs: ['contract-host'],
          jti: 'contract-jti',
        })
      )?.sub
    ).toBe('contract-rpc')
  })

  for (const [slot, envName, field] of [
    ['rpc', SLOT_ENV_NAMES[0], 'rpcJwtPrivateKey'],
    ['session', SLOT_ENV_NAMES[1], 'sessionJwtPrivateKey'],
    ['admin', SLOT_ENV_NAMES[2], 'adminJwtPrivateKey'],
    ['voucher', 'CONTROL_API_REGISTRY_VOUCHER_PRIVATE_KEY', 'registryVoucherPrivateKey'],
  ] as const) {
    for (const testCase of signingCases) {
      it(`${slot} applies the canonical signing policy to ${testCase.name}`, async () => {
        process.env[envName] = testCase.material
        if (testCase.reason) {
          await expect(import('../src/config.js')).rejects.toMatchObject({
            code: 'ERR_JWT_KEY_INVALID',
            reason: testCase.reason,
            source: envName,
          })
        } else {
          const { config } = await import('../src/config.js')
          const policy = await import('@clerum/jwt-key-policy')
          const expected = testCase.name === 'rsa4096' ? caseIdentity4096 : caseIdentity2048
          const actual = policy.publicKeyPemFingerprint(
            createPublicKey(config[field]).export({ type: 'spki', format: 'pem' }).toString()
          )
          expect(actual).toBe(expected)
          expect(config[field].startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true)
        }
        expect(providerLoad).not.toHaveBeenCalled()
        expect(existsSync(fixtureStore)).toBe(false)
      })
    }
  }
})
