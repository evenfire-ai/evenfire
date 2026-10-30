/**
 * #1044 — `AppService.continueModelStep`: the continuation POST mints the
 * wakeable message-invoke scopes for its single hostRef (parity with
 * `invokeHostMessage`), forwards the five contract arguments, maps the
 * structured host-availability 503s on both attempts, and re-mints once on a
 * 401/403-missing-scope token lapse. Every other answer is a real error and is
 * not retried.
 */
import { describe, expect, it, vi } from 'vitest'
import { AppService } from '../appService.js'
import { ApiError } from '../httpClient.js'
import type { ModelStepContinueResult } from '../types.js'

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  getChatStore: vi.fn(),
  unbindChatStore: vi.fn(),
}))

const CHECKPOINT_ID = 'msc_01J9Z7Q4R2M3N5P6Q7R8S9T0V1'
// HOST_FINITE_OPERATION_SCOPES.message, written out: a dropped or reordered
// scope must fail loudly instead of matching a subset.
const WAKEABLE = ['host:message:invoke', 'host:task:read', 'host:wake:write']
const claimed: ModelStepContinueResult = {
  outcome: 'claimed',
  httpStatus: 202,
  body: {
    taskId: 'task-c',
    checkpointId: CHECKPOINT_ID,
    status: 'claimed',
    replayed: false,
  },
}

function continueService() {
  const issueRpcTokenForHostRefs = vi
    .fn()
    .mockResolvedValue({ token: 'token-1', scopes: [], hostRefs: [] })
  const rpcClient = {
    continueModelStep: vi.fn().mockResolvedValue(claimed),
    invokeHostMessage: vi.fn().mockResolvedValue({ taskId: 'origin-task' }),
  }
  const clearRpcTokens = vi.fn()
  const service = new AppService() as unknown as {
    issueRpcTokenForHostRefs: typeof issueRpcTokenForHostRefs
    rpcClient: typeof rpcClient
    rpcTokenManager: { clear: () => void }
    continueModelStep: AppService['continueModelStep']
    invokeHostMessage: AppService['invokeHostMessage']
  }
  service.issueRpcTokenForHostRefs = issueRpcTokenForHostRefs
  service.rpcClient = rpcClient
  service.rpcTokenManager = { clear: clearRpcTokens }
  return { service, issueRpcTokenForHostRefs, rpcClient, clearRpcTokens }
}

describe('AppService.continueModelStep (#1044)', () => {
  it('mints the wakeable message scopes for one host and forwards all five arguments', async () => {
    const { service, issueRpcTokenForHostRefs, rpcClient } = continueService()

    const result = await service.continueModelStep('chatllm', 'agent-a', 'chat-1', CHECKPOINT_ID, 2)

    expect(result).toBe(claimed)
    expect(issueRpcTokenForHostRefs).toHaveBeenCalledTimes(1)
    expect(issueRpcTokenForHostRefs).toHaveBeenCalledWith(WAKEABLE, ['chatllm'])
    expect(rpcClient.continueModelStep).toHaveBeenCalledTimes(1)
    expect(rpcClient.continueModelStep).toHaveBeenCalledWith(
      'token-1',
      'chatllm',
      'agent-a',
      'chat-1',
      CHECKPOINT_ID,
      2
    )
  })

  it('requests exactly the scopes invokeHostMessage requests', async () => {
    const { service, issueRpcTokenForHostRefs } = continueService()

    await service.invokeHostMessage('chatllm', { content: 'hi' })
    await service.continueModelStep('chatllm', 'agent-a', 'chat-1', CHECKPOINT_ID, 2)

    const sendScopes = issueRpcTokenForHostRefs.mock.calls[0]![0]
    const continueScopes = issueRpcTokenForHostRefs.mock.calls[1]![0]
    // Parity with the send path, not a third copy of the literal array.
    expect(continueScopes).toEqual(sendScopes)
    // Anti-vacuity: parity cannot pass on two empty arrays.
    expect(sendScopes).toContain('host:wake:write')
    expect(issueRpcTokenForHostRefs.mock.calls[1]![1]).toEqual(['chatllm'])
  })

  it('trims every identifier before minting and before forwarding', async () => {
    const { service, issueRpcTokenForHostRefs, rpcClient } = continueService()

    await service.continueModelStep(' chatllm ', ' agent-a ', ' chat-1 ', ' msc_x ', 3)

    expect(issueRpcTokenForHostRefs).toHaveBeenCalledWith(WAKEABLE, ['chatllm'])
    expect(rpcClient.continueModelStep).toHaveBeenCalledWith(
      'token-1',
      'chatllm',
      'agent-a',
      'chat-1',
      'msc_x',
      3
    )
  })

  it('requires all four identifiers and mints nothing for an empty one', async () => {
    const { service, issueRpcTokenForHostRefs, rpcClient } = continueService()
    const required = 'hostRef, agent, chatId, and checkpointId are required'

    await expect(
      service.continueModelStep('', 'agent-a', 'chat-1', CHECKPOINT_ID, 2)
    ).rejects.toThrow(required)
    await expect(
      service.continueModelStep('chatllm', '', 'chat-1', CHECKPOINT_ID, 2)
    ).rejects.toThrow(required)
    await expect(
      service.continueModelStep('chatllm', 'agent-a', '', CHECKPOINT_ID, 2)
    ).rejects.toThrow(required)
    await expect(service.continueModelStep('chatllm', 'agent-a', 'chat-1', '', 2)).rejects.toThrow(
      required
    )
    expect(issueRpcTokenForHostRefs).not.toHaveBeenCalled()
    expect(rpcClient.continueModelStep).not.toHaveBeenCalled()

    // Liveness witness: the same stubs DO mint and reach the client for a valid
    // call, so the negatives above are not an artifact of a dead harness.
    await expect(
      service.continueModelStep('chatllm', 'agent-a', 'chat-1', CHECKPOINT_ID, 2)
    ).resolves.toBe(claimed)
    expect(issueRpcTokenForHostRefs).toHaveBeenCalledTimes(1)
    expect(rpcClient.continueModelStep).toHaveBeenCalledTimes(1)
  })

  it.each([
    { token: 'host_waking', bodyText: '{"code":"host_waking"}' },
    { token: 'host_draining', bodyText: '{"code":"host_draining"}' },
  ])('maps a 503 $token to the stable token and does not retry', async ({ token, bodyText }) => {
    const { service, issueRpcTokenForHostRefs, rpcClient } = continueService()
    rpcClient.continueModelStep.mockRejectedValueOnce(
      new ApiError('Continue failed (503)', 503, bodyText)
    )

    await expect(
      service.continueModelStep('chatllm', 'agent-a', 'chat-1', CHECKPOINT_ID, 2)
    ).rejects.toThrow(new RegExp(`^${token}:`))

    expect(rpcClient.continueModelStep).toHaveBeenCalledTimes(1)
    expect(issueRpcTokenForHostRefs).toHaveBeenCalledTimes(1)
  })

  it('re-mints once on a 401 and retries with the fresh token', async () => {
    const { service, issueRpcTokenForHostRefs, rpcClient, clearRpcTokens } = continueService()
    issueRpcTokenForHostRefs
      .mockResolvedValueOnce({ token: 'token-1', scopes: [], hostRefs: [] })
      .mockResolvedValueOnce({ token: 'token-2', scopes: [], hostRefs: [] })
    rpcClient.continueModelStep
      .mockRejectedValueOnce(new ApiError('Continue failed (401)', 401, ''))
      .mockResolvedValueOnce(claimed)

    const result = await service.continueModelStep('chatllm', 'agent-a', 'chat-1', CHECKPOINT_ID, 2)

    expect(result).toBe(claimed)
    expect(clearRpcTokens).toHaveBeenCalledTimes(1)
    expect(issueRpcTokenForHostRefs).toHaveBeenCalledTimes(2)
    expect(issueRpcTokenForHostRefs.mock.calls[1]![0]).toEqual(WAKEABLE)
    expect(rpcClient.continueModelStep.mock.calls[0]![0]).toBe('token-1')
    // The FRESH token, not the stale one.
    expect(rpcClient.continueModelStep.mock.calls[1]![0]).toBe('token-2')
    expect(rpcClient.continueModelStep.mock.calls[1]!.slice(1)).toEqual(
      rpcClient.continueModelStep.mock.calls[0]!.slice(1)
    )
  })

  it.each([
    { status: 404, label: 'not found' },
    { status: 500, label: 'server error' },
  ])('does not retry a $status ($label)', async ({ status }) => {
    const { service, issueRpcTokenForHostRefs, rpcClient } = continueService()
    rpcClient.continueModelStep
      .mockRejectedValueOnce(new ApiError(`Continue failed (${status})`, status, ''))
      .mockResolvedValueOnce(claimed)

    await expect(
      service.continueModelStep('chatllm', 'agent-a', 'chat-1', CHECKPOINT_ID, 2)
    ).rejects.toThrow(`(${status})`)
    expect(rpcClient.continueModelStep).toHaveBeenCalledTimes(1)

    // Liveness witness: the same service reaches the client and returns the
    // contract row on success, so "called once" is not an artifact of a dead
    // harness.
    await expect(
      service.continueModelStep('chatllm', 'agent-a', 'chat-1', CHECKPOINT_ID, 2)
    ).resolves.toBe(claimed)
    expect(rpcClient.continueModelStep).toHaveBeenCalledTimes(2)
    expect(issueRpcTokenForHostRefs).toHaveBeenCalledTimes(2)
  })

  it('maps host availability on the retried call too', async () => {
    const { service, rpcClient, clearRpcTokens } = continueService()
    rpcClient.continueModelStep
      .mockRejectedValueOnce(new ApiError('Continue failed (401)', 401, ''))
      .mockRejectedValueOnce(new ApiError('Continue failed (503)', 503, '{"code":"host_draining"}'))

    await expect(
      service.continueModelStep('chatllm', 'agent-a', 'chat-1', CHECKPOINT_ID, 2)
    ).rejects.toThrow(/^host_draining:/)

    // Witness: the answer came from the post-refresh retry, not the first call.
    expect(clearRpcTokens).toHaveBeenCalledTimes(1)
    expect(rpcClient.continueModelStep).toHaveBeenCalledTimes(2)
  })
})
