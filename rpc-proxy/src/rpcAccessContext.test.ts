import { describe, expect, it } from 'vitest'
import { rpcInvocationContext } from './rpcAccessContext.js'

describe('rpcInvocationContext', () => {
  it('keeps team-scoped invocations bound to a team id', () => {
    expect(rpcInvocationContext({ accessScope: 'team', teamId: 'team-1' })).toEqual({
      accessScope: 'team',
      teamId: 'team-1',
    })
  })

  it('keeps user-scoped invocations teamless', () => {
    expect(rpcInvocationContext({ accessScope: 'user', teamId: null })).toEqual({
      accessScope: 'user',
    })
  })

  it('rejects service-scoped invocations for user RPC routes', () => {
    expect(() => rpcInvocationContext({ accessScope: 'service', teamId: 'system' })).toThrow(
      /Service-scoped/
    )
  })
})
