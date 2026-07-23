import { describe, expect, it } from 'vitest'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { config } from '../src/config.js'
import { MockGateway } from './mockGateway.js'

/**
 * P3-S01 — provisioner gfs token mint route. A provisioner (InternalControl JWT
 * iss=hcc|wrc) mints a `host` token of its own class (hcc→host:1st, wrc→host:3rd)
 * for an allowed issuance namespace. Read-only scope by default (P3).
 */

function secretFor(iss: string): string {
  return iss === 'hcc'
    ? config.internalControlJwtHccHmacSecret
    : config.internalControlJwtWrcHmacSecret
}

function signInternalControlJwt(iss: 'hcc' | 'wrc'): string {
  return jwt.sign({ iss, aud: 'control-api', sub: `${iss}-provisioner` }, secretFor(iss), {
    algorithm: 'HS256',
    expiresIn: 60,
    jwtid: `${iss}-gfs-test-jti`,
  })
}

async function app() {
  const { createApp } = await import('../src/app.js')
  return createApp(new MockGateway('mcp-server') as never)
}

// HCC's sentinel issuance namespace (in the default allowlist).
const NS = 'mcp-host'

describe('POST /api/v1/auth/gfs/:subject/tokens', () => {
  it('hcc mints a 1st-party host token (read scope by default)', async () => {
    const res = await request(await app())
      .post('/api/v1/auth/gfs/chatllm/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({ namespace: NS })
    expect(res.status).toBe(200)
    expect(res.body.subject).toBe(`host:1st:${NS}/chatllm`)
    expect(typeof res.body.token).toBe('string')
    expect(res.body.expiresInSeconds).toBeGreaterThan(0)
  })

  it('rejects the reserved legacy standalone subject for HCC issuance', async () => {
    const res = await request(await app())
      .post('/api/v1/auth/gfs/standalone/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({ namespace: NS })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'subject_reserved' })
    expect(res.body.token).toBeUndefined()
  })

  it('does not reserve other standalone subjects or the third-party subject class', async () => {
    const hcc = await request(await app())
      .post('/api/v1/auth/gfs/standalone/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({ namespace: 'sandbox-recipes' })
    expect(hcc.status).toBe(200)
    expect(hcc.body.subject).toBe('host:1st:sandbox-recipes/standalone')

    const wrc = await request(await app())
      .post('/api/v1/auth/gfs/standalone/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({ namespace: NS })
    expect(wrc.status).toBe(200)
    expect(wrc.body.subject).toBe('host:3rd:mcp-host/standalone')
  })

  it('wrc mints a 3rd-party host token', async () => {
    const res = await request(await app())
      .post('/api/v1/auth/gfs/my-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({ namespace: 'sandbox-recipes' })
    expect(res.status).toBe(200)
    expect(res.body.subject).toBe('host:3rd:sandbox-recipes/my-recipe')
  })

  it('wrc mints a 3rd-party host token with write scope for GFS publish targets', async () => {
    const res = await request(await app())
      .post('/api/v1/auth/gfs/publish-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({ namespace: 'sandbox-recipes', scopes: ['gfs.read', 'gfs.write'] })
    expect(res.status).toBe(200)
    expect(res.body.subject).toBe('host:3rd:sandbox-recipes/publish-recipe')
    expect(res.body.expiresInSeconds).toBe(3600)
  })

  it('wrc cannot mint destructive 3rd-party host token scopes', async () => {
    const res = await request(await app())
      .post('/api/v1/auth/gfs/publish-recipe/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('wrc')}`)
      .send({ namespace: 'sandbox-recipes', scopes: ['gfs.read', 'gfs.delete'] })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('scope_forbidden')
  })

  it('hcc cannot mint destructive or governance scopes for first-party agents', async () => {
    for (const scope of ['gfs.delete', 'gfs.manage_acl', 'gfs.share']) {
      const res = await request(await app())
        .post('/api/v1/auth/gfs/chatllm/tokens')
        .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
        .send({ namespace: NS, scopes: ['gfs.read', scope] })
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: 'scope_forbidden' })
    }
  })

  it('rejects an unauthorized issuance namespace (400)', async () => {
    const res = await request(await app())
      .post('/api/v1/auth/gfs/standalone/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({ namespace: 'some-other-namespace' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_issuance_namespace')
  })

  it('rejects a missing namespace (400 subject_invalid)', async () => {
    const res = await request(await app())
      .post('/api/v1/auth/gfs/standalone/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('subject_invalid')
  })

  it('rejects a non-canonical subject name before minting a host token', async () => {
    const res = await request(await app())
      .post('/api/v1/auth/gfs/Standalone/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({ namespace: NS })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('subject_invalid')
  })

  it('rejects an unknown scope (400 invalid_scope)', async () => {
    const res = await request(await app())
      .post('/api/v1/auth/gfs/chatllm/tokens')
      .set('Authorization', `Bearer ${signInternalControlJwt('hcc')}`)
      .send({ namespace: NS, scopes: ['gfs.bogus'] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_scope')
  })

  it('rejects an unauthenticated request (no InternalControl JWT)', async () => {
    const res = await request(await app())
      .post('/api/v1/auth/gfs/standalone/tokens')
      .send({ namespace: NS })
    expect(res.status).toBe(401)
  })
})
