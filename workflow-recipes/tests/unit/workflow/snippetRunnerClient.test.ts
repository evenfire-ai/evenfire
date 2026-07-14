import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStaticRuntimeTokenProvider } from '@clerum/workflow-runtime-core'
import { SnippetRunnerClient } from '../../../src/workflow/snippetRunnerClient'

describe('SnippetRunnerClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('rereads token provider and uses a fresh abort signal after a 401 response', async () => {
    const provider = {
      getSnippetRunnerToken: vi.fn().mockResolvedValueOnce('jwt-a').mockResolvedValueOnce('jwt-b'),
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => '{"error":"unauthorized"}',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{"stepId":"s1","status":"completed","output":"ok"}',
      })
    vi.stubGlobal('fetch', fetchMock)

    const client = new SnippetRunnerClient('http://snippet-runner:8095', provider)
    const result = await client.execute({
      workflowName: 'wf',
      stepId: 's1',
      previousOutputs: {},
    })

    expect(result).toEqual({ stepId: 's1', status: 'completed', output: 'ok' })
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer jwt-a')
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer jwt-b')
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined()
    expect(fetchMock.mock.calls[1][1].signal).toBeDefined()
    expect(fetchMock.mock.calls[1][1].signal).not.toBe(fetchMock.mock.calls[0][1].signal)
  })

  it('returns a timeout failure when the snippet runner request aborts', async () => {
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
    vi.useFakeTimers()

    const client = new SnippetRunnerClient(
      'http://snippet-runner:8095',
      createStaticRuntimeTokenProvider({ snippetRunnerToken: 'jwt-a' }),
      100
    )
    const pending = client.execute({
      workflowName: 'wf',
      stepId: 's1',
      previousOutputs: {},
    })

    await vi.advanceTimersByTimeAsync(100)
    const result = await pending

    expect(result).toEqual({
      stepId: 's1',
      status: 'failed',
      error: 'snippet runner request timed out',
    })
  })

  it('uses declared snippet timeoutSeconds instead of the static fallback', async () => {
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
    vi.useFakeTimers()

    const client = new SnippetRunnerClient(
      'http://snippet-runner:8095',
      createStaticRuntimeTokenProvider({ snippetRunnerToken: 'jwt-a' }),
      100_000
    )
    const pending = client.execute({
      workflowName: 'wf',
      stepId: 's1',
      previousOutputs: {},
      timeoutSeconds: 1,
    })

    await vi.advanceTimersByTimeAsync(6000)
    const result = await pending

    expect(result.status).toBe('failed')
    expect(result.error).toBe('snippet runner request timed out')
  })
})
