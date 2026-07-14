import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'
import type { RPCServer } from '../server'
import type { HostActivityEvent } from '../server/types'

async function startServer(
  configure: (server: RPCServer) => void
): Promise<{ server: RPCServer; baseUrl: string }> {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  vi.resetModules()
  // config reads auth settings at module load, so import after the test env is set.
  const { RPCServer } = await import('../server')
  const server = new RPCServer(0)
  configure(server)
  await server.start()
  const address = (server as any).server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

const rpcEdgeHeaders = {
  'x-clerum-edge-caller': 'rpc-proxy',
  'x-clerum-edge-host-ref': 'chatllm',
  'x-clerum-edge-user-id': 'user-1',
}

describe('RPCServer activity routes', () => {
  it('serves activity snapshot with limit/sinceEventId', async () => {
    const events: HostActivityEvent[] = [
      {
        version: '1.0',
        eventId: 'evt_0000000001',
        hostRef: 'chatllm',
        ts: new Date().toISOString(),
        type: 'task.queued',
        title: 'queued',
        severity: 'info',
        meta: {},
        redactions: [],
      },
      {
        version: '1.0',
        eventId: 'evt_0000000002',
        hostRef: 'chatllm',
        ts: new Date().toISOString(),
        type: 'task.started',
        title: 'started',
        severity: 'info',
        meta: {},
        redactions: [],
      },
    ]

    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onActivitySnapshot(async (limit, sinceEventId) => ({
        hostRef: 'chatllm',
        version: '1.0',
        items: events.filter(event => !sinceEventId || event.eventId > sinceEventId).slice(-limit),
        nextCursor: 'evt_0000000002',
      }))
    })

    try {
      const response = await fetch(
        `${baseUrl}/v1/runtime/activity?limit=1&sinceEventId=evt_0000000001`,
        { headers: rpcEdgeHeaders }
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as { items: HostActivityEvent[] }
      expect(body.items).toHaveLength(1)
      expect(body.items[0]?.eventId).toBe('evt_0000000002')
    } finally {
      await server.stop()
    }
  })

  it('streams open/activity/closed SSE events', async () => {
    let subscriber: ((event: HostActivityEvent) => void) | null = null
    const { server, baseUrl } = await startServer(rpcServer => {
      rpcServer.onActivityStream(onEvent => {
        subscriber = onEvent
        return { hostRef: 'chatllm', unsubscribe: () => undefined }
      })
    })

    try {
      const response = await fetch(`${baseUrl}/v1/runtime/activity/stream`, {
        headers: rpcEdgeHeaders,
      })
      expect(response.status).toBe(200)
      const streamCallback = subscriber as ((event: HostActivityEvent) => void) | null
      if (streamCallback) {
        streamCallback({
          version: '1.0',
          eventId: 'evt_0000000003',
          hostRef: 'chatllm',
          ts: new Date().toISOString(),
          type: 'task.completed',
          title: 'done',
          severity: 'info',
          meta: {},
          redactions: [],
        })
      }
      const reader = response.body?.getReader()
      expect(reader).toBeTruthy()
      const first = await reader!.read()
      const chunk = new TextDecoder().decode(first.value || new Uint8Array())
      expect(chunk.includes('event: open') || chunk.includes('event: activity')).toBe(true)
      await reader?.cancel()
    } finally {
      await server.stop()
    }
  })
})
