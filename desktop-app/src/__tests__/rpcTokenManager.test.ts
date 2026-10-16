import { describe, expect, it, vi } from 'vitest'
import type { AuthClient } from '../authClient.js'
import { RpcTokenIssuanceSupersededError, RpcTokenManager } from '../rpcTokenManager.js'
import type { RpcTokenResult } from '../types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

const issuedToken = (token: string): RpcTokenResult => ({
  token,
  accessScope: 'team',
  teamId: 'team-a',
  scopes: ['host:activity:read'],
  hostRefs: ['chatllm'],
  expiresInSeconds: 300,
})

describe('RpcTokenManager', () => {
  it('does not cache a token whose request completed after the cache was cleared', async () => {
    const pending = deferred<RpcTokenResult>()
    const issueRpcToken = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(issuedToken('test-token-new'))
    const manager = new RpcTokenManager({ issueRpcToken } as unknown as AuthClient)

    const oldSessionRequest = manager.getOrIssue(
      'old-session',
      ['host:activity:read'],
      ['chatllm'],
      'old-session-generation'
    )
    manager.clear()
    pending.resolve(issuedToken('test-token-old'))
    await expect(oldSessionRequest).rejects.toBeInstanceOf(RpcTokenIssuanceSupersededError)

    expect(manager.getMetadata()).toEqual({ expiresAtMs: null, scopes: [], hostRefs: [] })
    await expect(
      manager.getOrIssue(
        'new-session',
        ['host:activity:read'],
        ['chatllm'],
        'new-session-generation'
      )
    ).resolves.toMatchObject({ token: 'test-token-new' })
    expect(issueRpcToken).toHaveBeenCalledTimes(2)
  })

  it('isolates the cached token and late issuance by authenticated session binding', async () => {
    const pending = deferred<RpcTokenResult>()
    const issueRpcToken = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(issuedToken('session-b-rpc-token'))
    const manager = new RpcTokenManager({ issueRpcToken } as unknown as AuthClient)

    const sessionA = manager.getOrIssue(
      'session-a',
      ['host:activity:read'],
      ['chatllm'],
      'session-a-generation'
    )
    await expect(
      manager.getOrIssue('session-b', ['host:activity:read'], ['chatllm'], 'session-b-generation')
    ).resolves.toMatchObject({ token: 'session-b-rpc-token' })

    pending.resolve(issuedToken('session-a-late-rpc-token'))
    await expect(sessionA).rejects.toBeInstanceOf(RpcTokenIssuanceSupersededError)
    await expect(
      manager.getOrIssue('session-b', ['host:activity:read'], ['chatllm'], 'session-b-generation')
    ).resolves.toMatchObject({ token: 'session-b-rpc-token' })
    expect(issueRpcToken).toHaveBeenCalledTimes(2)
  })
})
