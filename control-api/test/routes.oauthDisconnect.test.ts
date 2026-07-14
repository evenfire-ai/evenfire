import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/app.js'
import { config } from '../src/config.js'
import { MockGateway } from './mockGateway.js'

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
}))

const RPC_PROXY_TOKEN = 'dev-rpc-proxy-token'
const URL = '/api/v1/internal/sandbox-ui/oauth/grant'

function authed() {
  const app = createApp(new MockGateway() as never)
  return request(app)
    .delete(URL)
    .set('Authorization', `Bearer ${RPC_PROXY_TOKEN}`)
    .set('x-service-token', 'rpc-proxy')
}

describe('DELETE /api/v1/internal/sandbox-ui/oauth/grant (spec §9.9 disconnect)', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
  })

  it('returns 401 when service-token auth is missing', async () => {
    const app = createApp(new MockGateway() as never)
    await request(app).delete(URL).expect(401)
  })

  it('returns 401 when called by an unauthorized internal service', async () => {
    const app = createApp(new MockGateway() as never)
    await request(app)
      .delete(URL)
      .set('Authorization', `Bearer dev-external-rest-api-token`)
      .set('x-service-token', 'external-rest-api')
      .send({
        recipeNs: config.sandboxNamespace,
        recipeName: 'r1',
        oauthClientId: 'sf',
        userId: 'u-1',
      })
      .expect(401)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it.each([
    [{ recipeName: 'r1', oauthClientId: 'sf', userId: 'u' }, 'recipeNs missing'],
    [{ recipeNs: 'sandbox-recipes', oauthClientId: 'sf', userId: 'u' }, 'recipeName missing'],
    [{ recipeNs: 'sandbox-recipes', recipeName: 'r1', userId: 'u' }, 'oauthClientId missing'],
    [{ recipeNs: 'sandbox-recipes', recipeName: 'r1', oauthClientId: 'sf' }, 'userId missing'],
  ])('returns 400 when %o (%s)', async body => {
    await authed().send(body).expect(400)
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('returns 400 when recipeNs is not the configured sandbox namespace', async () => {
    const res = await authed()
      .send({
        recipeNs: 'attacker-ns',
        recipeName: 'r1',
        oauthClientId: 'sf',
        userId: 'u-1',
      })
      .expect(400)
    expect(res.body.error).toBe('invalid_recipe_namespace')
    expect(mockPoolQuery).not.toHaveBeenCalled()
  })

  it('returns 204 and deletes the grant on the happy path', async () => {
    await authed()
      .send({
        recipeNs: config.sandboxNamespace,
        recipeName: 'crm',
        oauthClientId: 'salesforce-prod',
        userId: 'user-uuid-1',
      })
      .expect(204)

    expect(mockPoolQuery).toHaveBeenCalledTimes(1)
    const [sql, params] = mockPoolQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('DELETE FROM oauth_grants')
    expect(params[0]).toBe(config.sandboxNamespace)
    expect(params[1]).toBe('crm')
    expect(params[2]).toBe('user-uuid-1')
    expect(params[3]).toBe('salesforce-prod')
  })

  it('is idempotent — 204 even when no grant exists', async () => {
    // pg returns rowCount=0 when nothing matched. The route does not surface
    // that — it returns 204 unconditionally so a malicious caller cannot
    // probe whether a (recipe, client) pair was ever connected.
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    await authed()
      .send({
        recipeNs: config.sandboxNamespace,
        recipeName: 'crm',
        oauthClientId: 'never-connected',
        userId: 'user-uuid-1',
      })
      .expect(204)
  })
})
