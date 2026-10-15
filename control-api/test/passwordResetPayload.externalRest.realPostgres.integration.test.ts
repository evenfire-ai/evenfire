import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import { type ChildProcess, spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { type Server, createServer, request as httpRequest } from 'node:http'
import path from 'node:path'
import { Pool } from 'pg'
import { config as controlConfig } from '../src/config.js'
import { initDb } from '../src/db.js'
import { requireInternalToken } from '../src/middleware/internalServiceAuth.js'
import { sendPasswordAdmissionError } from '../src/middleware/passwordLoginAdmission.js'
import { createExternalInvitationsRouter } from '../src/routes/external/invitations.js'
import { createSilentPasswordResetInvitation } from '../src/services/directory/passwordResetInvitations.js'
import { registerAndSendInvitation } from '../src/services/invitationFlowRegistrationService.js'
import {
  type ExternalRestHttpProcess,
  boundedRequest as request,
  startExternalRestHttpProcess,
} from './helpers/externalRestHttpProcess.js'
import { endPoolAndWaitForClients } from './helpers/realPostgresTeardown.js'

const holder = vi.hoisted(() => ({ pool: null as unknown as Pool }))

vi.mock('../src/db.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/db.js')>()
  const proxy = {
    query: (...args: unknown[]) => (holder.pool.query as Function)(...args),
    connect: () => holder.pool.connect(),
  }
  return {
    ...real,
    pool: proxy,
    corePool: proxy,
    rateLimitPool: proxy,
    withTransaction: (
      work: Parameters<typeof real.withTransaction>[0],
      _txPool?: Parameters<typeof real.withTransaction>[1],
      options?: Parameters<typeof real.withTransaction>[2]
    ) => real.withTransaction(work, holder.pool, options),
  }
})

const adminUrl = process.env.CONTROL_API_REAL_PG_ADMIN_URL
const memberRegistrationRoot = process.env.EVENFIRE_MEMBER_REGISTRATION_ROOT
const realProducer = adminUrl && memberRegistrationRoot ? describe : describe.skip
const internalToken = 'Synthetic-R4-L1-Internal-Token'
const tenantId = 'r4-l1-test-tenant'
const tenantKid = 'r4-l1-test-credential'
const tenantSecret = 'Synthetic-R4-L1-Member-Registration-Secret'
const externalConfig = { controlApiBaseUrl: '' }
const publicChildren: ExternalRestHttpProcess[] = []
let originalExternalJwtKey: string | undefined

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('test server did not bind TCP'))
        return
      }
      resolve(address.port)
    })
  })
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer()
  const port = await listen(server)
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  )
  return port
}

async function waitForMemberRegistration(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`local Member Registration producer exited (${child.exitCode})`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return
    } catch {
      // The local producer is still starting its PostgreSQL migrations.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('local Member Registration producer did not become ready')
}

function createDropResetResponseProxy(controlApiPort: number) {
  let resetPostCount = 0
  let droppedResolve!: () => void
  const droppedResetResponse = new Promise<void>(resolve => {
    droppedResolve = resolve
  })
  const server = createServer((incoming, outgoing) => {
    const target = httpRequest({
      host: '127.0.0.1',
      port: controlApiPort,
      method: incoming.method,
      path: incoming.url,
      headers: { ...incoming.headers, host: `127.0.0.1:${controlApiPort}` },
    })
    target.on('response', response => {
      if (
        incoming.method === 'POST' &&
        incoming.url?.endsWith('/external/invitations/password-token')
      ) {
        resetPostCount += 1
        response.resume()
        response.once('end', () => {
          droppedResolve()
          outgoing.destroy()
        })
        return
      }
      outgoing.statusCode = response.statusCode || 502
      outgoing.setHeader('content-type', 'application/json')
      response.pipe(outgoing)
    })
    target.on('error', () => outgoing.destroy())
    incoming.pipe(target)
  })
  return {
    server,
    start: async () => {
      const port = await listen(server)
      return `http://127.0.0.1:${port}/api/v1`
    },
    get resetPostCount() {
      return resetPostCount
    },
    droppedResetResponse,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      ),
  }
}

describe('ambiguous reset response proxy', () => {
  it('keeps a constant JSON header and drops upstream response headers', async () => {
    const upstream = createServer((_incoming, outgoing) => {
      outgoing.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '900',
        'x-user-selected-header': 'must-not-cross-the-proxy',
      })
      outgoing.end(JSON.stringify({ error: 'synthetic upstream response' }))
    })
    const upstreamPort = await listen(upstream)
    const proxy = createDropResetResponseProxy(upstreamPort)
    const proxyUrl = await proxy.start()

    try {
      const response = await fetch(`${proxyUrl}/token-preview`, {
        headers: { connection: 'close' },
      })

      expect(response.status).toBe(429)
      expect(response.headers.get('content-type')).toBe('application/json')
      expect(response.headers.get('retry-after')).toBeNull()
      expect(response.headers.get('x-user-selected-header')).toBeNull()
      await expect(response.json()).resolves.toEqual({ error: 'synthetic upstream response' })
    } finally {
      await proxy.close()
      await new Promise<void>((resolve, reject) =>
        upstream.close(error => (error ? reject(error) : resolve()))
      )
    }
  })
})

realProducer('R4-L1 reset password payload through the public route and real producers', () => {
  const controlDatabase = `r4l1_control_${randomBytes(6).toString('hex')}`
  const producerDatabase = `r4l1_member_registration_${randomBytes(6).toString('hex')}`
  const registrationSecret = tenantSecret
  let admin: Pool
  let controlPool: Pool
  let observer: Pool
  let producerObserver: Pool
  let controlServer: Server | undefined
  let memberRegistrationProcess: ChildProcess | undefined
  let ambiguousProxy: ReturnType<typeof createDropResetResponseProxy> | undefined
  let controlApiPort = 0
  let controlBaseUrl = ''
  let producerBaseUrl = ''
  async function publicApp() {
    const child = await startExternalRestHttpProcess({
      controlApiBaseUrl: externalConfig.controlApiBaseUrl,
      controlApiServiceToken: internalToken,
      jwtPrivateKey: controlConfig.sessionJwtPrivateKey,
    })
    publicChildren.push(child)
    return child.baseUrl
  }
  let producerResponses: Array<{ status: number; error: string | null }> = []
  let originalControlConfig: Record<string, unknown> = {}

  beforeAll(async () => {
    originalExternalJwtKey = process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY
    if (!originalExternalJwtKey) {
      process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).publicKey
    }
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`CREATE DATABASE "${controlDatabase}"`)
    await admin.query(`CREATE DATABASE "${producerDatabase}"`)
    const controlUrl = new URL(adminUrl!)
    controlUrl.pathname = `/${controlDatabase}`
    const producerUrl = new URL(adminUrl!)
    producerUrl.pathname = `/${producerDatabase}`
    controlPool = new Pool({ connectionString: controlUrl.toString() })
    observer = new Pool({ connectionString: controlUrl.toString() })
    producerObserver = new Pool({ connectionString: producerUrl.toString() })
    holder.pool = controlPool
    await initDb(controlPool)

    originalControlConfig = {
      memberRegistrationMode: controlConfig.memberRegistrationMode,
      memberRegistrationServiceBaseUrl: controlConfig.memberRegistrationServiceBaseUrl,
      memberRegistrationServiceHmacSecret: controlConfig.memberRegistrationServiceHmacSecret,
      memberRegistrationServiceHmacKid: controlConfig.memberRegistrationServiceHmacKid,
      memberRegistrationTenantId: controlConfig.memberRegistrationTenantId,
      desktopExternalRestApiBaseUrl: controlConfig.desktopExternalRestApiBaseUrl,
      desktopRpcProxyBaseUrl: controlConfig.desktopRpcProxyBaseUrl,
      desktopProfileUiBaseUrl: controlConfig.desktopProfileUiBaseUrl,
      desktopAppName: controlConfig.desktopAppName,
      internalServiceToken: controlConfig.internalServiceTokens['external-rest-api'],
    }
    const producerPort = await freeLoopbackPort()
    memberRegistrationProcess = spawn(
      path.join(memberRegistrationRoot!, 'node_modules/.bin/tsx'),
      ['src/main.ts'],
      {
        cwd: memberRegistrationRoot,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          MEMBER_REGISTRATION_SERVICE_PORT: String(producerPort),
          MEMBER_REGISTRATION_SERVICE_PG_CONNECTION_STRING: producerUrl.toString(),
          MEMBER_REGISTRATION_SERVICE_INVITATION_JWT_SECRET: registrationSecret,
          MEMBER_REGISTRATION_SERVICE_ADMIN_TOKEN: 'Synthetic-R4-L1-Admin-Token',
          MEMBER_REGISTRATION_PUBLIC_BASE_URL: `http://127.0.0.1:${producerPort}`,
          MEMBER_REGISTRATION_SERVICE_SMTP_HOST: '',
          MEMBER_REGISTRATION_SERVICE_SMTP_USER: '',
          MEMBER_REGISTRATION_SERVICE_SMTP_PASSWORD: '',
        },
        stdio: 'ignore',
      }
    )
    await waitForMemberRegistration(producerPort, memberRegistrationProcess)
    producerBaseUrl = `http://127.0.0.1:${producerPort}/api/v1`
    await producerObserver.query(
      `INSERT INTO tenant_credentials(tenant_id, kid, hmac_secret, tenant_type, bound_domain)
       VALUES ($1, $2, $3, 'managed', NULL)`,
      [tenantId, tenantKid, registrationSecret]
    )

    controlConfig.memberRegistrationMode = 'remote'
    controlConfig.memberRegistrationServiceBaseUrl = producerBaseUrl
    controlConfig.memberRegistrationServiceHmacSecret = registrationSecret
    controlConfig.memberRegistrationServiceHmacKid = tenantKid
    controlConfig.memberRegistrationTenantId = tenantId
    controlConfig.desktopExternalRestApiBaseUrl = 'https://api.example.invalid'
    controlConfig.desktopRpcProxyBaseUrl = 'https://rpc.example.invalid'
    controlConfig.desktopProfileUiBaseUrl = 'https://member.example.invalid'
    controlConfig.desktopAppName = 'Synthetic Evenfire'
    controlConfig.internalServiceTokens['external-rest-api'] = internalToken

    const controlApp = express()
    controlApp.use(express.json())
    controlApp.use((req, res, next) => {
      if (req.method === 'POST' && req.path === '/api/v1/external/invitations/password-token') {
        const json = res.json.bind(res)
        res.json = ((body: unknown) => {
          const error =
            body && typeof body === 'object' && 'error' in body
              ? String((body as { error: unknown }).error)
              : null
          producerResponses.push({ status: res.statusCode, error })
          return json(body)
        }) as typeof res.json
      }
      next()
    })
    controlApp.use('/api/v1', requireInternalToken, createExternalInvitationsRouter())
    controlApp.use(
      (error: unknown, _req: express.Request, res: express.Response, _next: unknown) => {
        if (sendPasswordAdmissionError(error, res)) return
        res.status(500).json({ error: 'Internal Server Error' })
      }
    )
    controlServer = createServer(controlApp)
    controlApiPort = await listen(controlServer)
    controlBaseUrl = `http://127.0.0.1:${controlApiPort}/api/v1`

    externalConfig.controlApiBaseUrl = controlBaseUrl
  }, 60_000)

  afterAll(async () => {
    let childCleanup: PromiseSettledResult<void>[] | undefined
    try {
      childCleanup = await Promise.allSettled(publicChildren.splice(0).map(child => child.stop()))
      await ambiguousProxy?.close()
      if (controlServer) {
        await new Promise<void>(resolve => controlServer!.close(() => resolve()))
      }
      if (memberRegistrationProcess && memberRegistrationProcess.exitCode === null) {
        const stopped = once(memberRegistrationProcess, 'exit')
        memberRegistrationProcess.kill('SIGTERM')
        await stopped
      }
      if (controlPool) await endPoolAndWaitForClients(controlPool)
      if (observer) await endPoolAndWaitForClients(observer)
      if (producerObserver) await endPoolAndWaitForClients(producerObserver)
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${controlDatabase}"`)
        await admin.query(`DROP DATABASE IF EXISTS "${producerDatabase}"`)
      }
    } finally {
      await admin?.end()
      Object.assign(controlConfig, {
        memberRegistrationMode: originalControlConfig.memberRegistrationMode,
        memberRegistrationServiceBaseUrl: originalControlConfig.memberRegistrationServiceBaseUrl,
        memberRegistrationServiceHmacSecret:
          originalControlConfig.memberRegistrationServiceHmacSecret,
        memberRegistrationServiceHmacKid: originalControlConfig.memberRegistrationServiceHmacKid,
        memberRegistrationTenantId: originalControlConfig.memberRegistrationTenantId,
        desktopExternalRestApiBaseUrl: originalControlConfig.desktopExternalRestApiBaseUrl,
        desktopRpcProxyBaseUrl: originalControlConfig.desktopRpcProxyBaseUrl,
        desktopProfileUiBaseUrl: originalControlConfig.desktopProfileUiBaseUrl,
        desktopAppName: originalControlConfig.desktopAppName,
      })
      if (originalControlConfig.internalServiceToken) {
        controlConfig.internalServiceTokens['external-rest-api'] = String(
          originalControlConfig.internalServiceToken
        )
      }
      if (originalExternalJwtKey === undefined) {
        delete process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY
      } else {
        process.env.EXTERNAL_REST_API_JWT_PUBLIC_KEY = originalExternalJwtKey
      }
    }
    const failed = childCleanup?.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  })

  async function createReset(emailLabel: string) {
    const email = `r4l1-${emailLabel}-${randomUUID()}@example.invalid`
    const originalPassword = `Synthetic-R4-L1-Original-${randomUUID()}`
    const originalHash = await bcrypt.hash(originalPassword, 12)
    const userId = (
      await controlPool.query(
        'INSERT INTO users(email, password_hash) VALUES ($1, $2) RETURNING id',
        [email, originalHash]
      )
    ).rows[0].id as string
    const invitation = await createSilentPasswordResetInvitation({
      inviteeName: 'Synthetic R4-L1 member',
      email,
    })
    const sibling = await createSilentPasswordResetInvitation({
      inviteeName: 'Synthetic R4-L1 member',
      email,
    })
    await registerAndSendInvitation(
      email,
      invitation.token,
      null,
      invitation.created_at.toISOString(),
      invitation.expires_at.toISOString(),
      { purpose: 'password_reset' }
    )
    const registered = await producerObserver.query<{ invitation_jwt: string }>(
      `SELECT invitation_jwt
         FROM invitation_flow_registrations
        WHERE email = $1 AND invitation_uuid = $2::uuid
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [email, invitation.token]
    )
    const proof = registered.rows[0]?.invitation_jwt
    expect(proof).toEqual(expect.any(String))
    return {
      email,
      userId,
      originalHash,
      invitationId: invitation.id,
      siblingId: sibling.id,
      proof: proof!,
    }
  }

  it('returns sanitized 400 for the producer invalid-payload response and allows valid retry', async () => {
    producerResponses = []
    const reset = await createReset('empty')
    const empty = await request(await publicApp())
      .post('/api/v1/invitations/password')
      .send({
        token: reset.proof,
        email: reset.email,
        invitationId: reset.invitationId,
        password: '',
      })

    expect(empty.status).toBe(400)
    expect(empty.body).toEqual({ error: 'Password must be between 8 and 256 characters' })
    expect(JSON.stringify(empty.body)).not.toContain('invalid payload')
    expect(empty.headers['set-cookie']).toBeUndefined()
    expect(producerResponses.at(-1)).toEqual({ status: 400, error: 'invalid_password' })
    const unchanged = await observer.query(
      `SELECT primary_invite.status AS reset_status,
              sibling.status AS sibling_status,
              member_user.password_hash
         FROM invitations primary_invite
         JOIN invitations sibling ON sibling.id = $2
         JOIN users member_user ON member_user.id = $3
        WHERE primary_invite.id = $1`,
      [reset.invitationId, reset.siblingId, reset.userId]
    )
    expect(unchanged.rows[0]).toMatchObject({
      reset_status: 'pending',
      sibling_status: 'pending',
      password_hash: reset.originalHash,
    })

    const replacementPassword = `Synthetic-R4-L1-Replacement-${randomUUID()}`
    const valid = await request(await publicApp())
      .post('/api/v1/invitations/password')
      .send({
        token: reset.proof,
        email: reset.email,
        invitationId: reset.invitationId,
        password: replacementPassword,
      })
    expect(valid.status).toBe(200)
    expect(valid.headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('profile_session=')])
    )
    expect(valid.body).not.toHaveProperty('token')
    expect(valid.body).not.toHaveProperty('sessionContext')
    expect(producerResponses.at(-1)?.status).toBe(200)
    const accepted = await observer.query(
      `SELECT primary_invite.status AS reset_status,
              sibling.status AS sibling_status,
              member_user.password_hash
         FROM invitations primary_invite
         JOIN invitations sibling ON sibling.id = $2
         JOIN users member_user ON member_user.id = $3
        WHERE primary_invite.id = $1`,
      [reset.invitationId, reset.siblingId, reset.userId]
    )
    expect(accepted.rows[0]?.reset_status).toBe('accepted')
    expect(accepted.rows[0]?.sibling_status).toBe('revoked')
    expect(
      await bcrypt.compare(replacementPassword, accepted.rows[0]?.password_hash as string)
    ).toBe(true)
  }, 60_000)

  it('keeps an ambiguous post-dispatch outcome unknown and never repeats the reset', async () => {
    producerResponses = []
    const reset = await createReset('ambiguous')
    ambiguousProxy = createDropResetResponseProxy(controlApiPort)
    const proxyBaseUrl = await ambiguousProxy.start()
    externalConfig.controlApiBaseUrl = proxyBaseUrl
    const replacementPassword = `Synthetic-R4-L1-Ambiguous-${randomUUID()}`
    const unknown = await request(await publicApp())
      .post('/api/v1/invitations/password')
      .send({
        token: reset.proof,
        email: reset.email,
        invitationId: reset.invitationId,
        password: replacementPassword,
      })
    await ambiguousProxy.droppedResetResponse
    expect(unknown.status).toBe(503)
    expect(unknown.body).toEqual({ error: 'recovery_outcome_unknown', retryAfterSeconds: 2 })
    expect(unknown.headers['retry-after']).toBe('2')
    expect(unknown.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(unknown.body)).not.toContain(reset.proof)
    expect(ambiguousProxy.resetPostCount).toBe(1)

    const committed = await observer.query(
      `SELECT primary_invite.status AS reset_status,
              sibling.status AS sibling_status,
              member_user.password_hash,
              (SELECT COUNT(*)::int FROM password_verification_work) AS owners
         FROM invitations primary_invite
         JOIN invitations sibling ON sibling.id = $2
         JOIN users member_user ON member_user.id = $3
        WHERE primary_invite.id = $1`,
      [reset.invitationId, reset.siblingId, reset.userId]
    )
    expect(committed.rows[0]).toMatchObject({
      reset_status: 'accepted',
      sibling_status: 'revoked',
      owners: 0,
    })
    expect(
      await bcrypt.compare(replacementPassword, committed.rows[0]?.password_hash as string)
    ).toBe(true)

    externalConfig.controlApiBaseUrl = controlBaseUrl
    const replay = await request(await publicApp())
      .post('/api/v1/invitations/password')
      .send({
        token: reset.proof,
        email: reset.email,
        invitationId: reset.invitationId,
        password: replacementPassword,
      })
    expect(replay.status).toBe(409)
    expect(replay.headers['set-cookie']).toBeUndefined()
    expect(ambiguousProxy.resetPostCount).toBe(1)
    expect(producerResponses.at(-1)?.status).toBe(409)
  }, 60_000)
})
