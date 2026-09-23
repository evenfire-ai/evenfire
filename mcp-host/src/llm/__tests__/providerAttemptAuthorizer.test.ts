import { describe, expect, it, vi } from 'vitest'
import { ENVELOPE_ALLOWANCE_BYTES as GROK_CONTRACT_ENVELOPE_ALLOWANCE_BYTES } from '@clerum/grok-provider-attempt-contract'
import {
  ENVELOPE_ALLOWANCE_BYTES as CODEX_CONTRACT_ENVELOPE_ALLOWANCE_BYTES,
  LIMITS,
} from '@clerum/llm-provider-attempt-contract'
import { LlmErrorCode } from '../../core/errors'
import { CodexSubscriptionProvider } from '../codexSubscription'
import { classifyFailoverClass } from '../failover/classify'
import { GrokSubscriptionProvider } from '../grokSubscription'
import {
  AUTHORIZE_ENVELOPE_ALLOWANCE_BYTES,
  type AuthorizeAttemptBody,
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

// The envelope `codexSubscription` and `grokSubscription` build, with every
// optional field filled.
function realisticEnvelope(request: unknown): AuthorizeAttemptBody {
  return {
    request,
    requestHash: 'c'.repeat(64),
    invocationId: '5f0c6f1e-8d6b-4a53-9a3e-2f7d1c4b9e10',
    attemptGeneration: 1,
    providerAttemptIndex: 1,
    policyRevision: 3,
    policyHash: 'b'.repeat(64),
    hostRef: 'hosts/5f0c6f1e-8d6b-4a53-9a3e-2f7d1c4b9e10',
    recipeNamespace: 'user-5f0c6f1e',
    recipeName: 'daily-report-recipe',
    userId: '5f0c6f1e-8d6b-4a53-9a3e-2f7d1c4b9e11',
    budgetReservationId: '5f0c6f1e-8d6b-4a53-9a3e-2f7d1c4b9e12',
    pluginWorkloadSdkProviderAttemptId: '5f0c6f1e-8d6b-4a53-9a3e-2f7d1c4b9e13',
    targetRef: 'targets/codex-subscription/gpt-5.5',
  }
}

// A V1 request whose own JSON is exactly `bytes` long.
function requestOfBytes(bytes: number): { content: string } {
  const frame = JSON.stringify({ content: '' }).length
  const request = { content: 'a'.repeat(bytes - frame) }
  expect(JSON.stringify(request).length).toBe(bytes)
  return request
}

describe('ProviderAttemptAuthorizer', () => {
  // R11 — control-api, both proxies and this authorizer import the allowance
  // from the contracts. mcp-host has both contracts installed, so the parity
  // check between them lives here. Each value is pinned first, so two missing
  // exports cannot pass by comparing undefined with undefined.
  it('T-R11-parity both contracts export the same 16 KiB envelope allowance', () => {
    expect(CODEX_CONTRACT_ENVELOPE_ALLOWANCE_BYTES).toBe(16 * 1024)
    expect(GROK_CONTRACT_ENVELOPE_ALLOWANCE_BYTES).toBe(16 * 1024)
    expect(GROK_CONTRACT_ENVELOPE_ALLOWANCE_BYTES).toBe(CODEX_CONTRACT_ENVELOPE_ALLOWANCE_BYTES)
  })

  it('T-R9-13a grants the envelope the same allowance as control-api, from the contract', () => {
    expect(AUTHORIZE_ENVELOPE_ALLOWANCE_BYTES).toBe(CODEX_CONTRACT_ENVELOPE_ALLOWANCE_BYTES)
  })

  it('T-R9-13b dispatches a request just under the cap in a realistic envelope', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => validAuthorize })
    const authorizer = new ProviderAttemptAuthorizer({
      authorizeUrl: 'http://gateway/authorize',
      readPlatformJwt: () => 'test-jwt',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const body = realisticEnvelope(requestOfBytes(8_388_544))
    // The whole body is over the cap only because of its envelope.
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeGreaterThan(
      LIMITS.maxRequestBodyBytes
    )
    await expect(authorizer.authorize(body)).resolves.toMatchObject({
      executionTicket: 'ticket-123456',
    })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('T-R9-13c rejects a body one byte over the cap plus the allowance before dispatch', async () => {
    const fetchFn = vi.fn()
    const authorizer = new ProviderAttemptAuthorizer({
      authorizeUrl: 'http://gateway/authorize',
      readPlatformJwt: () => 'test-jwt',
      fetchFn,
    })
    const limit = LIMITS.maxRequestBodyBytes + CODEX_CONTRACT_ENVELOPE_ALLOWANCE_BYTES
    const envelopeBytes = Buffer.byteLength(JSON.stringify(realisticEnvelope(requestOfBytes(100))))
    const body = realisticEnvelope(requestOfBytes(limit + 1 - (envelopeBytes - 100)))
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBe(limit + 1)
    await expect(authorizer.authorize(body)).rejects.toMatchObject({
      code: 'payload_too_large',
      message: expect.stringContaining(`${LIMITS.maxRequestBodyBytes / (1024 * 1024)} MiB`),
    })
    expect(fetchFn).not.toHaveBeenCalled()
    // Witness: the same envelope one byte smaller is dispatched.
    const dispatched = vi.fn().mockResolvedValue({ ok: true, json: async () => validAuthorize })
    const atLimit = realisticEnvelope(requestOfBytes(limit - (envelopeBytes - 100)))
    expect(Buffer.byteLength(JSON.stringify(atLimit), 'utf8')).toBe(limit)
    await new ProviderAttemptAuthorizer({
      authorizeUrl: 'http://gateway/authorize',
      readPlatformJwt: () => 'test-jwt',
      fetchFn: dispatched as unknown as typeof fetch,
    }).authorize(atLimit)
    expect(dispatched).toHaveBeenCalledOnce()
  })

  it('dispatches a V2 envelope larger than the V1 ceiling', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => validAuthorize,
    })
    const authorizer = new ProviderAttemptAuthorizer({
      authorizeUrl: 'http://gateway/authorize',
      readPlatformJwt: () => 'test-jwt',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    await expect(
      authorizer.authorize({
        request: {
          schemaVersion: 'codex-completion-request.v2',
          pad: 'a'.repeat(LIMITS.maxRequestBodyBytes + 1024 * 1024),
        },
        invocationId: 'inv-1',
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        policyRevision: 1,
        policyHash: 'b'.repeat(64),
      })
    ).resolves.toMatchObject({ executionTicket: 'ticket-123456' })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('recognizes a non-JSON 413 as a request limit', async () => {
    const fetchFn = vi.fn(async () => new Response('<h1>Too large</h1>', { status: 413 }))
    const authorizer = new ProviderAttemptAuthorizer({
      authorizeUrl: 'http://gateway/authorize',
      readPlatformJwt: () => 'test-jwt',
      fetchFn,
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
    ).rejects.toMatchObject({ code: 'payload_too_large' })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

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

  // #731 — nginx on the authorize route answers an oversized body itself, with
  // an HTML 413 that never reaches control-api. Recorded live on the branch
  // profile before the gateway picked up `client_max_body_size`: every request
  // over 1 MiB came back labelled provider_unavailable, a retryable outage.
  function nginx(status: number, reason: string): Response {
    return new Response(
      `<html><head><title>${status} ${reason}</title></head><body><center><h1>${status} ${reason}</h1></center><hr><center>nginx</center></body></html>`,
      { status, headers: { 'content-type': 'text/html' } }
    )
  }

  async function authorizeFailure(response: Response) {
    const fetchFn = vi.fn().mockResolvedValue(response)
    const authorizer = new ProviderAttemptAuthorizer({
      authorizeUrl: resolveCodexAuthorizeUrl('http://gateway:8092'),
      readPlatformJwt: () => 'platform-jwt',
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const err = await authorizer
      .authorize({
        request: {},
        invocationId: 'inv-1',
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        policyRevision: 1,
        policyHash: 'b'.repeat(64),
      })
      .then(
        () => undefined,
        (e: unknown) => e
      )
    return { err, fetchFn }
  }

  it('T-R7-1a reads an HTML 413 from the gateway as payload_too_large', async () => {
    const { err, fetchFn } = await authorizeFailure(nginx(413, 'Request Entity Too Large'))
    // Liveness witness: the authorize hop really ran and got the 413.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(err).toBeInstanceOf(CodexAuthorizeError)
    expect(err).toMatchObject({
      code: 'payload_too_large',
      message: 'Codex request is too large; use fewer or smaller images, or reduce context',
    })
  })

  it('T-R7-1b keeps an HTML 502 from the gateway as provider_unavailable', async () => {
    const { err, fetchFn } = await authorizeFailure(nginx(502, 'Bad Gateway'))
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(err).toMatchObject({
      code: 'provider_unavailable',
      message: 'authorize failed with 502',
    })
  })

  it('T-R7-1c reads a 413 as payload_too_large whatever JSON code it carries', async () => {
    const { err, fetchFn } = await authorizeFailure(
      new Response(JSON.stringify({ error: 'invalid_request' }), {
        status: 413,
        headers: { 'content-type': 'application/json' },
      })
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(err).toMatchObject({ code: 'payload_too_large' })
  })

  it.each([
    ['codex-subscription', () => new CodexSubscriptionProvider('gpt-5.3-codex', {} as never)],
    ['grok-subscription', () => new GrokSubscriptionProvider('grok-4.6', {} as never)],
  ])(
    'T-R7-1d %s classifies a gateway 413 as a non-retryable ContextLengthExceeded',
    async (_provider, build) => {
      const { err, fetchFn } = await authorizeFailure(nginx(413, 'Request Entity Too Large'))
      expect(fetchFn).toHaveBeenCalledTimes(1)
      const classified = build().classifyError(err)
      expect(classified).toMatchObject({
        code: LlmErrorCode.ContextLengthExceeded,
        retryable: false,
        providerCode: 'payload_too_large',
        providerDispatched: false,
      })
      expect(classifyFailoverClass(classified.code, classified.retryable)).toBeNull()
    }
  )

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

  it('forwards the caller deadline to the authorize hop and to its post-401 retry', async () => {
    const controller = new AbortController()
    const refreshOnUnauthorized = vi.fn().mockResolvedValue(undefined)
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Unauthorized' }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => validAuthorize })
    const authorizer = new ProviderAttemptAuthorizer({
      authorizeUrl: resolveCodexAuthorizeUrl('http://gateway:8092'),
      readPlatformJwt: () => 'platform-jwt',
      refreshOnUnauthorized,
      fetchFn: fetchFn as unknown as typeof fetch,
    })

    await authorizer.authorize(
      {
        request: { schemaVersion: 'codex-completion-request.v1' },
        invocationId: 'inv-1',
        attemptGeneration: 1,
        providerAttemptIndex: 1,
        policyRevision: 1,
        policyHash: 'b'.repeat(64),
      },
      { signal: controller.signal }
    )
    // The retry after a refresh must not outlive the deadline that bounded the
    // first hop — a second, unbounded call would be a second clock.
    expect(fetchFn.mock.calls[0][1].signal).toBe(controller.signal)
    expect(fetchFn.mock.calls[1][1].signal).toBe(controller.signal)
  })

  it('fails loudly on an already-expired deadline without rotating credentials', async () => {
    const refreshOnUnauthorized = vi.fn()
    // Faithful to real fetch: an aborted signal rejects before any response.
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException('operation aborted', 'AbortError')
      throw new Error('fetch must not proceed with an aborted signal')
    })
    const authorizer = new ProviderAttemptAuthorizer({
      authorizeUrl: resolveCodexAuthorizeUrl('http://gateway:8092'),
      readPlatformJwt: () => 'platform-jwt',
      refreshOnUnauthorized,
      fetchFn: fetchFn as unknown as typeof fetch,
    })

    await expect(
      authorizer.authorize(
        {
          request: {},
          invocationId: 'inv-1',
          attemptGeneration: 1,
          providerAttemptIndex: 1,
          policyRevision: 1,
          policyHash: 'b'.repeat(64),
        },
        { signal: AbortSignal.abort() }
      )
    ).rejects.toThrow(/aborted/i)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(refreshOnUnauthorized).not.toHaveBeenCalled()
  })
})
