import { describe, expect, it, vi } from 'vitest'
import { ApprovalPromptHistoryClient } from './approvalPromptHistoryClient'

const INPUT = {
  approvalRequestId: '00000000-0000-4000-8000-000000000123',
  runId: '00000000-0000-4000-8000-000000000456',
  hostRef: 'sandbox-recipes/example',
  sessionId: 'session-1',
  origin: 'direct_chat' as const,
  prompt: 'Use Bearer abc.def.ghi and secret-value',
}

describe('ApprovalPromptHistoryClient', () => {
  it('defaults off without making a request', async () => {
    const fetchImpl = vi.fn()
    const client = new ApprovalPromptHistoryClient({
      baseUrl: 'http://control-api',
      getAccessToken: () => 'runtime-token',
      fetchImpl: fetchImpl as never,
    })

    await expect(client.capture(INPUT)).resolves.toBe('disabled')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('redacts protected values before enforcing bytes and sending', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    const client = new ApprovalPromptHistoryClient({
      baseUrl: 'http://control-api/',
      getAccessToken: () => 'runtime-token',
      enabled: true,
      maxBytes: 16_384,
      fetchImpl: fetchImpl as never,
    })

    await expect(client.capture(INPUT, ['secret-value'])).resolves.toBe('captured')
    const request = fetchImpl.mock.calls[0]
    const body = JSON.parse(String(request[1].body)) as Record<string, unknown>
    expect(body).toMatchObject({
      approvalRequestId: INPUT.approvalRequestId,
      runId: INPUT.runId,
      hostRef: INPUT.hostRef,
      sessionId: INPUT.sessionId,
      origin: INPUT.origin,
    })
    expect(body.prompt).toBe('Use [REDACTED] and [REDACTED]')
    expect(String(request[1].body)).not.toContain('abc.def.ghi')
    expect(String(request[1].body)).not.toContain('secret-value')
  })

  it('rejects a redacted prompt above the configured byte limit', async () => {
    const fetchImpl = vi.fn()
    const client = new ApprovalPromptHistoryClient({
      baseUrl: 'http://control-api',
      getAccessToken: () => 'runtime-token',
      enabled: true,
      maxBytes: 1_024,
      fetchImpl: fetchImpl as never,
    })

    await expect(client.capture({ ...INPUT, prompt: 'x'.repeat(1_025) })).resolves.toBe('rejected')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports invalid enabled configuration as unavailable without sending', async () => {
    const fetchImpl = vi.fn()
    const client = new ApprovalPromptHistoryClient({
      baseUrl: 'http://control-api',
      getAccessToken: () => 'runtime-token',
      enabled: true,
      maxBytes: Number.NaN,
      fetchImpl: fetchImpl as never,
    })

    await expect(client.capture(INPUT)).resolves.toBe('unavailable')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
