import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  PolicyAuthClaims,
  requireAuth,
  requireHostAccess,
  requireMappedPolicy,
  requireScope,
  requireService,
} from '../src/middleware/policyAuth.js'

function buildApp(claims: PolicyAuthClaims | null) {
  const app = express()
  app.use(express.json())

  app.get(
    '/secured/hosts/:host',
    requireAuth(() => claims),
    requireScope('host:status:read'),
    requireService(['control-api', 'rpc-proxy']),
    requireHostAccess('host'),
    (_req, res) => res.status(200).json({ ok: true })
  )

  app.post(
    '/policy/hosts/:host',
    requireAuth(() => claims),
    requireMappedPolicy(req => {
      if (req.method === 'POST' && req.path.startsWith('/policy/hosts/')) {
        return {
          requiredScope: 'host:policy:write',
          allowedServices: ['control-api'],
          hostParam: 'host',
        }
      }
      return null
    }),
    (_req, res) => res.status(200).json({ ok: true })
  )

  app.post(
    '/policy/unmapped',
    requireAuth(() => claims),
    requireMappedPolicy(() => null),
    (_req, res) => res.status(200).json({ ok: true })
  )

  return app
}

describe('middleware/policyAuth', () => {
  it('returns 401 when token is missing', async () => {
    const app = buildApp({
      iss: 'control-api',
      aud: 'mcp-host',
      sub: 'service:rpc-proxy',
      typ: 'service',
      scopes: ['host:status:read'],
      hostRefs: ['chatllm'],
      service: 'rpc-proxy',
    })

    await request(app).get('/secured/hosts/chatllm').expect(401)
  })

  it('returns 403 for missing scope', async () => {
    const app = buildApp({
      iss: 'control-api',
      aud: 'mcp-host',
      sub: 'service:rpc-proxy',
      typ: 'service',
      scopes: ['host:health:read'],
      hostRefs: ['chatllm'],
      service: 'rpc-proxy',
    })

    await request(app)
      .get('/secured/hosts/chatllm')
      .set('authorization', 'Bearer test-token')
      .expect(403)
  })

  it('returns 403 for disallowed service identity', async () => {
    const app = buildApp({
      iss: 'control-api',
      aud: 'mcp-host',
      sub: 'service:channel-reader',
      typ: 'service',
      scopes: ['host:status:read'],
      hostRefs: ['chatllm'],
      service: 'channel-reader',
    })

    await request(app)
      .get('/secured/hosts/chatllm')
      .set('authorization', 'Bearer test-token')
      .expect(403)
  })

  it('returns 403 for host access denied', async () => {
    const app = buildApp({
      iss: 'control-api',
      aud: 'mcp-host',
      sub: 'service:rpc-proxy',
      typ: 'service',
      scopes: ['host:status:read'],
      hostRefs: ['agent2'],
      service: 'rpc-proxy',
    })

    await request(app)
      .get('/secured/hosts/chatllm')
      .set('authorization', 'Bearer test-token')
      .expect(403)
  })

  it('allows request when auth, scope, service, and host access pass', async () => {
    const app = buildApp({
      iss: 'control-api',
      aud: 'mcp-host',
      sub: 'service:rpc-proxy',
      typ: 'service',
      scopes: ['host:status:read'],
      hostRefs: ['chatllm'],
      service: 'rpc-proxy',
    })

    await request(app)
      .get('/secured/hosts/chatllm')
      .set('authorization', 'Bearer test-token')
      .expect(200)
  })

  it('denies unmapped protected policy route by default', async () => {
    const app = buildApp({
      iss: 'control-api',
      aud: 'control-api',
      sub: 'service:control-api',
      typ: 'service',
      scopes: ['host:policy:write'],
      hostRefs: ['chatllm'],
      service: 'control-api',
    })

    await request(app)
      .post('/policy/unmapped')
      .set('authorization', 'Bearer test-token')
      .send({})
      .expect(403)
  })

  it('allows mapped protected policy route when requirements pass', async () => {
    const app = buildApp({
      iss: 'control-api',
      aud: 'control-api',
      sub: 'service:control-api',
      typ: 'service',
      scopes: ['host:policy:write'],
      hostRefs: ['chatllm'],
      service: 'control-api',
    })

    await request(app)
      .post('/policy/hosts/chatllm')
      .set('authorization', 'Bearer test-token')
      .send({})
      .expect(200)
  })
})
