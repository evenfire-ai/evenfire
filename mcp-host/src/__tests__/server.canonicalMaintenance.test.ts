import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'

let serverModule: Promise<typeof import('../server')> | undefined
async function serverFixture() {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  if (!serverModule) {
    vi.resetModules()
    serverModule = import('../server')
  }
  const { RPCServer } = await serverModule
  const server = new RPCServer(0)
  let fenced = false
  const messages = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
  const approvals = vi.fn().mockResolvedValue({ success: true })
  const compact = vi.fn().mockResolvedValue({ kind: 'ok', before: 10, after: 5 })
  server.onMessage(messages)
  server.onApproval(approvals)
  server.onCompaction(compact)
  server.setConversationStoreMaintenanceGate(() => fenced)
  await server.start()
  const address = (server as unknown as { server: { address(): AddressInfo } }).server.address()
  const url = `http://127.0.0.1:${address.port}`
  const headers = {
    'Content-Type': 'application/json',
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': 'owner',
  }
  return {
    server,
    url,
    headers,
    messages,
    approvals,
    compact,
    fence: () => {
      fenced = true
    },
  }
}

describe('runtime durable conversation-store maintenance routes', () => {
  it('blocks all protected business routes after the existing edge guard, while liveness stays available', async () => {
    const f = await serverFixture()
    f.fence()
    try {
      for (const route of [
        '/v1/runtime/messages',
        '/v1/runtime/approvals/approve',
        '/v1/runtime/approvals/deny',
        '/v1/runtime/compact',
      ]) {
        const response = await fetch(f.url + route, {
          method: 'POST',
          headers: f.headers,
          body: '{}',
        })
        expect(response.status, route).toBe(503)
        expect(await response.json()).toEqual({ code: 'conversation_store_maintenance' })
      }
      expect(f.messages).not.toHaveBeenCalled()
      expect(f.approvals).not.toHaveBeenCalled()
      expect(f.compact).not.toHaveBeenCalled()
      expect((await fetch(f.url + '/v1/runtime/live')).status).toBe(200)
      const health = await fetch(f.url + '/v1/runtime/health')
      expect(health.status).toBe(503)
      expect(await health.json()).toEqual({ status: 'maintenance' })
      const unauthenticated = await fetch(f.url + '/v1/runtime/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      expect(unauthenticated.status).toBe(401)
    } finally {
      await f.server.stop()
    }
  })

  it('rejects channel ingress without signalling a reversible drain cancellation', async () => {
    const f = await serverFixture()
    const noteFencedIntake = vi.fn()
    f.server.setLifecycleGate({
      isIntakeFenced: () => false,
      noteIntakeActivity: vi.fn(),
      noteFencedIntake,
    })
    f.fence()
    try {
      const response = await fetch(f.url + '/v1/runtime/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-clerum-edge-caller': 'channel-reader',
          'x-clerum-edge-host-ref': 'chatllm',
          'x-clerum-edge-channel-type': 'telegram',
          'x-clerum-edge-channel-id': 'channel',
          'x-clerum-edge-sender': 'owner',
        },
        body: '{}',
      })
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ code: 'conversation_store_maintenance' })
      expect(noteFencedIntake).not.toHaveBeenCalled()
      expect(f.messages).not.toHaveBeenCalled()
    } finally {
      await f.server.stop()
    }
  })

  it('waits for an already admitted compaction even after its client disconnects', async () => {
    const f = await serverFixture()
    let complete!: (value: unknown) => void
    let entered!: () => void
    const entry = new Promise<void>(resolve => {
      entered = resolve
    })
    const work = new Promise<unknown>(resolve => {
      complete = resolve
    })
    f.server.onCompaction(async () => {
      entered()
      return work as Promise<{ kind: 'ok'; before: number; after: number; focus: string | null }>
    })
    const abort = new AbortController()
    const request = fetch(f.url + '/v1/runtime/compact', {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ sessionKey: 'owner:rpc:chatllm:chat-1', userId: 'owner' }),
      signal: abort.signal,
    }).catch(() => undefined)
    try {
      await Promise.race([
        entry,
        request.then(response => {
          if (response)
            throw new Error(`compaction did not reach the backend (HTTP ${response.status})`)
        }),
      ])
      f.fence()
      abort.abort()
      let drained = false
      const closing = f.server.drainConversationStoreBusiness(1000).then(() => {
        drained = true
      })
      await new Promise(resolve => setImmediate(resolve))
      expect(drained).toBe(false)
      complete({ kind: 'ok', before: 10, after: 5, focus: null })
      await closing
      await request
      expect(drained).toBe(true)
    } finally {
      complete({ kind: 'ok', before: 10, after: 5, focus: null })
      await f.server.stop()
    }
  })
})
