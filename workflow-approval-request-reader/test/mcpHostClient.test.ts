import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReaderConfig } from '../src/config.js'
import {
  submitMcpHostDecision,
  submitMcpHostEnrollment,
} from '../src/mcpHostClient.js'

const cfg: ReaderConfig = {
  port: 0,
  mcpHostBaseUrl: 'http://wf-figure-d-recipe-mcp-host.sandbox-recipes.svc.cluster.local:8080',
  mcpHostRef: 'sandbox-recipes/figure-d-recipe',
  mcpHostTargets: [
    {
      hostRef: 'sandbox-recipes/figure-d-recipe',
      baseUrl: 'http://wf-figure-d-recipe-mcp-host.sandbox-recipes.svc.cluster.local:8080',
    },
  ],
  enabledMedia: new Set(['telegram', 'slack']),
  mcpHostTimeoutMs: 5000,
  mcpHostMessageTimeoutMs: 120_000,
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 120,
  controlApiBaseUrl: '',
  controlApiToken: '',
  controlApiTimeoutMs: 4000,
  channelReaderUrlTemplate: 'http://channel-reader-{host}:8099',
  channelReaderHandoffToken: 'handoff-token',
  channelReaderHandoffTimeoutMs: 5000,
}

describe('mcp-host decision client routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('fails closed when a provider decision has no explicit runtime mcp-host route', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitMcpHostDecision(
        { ...cfg, mcpHostBaseUrl: '', mcpHostRef: '', mcpHostTargets: [] },
        {
          medium: 'telegram',
          approvalRequestId: '99999999-8888-7777-6666-555555555555',
          providerUserId: '123456',
          providerChannelId: '456',
          providerEventId: 'telegram:456:event-1',
          decision: 'approve',
        }
      )
    ).resolves.toEqual({ ok: false, status: 409, error: 'approval_route_not_found' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('routes provider decisions through explicit agent mcp-host route hints', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitMcpHostDecision(cfg, {
        medium: 'telegram',
        approvalRequestId: '99999999-8888-7777-6666-555555555555',
        providerUserId: '123456',
        providerChannelId: '456',
        providerEventId: 'telegram:456:event-1',
        mcpHostRef: 'llm',
        decision: 'approve',
      })
    ).resolves.toEqual({ ok: true, duplicate: false })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://llm.mcp-host.svc.cluster.local:8080/v1/runtime/workflow-approvals/decide',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-clerum-edge-caller': 'workflow-approval-request-reader',
          'x-clerum-edge-host-ref': 'llm',
          'x-clerum-edge-channel-type': 'telegram',
          'x-clerum-edge-channel-id': '456',
        }),
      })
    )
  })

  it('does not use configured static targets when callbacks omit the runtime route hint', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitMcpHostDecision(cfg, {
        medium: 'telegram',
        approvalRequestId: '99999999-8888-7777-6666-555555555555',
        providerUserId: '123456',
        providerChannelId: '456',
        providerEventId: 'telegram:456:event-1',
        decision: 'approve',
      })
    ).resolves.toEqual({ ok: false, status: 409, error: 'approval_route_not_found' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('routes provider decisions through the explicit recipe mcp-host route hint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitMcpHostDecision(cfg, {
        medium: 'telegram',
        approvalRequestId: '99999999-8888-7777-6666-555555555555',
        providerUserId: '123456',
        providerChannelId: '456',
        providerEventId: 'telegram:456:event-1',
        mcpHostRef: 'sandbox-recipes/figure-d-recipe',
        decision: 'approve',
      })
    ).resolves.toEqual({ ok: true, duplicate: false })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://wf-figure-d-recipe-mcp-host.sandbox-recipes.svc.cluster.local:8080/v1/runtime/workflow-approvals/decide',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-clerum-edge-caller': 'workflow-approval-request-reader',
          'x-clerum-edge-host-ref': 'sandbox-recipes/figure-d-recipe',
          'x-clerum-edge-channel-type': 'telegram',
          'x-clerum-edge-channel-id': '456',
        }),
      })
    )
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization')
  })

  it('derives provider decision routes only for sandbox-recipes runtime host refs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitMcpHostDecision(
        { ...cfg, mcpHostTargets: [] },
        {
          medium: 'telegram',
          approvalRequestId: '99999999-8888-7777-6666-555555555555',
          providerUserId: '123456',
          providerChannelId: '456',
          providerEventId: 'telegram:456:event-1',
          mcpHostRef: 'sandbox-recipes/figure-d-derived',
          decision: 'approve',
        }
      )
    ).resolves.toEqual({ ok: true, duplicate: false })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://wf-figure-d-derived-mcp-host.sandbox-recipes.svc.cluster.local:8080/v1/runtime/workflow-approvals/decide',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-clerum-edge-host-ref': 'sandbox-recipes/figure-d-derived',
        }),
      })
    )
  })

  it('derives DNS-safe runtime service names for dotted recipe refs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitMcpHostDecision(
        { ...cfg, mcpHostTargets: [] },
        {
          medium: 'telegram',
          approvalRequestId: '99999999-8888-7777-6666-555555555555',
          providerUserId: '123456',
          providerChannelId: '456',
          providerEventId: 'telegram:456:event-1',
          mcpHostRef: 'sandbox-recipes/finance.v1',
          decision: 'approve',
        }
      )
    ).resolves.toEqual({ ok: true, duplicate: false })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://wf-finance-v1-mcp-host.sandbox-recipes.svc.cluster.local:8080/v1/runtime/workflow-approvals/decide',
      expect.any(Object)
    )
  })

  it('derives short route-alias service names for compact Telegram route refs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitMcpHostDecision(
        { ...cfg, mcpHostTargets: [] },
        {
          medium: 'telegram',
          approvalRequestId: '99999999-8888-7777-6666-555555555555',
          providerUserId: '123456',
          providerChannelId: '456',
          providerEventId: 'telegram:456:event-1',
          mcpHostRef: 'sandbox-recipes/~0123456789abcdef',
          decision: 'approve',
        }
      )
    ).resolves.toEqual({ ok: true, duplicate: false })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://wf-0123456789abcdef-mcp-host.sandbox-recipes.svc.cluster.local:8080/v1/runtime/workflow-approvals/decide',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-clerum-edge-host-ref': 'sandbox-recipes/~0123456789abcdef',
        }),
      })
    )
  })

  it('sends the full provider identity required by runtime mcp-host decision routes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitMcpHostDecision(cfg, {
        medium: 'slack',
        approvalRequestId: '99999999-8888-7777-6666-555555555555',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'D123',
        providerEventId: 'slack:T123:D123:event-1',
        mcpHostRef: 'sandbox-recipes/figure-d-recipe',
        decision: 'approve',
      })
    ).resolves.toEqual({ ok: true, duplicate: false })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.providerIdentity).toMatchObject({
      medium: 'slack',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'D123',
      providerEventId: 'slack:T123:D123:event-1',
    })
  })

  it('does not surface HTTP 200 success:false runtime responses as accepted provider callbacks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: false, error: 'approval_binding_mismatch' }),
      } as Response)
    )

    await expect(
      submitMcpHostDecision(cfg, {
        medium: 'telegram',
        approvalRequestId: '99999999-8888-7777-6666-555555555555',
        providerUserId: '123456',
        providerChannelId: '456',
        providerEventId: 'telegram:456:event-1',
        mcpHostRef: 'sandbox-recipes/figure-d-recipe',
        decision: 'approve',
      })
    ).resolves.toEqual({ ok: false, status: 409, error: 'approval_binding_mismatch' })
  })
})

describe('mcp-host enrollment client routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('fails closed when enrollment has no configured mcp-host target', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitMcpHostEnrollment(
        {
          ...cfg,
          mcpHostBaseUrl: '',
          mcpHostRef: '',
          mcpHostTargets: [],
        },
        {
          nonce: 'nonce_1234567890123456',
          medium: 'telegram',
          providerUserId: '123456',
          providerChannelId: '123456',
        }
      )
    ).resolves.toEqual({ ok: false, status: 409, error: 'mcp_host_target_required' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('routes Slack enrollment to the assigned agent mcp-host', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, account: { id: 'account-1' } }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitMcpHostEnrollment(cfg, {
        nonce: '123456',
        medium: 'slack',
        mcpHostRef: 'llm',
        communicationChannelRef: 'channels/slack-channel',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'C123',
      })
    ).resolves.toEqual({ ok: true, account: { id: 'account-1' } })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://llm.mcp-host.svc.cluster.local:8080/v1/runtime/workflow-approval-mediums/link-sessions/confirm',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-clerum-edge-host-ref': 'llm',
          'x-clerum-edge-channel-type': 'slack',
          'x-clerum-edge-channel-id': 'C123',
        }),
      })
    )
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.communicationChannelRef).toBe('channels/slack-channel')
  })

  it('does not invent a channel ref when control-api resolution is not configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, account: { id: 'account-1' } }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitMcpHostEnrollment(cfg, {
        nonce: '123456',
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'D123',
      })
    ).resolves.toEqual({ ok: true, account: { id: 'account-1' } })

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({
      nonce: '123456',
      medium: 'slack',
      providerUserId: 'U123',
      providerWorkspaceId: 'T123',
      providerChannelId: 'D123',
      communicationChannelRef: null,
    })
  })

  it('uses the platform-resolved CommunicationChannel ref for Slack enrollment', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ communicationChannelRef: 'channels/platform-slack' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, account: { id: 'account-1' } }),
      } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitMcpHostEnrollment(
        {
          ...cfg,
          controlApiBaseUrl: 'http://control-api:8090',
          controlApiToken: 'reader-token',
        },
        {
          nonce: '123456',
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'D123',
        }
      )
    ).resolves.toEqual({ ok: true, account: { id: 'account-1' } })

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/api/v1/internal/workflow-approval-reader/channel-ref'
    )
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(body.communicationChannelRef).toBe('channels/platform-slack')
  })

  it('uses the platform-resolved CommunicationChannel ref for Telegram enrollment', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ communicationChannelRef: 'channels/platform-telegram' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, account: { id: 'account-1' } }),
      } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitMcpHostEnrollment(
        {
          ...cfg,
          controlApiBaseUrl: 'http://control-api:8090',
          controlApiToken: 'reader-token',
        },
        {
          nonce: 'nonce_1234567890123456',
          medium: 'telegram',
          providerUserId: '123',
          providerChannelId: '456',
        }
      )
    ).resolves.toEqual({ ok: true, account: { id: 'account-1' } })

    const resolveUrl = String(fetchMock.mock.calls[0]?.[0])
    expect(resolveUrl).toContain('/api/v1/internal/workflow-approval-reader/channel-ref')
    expect(resolveUrl).toContain('medium=telegram')
    expect(resolveUrl).toContain('providerChannelId=456')
    expect(resolveUrl).not.toContain('providerWorkspaceId=')
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(body).toMatchObject({
      medium: 'telegram',
      providerUserId: '123',
      providerWorkspaceId: null,
      providerChannelId: '456',
      communicationChannelRef: 'channels/platform-telegram',
    })
  })

  it('fails closed instead of falling back to a static channel ref when platform resolution fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ error: 'communication_channel_ambiguous' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ ok: false, error: 'communication_channel_ref_required' }),
      } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      submitMcpHostEnrollment(
        {
          ...cfg,
          controlApiBaseUrl: 'http://control-api:8090',
          controlApiToken: 'reader-token',
        },
        {
          nonce: '123456',
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'D123',
        }
      )
    ).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'communication_channel_ref_required',
    })

    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(body.communicationChannelRef).toBeNull()
  })

  it('keeps enrollment fail-closed without a resolved CommunicationChannel ref', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    await submitMcpHostEnrollment(
      cfg,
      {
        nonce: '123456',
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'D123',
      }
    )

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.communicationChannelRef).toBeNull()
  })
})
