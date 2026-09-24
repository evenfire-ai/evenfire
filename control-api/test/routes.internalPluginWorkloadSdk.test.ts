import { beforeEach, describe, expect, it, vi } from 'vitest'
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

function sign(iss: 'wrc' | 'hcc'): string {
  return jwt.sign(
    { iss, aud: 'control-api', sub: `${iss}-provisioner` },
    iss === 'wrc' ? config.internalControlJwtWrcHmacSecret : config.internalControlJwtHccHmacSecret,
    { algorithm: 'HS256', expiresIn: 60, jwtid: `${iss}-revocation-test` }
  )
}

function app() {
  const instance = express()
  instance.use(express.json())
  instance.use('/api/v1', createInternalPluginWorkloadSdkRouter())
  return instance
}

describe('internal Plugin Workload SDK revocation', () => {
  beforeEach(() => {
    db.revoke.mockReset()
    db.finalize.mockReset()
    limiterQuery.mockReset()
    limiterQuery.mockResolvedValue({ rows: [{ count: 1 }], rowCount: 1 })
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
})
