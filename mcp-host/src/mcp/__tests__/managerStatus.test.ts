/**
 * McpManager ↔ ServerStatusTracker integration.
 *
 * Verifies that the manager emits the right tracker events on the full
 * lifecycle (disabled, not-ready, connecting, connected, failed, refresh).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerInfo } from '../../types'
import { McpManager } from '../manager'
import { MCP_INIT_AUTH_FAILED_MESSAGE, MCP_NOT_READY_MESSAGE } from '../serverStatus'

function serverInfo(overrides: Partial<McpServerInfo> = {}): McpServerInfo {
  return {
    name: 'svc',
    contextRef: 'ctx',
    transport: { type: 'streamableHttp', url: 'http://svc/mcp' },
    enabled: true,
    status: { deployed: true, ready: true },
    ...overrides,
  }
}

describe('McpManager status tracking — disabled / not-ready paths', () => {
  it('markDisabled when enabled=false', async () => {
    const m = new McpManager()
    await m.addServer(serverInfo({ enabled: false }))
    const s = m.status.get('svc')!
    expect(s.state).toBe('disabled')
    expect(s.expected).toBe(false)
  })

  it('markNotReady when status.ready=false', async () => {
    const m = new McpManager()
    await m.addServer(
      serverInfo({ status: { deployed: true, ready: false, message: 'pod unscheduled' } })
    )
    const s = m.status.get('svc')!
    expect(s.state).toBe('failed')
    expect(s.reason).toBe('not_ready')
    expect(s.message).toBe('pod unscheduled')
  })

  it('markNotReady falls back to default message', async () => {
    const m = new McpManager()
    await m.addServer(serverInfo({ status: { deployed: true, ready: false } }))
    const s = m.status.get('svc')!
    expect(s.message).toBe(MCP_NOT_READY_MESSAGE)
  })

  it('does not connect when readiness is explicitly non-authoritative', async () => {
    const { McpClient } = await import('../client')
    const connect = vi.spyOn(McpClient.prototype, 'connect')
    const m = new McpManager()

    await m.addServer(
      serverInfo({
        status: {
          deployed: true,
          ready: true,
          authoritative: false,
          message: 'Deployment status unknown',
        },
      })
    )

    expect(connect).not.toHaveBeenCalled()
    expect(m.status.get('svc')).toMatchObject({
      state: 'failed',
      reason: 'not_ready',
      message: 'Deployment status unknown',
    })
  })

  it.each([
    ['disabled', serverInfo({ enabled: false })],
    ['not-ready', serverInfo({ status: { deployed: true, ready: false } })],
  ])(
    'removeServer cleans %s inventory and status even without a client',
    async (_label, server) => {
      const m = new McpManager()
      await m.addServer(server)
      expect(m.status.get(server.name)).toBeDefined()
      expect((m as any).serverInfos.has(server.name)).toBe(true)
      expect(m.getConnectedServers()).toEqual([])

      await m.removeServer(server.name)

      expect(m.status.get(server.name)).toBeUndefined()
      expect((m as any).serverInfos.has(server.name)).toBe(false)
    }
  )
})

describe('McpManager status tracking — connect success/failure', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('markConnected with toolCount after successful connect', async () => {
    // Patch the imported client constructor via the manager's client.ts dependency.
    const { McpClient } = await import('../client')
    const spy = vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (
      this: any
    ) {
      this.connected = true
      this.tools = [
        { name: 't1', inputSchema: {}, serverName: 'svc' },
        { name: 't2', inputSchema: {}, serverName: 'svc' },
      ]
    })

    const m = new McpManager()
    await m.addServer(serverInfo())
    expect(spy).toHaveBeenCalled()
    const s = m.status.get('svc')!
    expect(s.state).toBe('connected')
    expect(s.toolCount).toBe(2)
    expect(s.reason).toBeNull()
  })

  it('markFailed with auth_failed on 401', async () => {
    const { McpClient } = await import('../client')
    vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async () => {
      const err = Object.assign(new Error('Unauthorized'), { code: 401 })
      throw err
    })

    const m = new McpManager()
    await expect(m.addServer(serverInfo())).rejects.toMatchObject({
      message: 'Unauthorized',
      code: 401,
    })
    const s = m.status.get('svc')!
    expect(s.state).toBe('failed')
    expect(s.reason).toBe('auth_failed')
    expect(s.message).toBe(MCP_INIT_AUTH_FAILED_MESSAGE)
    expect(m.getConnectedServers()).toEqual([])
  })

  it('replaceServer keeps the previous connected revision when the candidate fails', async () => {
    const { McpClient } = await import('../client')
    const connect = vi
      .spyOn(McpClient.prototype, 'connect')
      .mockImplementationOnce(async function (this: any) {
        this.connected = true
        this.tools = [{ name: 'old-tool', inputSchema: {}, serverName: 'svc' }]
      })
      .mockRejectedValueOnce(new Error('replacement connect failed'))
    vi.spyOn(McpClient.prototype, 'disconnect').mockResolvedValue(undefined)
    const previous = serverInfo()
    const replacement = serverInfo({
      transport: { type: 'streamableHttp', url: 'http://replacement/mcp' },
    })
    const m = new McpManager()
    await m.addServer(previous)

    await expect(m.replaceServer(replacement)).rejects.toThrow('replacement connect failed')

    expect(connect).toHaveBeenCalledTimes(2)
    expect(m.getConnectedServers()).toEqual(['svc'])
    expect(m.status.get('svc')).toMatchObject({ state: 'connected', toolCount: 1 })
    expect((m as any).serverInfos.get('svc')).toEqual(previous)
    expect(m.getAllTools().map(tool => tool.name)).toEqual(['svc__old-tool'])
  })

  it('replaceServer connects the candidate before retiring the previous client', async () => {
    const effects: string[] = []
    const { McpClient } = await import('../client')
    vi.spyOn(McpClient.prototype, 'connect')
      .mockImplementationOnce(async function (this: any) {
        this.connected = true
        this.tools = [{ name: 'old-tool', inputSchema: {}, serverName: 'svc' }]
      })
      .mockImplementationOnce(async function (this: any) {
        effects.push('connect-candidate')
        this.connected = true
        this.tools = [{ name: 'new-tool', inputSchema: {}, serverName: 'svc' }]
      })
    vi.spyOn(McpClient.prototype, 'disconnect').mockImplementation(async () => {
      effects.push('disconnect-previous')
    })
    const previous = serverInfo()
    const replacement = serverInfo({
      transport: { type: 'streamableHttp', url: 'http://replacement/mcp' },
    })
    const m = new McpManager()
    await m.addServer(previous)

    await m.replaceServer(replacement)

    expect(effects).toEqual(['connect-candidate', 'disconnect-previous'])
    expect((m as any).serverInfos.get('svc')).toEqual(replacement)
    expect(m.getAllTools().map(tool => tool.name)).toEqual(['svc__new-tool'])
  })
})

describe('McpManager.refreshAllServerStatus', () => {
  afterEach(() => vi.restoreAllMocks())

  it('updates toolCount on successful probe', async () => {
    const { McpClient } = await import('../client')
    vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (this: any) {
      this.connected = true
      this.tools = [{ name: 't1', inputSchema: {}, serverName: 'svc' }]
    })
    const probe = vi
      .spyOn(McpClient.prototype, 'probeTools')
      .mockResolvedValue({ ok: true, toolCount: 4 })

    const m = new McpManager()
    await m.addServer(serverInfo())
    expect(m.status.get('svc')!.toolCount).toBe(1)

    const n = await m.refreshAllServerStatus()
    expect(n).toBe(1)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(m.status.get('svc')!.toolCount).toBe(4)
  })

  it('keeps state=connected and sets reason on probe failure', async () => {
    const { McpClient } = await import('../client')
    vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (this: any) {
      this.connected = true
      this.tools = [{ name: 't1', inputSchema: {}, serverName: 'svc' }]
    })
    vi.spyOn(McpClient.prototype, 'probeTools').mockResolvedValue({
      ok: false,
      error: { code: 500 },
    })

    const m = new McpManager()
    await m.addServer(serverInfo())
    await m.refreshAllServerStatus()

    const s = m.status.get('svc')!
    expect(s.state).toBe('connected') // monotonic
    expect(s.toolCount).toBe(0)
    expect(s.reason).toBe('upstream_5xx')
  })

  it('returns 0 and is a no-op when no servers are connected', async () => {
    const m = new McpManager()
    const n = await m.refreshAllServerStatus()
    expect(n).toBe(0)
  })
})

describe('McpManager.disconnectAll resets the tracker', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reset() drops all entries (spec §4.5 — only path to re-enter connecting)', async () => {
    const { McpClient } = await import('../client')
    vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (this: any) {
      this.connected = true
      this.tools = []
    })
    vi.spyOn(McpClient.prototype, 'disconnect').mockResolvedValue(undefined)

    const m = new McpManager()
    await m.addServer(serverInfo({ name: 'a' }))
    await m.addServer(serverInfo({ name: 'b' }))
    expect(m.status.size()).toBe(2)

    await m.disconnectAll()
    expect(m.status.size()).toBe(0)
  })
})
