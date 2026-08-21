import { describe, expect, it, vi } from 'vitest'
import { McpManager } from '../../mcp/manager'
import { ServerStatusTracker, classifyConnectError } from '../../mcp/serverStatus'

type ProbeClient = {
  probeTools: ReturnType<typeof vi.fn>
}

function connectedManager(clients: Record<string, ProbeClient>): {
  manager: McpManager
  tracker: ServerStatusTracker
} {
  const tracker = new ServerStatusTracker(() => new Date('2026-07-23T10:00:00.000Z'))
  const manager = new McpManager(undefined, tracker)
  const internalClients = (manager as unknown as { clients: Map<string, ProbeClient> }).clients
  for (const [name, client] of Object.entries(clients)) {
    internalClients.set(name, client)
    tracker.markConnecting(name)
    tracker.markConnected(name, 1)
  }
  return { manager, tracker }
}

describe('McpManager status refresh', () => {
  it('aggregates raw-probe metadata and forwards the round signal to every probe', async () => {
    const first = {
      probeTools: vi.fn().mockResolvedValue({ ok: true, toolCount: 2, outputSchemaCount: 1 }),
    }
    const second = {
      probeTools: vi
        .fn()
        .mockResolvedValue({ ok: false, error: new Error('upstream unavailable') }),
    }
    const { manager, tracker } = connectedManager({ first, second })
    const controller = new AbortController()

    await expect(
      manager.refreshAllServerStatus({ timeoutMs: 1234, signal: controller.signal })
    ).resolves.toEqual({
      serverCount: 2,
      succeeded: 1,
      failed: 1,
      toolCount: 2,
      outputSchemaCount: 1,
      aborted: false,
    })

    const firstSignal = first.probeTools.mock.calls[0]?.[0].signal as AbortSignal
    const secondSignal = second.probeTools.mock.calls[0]?.[0].signal as AbortSignal
    expect(firstSignal).toBe(controller.signal)
    expect(secondSignal).toBe(controller.signal)
    expect(tracker.get('first')?.toolCount).toBe(2)
    expect(tracker.get('second')?.reason).toBe('unknown')
  })

  it('does not invoke probes or mutate status for an already aborted round', async () => {
    const client = { probeTools: vi.fn() }
    const { manager, tracker } = connectedManager({ one: client })
    const before = tracker.get('one')
    const controller = new AbortController()
    controller.abort('shutdown')

    await expect(
      manager.refreshAllServerStatus({ signal: controller.signal })
    ).resolves.toMatchObject({
      serverCount: 1,
      aborted: true,
    })
    expect(client.probeTools).not.toHaveBeenCalled()
    expect(tracker.get('one')).toEqual(before)
  })
})

describe('MCP status error classification', () => {
  it('classifies JSON-RPC timeout and Zod response-shape failures deterministically', () => {
    expect(
      classifyConnectError({ code: -32001, message: 'request exceeded deadline' })
    ).toMatchObject({
      reason: 'timeout',
    })
    expect(
      classifyConnectError({
        name: '$ZodError',
        issues: [{ path: ['tools', 0], message: 'invalid' }],
        message: 'response parse error',
      })
    ).toEqual({ reason: 'handshake', message: 'invalid MCP response schema' })
  })
})
