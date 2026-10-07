import { describe, expect, it, vi } from 'vitest'
import type { AuthClient } from '../authClient.js'
import { RpcTokenManager } from '../rpcTokenManager.js'
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
      .mockResolvedValueOnce(issuedToken('new-session-token'))
    const manager = new RpcTokenManager({ issueRpcToken } as unknown as AuthClient)

    const oldSessionRequest = manager.getOrIssue('old-session', ['host:activity:read'], ['chatllm'])
    manager.clear()
    pending.resolve(issuedToken('old-session-token'))
    await expect(oldSessionRequest).resolves.toMatchObject({ token: 'old-session-token' })

    expect(manager.getMetadata()).toEqual({ expiresAtMs: null, scopes: [], hostRefs: [] })
    await expect(
      manager.getOrIssue('new-session', ['host:activity:read'], ['chatllm'])
    ).resolves.toMatchObject({ token: 'new-session-token' })
    expect(issueRpcToken).toHaveBeenCalledTimes(2)
  })
})
