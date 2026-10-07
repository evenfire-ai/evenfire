import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { config } from '../src/config.js'
import { createInternalPluginWorkloadSdkRouter } from '../src/routes/internal/pluginWorkloadSdk.js'

const db = vi.hoisted(() => ({ revoke: vi.fn(), finalize: vi.fn() }))
const limiterQuery = vi.hoisted(() => vi.fn())

// The internal SDK limiter counts in the dedicated limiter pool. Answer its
// upsert at the boundary so the route never waits on an unreachable database.
vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  rateLimitPool: { query: (...args: unknown[]) => limiterQuery(...args) },
}))

vi.mock('../src/services/pluginWorkloadSdkDb.js', () => ({
  revokePluginWorkloadSdkForRecipe: (...args: unknown[]) => db.revoke(...args),
  finalizePluginWorkloadSdkRevocation: (...args: unknown[]) => db.finalize(...args),
}))

function sign(
  iss: 'wrc' | 'hcc',
  jti = `${iss}-revocation-test`,
  audience = 'control-api',
  subject = `${iss}-provisioner`
): string {
  return jwt.sign(
    { iss, aud: audience, sub: subject },
    iss === 'wrc' ? config.internalControlJwtWrcHmacSecret : config.internalControlJwtHccHmacSecret,
    { algorithm: 'HS256', expiresIn: 60, jwtid: jti }
  )
}

function app() {
  const instance = express()
  instance.use(express.json())
  instance.use('/api/v1', createInternalPluginWorkloadSdkRouter())
  return instance
}

describe('internal Plugin Workload SDK revocation', () => {
  const originalLimit = config.pluginSdkInternalRlPerMin
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-02T12:00:17.500Z'))
    config.pluginSdkInternalRlPerMin = 600
    db.revoke.mockReset()
    db.finalize.mockReset()
    limiterQuery.mockReset()
    const counters = new Map<string, number>()
    limiterQuery.mockImplementation(async (_sql: string, params: unknown[]) => {
      const key = `${String(params[0])}|${String(params[1])}`
      const count = (counters.get(key) ?? 0) + 1
      counters.set(key, count)
      return { rows: [{ count }], rowCount: 1 }
    })
    db.revoke.mockResolvedValue({
      state: 'revoking',
      revocationId: '11111111-1111-4111-8111-111111111111',
      revoked: 1,
      fencedInvocations: 0,
    })
    db.finalize.mockResolvedValue({
      state: 'disabled',
      revocationId: '11111111-1111-4111-8111-111111111111',
      revoked: 0,
      fencedInvocations: 0,
      disabled: 1,
    })
  })

  afterEach(() => {
    config.pluginSdkInternalRlPerMin = originalLimit
    vi.useRealTimers()
  })

  it('revoke and finalize carry the authenticated WRC technical principal', async () => {
    const authorization = `Bearer ${sign('wrc')}`
    const binding = { recipeNamespace: 'sandbox-recipes', recipeName: 'sdk-recipe' }
    const revoke = await request(app())
      .post('/api/v1/internal/plugin-workload-sdk/revoke')
      .set('Authorization', authorization)
      .send(binding)
    expect(revoke.status).toBe(200)
    expect(db.revoke).toHaveBeenCalledWith(
      'sandbox-recipes',
      'sdk-recipe',
      expect.objectContaining({
        operatorSub: 'wrc-provisioner',
        internalPrincipal: expect.objectContaining({
          kind: 'wrc_internal_control',
          serviceSub: 'wrc-provisioner',
          credentialId: 'wrc-revocation-test',
        }),
      })
    )

    const finalize = await request(app())
      .post('/api/v1/internal/plugin-workload-sdk/finalize-revocation')
      .set('Authorization', authorization)
      .send({ ...binding, revocationId: '11111111-1111-4111-8111-111111111111' })
    expect(finalize.status).toBe(200)
    expect(db.finalize).toHaveBeenCalledWith(
      'sandbox-recipes',
      'sdk-recipe',
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({
        operatorSub: 'wrc-provisioner',
        internalPrincipal: expect.objectContaining({ credentialId: 'wrc-revocation-test' }),
      })
    )
    // Both requests were counted against the WRC principal's bucket.
    expect(limiterQuery.mock.calls.map(call => (call[1] as unknown[])[0])).toEqual([
      'plugin_workload_sdk_internal:wrc:wrc-provisioner',
      'plugin_workload_sdk_internal:wrc:wrc-provisioner',
    ])
  })

  it('rejects a different internal issuer before the mutation boundary', async () => {
    const response = await request(app())
      .post('/api/v1/internal/plugin-workload-sdk/revoke')
      .set('Authorization', `Bearer ${sign('hcc')}`)
      .send({ recipeNamespace: 'sandbox-recipes', recipeName: 'sdk-recipe' })
    expect(response.status).toBe(403)
    expect(db.revoke).not.toHaveBeenCalled()
  })

  it('keeps six hundred forbidden HCC requests on their signed principal without stealing the WRC allowance on the same IP', async () => {
    const instance = app()
    const hcc = `Bearer ${sign('hcc')}`
    const wrc = `Bearer ${sign('wrc')}`
    const binding = { recipeNamespace: 'sandbox-recipes', recipeName: 'sdk-recipe' }
    for (let index = 0; index < 600; index += 1) {
      await request(instance)
        .post('/api/v1/internal/plugin-workload-sdk/revoke')
        .set('Authorization', hcc)
        .send(binding)
        .expect(403)
    }
    expect(db.revoke).not.toHaveBeenCalled()
    for (let index = 0; index < 600; index += 1) {
      await request(instance)
        .post('/api/v1/internal/plugin-workload-sdk/revoke')
        .set('Authorization', wrc)
        .send(binding)
        .expect(200)
    }
    expect(db.revoke).toHaveBeenCalledTimes(600)
    await request(instance)
      .post('/api/v1/internal/plugin-workload-sdk/revoke')
      .set('Authorization', wrc)
      .send(binding)
      .expect(429)
  }, 15_000)

  it('keeps an exhausted invalid-audience or anonymous IP budget separate from the valid WRC allowance', async () => {
    const instance = app()
    const binding = { recipeNamespace: 'sandbox-recipes', recipeName: 'sdk-recipe' }
    const invalidAudience = `Bearer ${sign('wrc', 'audience-negative', 'other-service')}`
    for (let index = 0; index < 600; index += 1) {
      await request(instance)
        .post('/api/v1/internal/plugin-workload-sdk/revoke')
        .set('Authorization', invalidAudience)
        .send(binding)
        .expect(401)
    }
    await request(instance)
      .post('/api/v1/internal/plugin-workload-sdk/revoke')
      .send(binding)
      .expect(429)
    await request(instance)
      .post('/api/v1/internal/plugin-workload-sdk/revoke')
      .set('Authorization', `Bearer ${sign('wrc')}`)
      .send(binding)
      .expect(200)
    expect(db.revoke).toHaveBeenCalledTimes(1)
  }, 15_000)

  it('counts rotated signed credentials under one principal and recovers with PG at the minute boundary', async () => {
    config.pluginSdkInternalRlPerMin = 2
    const instance = app()
    const binding = { recipeNamespace: 'sandbox-recipes', recipeName: 'sdk-recipe' }
    for (let index = 0; index < 2; index += 1) {
      await request(instance)
        .post('/api/v1/internal/plugin-workload-sdk/revoke')
        .set('Authorization', `Bearer ${sign('wrc', `rotation-${index}`)}`)
        .send(binding)
        .expect(200)
    }
    const denied = await request(instance)
      .post('/api/v1/internal/plugin-workload-sdk/revoke')
      .set('Authorization', `Bearer ${sign('wrc', 'rotation-third')}`)
      .send(binding)
    expect(denied.status).toBe(429)
    expect(denied.headers['retry-after']).toBe('43')
    vi.setSystemTime(new Date('2026-10-02T12:01:00.000Z'))
    await request(instance)
      .post('/api/v1/internal/plugin-workload-sdk/revoke')
      .set('Authorization', `Bearer ${sign('wrc', 'rotation-next-minute')}`)
      .send(binding)
      .expect(200)
    expect(db.revoke).toHaveBeenCalledTimes(3)
  })

  it('does not cap a higher verified internal override at the legacy IP ceiling of six hundred', async () => {
    config.pluginSdkInternalRlPerMin = 601
    const instance = app()
    const binding = { recipeNamespace: 'sandbox-recipes', recipeName: 'sdk-recipe' }
    const authorization = `Bearer ${sign('wrc')}`
    for (let index = 0; index < 601; index += 1) {
      await request(instance)
        .post('/api/v1/internal/plugin-workload-sdk/revoke')
        .set('Authorization', authorization)
        .send(binding)
        .expect(200)
    }
    expect(db.revoke).toHaveBeenCalledTimes(601)
    await request(instance)
      .post('/api/v1/internal/plugin-workload-sdk/revoke')
      .set('Authorization', authorization)
      .send(binding)
      .expect(429)
  }, 15_000)

  it('keeps signed non-WRC subjects forbidden without turning an unusual subject into a server error', async () => {
    const instance = app()
    const binding = { recipeNamespace: 'sandbox-recipes', recipeName: 'sdk-recipe' }
    for (const subject of ['service:ip:other', '\ud800']) {
      await request(instance)
        .post('/api/v1/internal/plugin-workload-sdk/revoke')
        .set('Authorization', `Bearer ${sign('hcc', 'subject-negative', 'control-api', subject)}`)
        .send(binding)
        .expect(403)
    }
    expect(db.revoke).not.toHaveBeenCalled()
  })
})
