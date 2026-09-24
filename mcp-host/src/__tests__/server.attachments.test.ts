import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'
import { createRequire } from 'node:module'
import type { Attachment } from '../core/types'
import type { RPCServer } from '../server'

const { declaredHeaderPngOfSize } = createRequire(__filename)(
  '../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs'
) as {
  declaredHeaderPngOfSize: (targetBytes: number) => Buffer
}

const sampleAttachment: Attachment = {
  id: 'att_1',
  kind: 'image',
  mimeType: 'image/jpeg',
  encoding: 'base64',
  dataBase64: 'ZmFrZS1qcGVn',
  filename: 'capture.jpg',
}

async function startServer(configure: (server: RPCServer) => void): Promise<{
  server: RPCServer
  baseUrl: string
}> {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  vi.resetModules()
  // config reads auth settings at module load, so import after the test env is set.
  const { RPCServer } = await import('../server')
  const server = new RPCServer(0)
  configure(server)
  await server.start()
  const address = (server as any).server.address() as AddressInfo
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

function channelReaderEdgeHeaders(
  source: { channelType: 'telegram'; channelId: string; sender: string },
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    ...extra,
    'x-clerum-edge-caller': 'channel-reader',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-channel-type': source.channelType,
    'x-clerum-edge-channel-id': source.channelId,
    'x-clerum-edge-sender': source.sender,
  }
}

describe('RPCServer attachment responses', () => {
  it('returns attachments from POST /v1/runtime/messages', async () => {
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onMessage(async () => ({
        success: true,
        status: 'completed',
        response: 'rendered',
        attachments: [sampleAttachment],
      }))
    })

    try {
      const response = await fetch(`${baseUrl}/v1/runtime/messages`, {
        method: 'POST',
        headers: channelReaderEdgeHeaders(
          { channelType: 'telegram', channelId: 'chan-1', sender: 'user-1' },
          { 'Content-Type': 'application/json' }
        ),
        body: JSON.stringify({
          content: 'hello',
          channelType: 'telegram',
          channelId: 'chan-1',
          sender: 'user-1',
          timestamp: new Date().toISOString(),
          messageId: 'msg-1',
          hostRef: 'chatllm',
        }),
      })
      const body = (await response.json()) as { attachments?: Attachment[] }
      expect(response.status).toBe(200)
      expect(body.attachments).toEqual([sampleAttachment])
    } finally {
      await server.stop()
    }
  })

  it('returns attachments from GET /v1/runtime/tasks/:id/result', async () => {
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onTaskResult(async () => ({
        success: true,
        status: 'completed',
        response: 'final response',
        attachments: [sampleAttachment],
      }))
    })

    try {
      const response = await fetch(`${baseUrl}/v1/runtime/tasks/task-123/result`, {
        headers: channelReaderEdgeHeaders({
          channelType: 'telegram',
          channelId: 'chan-1',
          sender: 'user-1',
        }),
      })
      const body = (await response.json()) as { attachments?: Attachment[] }
      expect(response.status).toBe(200)
      expect(body.attachments).toEqual([sampleAttachment])
    } finally {
      await server.stop()
    }
  })

  it('returns attachments from GET /v1/runtime/cron/results', async () => {
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onCronResults(() => [
        {
          id: 'cron-1',
          origin: {
            channelType: 'telegram',
            channelId: 'chan-1',
            sender: 'user-1',
          },
          response: 'cron done',
          attachments: [sampleAttachment],
          cronJobId: 'job-1',
          cronJobName: 'nightly',
          timestamp: new Date('2026-03-05T00:00:00.000Z'),
          status: 'completed',
        },
      ])
    })

    try {
      const response = await fetch(`${baseUrl}/v1/runtime/cron/results`, {
        headers: channelReaderEdgeHeaders({
          channelType: 'telegram',
          channelId: 'chan-1',
          sender: 'user-1',
        }),
      })
      const body = (await response.json()) as { results: Array<{ attachments?: Attachment[] }> }
      expect(response.status).toBe(200)
      expect(body.results[0].attachments).toEqual([sampleAttachment])
    } finally {
      await server.stop()
    }
  })
})

describe('RPCServer message body limit', () => {
  const IMAGE_BUDGET_BYTES = 8 * 1024 * 1024
  const BODY_LIMIT_BYTES = 10 * 1024 * 1024

  function creditedPngMessage(sizeBytes: number): string {
    return JSON.stringify({
      content: 'describe these images',
      channelType: 'telegram',
      channelId: 'chan-1',
      sender: 'user-1',
      timestamp: new Date().toISOString(),
      messageId: 'msg-large',
      hostRef: 'chatllm',
      attachments: [
        {
          ...sampleAttachment,
          mimeType: 'image/png',
          dataBase64: declaredHeaderPngOfSize(sizeBytes).toString('base64'),
        },
      ],
    })
  }

  function messageBody(dataBase64Length: number): string {
    return JSON.stringify({
      content: 'describe these images',
      channelType: 'telegram',
      channelId: 'chan-1',
      sender: 'user-1',
      timestamp: new Date().toISOString(),
      messageId: 'msg-large',
      hostRef: 'chatllm',
      attachments: [{ ...sampleAttachment, dataBase64: 'A'.repeat(dataBase64Length) }],
    })
  }

  async function postMessage(baseUrl: string, body: string): Promise<Response> {
    return fetch(`${baseUrl}/v1/runtime/messages`, {
      method: 'POST',
      headers: channelReaderEdgeHeaders(
        { channelType: 'telegram', channelId: 'chan-1', sender: 'user-1' },
        { 'Content-Type': 'application/json' }
      ),
      body,
    })
  }

  it('accepts a message carrying an 8 MiB credited PNG', async () => {
    const received: number[] = []
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onMessage(async message => {
        received.push(message.attachments?.[0]?.dataBase64.length ?? -1)
        return { success: true, status: 'completed', response: 'ok' }
      })
    })

    try {
      const response = await postMessage(baseUrl, creditedPngMessage(IMAGE_BUDGET_BYTES))
      expect(response.status).toBe(200)
      expect(received[0]).toBeGreaterThan(IMAGE_BUDGET_BYTES)
    } finally {
      await server.stop()
    }
  })

  it('rejects an uncredited 10 MB body with 413 before the message handler runs', async () => {
    const received: number[] = []
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onMessage(async message => {
        received.push(message.attachments?.[0]?.dataBase64.length ?? -1)
        return { success: true, status: 'completed', response: 'ok' }
      })
    })

    try {
      const body = messageBody(BODY_LIMIT_BYTES)
      expect(body.length).toBeGreaterThan(BODY_LIMIT_BYTES)
      const response = await postMessage(baseUrl, body)
      // Witness: the server read and judged the body (413 is its answer).
      expect(response.status).toBe(413)
      expect(received).toEqual([])
    } finally {
      await server.stop()
    }
  })
})
