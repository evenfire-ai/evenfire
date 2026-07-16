/**
 * Stage 3 (stateless-agents) — route-level DRAINING fence contract.
 *
 * While the lifecycle gate reports fenced, POST /v1/runtime/messages must
 * reject with 503 and EXACTLY `{ code: 'host_draining' }` (rpc-proxy keys on
 * that code; no activity details leak). The fence is reversible: when the
 * gate lifts, intake resumes immediately with no restart.
 *
 * Same real-listening-server + fetch pattern as
 * `server.interface.contract.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'

type LifecycleGateStub = {
  isIntakeFenced: () => boolean
  noteIntakeActivity: ReturnType<typeof vi.fn<() => void>>
  noteFencedIntake: ReturnType<typeof vi.fn<() => void>>
}

type StartResult = {
  server: {
    stop(): Promise<void>
  }
  baseUrl: string
  messageHandler: ReturnType<typeof vi.fn>
}

async function startServer(gate?: LifecycleGateStub): Promise<StartResult> {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  vi.resetModules()
  const { RPCServer } = await import('../server')
  const server = new RPCServer(0)
  const messageHandler = vi.fn().mockResolvedValue({ success: true, status: 'completed' })
  server.onMessage(messageHandler)
  if (gate) {
    server.setLifecycleGate(gate)
  }
  await server.start()
  const address = (server as unknown as { server: { address: () => AddressInfo } }).server.address()
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, messageHandler }
}

function rpcEdgeHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': 'user-1',
  }
}

function runtimeMessageBody(): string {
  return JSON.stringify({
    sender: 'user-1',
    channelType: 'rpc',
    channelId: 'agent-x',
    threadId: 'chat-1',
    content: 'hello',
    timestamp: new Date().toISOString(),
    messageId: 'm1',
    hostRef: 'chatllm',
  })
}

describe('POST /v1/runtime/messages — reversible DRAINING fence', () => {
  it('rejects with 503 { code: "host_draining" } while fenced; in-flight handling is untouched', async () => {
    let fenced = true
    const gate: LifecycleGateStub = {
      isIntakeFenced: () => fenced,
      noteIntakeActivity: vi.fn(),
      noteFencedIntake: vi.fn(),
    }
    const { server, baseUrl, messageHandler } = await startServer(gate)
    try {
      const res = await fetch(`${baseUrl}/v1/runtime/messages`, {
        method: 'POST',
        headers: rpcEdgeHeaders(),
        body: runtimeMessageBody(),
      })
      expect(res.status).toBe(503)
      // Exact body contract — rpc-proxy keys on this code; nothing else leaks.
      expect(await res.json()).toEqual({ code: 'host_draining' })
      expect(messageHandler).not.toHaveBeenCalled()
      expect(gate.noteIntakeActivity).not.toHaveBeenCalled()
      // H2 self-heal: a fenced intake records the pending-work signal so the
      // next heartbeat can surface pendingIntake=true.
      expect(gate.noteFencedIntake).toHaveBeenCalledTimes(1)

      // Reversible: drain-cancel lifts the fence, intake resumes immediately.
      fenced = false
      const accepted = await fetch(`${baseUrl}/v1/runtime/messages`, {
        method: 'POST',
        headers: rpcEdgeHeaders(),
        body: runtimeMessageBody(),
      })
      expect(accepted.status).toBe(200)
      expect(messageHandler).toHaveBeenCalledTimes(1)
      expect(gate.noteIntakeActivity).toHaveBeenCalledTimes(1)
      // Accepted intake does NOT record a fenced-intake signal.
      expect(gate.noteFencedIntake).toHaveBeenCalledTimes(1)

      // Fence re-engages just as fast (drain → cancel → drain).
      fenced = true
      const refenced = await fetch(`${baseUrl}/v1/runtime/messages`, {
        method: 'POST',
        headers: rpcEdgeHeaders(),
        body: runtimeMessageBody(),
      })
      expect(refenced.status).toBe(503)
      expect(await refenced.json()).toEqual({ code: 'host_draining' })
      expect(messageHandler).toHaveBeenCalledTimes(1)
    } finally {
      await server.stop()
    }
  })

  it('leaves intake untouched when no lifecycle gate is wired (stateless flag off)', async () => {
    const { server, baseUrl, messageHandler } = await startServer()
    try {
      const res = await fetch(`${baseUrl}/v1/runtime/messages`, {
        method: 'POST',
        headers: rpcEdgeHeaders(),
        body: runtimeMessageBody(),
      })
      expect(res.status).toBe(200)
      expect(messageHandler).toHaveBeenCalledTimes(1)
    } finally {
      await server.stop()
    }
  })

  it('does not fence other runtime routes — only message intake', async () => {
    const gate: LifecycleGateStub = {
      isIntakeFenced: () => true,
      noteIntakeActivity: vi.fn(),
      noteFencedIntake: vi.fn(),
    }
    const { server, baseUrl } = await startServer(gate)
    try {
      // Liveness must stay green while draining: kubelet must not restart a
      // pod that is deliberately finishing its last turn.
      const live = await fetch(`${baseUrl}/v1/runtime/live`)
      expect(live.status).toBe(200)
    } finally {
      await server.stop()
    }
  })
})
