import { describe, expect, it } from 'vitest'
import { ipKeyGenerator } from 'express-rate-limit'
import {
  externalClientIp,
  externalClientRateLimitKey,
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
  it('uses the authenticated external-rest identity before the funnel address', () => {
    const req = request({ 'x-external-client-ip': '203.0.113.41' })
    expect(externalClientIp(req)).toBe('203.0.113.41')
    expect(externalClientRateLimitKey(req)).toBe('external-client-ip:203.0.113.41')
  })

  it('rejects malformed asserted identity and falls back to the proxy-aware request IP', () => {
    const req = request({ 'x-external-client-ip': 'not-an-ip' }, '198.51.100.7')
    expect(externalClientIp(req)).toBe('198.51.100.7')
  })

  it('uses express-rate-limit IPv6 masking so address rotation cannot evade the bucket', () => {
    const ipv6 = '2001:db8:abcd:1234:5678:9abc:def0:1234'
    const req = request({ 'x-external-client-ip': ipv6 })
    expect(externalClientRateLimitKey(req)).toBe(`external-client-ip:${ipKeyGenerator(ipv6)}`)
    expect(externalClientRateLimitKey(req)).not.toContain(ipv6)
  })

  it('separates authenticated sessions sharing one external address without exposing the token', () => {
    const first = request({ 'x-user-session-token': 'session-one' })
    const second = request({ 'x-user-session-token': 'session-two' })
    expect(externalClientRateLimitKey(first)).not.toBe(externalClientRateLimitKey(second))
    expect(externalClientRateLimitKey(first)).not.toContain('session-one')
  })
})
