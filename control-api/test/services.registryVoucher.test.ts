import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import request from 'supertest'
import { publicKeyPemFingerprint } from '@clerum/jwt-key-policy'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { rootLogger } from '../src/observability/logger.js'
import { createRegistryRouter } from '../src/routes/registry.js'
import {
  __resetRegistryConnectionCacheForTests,
  resolveVoucherSigningMaterial,
  upsertPendingConnection,
} from '../src/services/registryConnectionDb.js'
import { __resetRegistryIdentityCacheGenerationForTests } from '../src/services/registryIdentityCache.js'
import { VoucherUnavailableError, mintIdentityVoucher } from '../src/services/registryVoucher.js'

const { cfg, database, deniedIdentities } = vi.hoisted(() => ({
  cfg: {
    registryConnectionMode: 'managed',
    registryVoucherPrivateKey: '',
    registryVoucherKid: '',
    adminJwtPrivateKey: '',
    registryClientId: '',
    oauthEncryptionKey: '',
  } as Record<string, unknown>,
  database: { query: vi.fn(), row: undefined as Record<string, unknown> | undefined },
  deniedIdentities: new Set<string>(),
}))
vi.mock('../src/config.js', () => ({ config: cfg }))
vi.mock('../src/db.js', () => ({
  pool: { query: (sql: string, values?: unknown[]) => database.query(sql, values) },
  withTransaction: async (run: (db: unknown) => Promise<unknown>) =>
    run({ query: (sql: string, values?: unknown[]) => database.query(sql, values) }),
}))
vi.mock('@clerum/jwt-key-policy', async importOriginal => {
  const actual = await importOriginal<typeof import('@clerum/jwt-key-policy')>()
  return {
    ...actual,
    parseSigningMaterial: (
      raw: string,
      source: string,
      options?: import('@clerum/jwt-key-policy').JwtFingerprintOptions
    ) =>
      actual.parseSigningMaterial(raw, source, {
        ...options,
        fingerprints: [...(options?.fingerprints ?? []), ...deniedIdentities],
      }),
  }
})
// Authenticated admin and rate-limit persistence are HTTP preconditions. Policy,
// SQL producer, encryption, voucher signer, router and global handler stay real.
vi.mock('../src/middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    ;(req as unknown as { adminAuth: { sub: string } }).adminAuth = { sub: 'admin-1' }
    next()
  },
}))
vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}))
vi.mock('../src/services/adminAuthService.js', () => ({
  findAdminById: async () => ({ id: 'admin-1', username: 'alice', status: 'active' }),
}))

function keypair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}
const admin = { id: 'admin-1', username: 'alice' } as never

beforeEach(() => {
  vi.clearAllMocks()
  database.row = undefined
  database.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('DELETE FROM registry_connection')) database.row = undefined
    if (sql.includes('INSERT INTO registry_connection')) {
      database.row = {
        deployment_id: values[0],
        key_id: values[1],
        public_key_pem: values[2],
        private_key_encrypted: values[3],
        requested_org_name: values[4],
        contact_email: values[5],
        status: values[6],
        registry_url: values[7],
        client_id: null,
        client_secret_encrypted: null,
        org_name: null,
      }
    }
    return {
      rows: sql.includes('SELECT deployment_id') && database.row ? [database.row] : [],
      rowCount: 1,
    }
  })
  cfg.oauthEncryptionKey = randomBytes(32).toString('hex')
  vi.spyOn(rootLogger, 'warn')
  vi.spyOn(rootLogger, 'error')
})
afterEach(() => {
  __resetRegistryConnectionCacheForTests()
  __resetRegistryIdentityCacheGenerationForTests()
  deniedIdentities.clear()
  cfg.registryConnectionMode = 'managed'
  cfg.registryVoucherPrivateKey = ''
  cfg.registryVoucherKid = ''
  cfg.adminJwtPrivateKey = ''
  cfg.registryClientId = ''
  vi.restoreAllMocks()
})

async function persist(pair = keypair(), stored = pair.privateKey) {
  cfg.registryConnectionMode = 'self-hosted'
  await upsertPendingConnection({
    deploymentId: 'deployment-1',
    keyId: 'key-uuid-42',
    publicKeyPem: pair.publicKey,
    privateKeyPem: stored,
    requestedOrgName: 'contract-org',
    contactEmail: 'contract@example.invalid',
    registryUrl: 'https://registry.example.invalid',
    status: 'approved',
  })
  return pair
}

function app() {
  const application = express()
  application.use((req, _res, next) => {
    ;(req as unknown as { log: typeof rootLogger }).log = rootLogger
    ;(req as unknown as { correlationId: string }).correlationId = 'voucher-contract'
    next()
  })
  application.use(createRegistryRouter())
  application.use(clerumErrorHandler)
  return application
}

function reasonEvents() {
  return vi.mocked(rootLogger.warn).mock.calls.map(([fields]) => fields as Record<string, unknown>)
}

describe('managed voucher v2', () => {
  it('signs exactly the five voucher claims with the dedicated kid and 60-second TTL', async () => {
    const pair = keypair()
    cfg.registryVoucherPrivateKey = pair.privateKey
    cfg.registryVoucherKid = 'key-uuid-42'
    const signedJwt = await mintIdentityVoucher(admin)
    const header = jwt.decode(signedJwt, { complete: true })!.header
    const payload = jwt.verify(signedJwt, pair.publicKey, {
      algorithms: ['RS256'],
      issuer: 'control-api',
      audience: 'registry-api',
    }) as jwt.JwtPayload
    expect(header.alg).toBe('RS256')
    expect(header.kid).toBe('key-uuid-42')
    expect(payload.sub).toBe('admin-1')
    expect(Object.keys(payload).sort()).toEqual(['aud', 'exp', 'iss', 'jti', 'sub'])
    expect(payload.exp! - Math.floor(Date.now() / 1000)).toBeGreaterThan(0)
    expect(payload.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60)
  })

  it('requires the dedicated key and kid even when an admin key exists', async () => {
    cfg.adminJwtPrivateKey = keypair().privateKey
    cfg.registryVoucherKid = 'key-uuid-42'
    await expect(mintIdentityVoucher(admin)).rejects.toBeInstanceOf(VoucherUnavailableError)
    cfg.registryVoucherPrivateKey = keypair().privateKey
    cfg.registryVoucherKid = ''
    await expect(mintIdentityVoucher(admin)).rejects.toBeInstanceOf(VoucherUnavailableError)
    expect(database.query.mock.calls.length).toBe(0)
  })

  it('canonicalizes a managed PKCS1/escaped-CR private representation', async () => {
    const pair = keypair()
    cfg.registryVoucherPrivateKey = createPrivateKey(pair.privateKey)
      .export({ type: 'pkcs1', format: 'pem' })
      .toString()
      .replace(/\n/g, '\\r')
    cfg.registryVoucherKid = 'key-uuid-42'
    const resolved = await resolveVoucherSigningMaterial()
    expect(resolved.signingKey === pair.privateKey.trim()).toBe(true)
    const signedJwt = await mintIdentityVoucher(admin)
    expect(
      (jwt.verify(signedJwt, pair.publicKey, { audience: 'registry-api' }) as jwt.JwtPayload).sub
    ).toBe('admin-1')
  })
})

describe('persisted voucher key policy and actual HTTP composition', () => {
  it('uses the real producer/encryption row and signs a fresh voucher through the HTTP route', async () => {
    const pair = await persist()
    for (const column of [
      'deployment_id',
      'key_id',
      'public_key_pem',
      'private_key_encrypted',
      'requested_org_name',
      'contact_email',
      'status',
    ]) {
      expect(
        typeof database.row![column] === 'string' && (database.row![column] as string).length > 0
      ).toBe(true)
    }
    expect(publicKeyPemFingerprint(database.row!.public_key_pem as string)).toBe(
      publicKeyPemFingerprint(pair.publicKey)
    )
    expect((database.row!.private_key_encrypted as string).includes(pair.privateKey)).toBe(false)
    const result = await request(app()).post('/registry/identity-voucher').expect(200)
    expect(typeof result.body.voucher).toBe('string')
    const payload = jwt.verify(result.body.voucher, pair.publicKey, {
      algorithms: ['RS256'],
      issuer: 'control-api',
      audience: 'registry-api',
    }) as jwt.JwtPayload
    expect(payload.sub).toBe('admin-1')
    expect(reasonEvents().length).toBe(0)
  })

  it('rejects a scoped denied persisted identity before signing and emits only safe reason metadata', async () => {
    const pair = await persist()
    deniedIdentities.add(publicKeyPemFingerprint(pair.publicKey))
    const signing = vi.spyOn(jwt, 'sign')
    const result = await request(app()).post('/registry/identity-voucher').expect(500)
    expect(result.body.error).toBe('registry_voucher_unavailable')
    expect(signing.mock.calls.length).toBe(0)
    expect(reasonEvents().map(fields => fields.event)).toEqual(['registry_voucher_key_banned'])
    expect(reasonEvents()[0]).toMatchObject({
      source: 'registry_connection',
      slot: 'voucher',
      reason: 'banned_identity',
      deploymentId: 'deployment-1',
    })
    const serialized = JSON.stringify(reasonEvents())
    expect(serialized.includes(pair.privateKey)).toBe(false)
    expect(serialized.includes(database.row!.private_key_encrypted as string)).toBe(false)
    expect(serialized.includes('BEGIN')).toBe(false)
  })

  it('rejects malformed decrypted signing material with a distinct safe reason event', async () => {
    await persist(keypair(), 'invalid signing material for a corruption fixture')
    const signing = vi.spyOn(jwt, 'sign')
    const result = await request(app()).post('/registry/identity-voucher').expect(500)
    expect(result.body.error).toBe('registry_voucher_unavailable')
    expect(signing.mock.calls.length).toBe(0)
    expect(reasonEvents().map(fields => fields.event)).toEqual(['registry_voucher_key_invalid'])
    expect(reasonEvents()[0].reason).toBe('invalid_pem')
  })

  it('keeps missing enrollment distinct from an invalid stored key', async () => {
    cfg.registryConnectionMode = 'self-hosted'
    const signing = vi.spyOn(jwt, 'sign')
    const result = await request(app()).post('/registry/identity-voucher').expect(500)
    expect(result.body.error).toBe('registry_voucher_unavailable')
    expect(signing.mock.calls.length).toBe(0)
    expect(reasonEvents().length).toBe(0)
  })

  it('preserves database and decryption failures instead of classifying them as missing enrollment', async () => {
    cfg.registryConnectionMode = 'self-hosted'
    const databaseFailure = new Error('database unavailable')
    database.query.mockRejectedValueOnce(databaseFailure)
    await expect(mintIdentityVoucher(admin)).rejects.toBe(databaseFailure)
    const pair = await persist()
    database.row!.private_key_encrypted = 'invalid-at-rest-envelope'
    const failure = await mintIdentityVoucher(admin).catch(error => error)
    expect(failure instanceof Error).toBe(true)
    expect(failure instanceof VoucherUnavailableError).toBe(false)
    expect(reasonEvents().length).toBe(0)
    expect(typeof pair.publicKey).toBe('string')
  })
})
