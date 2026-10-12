import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import request from 'supertest'
import { publicKeyPemFingerprint } from '@clerum/jwt-key-policy'
import { clerumErrorHandler } from '../src/http/errorHandler.js'
import { rootLogger } from '../src/observability/logger.js'
import { createRegistryConnectRouter } from '../src/routes/admin/registryConnect.js'
import {
  __resetRegistryConnectionCacheForTests,
  upsertPendingConnection,
} from '../src/services/registryConnectionDb.js'
import { __resetRegistryIdentityCacheGenerationForTests } from '../src/services/registryIdentityCache.js'

const { cfg, database, policy } = vi.hoisted(() => ({
  cfg: {
    registryConnectionMode: 'self-hosted',
    registryUrl: 'https://registry.example.invalid',
    oauthEncryptionKey: '',
  } as Record<string, unknown>,
  database: { query: vi.fn(), row: undefined as Record<string, unknown> | undefined },
  policy: { denied: new Set<string>(), denyRegistration: false },
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
    ) => {
      const denied = [...policy.denied]
      if (policy.denyRegistration) denied.push(actual.publicKeyPemFingerprint(raw))
      return actual.parseSigningMaterial(raw, source, {
        ...options,
        fingerprints: [...(options?.fingerprints ?? []), ...denied],
      })
    },
  }
})
// Auth/ratelimit/SQL transport are named HTTP preconditions and external
// boundaries. The producer, encryption, key policy, PoP, routes and handler run.
vi.mock('../src/middleware/controlUIAuth.js', () => ({
  requireAuthForControlUI: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => {
    ;(req as unknown as { adminAuth: { sub: string } }).adminAuth = { sub: 'admin-contract' }
    next()
  },
}))
vi.mock('../src/middleware/rateLimitMiddleware.js', () => ({
  rateLimitMiddleware:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}))
vi.mock('../src/services/adminAuthService.js', () => ({
  findAdminById: async () => ({ id: 'admin-contract', username: 'contract', status: 'active' }),
}))

function pair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  database.row = undefined
  cfg.registryUrl = 'https://registry.example.invalid'
  cfg.oauthEncryptionKey = randomBytes(32).toString('hex')
  policy.denied.clear()
  policy.denyRegistration = false
  database.query.mockImplementation(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('DELETE FROM registry_connection')) database.row = undefined
    if (sql.includes('INSERT INTO registry_connection'))
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
    const current = database.row
    if (
      sql.includes('UPDATE registry_connection') &&
      current &&
      current.deployment_id === values[3]
    ) {
      Object.assign(current, {
        client_id: values[0],
        client_secret_encrypted: values[1],
        org_name: values[2],
        status: 'connected',
      })
    }
    return {
      rows: sql.includes('SELECT deployment_id') && database.row ? [database.row] : [],
      rowCount: 1,
    }
  })
  vi.spyOn(rootLogger, 'warn')
})
afterEach(() => {
  __resetRegistryConnectionCacheForTests()
  __resetRegistryIdentityCacheGenerationForTests()
  vi.restoreAllMocks()
})

async function persist(status: 'pending' | 'approved', invalid?: string) {
  const material = pair()
  await upsertPendingConnection({
    deploymentId: 'deployment-contract',
    keyId: 'key-contract',
    publicKeyPem: material.publicKey,
    privateKeyPem: invalid ?? material.privateKey,
    requestedOrgName: 'contract-org',
    contactEmail: 'contract@example.invalid',
    registryUrl: 'https://registry.example.invalid',
    status,
  })
  database.query.mockClear()
  return material
}
function app() {
  const application = express()
  application.use(express.json())
  application.use((req, _res, next) => {
    ;(req as unknown as { log: typeof rootLogger }).log = rootLogger
    ;(req as unknown as { correlationId: string }).correlationId = 'registry-policy-contract'
    next()
  })
  application.use(createRegistryConnectRouter())
  application.use(clerumErrorHandler)
  return application
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const mutationCount = () =>
  database.query.mock.calls.filter(([sql]) => /DELETE|INSERT|UPDATE/.test(sql)).length

// Opaque credentials are generated per boundary response, never literal fixtures.
const claimEvidence = () => Object.fromEntries([['claim_token', randomUUID()]])
const claimedCredentials = () =>
  Object.fromEntries([
    ['client_id', 'client-contract'],
    ['client_secret', randomUUID()],
    ['org', 'contract-org'],
  ])

function registryBoundary(publicKey: string) {
  const effects = { burns: 0, rotations: 0, claims: [] as jwt.JwtPayload[] }
  const outbound = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = String(input)
    const pop = (options?.headers as Record<string, string> | undefined)?.DPoP
    if (pop)
      effects.claims.push(
        jwt.verify(pop, publicKey, {
          algorithms: ['RS256'],
          audience: 'registry-api',
        }) as jwt.JwtPayload
      )
    if (url.endsWith('/status'))
      return response({ status: 'approved', claimed: false, suspended: false })
    if (url.endsWith('/claim-token')) {
      effects.rotations++
      return response(claimEvidence())
    }
    if (url.endsWith('/claim')) {
      effects.burns++
      return response(claimedCredentials())
    }
    throw new Error('Unexpected registry boundary call')
  })
  return { outbound, effects }
}

describe('permanent persisted PoP policy conflicts', () => {
  for (const kind of ['denied', 'malformed', 'mixed'] as const) {
    it.each(['pending status', 'approved status', 'manual claim', 'recovery'])(
      `${kind} key blocks %s before every registry/state effect`,
      async operation => {
        const invalid =
          kind === 'malformed'
            ? 'invalid signing material for a corruption fixture'
            : kind === 'mixed'
              ? pair().privateKey + pair().publicKey
              : undefined
        const material = await persist(
          operation === 'approved status' || operation === 'recovery' ? 'approved' : 'pending',
          invalid
        )
        if (kind === 'denied') policy.denied.add(publicKeyPemFingerprint(material.publicKey))
        const before = JSON.stringify(database.row)
        const { outbound, effects } = registryBoundary(material.publicKey)
        const signing = vi.spyOn(jwt, 'sign')
        const client = request(app())
        const result = operation.endsWith('status')
          ? await client.get('/admin/registry/connect').expect(409)
          : await client
              .post(
                operation === 'recovery'
                  ? '/admin/registry/connect/recover'
                  : '/admin/registry/connect/claim'
              )
              .send(claimEvidence())
              .expect(409)
        expect(result.body.error).toBe('registry_signing_material_unavailable')
        expect(outbound.mock.calls.length).toBe(0)
        expect(signing.mock.calls.length).toBe(0)
        expect(effects.burns).toBe(0)
        expect(effects.rotations).toBe(0)
        expect(mutationCount()).toBe(0)
        expect(JSON.stringify(database.row) === before).toBe(true)
        const events = vi
          .mocked(rootLogger.warn)
          .mock.calls.map(([fields]) => fields as Record<string, unknown>)
        expect(events.some(fields => fields.event === 'registry_pop_key_unavailable')).toBe(true)
        expect(JSON.stringify(events).includes('BEGIN')).toBe(false)
        expect(JSON.stringify(events).includes(database.row!.private_key_encrypted as string)).toBe(
          false
        )
      }
    )
  }
})

describe('fresh registry PoP contracts and transient separation', () => {
  it('preserves real pending status and manual claim with the persisted kid/claims', async () => {
    const material = await persist('pending')
    const { effects } = registryBoundary(material.publicKey)
    const result = await request(app()).get('/admin/registry/connect').expect(200)
    expect(result.body.state).toBe('approved')
    await request(app()).post('/admin/registry/connect/claim').send(claimEvidence()).expect(200)
    expect(database.row!.status).toBe('connected')
    expect(effects.burns).toBe(1)
    expect(effects.claims.length).toBe(2)
    expect(new Set(effects.claims.map(claims => claims.jti)).size).toBe(2)
    for (const claims of effects.claims) {
      expect(claims.sub).toBe('admin-contract')
      expect(claims.iat).toBeUndefined()
      expect(claims.exp! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(120)
    }
  })

  it('preserves real recovery rotation/claim and commits connected only after claim success', async () => {
    const material = await persist('approved')
    const { effects, outbound } = registryBoundary(material.publicKey)
    const result = await request(app()).post('/admin/registry/connect/recover').expect(200)
    expect(result.body.state).toBe('connected')
    expect(effects.rotations).toBe(1)
    expect(effects.burns).toBe(1)
    expect(outbound.mock.calls.length).toBe(3)
    expect(mutationCount()).toBe(1)
    expect(database.row!.status).toBe('connected')
  })

  it('keeps actual transport failures as pending/connecting and does not mutate or burn', async () => {
    await persist('pending')
    const outbound = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Fixture registry transport failure'))
    const result = await request(app()).get('/admin/registry/connect').expect(200)
    expect(result.body.state).toBe('pending')
    expect(mutationCount()).toBe(0)
    expect(outbound.mock.calls.length).toBe(1)
    const manual = await request(app())
      .post('/admin/registry/connect/claim')
      .send(claimEvidence())
      .expect(500)
    expect(manual.body.error === 'registry_signing_material_unavailable').toBe(false)
    expect(mutationCount()).toBe(0)
    await persist('approved')
    const recovery = await request(app()).post('/admin/registry/connect/recover').expect(202)
    expect(recovery.body.state).toBe('connecting')
    expect(mutationCount()).toBe(0)
  })

  it('rejects a denied new registration before outbound registration and local persistence', async () => {
    policy.denyRegistration = true
    const outbound = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({}, 201))
    const signing = vi.spyOn(jwt, 'sign')
    const result = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'contract-org', contact_email: 'contract@example.invalid' })
      .expect(409)
    expect(result.body.error).toBe('registry_signing_material_unavailable')
    expect(outbound.mock.calls.length).toBe(0)
    expect(signing.mock.calls.length).toBe(0)
    expect(mutationCount()).toBe(0)
    expect(database.row === undefined).toBe(true)
  })

  it('keeps fresh registration no-kid PoP and auto-claim producer/connected behavior', async () => {
    let registeringPublic = ''
    let claimsConsumed = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (String(input).endsWith('/register')) {
        const body = JSON.parse(options!.body as string) as {
          public_key_pem: string
          pop: string
          deployment_info: { auto_claim: boolean }
        }
        registeringPublic = body.public_key_pem
        const signed = jwt.decode(body.pop, { complete: true })!
        expect(signed.header.kid).toBeUndefined()
        expect(body.deployment_info.auto_claim).toBe(true)
        expect(
          (jwt.verify(body.pop, registeringPublic, { audience: 'registry-api' }) as jwt.JwtPayload)
            .sub
        ).toBe('admin-contract')
        return response(
          { ...claimEvidence(), deployment_id: 'deployment-contract', key_id: 'key-contract' },
          201
        )
      }
      if (String(input).endsWith('/claim')) {
        const pop = (options!.headers as Record<string, string>).DPoP
        expect(jwt.decode(pop, { complete: true })!.header.kid).toBe('key-contract')
        jwt.verify(pop, registeringPublic, { algorithms: ['RS256'], audience: 'registry-api' })
        claimsConsumed++
        return response(claimedCredentials())
      }
      throw new Error('Unexpected registry boundary call')
    })
    const result = await request(app())
      .post('/admin/registry/connect/request')
      .send({ requested_org_name: 'contract-org', contact_email: 'contract@example.invalid' })
      .expect(200)
    expect(result.body.state).toBe('connected')
    expect(claimsConsumed).toBe(1)
    expect(database.row!.status).toBe('connected')
    expect(database.row!.requested_org_name).toBe('contract-org')
    expect(database.row!.contact_email).toBe('contract@example.invalid')
  })

  it('allows explicit DELETE cleanup with no URL even when the stored key is invalid', async () => {
    await persist('approved', 'invalid signing material for a cleanup fixture')
    cfg.registryUrl = ''
    const outbound = vi.spyOn(globalThis, 'fetch')
    const signing = vi.spyOn(jwt, 'sign')
    await request(app()).delete('/admin/registry/connect').expect(204)
    expect(database.row === undefined).toBe(true)
    expect(mutationCount()).toBe(1)
    expect(outbound.mock.calls.length).toBe(0)
    expect(signing.mock.calls.length).toBe(0)
  })
})
