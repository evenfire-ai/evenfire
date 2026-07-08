import { afterEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { config } from '../../config.js'
import {
  buildSandboxUiSetCookie,
  createSandboxUiSession,
  verifySandboxUiSession,
} from '../sandboxUiSession.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('sandboxUiSession', () => {
  it('round-trips through verify', () => {
    const token = createSandboxUiSession('u1', 'sandbox-recipes', 'r1')
    const claims = verifySandboxUiSession(token, 'sandbox-recipes', 'r1')
    expect(claims).not.toBeNull()
    expect(claims!.sub).toBe('u1')
    expect(claims!.recipeNs).toBe('sandbox-recipes')
    expect(claims!.recipeName).toBe('r1')
    expect(claims!.scope).toBe('sandbox:ui:view')
    expect(claims!.iss).toBe('rpc-proxy')
    expect(claims!.aud).toBe('rpc-proxy-sandbox-ui')
  })

  it('rejects a token whose recipeNs does not match the URL claim', () => {
    const token = createSandboxUiSession('u1', 'sandbox-recipes', 'r1')
    expect(verifySandboxUiSession(token, 'other-ns', 'r1')).toBeNull()
  })

  it('rejects a token whose recipeName does not match the URL claim', () => {
    const token = createSandboxUiSession('u1', 'sandbox-recipes', 'r1')
    expect(verifySandboxUiSession(token, 'sandbox-recipes', 'r2')).toBeNull()
  })

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign(
      { sub: 'u1', recipeNs: 'sandbox-recipes', recipeName: 'r1', scope: 'sandbox:ui:view' },
      'wrong-secret',
      {
        algorithm: 'HS256',
        issuer: 'rpc-proxy',
        audience: 'rpc-proxy-sandbox-ui',
        expiresIn: 300,
      }
    )
    expect(verifySandboxUiSession(forged, 'sandbox-recipes', 'r1')).toBeNull()
  })

  it('rejects a token with the wrong issuer', () => {
    const wrongIss = jwt.sign(
      { sub: 'u1', recipeNs: 'sandbox-recipes', recipeName: 'r1', scope: 'sandbox:ui:view' },
      config.sandboxUiCookieSecret,
      {
        algorithm: 'HS256',
        issuer: 'someone-else',
        audience: 'rpc-proxy-sandbox-ui',
        expiresIn: 300,
      }
    )
    expect(verifySandboxUiSession(wrongIss, 'sandbox-recipes', 'r1')).toBeNull()
  })

  it('rejects a token with the wrong audience', () => {
    const wrongAud = jwt.sign(
      { sub: 'u1', recipeNs: 'sandbox-recipes', recipeName: 'r1', scope: 'sandbox:ui:view' },
      config.sandboxUiCookieSecret,
      {
        algorithm: 'HS256',
        issuer: 'rpc-proxy',
        audience: 'wrong-aud',
        expiresIn: 300,
      }
    )
    expect(verifySandboxUiSession(wrongAud, 'sandbox-recipes', 'r1')).toBeNull()
  })

  it('rejects a token whose scope is not sandbox:ui:view', () => {
    const wrongScope = jwt.sign(
      { sub: 'u1', recipeNs: 'sandbox-recipes', recipeName: 'r1', scope: 'desktop:view' },
      config.sandboxUiCookieSecret,
      {
        algorithm: 'HS256',
        issuer: 'rpc-proxy',
        audience: 'rpc-proxy-sandbox-ui',
        expiresIn: 300,
      }
    )
    expect(verifySandboxUiSession(wrongScope, 'sandbox-recipes', 'r1')).toBeNull()
  })

  it('rejects an expired token', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-08T00:00:00Z'))
    const token = createSandboxUiSession('u1', 'sandbox-recipes', 'r1')
    vi.setSystemTime(new Date(Date.now() + (config.sandboxUiCookieMaxAgeSec + 1) * 1000))
    expect(verifySandboxUiSession(token, 'sandbox-recipes', 'r1')).toBeNull()
  })

  it('rejects a malformed token', () => {
    expect(verifySandboxUiSession('not-a-jwt', 'sandbox-recipes', 'r1')).toBeNull()
  })
})

describe('buildSandboxUiSetCookie', () => {
  it('scopes the Path to the per-recipe view URL prefix', () => {
    const setCookie = buildSandboxUiSetCookie('JWT', 'sandbox-recipes', 'r1')
    expect(setCookie).toContain('Path=/api/v1/sandbox-ui/sandbox-recipes/r1/')
  })

  it('sets HttpOnly and SameSite=Strict', () => {
    const setCookie = buildSandboxUiSetCookie('JWT', 'sandbox-recipes', 'r1')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
  })

  it('omits Secure outside production', () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'test'
    try {
      const setCookie = buildSandboxUiSetCookie('JWT', 'sandbox-recipes', 'r1')
      expect(setCookie).not.toContain('Secure')
    } finally {
      process.env.NODE_ENV = prev
    }
  })

  it('appends Secure in production', () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const setCookie = buildSandboxUiSetCookie('JWT', 'sandbox-recipes', 'r1')
      expect(setCookie).toContain('Secure')
    } finally {
      process.env.NODE_ENV = prev
    }
  })

  it('uses the configured Max-Age', () => {
    const setCookie = buildSandboxUiSetCookie('JWT', 'sandbox-recipes', 'r1')
    expect(setCookie).toContain(`Max-Age=${config.sandboxUiCookieMaxAgeSec}`)
  })

  it('percent-encodes ns / name into the Path so a stray slash cannot escape the cookie scope', () => {
    const setCookie = buildSandboxUiSetCookie('JWT', 'weird/ns', 'name with space')
    expect(setCookie).toContain('Path=/api/v1/sandbox-ui/weird%2Fns/name%20with%20space/')
  })
})
