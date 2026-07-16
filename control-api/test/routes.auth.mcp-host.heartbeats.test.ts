import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { config } from '../src/config.js'
import { createAuthMcpHostHeartbeatsRoutes } from '../src/routes/auth/mcp-host/heartbeats.routes.js'
import * as hostHeartbeatService from '../src/services/hostHeartbeatService.js'

/**
 * HTTP-level tests for GET /auth/mcp-host/heartbeats — the InternalControl
 * feed HCC's heartbeat poller consumes. The REAL requireInternalControlJwt
 * middleware runs (tokens signed with the dev-default HMAC secrets); only
 * the persistence service is mocked.
 */

vi.mock('../src/services/hostHeartbeatService.js', () => ({
  upsertHostHeartbeat: vi.fn(),
  listHostHeartbeatsSince: vi.fn(),
}))

const listSpy = vi.mocked(hostHeartbeatService.listHostHeartbeatsSince)

function signInternalControlJwt(iss: 'hcc' | 'wrc'): string {
  const secret =
    iss === 'hcc' ? config.internalControlJwtHccHmacSecret : config.internalControlJwtWrcHmacSecret
  return jwt.sign({ iss, aud: 'control-api', sub: `${iss}-provisioner` }, secret, {
    algorithm: 'HS256',
    expiresIn: 60,
    jwtid: `${iss}-test-jti-${Date.now()}`,
  })
}

const ROW = {
  hostRef: 'chatllm',
  podUid: 'pod-uid-123',
  activeWork: false,
  conditions: { activeTask: false, awaitingApproval: false, pendingResults: false },
  lastActivityTs: 1_700_000_000_000,
  state: 'active' as const,
  receivedAtMs: 1_700_000_030_000,
}

describe('GET /auth/mcp-host/heartbeats', () => {
  const app = express()
  app.use(express.json())
  app.use(createAuthMcpHostHeartbeatsRoutes())

  function poll(query?: string, token?: string) {
    const req = request(app).get(`/auth/mcp-host/heartbeats${query ?? ''}`)
    if (token !== undefined) {
      req.set('Authorization', `Bearer ${token}`)
    }
    return req
  }

  beforeEach(() => {
    listSpy.mockReset()
    listSpy.mockResolvedValue([ROW])
  })

  it('rejects a missing bearer token with 401', async () => {
    const res = await poll('?since=0')
    expect(res.status).toBe(401)
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('rejects a garbage token with 401', async () => {
    const res = await poll('?since=0', 'not-a-jwt')
    expect(res.status).toBe(401)
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('rejects a WRC-issued InternalControl token with 403 — heartbeat consumption is HCC-only', async () => {
    const res = await poll('?since=0', signInternalControlJwt('wrc'))
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('issuer_not_allowed')
    expect(listSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['missing since', ''],
    ['non-numeric since', '?since=yesterday'],
    ['fractional since', '?since=12.5'],
    ['negative since', '?since=-1'],
  ])('rejects %s with 400', async (_name, query) => {
    const res = await poll(query, signInternalControlJwt('hcc'))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('since_required')
    expect(listSpy).not.toHaveBeenCalled()
  })

  it('accepts an hcc token and returns the rows newer than since', async () => {
    const res = await poll('?since=1700000000000', signInternalControlJwt('hcc'))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ heartbeats: [ROW] })
    expect(listSpy).toHaveBeenCalledTimes(1)
    expect(listSpy).toHaveBeenCalledWith(1_700_000_000_000)
  })

  it('accepts since=0 (full replay)', async () => {
    const res = await poll('?since=0', signInternalControlJwt('hcc'))
    expect(res.status).toBe(200)
    expect(listSpy).toHaveBeenCalledWith(0)
  })
})
