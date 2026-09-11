import { describe, expect, it } from 'vitest'
import express from 'express'
import { ipKeyGenerator } from 'express-rate-limit'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import supertest from 'supertest'
import {
  createExternalClientRateLimiters,
  externalClientIp,
  externalClientIpRateLimitKey,
  externalClientRateLimitKey,
  externalClientSessionRateLimitKey,
} from '../src/middleware/externalClientIdentity.js'

function request(headers: Record<string, string>, ip = '10.0.0.9') {
  return {
    header(name: string) {
      return headers[name.toLowerCase()]
    },
    ip,
    socket: { remoteAddress: '10.0.0.10' },
  } as never
}

describe('external client rate-limit identity', () => {
  it('installs both independent gates on every non-GFS external family', () => {
    const routesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/routes/external')
    const families = [
      'directory.ts',
      'members.ts',
      'teams.ts',
      'users.ts',
      'invitations.ts',
      'oauthGrants.ts',
      'sharedFilesystems.ts',
      'decisions.routes.ts',
      'notifications.routes.ts',
      'workflow-approval-mediums.routes.ts',
    ]

    for (const family of families) {
      const source = readFileSync(resolve(routesDir, family), 'utf8')
      expect(source, family).toContain('createExternalClientRateLimiters')
      expect(source, family).toContain('config.approvalRlExternalClientIpPerMin')
      expect(source, family).toContain('config.approvalRlExternalEdgePerMin')
      expect(source, family).toMatch(/\.\.\.[A-Za-z]+RateLimits/)
      expect(source, family).toContain('requireValidExternalSessionToken')
    }
  })

  it('uses the authenticated external-rest identity before the funnel address', () => {
    const req = request({ 'x-external-client-ip': '203.0.113.41' })
    expect(externalClientIp(req)).toBe('203.0.113.41')
    expect(externalClientIpRateLimitKey(req)).toBe('external-client-ip:203.0.113.41')
    expect(externalClientSessionRateLimitKey(req)).toBe(
      'external-client-session:203.0.113.41:anonymous'
    )
  })

  it('rejects malformed asserted identity and falls back to the proxy-aware request IP', () => {
    const req = request({ 'x-external-client-ip': 'not-an-ip' }, '198.51.100.7')
    expect(externalClientIp(req)).toBe('198.51.100.7')
  })

  it('uses express-rate-limit IPv6 masking so address rotation cannot evade the bucket', () => {
    const ipv6 = '2001:db8:abcd:1234:5678:9abc:def0:1234'
    const req = request({ 'x-external-client-ip': ipv6 })
    expect(externalClientIpRateLimitKey(req)).toBe(`external-client-ip:${ipKeyGenerator(ipv6)}`)
    expect(externalClientIpRateLimitKey(req)).not.toContain(ipv6)
    expect(externalClientSessionRateLimitKey(req)).toBe(
      `external-client-session:${ipKeyGenerator(ipv6)}:anonymous`
    )
  })

  it('separates authenticated sessions sharing one external address without exposing the token', () => {
    const first = request({ 'x-user-session-token': 'session-one' })
    const second = request({ 'x-user-session-token': 'session-two' })
    expect(externalClientSessionRateLimitKey(first)).not.toBe(
      externalClientSessionRateLimitKey(second)
    )
    expect(externalClientSessionRateLimitKey(first)).not.toContain('session-one')
    expect(externalClientIpRateLimitKey(first)).toBe(externalClientIpRateLimitKey(second))
  })

  it('keeps the source-IP ceiling stable while unverified session tokens rotate', () => {
    const first = request({ 'x-user-session-token': 'session-one' })
    const rotated = request({ 'x-user-session-token': 'rotated-session' })
    expect(externalClientIpRateLimitKey(first)).toBe(externalClientIpRateLimitKey(rotated))
    expect(externalClientSessionRateLimitKey(first)).not.toBe(
      externalClientSessionRateLimitKey(rotated)
    )
    // The legacy export is intentionally the session dimension, not the IP
    // ceiling; route factories install both gates together.
    expect(externalClientRateLimitKey(first)).toBe(externalClientSessionRateLimitKey(first))
  })

  it('enforces the shared source-IP ceiling across rotated session tokens', async () => {
    const app = express()
    const [sourceIpLimiter, sessionLimiter] = createExternalClientRateLimiters('identity-test', 2)
    app.use('/external/identity-test', sourceIpLimiter, sessionLimiter, (_req, res) => {
      res.sendStatus(204)
    })

    for (const token of ['session-one', 'session-two']) {
      await supertest(app)
        .get('/external/identity-test')
        .set('x-external-client-ip', '203.0.113.41')
        .set('x-user-session-token', token)
        .expect(204)
    }
    await supertest(app)
      .get('/external/identity-test')
      .set('x-external-client-ip', '203.0.113.41')
      .set('x-user-session-token', 'session-three')
      .expect(429)
  })

  it('keeps the source-IP ceiling wider than the per-session fairness bucket', async () => {
    const app = express()
    const [sourceIpLimiter, sessionLimiter] = createExternalClientRateLimiters(
      'identity-width-test',
      3,
      2
    )
    app.use('/external/identity-width-test', sourceIpLimiter, sessionLimiter, (_req, res) => {
      res.sendStatus(204)
    })

    await supertest(app)
      .get('/external/identity-width-test')
      .set('x-external-client-ip', '203.0.113.42')
      .set('x-user-session-token', 'same-session')
      .expect(204)
    await supertest(app)
      .get('/external/identity-width-test')
      .set('x-external-client-ip', '203.0.113.42')
      .set('x-user-session-token', 'same-session')
      .expect(204)
    await supertest(app)
      .get('/external/identity-width-test')
      .set('x-external-client-ip', '203.0.113.42')
      .set('x-user-session-token', 'rotated-session')
      .expect(204)
    await supertest(app)
      .get('/external/identity-width-test')
      .set('x-external-client-ip', '203.0.113.42')
      .set('x-user-session-token', 'third-session')
      .expect(429)
  })
})
