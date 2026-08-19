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

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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
      expect(m.getKnownServers()).toEqual([server.name])

      await m.removeServer(server.name)

      expect(m.status.get(server.name)).toBeUndefined()
      expect((m as any).serverInfos.has(server.name)).toBe(false)
      expect(m.getKnownServers()).toEqual([])
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
    vi.spyOn(McpClient.prototype, 'retire').mockReturnValue(async () => undefined)
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
    vi.spyOn(McpClient.prototype, 'retire').mockImplementation(() => async () => {
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

  it('discards a candidate that becomes stale while connect is in flight', async () => {
    const { McpClient } = await import('../client')
    const connectStarted = deferred()
    const releaseConnect = deferred()
    vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (this: any) {
      connectStarted.resolve()
      await releaseConnect.promise
      this.connected = true
      this.tools = [{ name: 'stale-tool', inputSchema: {}, serverName: 'svc' }]
    })
    const cleanup = vi.fn().mockResolvedValue(undefined)
    const retire = vi.spyOn(McpClient.prototype, 'retire').mockReturnValue(cleanup)
    const scheduledCleanups: Array<() => Promise<void>> = []
    let current = true
    const onCommit = vi.fn()
    const m = new McpManager()
    const admission = m.addServer(serverInfo(), undefined, {
      isCurrent: () => current,
      onCommit,
      scheduleCleanup: scheduledCleanup => scheduledCleanups.push(scheduledCleanup),
    })

    await connectStarted.promise
    expect(m.getKnownServers()).toEqual(['svc'])
    current = false
    releaseConnect.resolve()

    await expect(admission).resolves.toBe('stale')
    expect(retire).toHaveBeenCalledTimes(1)
    expect(scheduledCleanups).toHaveLength(1)
    expect(cleanup).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
    expect(m.getConnectedServers()).toEqual([])
    expect(m.getKnownServers()).toEqual([])
    expect(m.status.get('svc')).toBeUndefined()
  })

  it('does not record a stale connect failure', async () => {
    const { McpClient } = await import('../client')
    const connectStarted = deferred()
    const rejectConnect = deferred()
    vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async () => {
      connectStarted.resolve()
      await rejectConnect.promise
    })
    vi.spyOn(McpClient.prototype, 'retire').mockReturnValue(async () => undefined)
    let current = true
    const m = new McpManager()
    const admission = m.addServer(serverInfo(), undefined, {
      isCurrent: () => current,
    })

    await connectStarted.promise
    current = false
    rejectConnect.reject(new Error('stale failure'))

    await expect(admission).resolves.toBe('stale')
    expect(m.getKnownServers()).toEqual([])
    expect(m.status.get('svc')).toBeUndefined()
  })

  it('revokes inventory and tools before a detached client finishes disconnecting', async () => {
    const { McpClient } = await import('../client')
    vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (this: any) {
      this.connected = true
      this.tools = [{ name: 'tool', inputSchema: {}, serverName: 'svc' }]
    })
    const releaseCleanup = deferred()
    const retire = vi
      .spyOn(McpClient.prototype, 'retire')
      .mockReturnValue(() => releaseCleanup.promise)
    const m = new McpManager()
    await m.addServer(serverInfo())

    const cleanup = m.detachServer('svc')

    expect(m.getConnectedServers()).toEqual([])
    expect(m.getKnownServers()).toEqual([])
    expect(m.getAllTools()).toEqual([])
    expect(m.status.get('svc')).toBeUndefined()
    expect(retire).toHaveBeenCalledTimes(1)

    const cleaning = cleanup()
    releaseCleanup.resolve()
    await cleaning
  })

  it('disconnectAll fences an admission that was already connecting', async () => {
    const { McpClient } = await import('../client')
    const connectStarted = deferred()
    const releaseConnect = deferred()
    vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (this: any) {
      connectStarted.resolve()
      await releaseConnect.promise
      this.connected = true
      this.tools = [{ name: 'late-tool', inputSchema: {}, serverName: 'svc' }]
    })
    vi.spyOn(McpClient.prototype, 'retire').mockReturnValue(async () => undefined)
    const m = new McpManager()
    const admission = m.addServer(serverInfo())

    await connectStarted.promise
    await m.disconnectAll()
    releaseConnect.resolve()

    await expect(admission).resolves.toBe('stale')
    expect(m.getConnectedServers()).toEqual([])
    expect(m.getKnownServers()).toEqual([])
    expect(m.status.get('svc')).toBeUndefined()
  })

  it.each(['detachServer', 'removeServer', 'disconnectAll', 'close'] as const)(
    '%s retires a pending add synchronously and cleans it exactly once',
    async revocation => {
      const { McpClient } = await import('../client')
      const connectStarted = deferred()
      const releaseConnect = deferred()
      vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (this: any) {
        connectStarted.resolve()
        await releaseConnect.promise
        this.connected = true
        this.tools = [{ name: 'late-tool', inputSchema: {}, serverName: 'svc' }]
      })
      const cleanup = vi.fn().mockResolvedValue(undefined)
      const retire = vi.spyOn(McpClient.prototype, 'retire').mockReturnValue(cleanup)
      const scheduledCleanups: Array<() => Promise<void>> = []
      const onCommit = vi.fn()
      const m = new McpManager()
      const admission = m.addServer(serverInfo(), undefined, {
        onCommit,
        scheduleCleanup: scheduledCleanup => scheduledCleanups.push(scheduledCleanup),
      })

      await connectStarted.promise
      const revoking =
        revocation === 'detachServer'
          ? m.detachServer('svc')()
          : revocation === 'removeServer'
            ? m.removeServer('svc')
            : revocation === 'disconnectAll'
              ? m.disconnectAll()
              : m.close()

      expect(retire).toHaveBeenCalledTimes(1)
      await revoking
      expect(cleanup).toHaveBeenCalledTimes(1)

      releaseConnect.resolve()
      await expect(admission).resolves.toBe('stale')

      expect(retire).toHaveBeenCalledTimes(1)
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(scheduledCleanups).toEqual([])
      expect(onCommit).not.toHaveBeenCalled()
      expect(m.getConnectedServers()).toEqual([])
      expect(m.getKnownServers()).toEqual([])
      expect(m.status.get('svc')).toBeUndefined()
    }
  )

  it.each(['detachServer', 'removeServer', 'disconnectAll', 'close'] as const)(
    '%s retires both the installed client and pending replacement before its handshake completes',
    async revocation => {
      const { McpClient } = await import('../client')
      const replacementConnectStarted = deferred()
      const releaseReplacementConnect = deferred()
      vi.spyOn(McpClient.prototype, 'connect')
        .mockImplementationOnce(async function (this: any) {
          this.connected = true
          this.tools = [{ name: 'old-tool', inputSchema: {}, serverName: 'svc' }]
        })
        .mockImplementationOnce(async function (this: any) {
          replacementConnectStarted.resolve()
          await releaseReplacementConnect.promise
          this.connected = true
          this.tools = [{ name: 'late-new-tool', inputSchema: {}, serverName: 'svc' }]
        })
      const cleanups: Array<ReturnType<typeof vi.fn>> = []
      const retire = vi.spyOn(McpClient.prototype, 'retire').mockImplementation(() => {
        const cleanup = vi.fn().mockResolvedValue(undefined)
        cleanups.push(cleanup)
        return cleanup
      })
      const scheduledCleanups: Array<() => Promise<void>> = []
      const onCommit = vi.fn()
      const m = new McpManager()
      await m.addServer(serverInfo())
      const admission = m.replaceServer(
        serverInfo({
          transport: { type: 'streamableHttp', url: 'http://replacement/mcp' },
        }),
        undefined,
        {
          onCommit,
          scheduleCleanup: scheduledCleanup => scheduledCleanups.push(scheduledCleanup),
        }
      )

      await replacementConnectStarted.promise
      const revoking =
        revocation === 'detachServer'
          ? m.detachServer('svc')()
          : revocation === 'removeServer'
            ? m.removeServer('svc')
            : revocation === 'disconnectAll'
              ? m.disconnectAll()
              : m.close()

      expect(retire).toHaveBeenCalledTimes(2)
      await revoking
      expect(cleanups).toHaveLength(2)
      expect(cleanups.every(cleanup => cleanup.mock.calls.length === 1)).toBe(true)

      releaseReplacementConnect.resolve()
      await expect(admission).resolves.toBe('stale')

      expect(retire).toHaveBeenCalledTimes(2)
      expect(cleanups.every(cleanup => cleanup.mock.calls.length === 1)).toBe(true)
      expect(scheduledCleanups).toEqual([])
      expect(onCommit).not.toHaveBeenCalled()
      expect(m.getConnectedServers()).toEqual([])
      expect(m.getKnownServers()).toEqual([])
      expect(m.getAllTools()).toEqual([])
      expect(m.status.get('svc')).toBeUndefined()
    }
  )

  it('permanently rejects admissions after close', async () => {
    const { McpClient } = await import('../client')
    const connect = vi.spyOn(McpClient.prototype, 'connect').mockResolvedValue(undefined)
    vi.spyOn(McpClient.prototype, 'retire').mockReturnValue(async () => undefined)
    const scheduledCleanups: Array<() => Promise<void>> = []
    const m = new McpManager()
    await m.addServer(serverInfo())

    await m.close(cleanup => scheduledCleanups.push(cleanup))
    await expect(m.addServer(serverInfo({ name: 'late-server' }))).resolves.toBe('stale')
    m.recordAdmissionFailure(serverInfo({ name: 'late-failure' }), new Error('late'))

    expect(connect).toHaveBeenCalledTimes(1)
    expect(m.getConnectedServers()).toEqual([])
    expect(m.getKnownServers()).toEqual([])
    expect(m.status.size()).toBe(0)
    expect(scheduledCleanups).toHaveLength(1)
    await scheduledCleanups[0]()
  })

  it('commits a replacement without waiting for bounded old-client cleanup', async () => {
    const { McpClient } = await import('../client')
    vi.spyOn(McpClient.prototype, 'connect')
      .mockImplementationOnce(async function (this: any) {
        this.connected = true
        this.tools = [{ name: 'old-tool', inputSchema: {}, serverName: 'svc' }]
      })
      .mockImplementationOnce(async function (this: any) {
        this.connected = true
        this.tools = [{ name: 'new-tool', inputSchema: {}, serverName: 'svc' }]
      })
    const releaseCleanup = deferred()
    vi.spyOn(McpClient.prototype, 'retire').mockReturnValue(() => releaseCleanup.promise)
    const scheduled: Array<() => Promise<void>> = []
    const onCommit = vi.fn()
    const replacement = serverInfo({
      transport: { type: 'streamableHttp', url: 'http://replacement/mcp' },
    })
    const m = new McpManager()
    await m.addServer(serverInfo())

    await expect(
      m.replaceServer(replacement, undefined, {
        onCommit,
        scheduleCleanup: cleanup => scheduled.push(cleanup),
      })
    ).resolves.toBe('applied')

    expect(onCommit).toHaveBeenCalledTimes(1)
    expect((m as any).serverInfos.get('svc')).toEqual(replacement)
    expect(m.getAllTools().map(tool => tool.name)).toEqual(['svc__new-tool'])
    expect(scheduled).toHaveLength(1)

    const cleanup = scheduled[0]()
    releaseCleanup.resolve()
    await cleanup
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
      .mockResolvedValue({ ok: true, toolCount: 4, outputSchemaCount: 0 })

    const m = new McpManager()
    await m.addServer(serverInfo())
    expect(m.status.get('svc')!.toolCount).toBe(1)

    const summary = await m.refreshAllServerStatus()
    expect(summary).toMatchObject({
      serverCount: 1,
      succeeded: 1,
      failed: 0,
      toolCount: 4,
      outputSchemaCount: 0,
      aborted: false,
    })
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
      stale: false,
    })

    const m = new McpManager()
    await m.addServer(serverInfo())
    await m.refreshAllServerStatus()

    const s = m.status.get('svc')!
    expect(s.state).toBe('connected') // monotonic
    expect(s.toolCount).toBe(0)
    expect(s.reason).toBe('upstream_5xx')
  })

  it('does not let a probe from a superseded epoch degrade the same connected client', async () => {
    const { McpClient } = await import('../client')
    vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (this: any) {
      this.connected = true
      this.tools = [
        { name: 'tool-1', inputSchema: {}, serverName: 'svc' },
        { name: 'tool-2', inputSchema: {}, serverName: 'svc' },
      ]
    })
    vi.spyOn(McpClient.prototype, 'probeTools').mockResolvedValue({
      ok: false,
      error: new Error('MCP client svc is superseded'),
      stale: true,
    })
    const m = new McpManager()
    await m.addServer(serverInfo())

    await m.refreshAllServerStatus()

    expect(m.status.get('svc')).toMatchObject({
      state: 'connected',
      toolCount: 2,
      reason: null,
    })
  })

  it('returns an empty summary and is a no-op when no servers are connected', async () => {
    const m = new McpManager()
    await expect(m.refreshAllServerStatus()).resolves.toEqual({
      serverCount: 0,
      succeeded: 0,
      failed: 0,
      toolCount: 0,
      outputSchemaCount: 0,
      aborted: false,
    })
  })

  it('does not let a stale probe overwrite a replacement connection status', async () => {
    const { McpClient } = await import('../client')
    vi.spyOn(McpClient.prototype, 'connect')
      .mockImplementationOnce(async function (this: any) {
        this.connected = true
        this.tools = [{ name: 'old-tool', inputSchema: {}, serverName: 'svc' }]
      })
      .mockImplementationOnce(async function (this: any) {
        this.connected = true
        this.tools = [
          { name: 'new-tool-1', inputSchema: {}, serverName: 'svc' },
          { name: 'new-tool-2', inputSchema: {}, serverName: 'svc' },
        ]
      })
    const probeStarted = deferred()
    const releaseProbe = deferred<{ ok: true; toolCount: number; outputSchemaCount: number }>()
    vi.spyOn(McpClient.prototype, 'probeTools').mockImplementation(async () => {
      probeStarted.resolve()
      return releaseProbe.promise
    })
    const m = new McpManager()
    await m.addServer(serverInfo())
    const refresh = m.refreshAllServerStatus()
    await probeStarted.promise

    await m.replaceServer(
      serverInfo({ transport: { type: 'streamableHttp', url: 'http://replacement/mcp' } }),
      undefined,
      { scheduleCleanup: vi.fn() }
    )
    expect(m.status.get('svc')).toMatchObject({ state: 'connected', toolCount: 2 })

    releaseProbe.resolve({ ok: true, toolCount: 99, outputSchemaCount: 0 })
    await refresh
    expect(m.status.get('svc')).toMatchObject({ state: 'connected', toolCount: 2 })
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
    vi.spyOn(McpClient.prototype, 'retire').mockReturnValue(async () => undefined)

    const m = new McpManager()
    await m.addServer(serverInfo({ name: 'a' }))
    await m.addServer(serverInfo({ name: 'b' }))
    expect(m.status.size()).toBe(2)

    await m.disconnectAll()
    expect(m.status.size()).toBe(0)
  })

  it('cleans every client when one disconnect fails, then reports the cleanup error', async () => {
    const { McpClient } = await import('../client')
    vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (this: any) {
      this.connected = true
      this.tools = []
    })
    const cleanupError = new Error('first disconnect failed')
    const cleanupCalls: string[] = []
    const retire = vi.spyOn(McpClient.prototype, 'retire').mockImplementation(function (this: any) {
      return async () => {
        cleanupCalls.push(this.name)
        if (this.name === 'a') throw cleanupError
      }
    })

    const m = new McpManager()
    await m.addServer(serverInfo({ name: 'a' }))
    await m.addServer(serverInfo({ name: 'b' }))

    await expect(m.disconnectAll()).rejects.toBe(cleanupError)

    expect(retire).toHaveBeenCalledTimes(2)
    expect(cleanupCalls).toEqual(['a', 'b'])
    expect(m.getConnectedServers()).toEqual([])
    expect(m.status.size()).toBe(0)
  })

  it('detaches every client before awaiting the first disconnect', async () => {
    const { McpClient } = await import('../client')
    vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (this: any) {
      this.connected = true
      this.tools = [{ name: `${this.name}-tool`, inputSchema: {}, serverName: this.name }]
    })
    const releaseFirstCleanup = deferred()
    const cleanupCalls: string[] = []
    const retire = vi.spyOn(McpClient.prototype, 'retire').mockImplementation(function (this: any) {
      return async () => {
        cleanupCalls.push(this.name)
        if (this.name === 'a') await releaseFirstCleanup.promise
      }
    })
    const m = new McpManager()
    await m.addServer(serverInfo({ name: 'a' }))
    await m.addServer(serverInfo({ name: 'b' }))

    const shutdown = m.disconnectAll()
    await Promise.resolve()

    expect(m.getConnectedServers()).toEqual([])
    expect(m.getKnownServers()).toEqual([])
    expect(m.getAllTools()).toEqual([])
    expect(m.status.size()).toBe(0)
    expect(retire).toHaveBeenCalledTimes(2)
    expect(cleanupCalls).toEqual(['a'])

    releaseFirstCleanup.resolve()
    await shutdown
    expect(cleanupCalls).toEqual(['a', 'b'])
  })
})
