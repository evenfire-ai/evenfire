import { describe, expect, it } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { config } from '../src/config.js'
import {
  requireRpcTokenHostMatch,
  requireRpcTokenTeamMatch,
  requireRpcTokenUserMatch,
  requireValidRpcAccessToken,
  requireValidRpcAccessTokenAny,
} from '../src/middleware/rpcAccessAuth.js'
import { signRpcAccessToken } from '../src/utils/auth/rpcAuthToken.js'

function buildApp() {
  const app = express()
  app.get(
    '/rpc/access/users/:userId/check',
    requireValidRpcAccessToken(),
    requireRpcTokenUserMatch(),
    (_req, res) => res.status(200).json({ ok: true })
  )
  app.get(
    '/rpc/access/teams/:teamId/check',
    requireValidRpcAccessToken(),
    requireRpcTokenTeamMatch(),
    (_req, res) => res.status(200).json({ ok: true })
  )
  app.get(
    '/rpc/access/users/:userId/mcp-hosts/:hostRef/check',
    requireValidRpcAccessTokenAny([
      'host:message:invoke',
      'host:status:read',
      'host:health:read',
      'host:activity:read',
    ]),
    requireRpcTokenUserMatch(),
    requireRpcTokenHostMatch(),
    (_req, res) => res.status(200).json({ ok: true })
  )
  return app
}

function signUserRpcToken(overrides?: Partial<Parameters<typeof signRpcAccessToken>[0]>) {
  return signRpcAccessToken({
    sub: 'user-1',
    typ: 'user',
    teamId: 'team-1',
    role: 'member',
    scopes: ['mcp:servers:list'],
    hostRefs: ['host-a'],
    jti: 'rpc-jti-test',
    ...overrides,
  })
}

describe('middleware/rpcAccessAuth', () => {
  it('returns 401 for bad typ (service token)', async () => {
    const app = buildApp()
    const token = signRpcAccessToken({
      sub: 'svc-rpc-proxy',
      typ: 'service',
      teamId: 'team-1',
      scopes: ['mcp:servers:list'],
      hostRefs: ['host-a'],
      jti: 'rpc-jti-service',
    })

    await request(app)
      .get('/rpc/access/users/user-1/check')
      .set('x-rpc-access-token', token)
      .expect(401)
  })

  it('returns 403 for missing required scope', async () => {
    const app = buildApp()
    const token = signUserRpcToken({ scopes: ['mcp:server:invoke'], jti: 'rpc-jti-no-list' })

    await request(app)
      .get('/rpc/access/users/user-1/check')
      .set('x-rpc-access-token', token)
      .expect(403)
  })

  it('returns 403 for user mismatch', async () => {
    const app = buildApp()
    const token = signUserRpcToken({ sub: 'user-1', jti: 'rpc-jti-user-mismatch' })

    await request(app)
      .get('/rpc/access/users/user-2/check')
      .set('x-rpc-access-token', token)
      .expect(403)
  })

  it('returns 403 for team mismatch', async () => {
    const app = buildApp()
    const token = signUserRpcToken({ teamId: 'team-1', jti: 'rpc-jti-team-mismatch' })

    await request(app)
      .get('/rpc/access/teams/team-2/check')
      .set('x-rpc-access-token', token)
      .expect(403)
  })

  it('allows user routes but rejects team routes for a user-scoped token', async () => {
    const app = buildApp()
    const token = signUserRpcToken({
      accessScope: 'user',
      teamId: null,
      jti: 'rpc-jti-user-scope',
    })

    await request(app)
      .get('/rpc/access/users/user-1/check')
      .set('x-rpc-access-token', token)
      .expect(200)

    await request(app)
      .get('/rpc/access/teams/team-1/check')
      .set('x-rpc-access-token', token)
      .expect(403)
  })

  it('returns 401 for expired token', async () => {
    const app = buildApp()
    const expiredToken = jwt.sign(
      {
        sub: 'user-1',
        typ: 'user',
        teamId: 'team-1',
        role: 'member',
        scopes: ['mcp:servers:list'],
        hostRefs: ['host-a'],
        jti: 'rpc-jti-expired',
      },
      config.rpcJwtPrivateKey,
      {
        algorithm: 'RS256',
        issuer: config.rpcJwtIssuer,
        audience: config.rpcJwtAudience,
        expiresIn: -10,
      }
    )

    await request(app)
      .get('/rpc/access/users/user-1/check')
      .set('x-rpc-access-token', expiredToken)
      .expect(401)
  })

  it('enforces host match and host scope for mcp-host route', async () => {
    const app = buildApp()
    const token = signUserRpcToken({
      scopes: ['host:message:invoke'],
      hostRefs: ['agent2'],
      jti: 'rpc-jti-host-ok',
    })

    await request(app)
      .get('/rpc/access/users/user-1/mcp-hosts/agent2/check')
      .set('x-rpc-access-token', token)
      .expect(200)

    await request(app)
      .get('/rpc/access/users/user-1/mcp-hosts/not-allowed/check')
      .set('x-rpc-access-token', token)
      .expect(403)
  })
})
