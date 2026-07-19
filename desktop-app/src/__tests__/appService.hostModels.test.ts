import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  getChatStore: vi.fn(),
  unbindChatStore: vi.fn(),
}))

/**
 * Wires an AppService with `issueRpcTokenForHostRefs` stubbed so the tests can
 * assert the exact scope set each model-selector method requests (R2 §3.4/§8.2),
 * without touching team resolution or the real RPC token manager. Mirrors the
 * canonical `getContextBreakdown` chain.
 */
function modelService() {
  const issueRpcTokenForHostRefs = vi
    .fn()
    .mockResolvedValue({ token: 'rpc-token', scopes: [], hostRefs: [] })
  const rpcClient = {
    getHostModels: vi.fn(),
    setHostModel: vi.fn(),
  }
  const service = new AppService() as any
  service.issueRpcTokenForHostRefs = issueRpcTokenForHostRefs
  service.rpcClient = rpcClient
  return { service, issueRpcTokenForHostRefs, rpcClient }
}

describe('AppService.getHostModels', () => {
  it('issues a host:session:read token and forwards hostRef+chatId', async () => {
    const { service, issueRpcTokenForHostRefs, rpcClient } = modelService()
    const payload = {
      provider: 'claude',
      hostDefault: 'claude-opus-4-8',
      sessionModel: 'claude-haiku-4-5',
      degraded: false,
      models: [{ name: 'claude-opus-4-8' }, { name: 'claude-haiku-4-5' }],
    }
    rpcClient.getHostModels.mockResolvedValue(payload)

    const result = await service.getHostModels('chatllm', 'chat-1')

    expect(result).toEqual(payload)
    // Reading the list reuses the session-read scope — NOT the write scope.
    expect(issueRpcTokenForHostRefs).toHaveBeenCalledWith(['host:session:read'], ['chatllm'])
    expect(rpcClient.getHostModels).toHaveBeenCalledWith('rpc-token', 'chatllm', 'chat-1')
  })

  it('defaults hostRefs to the target host but honors an explicit set', async () => {
    const { service, issueRpcTokenForHostRefs, rpcClient } = modelService()
    rpcClient.getHostModels.mockResolvedValue(null)

    await service.getHostModels('chatllm', 'chat-1', ['chatllm', 'other-host'])

    expect(issueRpcTokenForHostRefs).toHaveBeenCalledWith(
      ['host:session:read'],
      ['chatllm', 'other-host']
    )
  })

  it('propagates the null the client returns for a host without the endpoint', async () => {
    const { service, rpcClient } = modelService()
    rpcClient.getHostModels.mockResolvedValue(null)
    await expect(service.getHostModels('chatllm', 'chat-1')).resolves.toBeNull()
  })

  it('swallows a runtime missing-token 401 to null so the selector hides', async () => {
    const { service, rpcClient } = modelService()
    rpcClient.getHostModels.mockRejectedValue(
      new Error('Get host models failed (401): missing token')
    )
    await expect(service.getHostModels('chatllm', 'chat-1')).resolves.toBeNull()
  })

  it('rethrows a genuine error', async () => {
    const { service, rpcClient } = modelService()
    rpcClient.getHostModels.mockRejectedValue(new Error('Get host models failed (500): boom'))
    await expect(service.getHostModels('chatllm', 'chat-1')).rejects.toThrow('500')
  })

  it('requires hostRef but treats chatId as optional (host-level list)', async () => {
    const { service, issueRpcTokenForHostRefs } = modelService()
    await expect(service.getHostModels('', 'chat-1')).rejects.toThrow('hostRef is required')
    expect(issueRpcTokenForHostRefs).not.toHaveBeenCalled()
  })

  it('allows an absent chatId and forwards an empty chatId to the client (new-chat composer)', async () => {
    // R2 new-chat composer: the model LIST is host-level, so a brand-new chat with
    // no id still resolves the list. The empty chatId flows through; the client
    // omits the `?chatId=` query so the server returns `sessionModel: null`.
    const { service, issueRpcTokenForHostRefs, rpcClient } = modelService()
    rpcClient.getHostModels.mockResolvedValue({
      provider: 'claude',
      hostDefault: 'claude-opus-4-8',
      sessionModel: null,
      degraded: false,
      models: [{ name: 'claude-opus-4-8' }],
    })

    const result = await service.getHostModels('chatllm', '')

    expect(result?.sessionModel).toBeNull()
    expect(issueRpcTokenForHostRefs).toHaveBeenCalledWith(['host:session:read'], ['chatllm'])
    expect(rpcClient.getHostModels).toHaveBeenCalledWith('rpc-token', 'chatllm', '')
  })
})

describe('AppService.setHostModel', () => {
  it('issues a host:model:write token and forwards the selection', async () => {
    const { service, issueRpcTokenForHostRefs, rpcClient } = modelService()
    rpcClient.setHostModel.mockResolvedValue({
      effective: 'next-task',
      provider: 'claude',
      model: 'claude-haiku-4-5',
    })

    const result = await service.setHostModel('chatllm', 'chat-1', 'claude-haiku-4-5')

    expect(result.effective).toBe('next-task')
    // The write path is gated by the dedicated write scope only (§8.2).
    expect(issueRpcTokenForHostRefs).toHaveBeenCalledWith(['host:model:write'], ['chatllm'])
    expect(rpcClient.setHostModel).toHaveBeenCalledWith(
      'rpc-token',
      'chatllm',
      'chat-1',
      'claude-haiku-4-5'
    )
  })

  it('propagates a model_not_allowed rejection unchanged (no swallow)', async () => {
    const { service, rpcClient } = modelService()
    rpcClient.setHostModel.mockRejectedValue(
      new Error('Set host model rejected (model_not_allowed)')
    )
    await expect(service.setHostModel('chatllm', 'chat-1', 'banned')).rejects.toThrow(
      'model_not_allowed'
    )
  })

  it('requires hostRef, chatId, and model', async () => {
    const { service, issueRpcTokenForHostRefs } = modelService()
    await expect(service.setHostModel('', 'chat-1', 'm')).rejects.toThrow(
      'hostRef, chatId, and model are required'
    )
    await expect(service.setHostModel('chatllm', '', 'm')).rejects.toThrow(
      'hostRef, chatId, and model are required'
    )
    await expect(service.setHostModel('chatllm', 'chat-1', '')).rejects.toThrow(
      'hostRef, chatId, and model are required'
    )
    expect(issueRpcTokenForHostRefs).not.toHaveBeenCalled()
  })
})
