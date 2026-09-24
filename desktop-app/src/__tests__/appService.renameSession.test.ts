import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
import { ApiError } from '../httpClient.js'

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  getChatStore: vi.fn(),
  unbindChatStore: vi.fn(),
}))

function renameService() {
  const issueRpcTokenForHostRefs = vi
    .fn()
    .mockResolvedValue({ token: 'fake-rpc-token', scopes: [], hostRefs: [] })
  const rpcClient = { renameSession: vi.fn() }
  const service = new AppService() as unknown as {
    issueRpcTokenForHostRefs: typeof issueRpcTokenForHostRefs
    rpcClient: typeof rpcClient
    rpcTokenManager: { clear: () => void }
    renameSession: AppService['renameSession']
  }
  service.issueRpcTokenForHostRefs = issueRpcTokenForHostRefs
  service.rpcClient = rpcClient
  service.rpcTokenManager = { clear: vi.fn() }
  return { service, issueRpcTokenForHostRefs, rpcClient }
}

describe('AppService.renameSession (spec 15 Fase B)', () => {
  it('issues a host:session:write token — NOT wake-eligible — and forwards the rename', async () => {
    const { service, issueRpcTokenForHostRefs, rpcClient } = renameService()
    rpcClient.renameSession.mockResolvedValue({ title: 'New name' })

    const result = await service.renameSession('chatllm', 'chatllm', 'chat-1', 'New name')

    expect(result).toEqual({ title: 'New name' })
    // The dedicated write scope, and DELIBERATELY without host:wake:write: a
    // rename must not be a cheap "wake my pod" primitive (spec 15 §5).
    expect(issueRpcTokenForHostRefs).toHaveBeenCalledWith(['host:session:write'], ['chatllm'])
    expect(issueRpcTokenForHostRefs.mock.calls[0]?.[0]).not.toContain('host:wake:write')
    expect(rpcClient.renameSession).toHaveBeenCalledWith(
      'fake-rpc-token',
      'chatllm',
      'chatllm',
      'chat-1',
      'New name'
    )
  })

  it('does not accept a renderer hostRefs fleet — token is scoped to the single host', async () => {
    const { service, issueRpcTokenForHostRefs, rpcClient } = renameService()
    rpcClient.renameSession.mockResolvedValue({ title: 'x' })
    // The method signature carries an optional hostRefs, but the ipc handler never
    // forwards one; default is [hostRef].
    await service.renameSession('chatllm', 'chatllm', 'chat-1', 'x')
    expect(issueRpcTokenForHostRefs).toHaveBeenCalledWith(['host:session:write'], ['chatllm'])
  })

  it('re-mints the token and retries once on a 401 token lapse', async () => {
    const { service, issueRpcTokenForHostRefs, rpcClient } = renameService()
    rpcClient.renameSession
      .mockRejectedValueOnce(new ApiError('Rename session failed (401)', 401, ''))
      .mockResolvedValueOnce({ title: 'ok' })

    const result = await service.renameSession('chatllm', 'chatllm', 'chat-1', 'ok')

    expect(result).toEqual({ title: 'ok' })
    expect(rpcClient.renameSession).toHaveBeenCalledTimes(2)
    expect(issueRpcTokenForHostRefs).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a 404 (that is a real "not found" for the queue to handle)', async () => {
    const { service, rpcClient } = renameService()
    rpcClient.renameSession.mockRejectedValue(new ApiError('Rename session failed (404)', 404, ''))
    await expect(service.renameSession('chatllm', 'chatllm', 'chat-1', 'x')).rejects.toThrow(
      '(404)'
    )
    expect(rpcClient.renameSession).toHaveBeenCalledTimes(1)
  })

  it('requires hostRef, agent, and chatId', async () => {
    const { service } = renameService()
    await expect(service.renameSession('', 'chatllm', 'chat-1', 'x')).rejects.toThrow()
    await expect(service.renameSession('chatllm', '', 'chat-1', 'x')).rejects.toThrow()
    await expect(service.renameSession('chatllm', 'chatllm', '', 'x')).rejects.toThrow()
  })
})
