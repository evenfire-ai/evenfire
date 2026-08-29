import { describe, expect, it, vi } from 'vitest'
import {
  CodexAuthorizeError,
  ProviderAttemptAuthorizer,
  resolveCodexAuthorizeUrl,
} from '../providerAttemptAuthorizer'

const validAuthorize = {
  providerAttemptId: 'attempt-1',
  requestHash: 'a'.repeat(64),
  executionTicket: 'ticket-123456',
  expiresAt: '2026-08-20T10:00:00.000Z',
}

describe('ProviderAttemptAuthorizer', () => {
  it('posts the platform JWT to the server-owned gateway URL', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => validAuthorize,
    })
    const authorizer = new ProviderAttemptAuthorizer({
      authorizeUrl: resolveCodexAuthorizeUrl('http://gateway:8092'),
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const result = await authorizer.authorize({
      request: { schemaVersion: 'codex-completion-request.v1' },
      invocationId: 'inv-1',
      attemptGeneration: 1,
      providerAttemptIndex: 1,
      policyRevision: 1,
      policyHash: 'b'.repeat(64),
    })
    expect(fetchFn).toHaveBeenCalledWith(
      'http://gateway:8092/api/v1/mcp-host/llm/provider-attempts/authorize',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer platform-jwt' }),
      })
    )
    expect(result.executionTicket).toBe('ticket-123456')
    expect(result).not.toHaveProperty('accessToken')
  })

  it('rejects an authorize payload that leaks an access token', async () => {
    const authorizer = new ProviderAttemptAuthorizer({
      authorizeUrl: 'http://gateway:8092/api/v1/mcp-host/llm/provider-attempts/authorize',
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ...validAuthorize, accessToken: 'sk-leaked' }),
      }) as unknown as typeof fetch,
    })
    await expect(
      authorizer.authorize({
        request: {},
        invocationId: 'inv-1',
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        policyRevision: 1,
        policyHash: 'b'.repeat(64),
      })
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('maps insufficient_scope from the gateway', async () => {
    const authorizer = new ProviderAttemptAuthorizer({
      authorizeUrl: 'http://gateway:8092/api/v1/mcp-host/llm/provider-attempts/authorize',
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: 'insufficient_scope' }),
      }) as unknown as typeof fetch,
    })
    await expect(
      authorizer.authorize({
        request: {},
        invocationId: 'inv-1',
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        policyRevision: 1,
        policyHash: 'b'.repeat(64),
      })
    ).rejects.toBeInstanceOf(CodexAuthorizeError)
    await expect(
      authorizer.authorize({
        request: {},
        invocationId: 'inv-1',
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        policyRevision: 1,
        policyHash: 'b'.repeat(64),
      })
    ).rejects.toMatchObject({ code: 'insufficient_scope' })
  })

  it('refreshes the platform JWT once and retries authorize after HTTP 401', async () => {
    let jwt = 'stale-jwt'
    const refreshOnUnauthorized = vi.fn(async () => {
      jwt = 'fresh-jwt'
    })
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Unauthorized' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => validAuthorize,
      })
    const authorizer = new ProviderAttemptAuthorizer({
      authorizeUrl: resolveCodexAuthorizeUrl('http://gateway:8092'),
      readPlatformJwt: () => jwt,
      refreshOnUnauthorized,
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const result = await authorizer.authorize({
      request: { schemaVersion: 'codex-completion-request.v1' },
      invocationId: 'inv-1',
      attemptGeneration: 1,
      providerAttemptIndex: 1,
      policyRevision: 1,
      policyHash: 'b'.repeat(64),
    })
    expect(refreshOnUnauthorized).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn.mock.calls[0][1].headers.authorization).toBe('Bearer stale-jwt')
    expect(fetchFn.mock.calls[1][1].headers.authorization).toBe('Bearer fresh-jwt')
    expect(result.executionTicket).toBe('ticket-123456')
  })
})
