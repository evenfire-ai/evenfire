import { afterEach, describe, expect, it, vi } from 'vitest'
import { RPCClient } from '../rpcClient'
import type { Message } from '../types'

vi.hoisted(() => {
  process.env.CLERUM_HOST_REF = process.env.CLERUM_HOST_REF ?? 'test-host'
})

function telegramMessage(): Message {
  return {
    channelType: 'telegram',
    channelId: '424242',
    sender: '123456',
    content: 'listar workflows',
    timestamp: new Date('2026-05-29T10:00:00.000Z'),
    messageId: 'telegram:424242:9001',
    providerIdentity: {
      medium: 'telegram',
      providerUserId: '123456',
      providerChannelId: '424242',
      providerEventId: 'telegram:424242:9001',
    },
  }
}

describe('RPCClient workflow provider boundary', () => {
  const fetchMock = vi.fn<typeof fetch>()

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('forwards stable provider identity to mcp-host without resolving workflow targets in channel-reader', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, status: 'completed', response: 'ok' }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)
    const result = await new RPCClient('http://mcp-host.test').sendMessage(telegramMessage())

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://mcp-host.test/v1/runtime/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-clerum-edge-caller': 'channel-reader',
          'x-clerum-edge-host-ref': 'test-host',
          'x-clerum-edge-channel-type': 'telegram',
          'x-clerum-edge-channel-id': '424242',
          'x-clerum-edge-sender': '123456',
        }),
      })
    )
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({
      channelType: 'telegram',
      channelId: '424242',
      sender: '123456',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: '424242',
      },
    })
    expect(fetchMock.mock.calls.map(call => String(call[0])).join('\n')).not.toContain(
      '/api/v1/workflows/effective-targets/resolve'
    )
  })

  it('downloads workflow results through the deterministic provider endpoint', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        status: 'completed',
        response: 'Workflow result is ready.',
      }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const result = await new RPCClient('http://mcp-host.test').downloadWorkflowResult(
      telegramMessage(),
      'due-diligence'
    )

    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://mcp-host.test/v1/runtime/workflow-results/latest',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-clerum-edge-caller': 'channel-reader',
          'x-clerum-edge-channel-type': 'telegram',
          'x-clerum-edge-channel-id': '424242',
          'x-clerum-edge-sender': '123456',
        }),
      })
    )
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      workflowName: 'due-diligence',
      providerIdentity: {
        medium: 'telegram',
        providerUserId: '123456',
        providerChannelId: '424242',
        providerEventId: 'telegram:424242:9001',
      },
      source: {
        channelType: 'telegram',
        channelId: '424242',
        sender: '123456',
        messageId: 'telegram:424242:9001',
        timestamp: '2026-05-29T10:00:00.000Z',
      },
    })
  })
})
