import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpHostClient } from '../../src/mcp-host-client/client'
import { createStaticRuntimeTokenProvider } from '../../src/runtime-token-provider/provider'
import { AUTH_RETRY_DELAY_MS } from '../../src/status-reporter/authRetry'

const tokenProvider = (token = 'tok') => createStaticRuntimeTokenProvider({ mcpHostToken: token })

describe('McpHostClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  describe('executeAgentStep()', () => {
    it('POSTs to /api/v1/workflow/execute', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          stepId: 's1',
          output: 'result',
          durationMs: 1500,
          status: 'completed',
        }),
      })
      vi.stubGlobal('fetch', fetchMock)
      const client = new McpHostClient('http://mcp:8080', tokenProvider())
      const result = await client.executeAgentStep({
        stepId: 's1',
        mcpServers: [{ name: 'db', url: 'http://db:3000' }],
        allowedTools: { include: ['query'] },
        instruction: 'Do something',
        approvalBindingProof: '00000000-0000-4000-8000-000000000123',
      })
      expect(result.status).toBe('completed')
      expect(result.output).toBe('result')
      expect(fetchMock).toHaveBeenCalledWith(
        'http://mcp:8080/api/v1/workflow/execute',
        expect.objectContaining({ method: 'POST' })
      )
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        approvalBindingProof: '00000000-0000-4000-8000-000000000123',
      })
    })

    it('returns failed result when mcp-host returns non-ok', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        })
      )
      const client = new McpHostClient('http://mcp:8080', tokenProvider())
      const result = await client.executeAgentStep({
        stepId: 's1',
        instruction: 'test',
      })
      expect(result.status).toBe('failed')
      expect(result.error).toContain('500')
    })

    it("returns failed result with 'timeout' on AbortError", async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      )
      const client = new McpHostClient('http://mcp:8080', tokenProvider())
      const result = await client.executeAgentStep({
        stepId: 's1',
        instruction: 'test',
        timeoutSeconds: 1,
      })
      expect(result.status).toBe('failed')
      expect(result.error).toBe('timeout')
    })

    it('uses MCP_HOST_STEP_TIMEOUT_SECONDS when the request omits timeoutSeconds', async () => {
      vi.useFakeTimers()
      vi.stubEnv('MCP_HOST_STEP_TIMEOUT_SECONDS', '1')
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init: RequestInit) => {
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            })
          })
        })
      )

      const client = new McpHostClient('http://mcp:8080', tokenProvider())
      const pending = client.executeAgentStep({
        stepId: 's1',
        instruction: 'test',
      })

      await vi.advanceTimersByTimeAsync(6000)
      const result = await pending
      expect(result.status).toBe('failed')
      expect(result.error).toBe('timeout')
    })

    it('fails closed when MCP_HOST_STEP_TIMEOUT_SECONDS is invalid', async () => {
      vi.stubEnv('MCP_HOST_STEP_TIMEOUT_SECONDS', '0')
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const client = new McpHostClient('http://mcp:8080', tokenProvider())
      const result = await client.executeAgentStep({
        stepId: 's1',
        instruction: 'test',
      })

      expect(result.status).toBe('failed')
      expect(result.error).toBe('MCP_HOST_STEP_TIMEOUT_SECONDS must be a positive integer')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("returns 'unknown' in error when resp.text() rejects", async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 502,
          text: async () => {
            throw new Error('stream consumed')
          },
        })
      )
      const client = new McpHostClient('http://mcp:8080', tokenProvider())
      const result = await client.executeAgentStep({
        stepId: 's1',
        instruction: 'test',
      })
      expect(result.status).toBe('failed')
      expect(result.error).toContain('unknown')
    })

    it('returns failed result on network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
      const client = new McpHostClient('http://mcp:8080', tokenProvider())
      const result = await client.executeAgentStep({
        stepId: 's1',
        instruction: 'test',
      })
      expect(result.status).toBe('failed')
      expect(result.error).toBe('ECONNREFUSED')
    })

    it('sends Authorization header', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          stepId: 's1',
          output: null,
          durationMs: 0,
          status: 'completed',
        }),
      })
      vi.stubGlobal('fetch', fetchMock)
      const client = new McpHostClient('http://mcp:8080', tokenProvider('my-token'))
      await client.executeAgentStep({
        stepId: 's1',
        instruction: 'test',
      })
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer my-token')
    })

    it('rereads mcp-host token provider after a 401 response', async () => {
      vi.useFakeTimers()
      const provider = {
        getMcpHostToken: vi.fn().mockResolvedValueOnce('jwt-a').mockResolvedValueOnce('jwt-b'),
      }
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            stepId: 's1',
            output: 'ok',
            durationMs: 1,
            status: 'completed',
          }),
        })
      vi.stubGlobal('fetch', fetchMock)
      const client = new McpHostClient('http://mcp:8080', provider)

      const pending = client.executeAgentStep({ stepId: 's1', instruction: 'test' })
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS)
      const result = await pending

      expect(result.status).toBe('completed')
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt-a')
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer jwt-b')
      expect(fetchMock.mock.calls[0][1].signal).toBeDefined()
      expect(fetchMock.mock.calls[1][1].signal).toBeDefined()
      expect(fetchMock.mock.calls[1][1].signal).not.toBe(fetchMock.mock.calls[0][1].signal)
    })

    it('keeps 401 auth retry within the original step timeout budget', async () => {
      vi.useFakeTimers()
      const provider = {
        getMcpHostToken: vi.fn().mockResolvedValueOnce('jwt-a').mockResolvedValueOnce('jwt-b'),
      }
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' })
        .mockImplementationOnce((_url: string, init: RequestInit) => {
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            })
          })
        })
      vi.stubGlobal('fetch', fetchMock)
      const client = new McpHostClient('http://mcp:8080', provider)

      const pending = client.executeAgentStep({
        stepId: 's1',
        instruction: 'test',
        timeoutSeconds: 1,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAY_MS)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await pending

      expect(result.status).toBe('failed')
      expect(result.error).toBe('timeout')
    })

    it('sends request body with all fields', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          stepId: 's1',
          output: null,
          durationMs: 0,
          status: 'completed',
        }),
      })
      vi.stubGlobal('fetch', fetchMock)
      const client = new McpHostClient('http://mcp:8080', tokenProvider())
      await client.executeAgentStep({
        stepId: 's1',
        mcpServers: [
          { name: 'db', url: 'http://db:3000' },
          { name: 'cache', url: 'http://cache:3000' },
        ],
        allowedTools: { include: ['query', 'get'] },
        instruction: 'Do work',
        timeoutSeconds: 60,
      })
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.mcpServers).toEqual([
        { name: 'db', url: 'http://db:3000' },
        { name: 'cache', url: 'http://cache:3000' },
      ])
      expect(body.allowedTools).toEqual({ include: ['query', 'get'] })
      expect(body.timeoutSeconds).toBe(60)
    })

    it('parses text/event-stream result responses', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: { get: () => 'text/event-stream' },
          text: async () =>
            ': keepalive\n\nevent: result\ndata: {"stepId":"s1","status":"completed","output":"streamed","durationMs":12}\n\n',
        })
      )
      const client = new McpHostClient('http://mcp:8080', tokenProvider())
      const result = await client.executeAgentStep({ stepId: 's1', instruction: 'test' })
      expect(result.status).toBe('completed')
      expect(result.output).toBe('streamed')
    })

    it('parses text/event-stream error responses', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: { get: () => 'text/event-stream' },
          text: async () => 'event: error\ndata: {"message":"blocked"}\n\n',
        })
      )
      const client = new McpHostClient('http://mcp:8080', tokenProvider())
      const result = await client.executeAgentStep({ stepId: 's1', instruction: 'test' })
      expect(result.status).toBe('failed')
      expect(result.error).toBe('blocked')
    })

    it('times out when an SSE response opens headers but never completes the body', async () => {
      vi.useFakeTimers()
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init: RequestInit) =>
          Promise.resolve({
            ok: true,
            headers: { get: () => 'text/event-stream' },
            text: () =>
              new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => {
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
                })
              }),
          })
        )
      )
      const client = new McpHostClient('http://mcp:8080', tokenProvider())

      const pending = client.executeAgentStep({
        stepId: 's1',
        instruction: 'test',
        timeoutSeconds: 1,
      })
      await vi.advanceTimersByTimeAsync(6000)
      const result = await pending

      expect(result.status).toBe('failed')
      expect(result.error).toBe('timeout')
    })

    it('fails closed when MCP_HOST_STEP_TIMEOUT_SECONDS exceeds the workflow ceiling', async () => {
      vi.stubEnv('MCP_HOST_STEP_TIMEOUT_SECONDS', '5401')
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const client = new McpHostClient('http://mcp:8080', tokenProvider())

      const result = await client.executeAgentStep({
        stepId: 's1',
        instruction: 'test',
      })

      expect(result.status).toBe('failed')
      expect(result.error).toBe('MCP_HOST_STEP_TIMEOUT_SECONDS must be <= 5400')
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('healthCheck()', () => {
    it('returns healthy when response ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
      const client = new McpHostClient('http://mcp:8080', tokenProvider())
      const result = await client.healthCheck()
      expect(result.status).toBe('healthy')
    })

    it('returns unhealthy when response not ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }))
      const client = new McpHostClient('http://mcp:8080', tokenProvider())
      const result = await client.healthCheck()
      expect(result.status).toBe('unhealthy')
    })

    it('rereads mcp-host token provider after a 401 health response', async () => {
      const provider = {
        getMcpHostToken: vi.fn().mockResolvedValueOnce('jwt-a').mockResolvedValueOnce('jwt-b'),
      }
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: true, status: 200 })
      vi.stubGlobal('fetch', fetchMock)
      const client = new McpHostClient('http://mcp:8080', provider)

      const result = await client.healthCheck()

      expect(result.status).toBe('healthy')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt-a')
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer jwt-b')
    })

    it('returns unhealthy on network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
      const client = new McpHostClient('http://mcp:8080', tokenProvider())
      const result = await client.healthCheck()
      expect(result.status).toBe('unhealthy')
    })
  })
})
