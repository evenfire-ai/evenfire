import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpMcpHostClient } from '../../../src/workflow/httpMcpHostClient'

describe('HttpMcpHostClient', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  function mockFetch(status: number, body: Record<string, unknown>) {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
  }

  it('sends POST /configure with Bearer token and JSON body', async () => {
    mockFetch(200, { configured: true })
    const client = new HttpMcpHostClient()

    await client.configure(
      'http://wf-test-mcp-host.sandbox-recipes.svc.cluster.local:8080',
      'jwt-token-123',
      { provider: 'openai', model: 'gpt-4', apiKey: 'sk-test' }
    )

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://wf-test-mcp-host.sandbox-recipes.svc.cluster.local:8080/api/v1/workflow/configure',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer jwt-token-123',
        },
        body: JSON.stringify({ provider: 'openai', model: 'gpt-4', apiKey: 'sk-test' }),
      })
    )
  })

  it('returns status and parsed JSON body on success', async () => {
    mockFetch(200, { configured: true, model: 'gpt-4' })
    const client = new HttpMcpHostClient()

    const result = await client.configure('http://mcp-host:8080', 'tok', { provider: 'openai' })
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ configured: true, model: 'gpt-4' })
  })

  it('returns error status from mcp_host (4xx/5xx)', async () => {
    mockFetch(500, { error: 'internal server error' })
    const client = new HttpMcpHostClient()

    const result = await client.configure('http://mcp-host:8080', 'tok', {})
    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: 'internal server error' })
  })

  it('handles non-JSON response body gracefully', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 502,
      json: async () => {
        throw new Error('not json')
      },
      text: async () => 'Bad Gateway',
    })
    const client = new HttpMcpHostClient()

    const result = await client.configure('http://mcp-host:8080', 'tok', {})
    expect(result.status).toBe(502)
    expect(result.body).toEqual({ raw: 'Bad Gateway' })
  })

  it('propagates network errors (fetch rejects)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new HttpMcpHostClient()

    await expect(client.configure('http://unreachable:8080', 'tok', {})).rejects.toThrow(
      'ECONNREFUSED'
    )
  })

  it('includes AbortSignal for timeout protection', async () => {
    mockFetch(200, { ok: true })
    const client = new HttpMcpHostClient()

    await client.configure('http://mcp-host:8080', 'tok', {})

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const options = callArgs[1] as RequestInit
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('never leaks apiKey in error messages', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection reset'))
    const client = new HttpMcpHostClient()

    try {
      await client.configure('http://mcp-host:8080', 'tok', { apiKey: 'sk-secret-key' })
    } catch (e: unknown) {
      const msg = (e as Error).message
      expect(msg).not.toContain('sk-secret-key')
    }
  })
})
