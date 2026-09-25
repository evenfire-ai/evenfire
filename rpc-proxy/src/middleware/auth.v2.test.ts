import { describe, expect, it, vi } from 'vitest'
import { stripInboundTrustedEdgeHeaders } from './auth.js'

describe('trusted edge header boundary', () => {
  it('strips the entire inbound trusted-edge namespace', () => {
    const req = {
      headers: {
        authorization: 'Bearer external-token',
        'x-clerum-edge-action-context': 'spoofed',
        'x-clerum-edge-user-id': 'spoofed-user',
        'X-Clerum-Edge-Future-Authority': 'spoofed-future-value',
      },
    }
    const next = vi.fn()
    stripInboundTrustedEdgeHeaders(req as never, {} as never, next)
    expect(req.headers).toEqual({ authorization: 'Bearer external-token' })
    expect(next).toHaveBeenCalledOnce()
  })
})
