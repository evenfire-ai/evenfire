import { describe, expect, it, vi } from 'vitest'
import {
  bindVerifiedProviderTraceAttribution,
  parseProviderTraceBinding,
} from '../src/routes/mcp-host/user-approval-requests.routes.js'

const binding = {
  runId: '00000000-0000-4000-8000-000000000123',
  sessionId: 'conv-telegram-session-1',
  origin: 'channel_event' as const,
}

describe('mcp-host provider trace binding', () => {
  it('accepts only the bounded channel trace contract', () => {
    expect(parseProviderTraceBinding({ traceBinding: binding })).toEqual({
      ok: true,
      binding,
    })
    expect(
      parseProviderTraceBinding({ traceBinding: { ...binding, actorHumanSub: 'untrusted' } })
    ).toEqual({
      ok: false,
      status: 400,
      error: 'traceBinding contains unrecognized fields',
    })
  })

  it('derives human attribution from the verified account', async () => {
    const bind = vi.fn().mockResolvedValue({ status: 'created' })

    await expect(
      bindVerifiedProviderTraceAttribution({
        binding,
        callerHostRef: 'chatllm',
        providerHostRef: 'chatllm',
        identityIssuer: 'https://identity.example.test',
        accountUserId: '00000000-0000-4000-8000-000000000001',
        service: { bind },
      })
    ).resolves.toBe('bound')

    expect(bind).toHaveBeenCalledWith({
      ...binding,
      hostRef: 'chatllm',
      identityIssuer: 'https://identity.example.test',
      actorHumanSub: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000001',
      teamId: null,
    })
  })

  it('rejects a provider host that differs from the authenticated caller', async () => {
    const bind = vi.fn()

    await expect(
      bindVerifiedProviderTraceAttribution({
        binding,
        callerHostRef: 'chatllm',
        providerHostRef: 'different-host',
        identityIssuer: 'https://identity.example.test',
        accountUserId: '00000000-0000-4000-8000-000000000001',
        service: { bind },
      })
    ).resolves.toBe('host_mismatch')
    expect(bind).not.toHaveBeenCalled()
  })
})
