import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowBrokerClient } from '../workflowBrokerClient'

function tokenProvider() {
  return {
    getWorkflowControlToken: vi.fn().mockResolvedValue('workflow-control-token'),
  }
}

function env(key: string): string | undefined {
  return key === 'MCP_HOST_GATEWAY_URL' ? 'http://gateway:8092' : undefined
}

describe('WorkflowBrokerClient download', () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fails closed when streamed bytes exceed the configured cap before buffering completes', async () => {
    const body = Buffer.from('artifact-body-too-large')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => {
          const key = name.toLowerCase()
          if (key === 'content-length') return '4'
          if (key === 'content-type') return 'application/pdf'
          if (key === 'content-disposition') return 'attachment; filename="risk-review.pdf"'
          return null
        },
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(body.subarray(0, 2))
          controller.enqueue(body.subarray(2))
          controller.close()
        },
      }),
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    } as Response)

    const client = new WorkflowBrokerClient(env, tokenProvider())

    await expect(client.download('/api/v1/workflows/result.pdf', { maxBytes: 4 })).rejects.toThrow(
      /artifact exceeds byte cap/
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
