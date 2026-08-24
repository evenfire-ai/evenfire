import { describe, expect, it, vi } from 'vitest'
import { config } from '../config'
import { ContextMapperRequestError } from '../contextMapperClient'
import {
  admitDevelopmentMcpServers,
  createCoalescedPollRunner,
  createMcpAuthorityPollFailureOptions,
  createMcpAuthorityStalenessDeadline,
  isMcpAuthorityStale,
  startContextMapperPolling,
  stopContextMapperPolling,
} from '../main'
import {
  AuthoritativeMcpFleetCoordinator,
  pollAuthoritativeMcpSnapshotIfCurrent,
  reconcileAuthoritativeMcpSnapshot,
  replaceAuthoritativeMcpFleet,
  runAuthoritativeMcpInitialization,
} from '../mcp/authoritativeFleet'
import { handleMcpAuthorityPollFailure } from '../mcp/authorityLifecycle'
import { McpManager } from '../mcp/manager'
import type { McpServerInfo } from '../types'

function readyServer(overrides: Partial<McpServerInfo> = {}): McpServerInfo {
  return {
    name: 'secured-server',
    contextRef: 'production',
    transport: { type: 'streamableHttp', url: 'http://secured-server.test/mcp' },
    auth: { type: 'bearer', secretRef: 'secured-server-auth' },
    enabled: true,
    // Mirror the real producer contract: HCC's reconciler.getStatus() (surfaced
    // through k8sClient.toServerInfo) always stamps `authoritative` explicitly —
    // a ready, identity-matched snapshot carries authoritative: true. The legacy
    // shape that omitted it is never emitted for a live server, so the default
    // fixture must carry it too.
    status: { deployed: true, ready: true, authoritative: true },
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

function appliedAdmission(
  effect?: (server: McpServerInfo, authToken?: string) => void | Promise<void>
) {
  return vi.fn(
    async (
      server: McpServerInfo,
      authToken?: string,
      control?: Parameters<McpManager['addServer']>[2]
    ) => {
      await effect?.(server, authToken)
      if (control?.isCurrent?.() === false) return 'stale' as const
      control?.onCommit?.()
      return 'applied' as const
    }
  )
}

describe('admitDevelopmentMcpServers', () => {
  it('continues admitting peers when one development server is unavailable', async () => {
    const firstServer = readyServer({ name: 'first-server', auth: { type: 'none' } })
    const failedServer = readyServer({ name: 'failed-server', auth: { type: 'none' } })
    const thirdServer = readyServer({ name: 'third-server', auth: { type: 'none' } })
    const addServer = appliedAdmission(async server => {
      if (server.name === failedServer.name) {
        throw new Error('MCP connect failed')
      }
    })

    await expect(
      admitDevelopmentMcpServers([firstServer, failedServer, thirdServer], { addServer })
    ).resolves.toBeUndefined()

    expect(addServer).toHaveBeenCalledTimes(3)
    expect(addServer).toHaveBeenNthCalledWith(1, firstServer)
    expect(addServer).toHaveBeenNthCalledWith(2, failedServer)
    expect(addServer).toHaveBeenNthCalledWith(3, thirdServer)
  })
})

describe('runAuthoritativeMcpInitialization', () => {
  it('obtains an authoritative snapshot before replacing the current fleet', async () => {
    const effects: string[] = []
    const client = {
      healthCheck: vi.fn(async () => {
        effects.push('ready')
        return true
      }),
      listServersForHost: vi.fn(async () => {
        effects.push('snapshot')
        return []
      }),
    }

    await runAuthoritativeMcpInitialization({
      client,
      replaceFleet: async servers => {
        effects.push('replace')
        expect(servers).toEqual([])
      },
      sleep: vi.fn(),
      maxRetries: 2,
    })

    expect(effects).toEqual(['ready', 'snapshot', 'replace'])
  })

  it('preserves the prior fleet when authoritative discovery rejects', async () => {
    const priorManager = { id: 'prior-manager' }
    const priorState = new Map([['existing-server', 'existing-state']])
    let currentManager = priorManager
    let currentState = priorState
    const discoveryError = new Error('HTTP 503: Service Unavailable')
    const replaceFleet = vi.fn(async () => {
      currentManager = { id: 'replacement-manager' }
      currentState = new Map()
    })

    await expect(
      runAuthoritativeMcpInitialization({
        client: {
          healthCheck: vi.fn().mockResolvedValue(true),
          listServersForHost: vi.fn().mockRejectedValue(discoveryError),
        },
        replaceFleet,
        sleep: vi.fn(),
        maxRetries: 2,
      })
    ).rejects.toBe(discoveryError)

    expect(replaceFleet).not.toHaveBeenCalled()
    expect(currentManager).toBe(priorManager)
    expect(currentState).toBe(priorState)
  })

  it.each(['shutdown', 'a newer initialization'] as const)(
    'drops delayed initial discovery after %s while the manager is still null',
    async invalidation => {
      const discoveryStarted = deferred()
      const delayedDiscovery = deferred<McpServerInfo[]>()
      const candidateManager = {
        addServer: appliedAdmission(),
        disconnectAll: vi.fn().mockResolvedValue(undefined),
        recordAdmissionFailure: vi.fn(),
      }
      let shuttingDown = false
      let currentGeneration = 1
      const initializationGeneration = currentGeneration
      let currentManager: typeof candidateManager | null = null
      const installFleet = vi.fn((manager: typeof candidateManager) => {
        currentManager = manager
      })
      const startPolling = vi.fn()
      const createManager = vi.fn(() => candidateManager)
      const replaceFleet = vi.fn((servers: McpServerInfo[]) =>
        replaceAuthoritativeMcpFleet({
          servers,
          previousManager: currentManager,
          createManager,
          getAuthToken: vi.fn(),
          installFleet,
          onColdStartPublished: startPolling,
          isFleetLifecycleCurrent: () =>
            !shuttingDown && currentGeneration === initializationGeneration,
        })
      )

      const initialization = runAuthoritativeMcpInitialization({
        client: {
          healthCheck: vi.fn().mockResolvedValue(true),
          listServersForHost: vi.fn(async () => {
            discoveryStarted.resolve()
            return delayedDiscovery.promise
          }),
        },
        replaceFleet,
        isCurrent: () => !shuttingDown && currentGeneration === initializationGeneration,
      })

      await discoveryStarted.promise
      expect(currentManager).toBeNull()
      if (invalidation === 'shutdown') {
        shuttingDown = true
      }
      currentGeneration += 1
      delayedDiscovery.resolve([readyServer({ auth: { type: 'none' } })])
      await initialization

      expect(replaceFleet).not.toHaveBeenCalled()
      expect(createManager).not.toHaveBeenCalled()
      expect(installFleet).not.toHaveBeenCalled()
      expect(startPolling).not.toHaveBeenCalled()
      expect(currentManager).toBeNull()
    }
  )

  it('fails explicitly after readiness retry exhaustion without replacing the prior fleet', async () => {
    const replaceFleet = vi.fn()
    const sleep = vi.fn().mockResolvedValue(undefined)
    const healthCheck = vi.fn().mockResolvedValue(false)
    const listServersForHost = vi.fn()

    await expect(
      runAuthoritativeMcpInitialization({
        client: { healthCheck, listServersForHost },
        replaceFleet,
        sleep,
        maxRetries: 2,
      })
    ).rejects.toThrow('Context Mapper was not ready after 2 attempts')

    expect(healthCheck).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(listServersForHost).not.toHaveBeenCalled()
    expect(replaceFleet).not.toHaveBeenCalled()
  })
})

describe('createCoalescedPollRunner', () => {
  it('coalesces overlapping ticks into one bounded trailing poll', async () => {
    let resolveFirst!: () => void
    let resolveSecond!: () => void
    const poll = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise<void>(resolve => (resolveSecond = resolve)))
      .mockResolvedValue(undefined)
    const runner = createCoalescedPollRunner(poll)

    runner.trigger()
    runner.trigger()
    runner.trigger()
    expect(poll).toHaveBeenCalledTimes(1)

    resolveFirst()
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(2))
    resolveSecond()
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(2))

    runner.trigger()
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(3))
  })

  it('drops a pending trailing poll after stop', async () => {
    let resolveFirst!: () => void
    const poll = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => (resolveFirst = resolve)))
    const runner = createCoalescedPollRunner(poll)

    runner.trigger()
    runner.trigger()
    runner.stop()
    resolveFirst()
    await Promise.resolve()
    await Promise.resolve()

    expect(poll).toHaveBeenCalledTimes(1)
  })
})

describe('AuthoritativeMcpFleetCoordinator scheduling', () => {
  it('prunes obsolete unique-name admissions while the global permit is saturated', async () => {
    const coordinator = new AuthoritativeMcpFleetCoordinator(1, 1, true)
    const manager = {}
    const blocker = readyServer({ name: 'blocker', auth: { type: 'none' } })
    const blockerLease = coordinator.publishSnapshot(manager, [blocker])
    const blockerStarted = deferred()
    const releaseBlocker = deferred()
    const blockerRun = coordinator.runAdmission(manager, blocker.name, blockerLease, async () => {
      blockerStarted.resolve()
      await releaseBlocker.promise
    })
    await blockerStarted.promise

    const executed: string[] = []
    const scheduled: Array<Promise<void>> = []
    for (let revision = 0; revision < 50; revision += 1) {
      const server = readyServer({
        name: `churn-${revision}`,
        auth: { type: 'none' },
      })
      const lease = coordinator.publishSnapshot(manager, [blocker, server])
      scheduled.push(
        coordinator.runAdmission(manager, server.name, lease, async isCurrent => {
          expect(isCurrent()).toBe(true)
          executed.push(server.name)
        })
      )
    }

    const scheduler = coordinator as unknown as {
      admissionWaiters: unknown[]
      admissions: WeakMap<object, Map<string, unknown>>
      admissionTasks: Set<Promise<void>>
    }
    const queuedBeforeRelease = scheduler.admissionWaiters.length
    const slotsBeforeRelease = scheduler.admissions.get(manager)?.size ?? 0
    const tasksBeforeRelease = scheduler.admissionTasks.size

    await Promise.all(scheduled.slice(0, -1))
    expect(executed).toEqual([])
    releaseBlocker.resolve()
    await Promise.all([blockerRun, ...scheduled])

    expect({
      queuedBeforeRelease,
      slotsBeforeRelease,
      tasksBeforeRelease,
    }).toEqual({
      queuedBeforeRelease: 1,
      slotsBeforeRelease: 2,
      tasksBeforeRelease: 2,
    })
    expect(executed).toEqual(['churn-49'])
  })

  it('replaces stale queued epochs with only the latest admission per server', async () => {
    const coordinator = new AuthoritativeMcpFleetCoordinator(1, 1, true)
    const manager = {}
    const blocker = readyServer({ name: 'blocker', auth: { type: 'none' } })
    const blockerLease = coordinator.publishSnapshot(manager, [blocker])
    const blockerStarted = deferred()
    const releaseBlocker = deferred()
    const blockerRun = coordinator.runAdmission(manager, blocker.name, blockerLease, async () => {
      blockerStarted.resolve()
      await releaseBlocker.promise
    })
    await blockerStarted.promise

    const executedRevisions: number[] = []
    const scheduled: Array<Promise<void>> = []
    for (let revision = 0; revision < 25; revision += 1) {
      const target = readyServer({
        name: 'target',
        auth: { type: 'none' },
        transport: {
          type: 'streamableHttp',
          url: `http://target.test/revision-${revision}`,
        },
      })
      const lease = coordinator.publishSnapshot(manager, [blocker, target])
      scheduled.push(
        coordinator.runAdmission(manager, target.name, lease, async isCurrent => {
          expect(isCurrent()).toBe(true)
          executedRevisions.push(revision)
        })
      )
    }

    expect(executedRevisions).toEqual([])
    releaseBlocker.resolve()
    await Promise.all([blockerRun, ...scheduled])

    expect(executedRevisions).toEqual([24])
  })

  it('does not let a delayed poll publish authority after manager shutdown', async () => {
    const coordinator = new AuthoritativeMcpFleetCoordinator(1, 1, true)
    const manager = {}
    const server = readyServer({ name: 'closed-server', auth: { type: 'none' } })
    coordinator.publishSnapshot(manager, [server])
    const delayedSnapshot = deferred<McpServerInfo[]>()
    const admission = vi.fn()
    const delayedPoll = delayedSnapshot.promise.then(async servers => {
      const delayedLease = coordinator.publishSnapshot(manager, servers)
      await coordinator.runAdmission(manager, server.name, delayedLease, admission)
    })

    coordinator.closeManager(manager)
    delayedSnapshot.resolve([server])
    await delayedPoll

    expect(admission).not.toHaveBeenCalled()
  })

  it('abandons a hung cleanup permit so later cleanup can progress', async () => {
    vi.useFakeTimers()
    try {
      const coordinator = new AuthoritativeMcpFleetCoordinator(1, 1, true)
      const neverSettles = new Promise<void>(() => {})
      const laterCleanup = vi.fn().mockResolvedValue(undefined)

      coordinator.scheduleCleanup(() => neverSettles)
      coordinator.scheduleCleanup(laterCleanup)
      await Promise.resolve()
      expect(laterCleanup).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(laterCleanup).toHaveBeenCalledTimes(1))
      await coordinator.drainCleanups()
    } finally {
      vi.useRealTimers()
    }
  })

  it('observes manager-scheduled cleanup rejection and drains the tracked task', async () => {
    const { McpClient } = await import('../mcp/client')
    const error = new Error('cleanup rejected')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const connect = vi.spyOn(McpClient.prototype, 'connect').mockResolvedValue(undefined)
    const retire = vi.spyOn(McpClient.prototype, 'retire').mockReturnValue(async () => {
      throw error
    })
    const coordinator = new AuthoritativeMcpFleetCoordinator(1, 1, true)
    const manager = new McpManager()
    const server = readyServer({ name: 'cleanup-error-server', auth: { type: 'none' } })

    await manager.addServer(server)
    await manager.close(cleanup => coordinator.scheduleCleanup(cleanup))
    await coordinator.drainCleanups()

    expect(errorSpy).toHaveBeenCalledWith('[Main] MCP detached client cleanup failed:', error)
    expect(retire).toHaveBeenCalledTimes(1)
    connect.mockRestore()
    retire.mockRestore()
    errorSpy.mockRestore()
  })

  it('waits for a closing admission to schedule its late cleanup before shutdown drain returns', async () => {
    const { McpClient } = await import('../mcp/client')
    const connectStarted = deferred()
    const releaseConnect = deferred()
    const connect = vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (
      this: any
    ) {
      connectStarted.resolve()
      await releaseConnect.promise
      this.connected = true
      this.tools = [{ name: 'late-tool', inputSchema: {}, serverName: 'late-server' }]
    })
    const retire = vi.spyOn(McpClient.prototype, 'retire').mockReturnValue(async () => undefined)
    const coordinator = new AuthoritativeMcpFleetCoordinator(1, 1, true)
    const manager = new McpManager()
    const server = readyServer({ name: 'late-server', auth: { type: 'none' } })
    const lease = coordinator.publishSnapshot(manager, [server])
    const admission = coordinator.runAdmission(manager, server.name, lease, async isCurrent => {
      await manager.addServer(server, undefined, {
        isCurrent,
        onCommit: vi.fn(),
        scheduleCleanup: cleanup => coordinator.scheduleCleanup(cleanup),
      })
    })

    await connectStarted.promise
    coordinator.closeManager(manager)
    await manager.close(cleanup => coordinator.scheduleCleanup(cleanup))
    let drainReturned = false
    const drain = coordinator.drainForShutdown().then(() => {
      drainReturned = true
    })
    await Promise.resolve()
    expect(drainReturned).toBe(false)

    releaseConnect.resolve()
    await Promise.all([admission, drain])

    expect(connect).toHaveBeenCalledTimes(1)
    expect(retire).toHaveBeenCalledTimes(1)
    expect(manager.getConnectedServers()).toEqual([])
    expect(manager.getKnownServers()).toEqual([])
    connect.mockRestore()
    retire.mockRestore()
  })

  it('bounds shutdown admission drain when transport connect never settles', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const coordinator = new AuthoritativeMcpFleetCoordinator(1, 1, true, 30_000, 25)
      const manager = {}
      const server = readyServer({ name: 'never-settles', auth: { type: 'none' } })
      const lease = coordinator.publishSnapshot(manager, [server])
      void coordinator.runAdmission(manager, server.name, lease, () => new Promise<void>(() => {}))
      await Promise.resolve()
      coordinator.closeManager(manager)

      const drain = coordinator.drainForShutdown()
      await vi.advanceTimersByTimeAsync(25)
      await drain

      expect(warnSpy).toHaveBeenCalledWith(
        '[Main] MCP admission drain exceeded 25ms; abandoning transport wait'
      )
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('authoritative poll publication fence', () => {
  it('drops a delayed snapshot when shutdown or a manager swap makes the poll stale', async () => {
    const pollStarted = deferred()
    const delayedSnapshot = deferred<{ servers: McpServerInfo[] }>()
    let current = true
    const reconcile = vi.fn().mockResolvedValue(undefined)
    const poll = pollAuthoritativeMcpSnapshotIfCurrent({
      poll: async () => {
        pollStarted.resolve()
        return delayedSnapshot.promise
      },
      isCurrent: () => current,
      reconcile,
    })

    await pollStarted.promise
    current = false
    delayedSnapshot.resolve({
      servers: [readyServer({ name: 'stale-post-fetch-server' })],
    })
    await poll

    expect(reconcile).not.toHaveBeenCalled()
  })
})

describe('context-mapper polling lifecycle', () => {
  it('wires the live manager and configured staleness ceiling into poll failure handling', () => {
    const manager = {}
    const lastSuccessAt = 1_000
    const staleNow = lastSuccessAt + config.hccAuthorityMaxStalenessMs
    const revoke = vi.fn()
    const onCallerAuthorizationRejected = vi.fn()
    const onInventoryAuthorityRevoked = vi.fn()
    const onUnavailable = vi.fn()
    const options = createMcpAuthorityPollFailureOptions({
      getManager: () => manager,
      lastSuccessAt: () => lastSuccessAt,
      now: () => staleNow,
      revoke,
      onCallerAuthorizationRejected,
      onInventoryAuthorityRevoked,
      onUnavailable,
    })

    expect(options.maxStalenessMs).toBe(config.hccAuthorityMaxStalenessMs)
    const disposition = handleMcpAuthorityPollFailure(
      new ContextMapperRequestError(503, 'inventory', false),
      options
    )

    expect(disposition).toBe('authority_stale')
    expect(revoke).toHaveBeenCalledWith('authority_stale', true)
    expect(onUnavailable).toHaveBeenCalledTimes(1)
    expect(onCallerAuthorizationRejected).not.toHaveBeenCalled()
    expect(onInventoryAuthorityRevoked).not.toHaveBeenCalled()

    const noManagerRevoke = vi.fn()
    const noManagerDisposition = handleMcpAuthorityPollFailure(
      new ContextMapperRequestError(503, 'inventory', false),
      createMcpAuthorityPollFailureOptions({
        getManager: () => null,
        lastSuccessAt: () => lastSuccessAt,
        now: () => staleNow,
        revoke: noManagerRevoke,
        onCallerAuthorizationRejected: vi.fn(),
        onInventoryAuthorityRevoked: vi.fn(),
        onUnavailable: vi.fn(),
      })
    )
    expect(noManagerDisposition).toBe('unavailable')
    expect(noManagerRevoke).not.toHaveBeenCalled()
  })

  it('keeps exactly one interval producer when polling is started again', () => {
    vi.useFakeTimers()
    try {
      startContextMapperPolling()
      expect(vi.getTimerCount()).toBe(1)

      startContextMapperPolling()
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      stopContextMapperPolling()
      vi.useRealTimers()
    }
  })

  it('bounds transient authority preservation to the configured staleness window', () => {
    expect(isMcpAuthorityStale(1_000, 60_999, 60_000)).toBe(false)
    expect(isMcpAuthorityStale(1_000, 61_000, 60_000)).toBe(true)
    expect(isMcpAuthorityStale(0, 1_000_000, 60_000)).toBe(false)
    expect(isMcpAuthorityStale(1_000, 61_000, 0)).toBe(false)
  })

  it('revokes at the absolute staleness deadline without waiting for another poll', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T00:00:00.000Z'))
    try {
      const expired = vi.fn()
      const deadline = createMcpAuthorityStalenessDeadline(60_000, expired)

      deadline.recordSuccess()
      vi.advanceTimersByTime(59_999)
      expect(expired).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(expired).toHaveBeenCalledTimes(1)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('moves the absolute deadline forward only after a newer authoritative success', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T00:00:00.000Z'))
    try {
      const expired = vi.fn()
      const deadline = createMcpAuthorityStalenessDeadline(60_000, expired)

      deadline.recordSuccess()
      vi.advanceTimersByTime(50_000)
      deadline.recordSuccess()
      vi.advanceTimersByTime(10_000)
      expect(expired).not.toHaveBeenCalled()

      vi.advanceTimersByTime(50_000)
      expect(expired).toHaveBeenCalledTimes(1)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('cancels the absolute deadline when authority is withdrawn explicitly', () => {
    vi.useFakeTimers()
    try {
      const expired = vi.fn()
      const deadline = createMcpAuthorityStalenessDeadline(60_000, expired)

      deadline.recordSuccess()
      deadline.clear()
      vi.advanceTimersByTime(60_000)

      expect(expired).not.toHaveBeenCalled()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})

describe('replaceAuthoritativeMcpFleet', () => {
  it('publishes a cold manager and healthy peer before a slow peer finishes admission', async () => {
    const slowServer = readyServer({ name: 'slow-server', auth: { type: 'none' } })
    const healthyServer = readyServer({ name: 'healthy-server', auth: { type: 'none' } })
    const slowStarted = deferred()
    const releaseSlow = deferred()
    const connected = new Set<string>()
    const initializationGeneration = 1
    const currentGeneration = initializationGeneration
    const candidateManager = {
      addServer: appliedAdmission(async (server: McpServerInfo) => {
        if (server.name === slowServer.name) {
          slowStarted.resolve()
          await releaseSlow.promise
        }
        connected.add(server.name)
      }),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
      recordAdmissionFailure: vi.fn(),
    }
    let installedManager: typeof candidateManager | undefined
    let installedState: Map<string, string> | undefined
    const initialization = replaceAuthoritativeMcpFleet({
      servers: [slowServer, healthyServer],
      previousManager: null,
      createManager: () => candidateManager,
      getAuthToken: vi.fn(),
      maxConcurrency: 2,
      installFleet: (manager, serverState) => {
        installedManager = manager
        installedState = serverState
      },
      isFleetLifecycleCurrent: () => currentGeneration === initializationGeneration,
    })

    try {
      await slowStarted.promise
      await Promise.resolve()
      await Promise.resolve()

      expect(installedManager).toBe(candidateManager)
      expect(candidateManager.addServer).toHaveBeenCalledTimes(2)
      expect(connected).toContain(healthyServer.name)
      expect(installedState?.get(healthyServer.name)).toBe(JSON.stringify(healthyServer))
      expect(connected).not.toContain(slowServer.name)
      expect(installedState?.has(slowServer.name)).toBe(false)
    } finally {
      releaseSlow.resolve()
      await initialization
    }

    expect(connected).toEqual(new Set([healthyServer.name, slowServer.name]))
    expect(installedState?.get(slowServer.name)).toBe(JSON.stringify(slowServer))
  })

  it('bounds concurrent cold-start admission without serializing the fleet', async () => {
    const servers = Array.from({ length: 5 }, (_, index) =>
      readyServer({ name: `server-${index}`, auth: { type: 'none' } })
    )
    const firstAdmissionStarted = deferred()
    const releaseAdmissions = deferred()
    let active = 0
    let maxActive = 0
    const candidateManager = {
      addServer: appliedAdmission(async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        firstAdmissionStarted.resolve()
        await releaseAdmissions.promise
        active -= 1
      }),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
      recordAdmissionFailure: vi.fn(),
    }
    const initialization = replaceAuthoritativeMcpFleet({
      servers,
      previousManager: null,
      createManager: () => candidateManager,
      getAuthToken: vi.fn(),
      maxConcurrency: 2,
      installFleet: vi.fn(),
    })

    try {
      await firstAdmissionStarted.promise
      await Promise.resolve()
      await Promise.resolve()

      expect(candidateManager.addServer).toHaveBeenCalledTimes(2)
      expect(maxActive).toBe(2)
    } finally {
      releaseAdmissions.resolve()
      await initialization
    }

    expect(candidateManager.addServer).toHaveBeenCalledTimes(servers.length)
    expect(maxActive).toBe(2)
  })

  it('rejects invalid cold-start concurrency before publishing a candidate', async () => {
    const candidateManager = {
      addServer: appliedAdmission(),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
      recordAdmissionFailure: vi.fn(),
    }
    const createManager = vi.fn(() => candidateManager)
    const installFleet = vi.fn()

    await expect(
      replaceAuthoritativeMcpFleet({
        servers: [readyServer({ auth: { type: 'none' } })],
        previousManager: null,
        createManager,
        getAuthToken: vi.fn(),
        installFleet,
        maxConcurrency: 0,
      })
    ).rejects.toThrow('MCP fleet reconciliation concurrency must be a positive integer')

    expect(createManager).not.toHaveBeenCalled()
    expect(installFleet).not.toHaveBeenCalled()
    expect(candidateManager.addServer).not.toHaveBeenCalled()
    expect(candidateManager.disconnectAll).not.toHaveBeenCalled()
  })

  it('keeps polling live after cold publish and prevents revoked in-flight peers from resurfacing', async () => {
    const slowServer = readyServer({ name: 'slow-server', auth: { type: 'none' } })
    const healthyServer = readyServer({ name: 'healthy-server', auth: { type: 'none' } })
    const slowStarted = deferred()
    const releaseSlow = deferred()
    const connected = new Set<string>()
    const known = new Set<string>()
    const coordinator = new AuthoritativeMcpFleetCoordinator(2, 2, true)
    const candidateManager = {
      addServer: vi.fn(
        async (
          server: McpServerInfo,
          _authToken?: string,
          control?: { isCurrent(): boolean; onCommit(): void }
        ) => {
          if (server.name === slowServer.name) {
            slowStarted.resolve()
            await releaseSlow.promise
          }
          if (control && !control.isCurrent()) return 'stale'
          connected.add(server.name)
          known.add(server.name)
          control?.onCommit()
          return 'applied'
        }
      ),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(async (name: string) => {
        connected.delete(name)
        known.delete(name)
      }),
      detachServer: vi.fn((name: string) => {
        connected.delete(name)
        known.delete(name)
        return vi.fn().mockResolvedValue(undefined)
      }),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
      getConnectedServers: vi.fn(() => [...connected]),
      getKnownServers: vi.fn(() => [...known]),
      recordAdmissionFailure: vi.fn(),
    }
    let installedState: Map<string, string> | undefined
    const pollingStarted = vi.fn()
    let initializationSettled = false
    const initialization = replaceAuthoritativeMcpFleet({
      servers: [slowServer, healthyServer],
      previousManager: null,
      createManager: () => candidateManager,
      getAuthToken: vi.fn(),
      installFleet: (_manager, serverState) => {
        installedState = serverState
      },
      coordinator,
      onColdStartPublished: pollingStarted,
      maxConcurrency: 2,
    }).finally(() => {
      initializationSettled = true
    })

    await slowStarted.promise
    await vi.waitFor(() => expect(connected).toContain(healthyServer.name))
    expect(pollingStarted).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(initializationSettled).toBe(true))

    await reconcileAuthoritativeMcpSnapshot({
      servers: [slowServer, healthyServer],
      manager: candidateManager,
      serverState: installedState!,
      getAuthToken: vi.fn(),
      coordinator,
      maxConcurrency: 2,
    })
    await reconcileAuthoritativeMcpSnapshot({
      servers: [slowServer],
      manager: candidateManager,
      serverState: installedState!,
      getAuthToken: vi.fn(),
      coordinator,
      maxConcurrency: 2,
    })

    expect(connected).toEqual(new Set())
    expect(installedState).toEqual(new Map())

    releaseSlow.resolve()
    await initialization

    expect(connected).toEqual(new Set([slowServer.name]))
    expect(known).toEqual(new Set([slowServer.name]))
    expect(installedState).toEqual(new Map([[slowServer.name, JSON.stringify(slowServer)]]))
  })

  it('coalesces an identical poll onto a cold admission and retries after its failure', async () => {
    const server = readyServer({ name: 'retry-server', auth: { type: 'none' } })
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const coordinator = new AuthoritativeMcpFleetCoordinator(2, 2, true)
    let attempt = 0
    const known = new Set<string>()
    const manager = {
      addServer: vi.fn(
        async (
          desired: McpServerInfo,
          _authToken?: string,
          control?: { isCurrent(): boolean; onCommit(): void }
        ) => {
          attempt += 1
          if (attempt === 1) {
            firstStarted.resolve()
            await releaseFirst.promise
            throw new Error('first connect failed')
          }
          if (control && !control.isCurrent()) return 'stale'
          known.add(desired.name)
          control?.onCommit()
          return 'applied'
        }
      ),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
      getConnectedServers: vi.fn(() => []),
      getKnownServers: vi.fn(() => [...known]),
      recordAdmissionFailure: vi.fn((desired: McpServerInfo) => known.add(desired.name)),
    }
    let state: Map<string, string> | undefined
    const initialization = replaceAuthoritativeMcpFleet({
      servers: [server],
      previousManager: null,
      createManager: () => manager,
      getAuthToken: vi.fn(),
      installFleet: (_manager, serverState) => {
        state = serverState
      },
      coordinator,
    })

    await firstStarted.promise
    for (let poll = 0; poll < 25; poll += 1) {
      await reconcileAuthoritativeMcpSnapshot({
        servers: [server],
        manager,
        serverState: state!,
        getAuthToken: vi.fn(),
        coordinator,
      })
    }
    expect(manager.addServer).toHaveBeenCalledTimes(1)

    releaseFirst.resolve()
    await initialization
    await vi.waitFor(() =>
      expect(
        (
          coordinator as unknown as {
            admissionTasks: Set<Promise<void>>
          }
        ).admissionTasks.size
      ).toBe(0)
    )
    expect(state).toEqual(new Map())

    await reconcileAuthoritativeMcpSnapshot({
      servers: [server],
      manager,
      serverState: state!,
      getAuthToken: vi.fn(),
      coordinator,
    })
    await vi.waitFor(() => expect(manager.addServer).toHaveBeenCalledTimes(2))
    expect(state?.get(server.name)).toBe(JSON.stringify(server))
  })

  it('does not publish an auth failure after a newer snapshot deletes the server', async () => {
    const server = readyServer({ name: 'stale-auth-server' })
    const authStarted = deferred()
    const rejectAuth = deferred<string | undefined>()
    const coordinator = new AuthoritativeMcpFleetCoordinator(2, 2, true)
    const manager = {
      addServer: appliedAdmission(),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
      getConnectedServers: vi.fn(() => []),
      getKnownServers: vi.fn(() => []),
      recordAdmissionFailure: vi.fn(),
    }
    let state: Map<string, string> | undefined
    const initialization = replaceAuthoritativeMcpFleet({
      servers: [server],
      previousManager: null,
      createManager: () => manager,
      getAuthToken: vi.fn(async () => {
        authStarted.resolve()
        return rejectAuth.promise
      }),
      installFleet: (_manager, serverState) => {
        state = serverState
      },
      coordinator,
    })

    await authStarted.promise
    await reconcileAuthoritativeMcpSnapshot({
      servers: [],
      manager,
      serverState: state!,
      getAuthToken: vi.fn(),
      coordinator,
    })
    rejectAuth.reject(new Error('stale auth failure'))
    await initialization

    expect(manager.recordAdmissionFailure).not.toHaveBeenCalled()
    expect(manager.addServer).not.toHaveBeenCalled()
    expect(state).toEqual(new Map())
  })

  it('removes a failed-only server when the next authoritative snapshot deletes it', async () => {
    const failedServer = readyServer({ name: 'failed-only-server', auth: { type: 'none' } })
    const connectError = new Error('MCP connect failed')
    const knownServers = new Set<string>()
    const candidateManager = {
      addServer: vi.fn(async (server: McpServerInfo) => {
        knownServers.add(server.name)
        throw connectError
      }),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(async (serverName: string) => {
        knownServers.delete(serverName)
      }),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
      getConnectedServers: vi.fn(() => []),
      getKnownServers: vi.fn(() => [...knownServers]),
      recordAdmissionFailure: vi.fn((server: McpServerInfo) => {
        knownServers.add(server.name)
      }),
    }
    let installedState: Map<string, string> | undefined

    await replaceAuthoritativeMcpFleet({
      servers: [failedServer],
      previousManager: null,
      createManager: () => candidateManager,
      getAuthToken: vi.fn(),
      installFleet: (_manager, serverState) => {
        installedState = serverState
      },
    })

    expect(installedState).toEqual(new Map())
    expect(candidateManager.getKnownServers()).toEqual([failedServer.name])

    await reconcileAuthoritativeMcpSnapshot({
      servers: [],
      manager: candidateManager,
      serverState: installedState!,
      getAuthToken: vi.fn(),
    })

    expect(candidateManager.removeServer).toHaveBeenCalledWith(failedServer.name)
    expect(candidateManager.getKnownServers()).toEqual([])
  })

  it('publishes healthy servers, retains the failed admission status, and leaves its revision retryable', async () => {
    const firstServer = readyServer({ name: 'first-server', auth: { type: 'none' } })
    const failedServer = readyServer({ name: 'failed-server', auth: { type: 'none' } })
    const thirdServer = readyServer({ name: 'third-server', auth: { type: 'none' } })
    const connectError = new Error('MCP connect failed')
    const candidateManager = {
      addServer: appliedAdmission(async server => {
        if (server.name === failedServer.name) throw connectError
      }),
      disconnectAll: vi.fn(),
      recordAdmissionFailure: vi.fn(),
    }
    const installFleet = vi.fn()

    await replaceAuthoritativeMcpFleet({
      servers: [firstServer, failedServer, thirdServer],
      previousManager: null,
      createManager: () => candidateManager,
      getAuthToken: vi.fn(),
      installFleet,
    })

    expect(candidateManager.addServer).toHaveBeenCalledTimes(3)
    // addServer owns connection-failure status; the fleet helper must not
    // duplicate that transition.
    expect(candidateManager.recordAdmissionFailure).not.toHaveBeenCalled()
    expect(installFleet).toHaveBeenCalledWith(
      candidateManager,
      new Map([
        [firstServer.name, JSON.stringify(firstServer)],
        [thirdServer.name, JSON.stringify(thirdServer)],
      ])
    )
    expect(candidateManager.disconnectAll).not.toHaveBeenCalled()
  })

  it('publishes a failed auth status without recording its revision', async () => {
    const authError = new Error('HTTP 503: Service Unavailable')
    const candidateManager = {
      addServer: appliedAdmission(),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
      recordAdmissionFailure: vi.fn(),
    }
    const installFleet = vi.fn()

    const server = readyServer()
    await replaceAuthoritativeMcpFleet({
      servers: [server],
      previousManager: null,
      createManager: () => candidateManager,
      getAuthToken: vi.fn().mockRejectedValue(authError),
      installFleet,
    })

    expect(candidateManager.addServer).not.toHaveBeenCalled()
    expect(candidateManager.recordAdmissionFailure).toHaveBeenCalledWith(server, authError)
    expect(installFleet).toHaveBeenCalledWith(candidateManager, new Map())
    expect(candidateManager.disconnectAll).not.toHaveBeenCalled()
  })

  it('preserves an existing fleet when a replacement candidate has an admission failure', async () => {
    const connectError = new Error('MCP connect failed')
    const firstServer = readyServer({ name: 'first-server', auth: { type: 'none' } })
    const failingServer = readyServer({ name: 'failing-server', auth: { type: 'none' } })
    const previousManager = {
      addServer: appliedAdmission(),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
    }
    const candidateManager = {
      addServer: appliedAdmission(async server => {
        if (server.name === failingServer.name) throw connectError
      }),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
      recordAdmissionFailure: vi.fn(),
    }
    const installFleet = vi.fn()

    await expect(
      replaceAuthoritativeMcpFleet({
        servers: [firstServer, failingServer],
        previousManager,
        createManager: () => candidateManager,
        getAuthToken: vi.fn(),
        installFleet,
      })
    ).rejects.toBe(connectError)

    expect(candidateManager.addServer).toHaveBeenNthCalledWith(
      1,
      firstServer,
      undefined,
      expect.any(Object)
    )
    expect(candidateManager.addServer).toHaveBeenNthCalledWith(
      2,
      failingServer,
      undefined,
      expect.any(Object)
    )
    expect(candidateManager.recordAdmissionFailure).not.toHaveBeenCalled()
    expect(installFleet).not.toHaveBeenCalled()
    expect(candidateManager.disconnectAll).toHaveBeenCalledTimes(1)
    expect(previousManager.disconnectAll).not.toHaveBeenCalled()
  })

  it('rejects a replacement candidate superseded by a newer live snapshot', async () => {
    const previousServer = readyServer({ name: 'previous-server', auth: { type: 'none' } })
    const candidateServer = readyServer({ name: 'candidate-server', auth: { type: 'none' } })
    const newerServer = readyServer({ name: 'newer-server', auth: { type: 'none' } })
    const previousManager = { disconnectAll: vi.fn().mockResolvedValue(undefined) }
    const coordinator = new AuthoritativeMcpFleetCoordinator(2, 2, true)
    coordinator.publishSnapshot(previousManager, [previousServer])
    const candidateStarted = deferred()
    const releaseCandidate = deferred()
    const candidateManager = {
      addServer: appliedAdmission(async () => {
        candidateStarted.resolve()
        await releaseCandidate.promise
      }),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
      recordAdmissionFailure: vi.fn(),
    }
    const installFleet = vi.fn()
    const replacement = replaceAuthoritativeMcpFleet({
      servers: [candidateServer],
      previousManager,
      createManager: () => candidateManager,
      getAuthToken: vi.fn(),
      installFleet,
      coordinator,
    })

    await candidateStarted.promise
    coordinator.publishSnapshot(previousManager, [newerServer])
    releaseCandidate.resolve()

    await expect(replacement).rejects.toThrow(
      'MCP fleet replacement candidate was superseded before commit'
    )
    expect(installFleet).not.toHaveBeenCalled()
    expect(candidateManager.disconnectAll).toHaveBeenCalledTimes(1)
    expect(previousManager.disconnectAll).not.toHaveBeenCalled()
  })

  it('commits a replacement candidate across an identical live poll', async () => {
    const previousServer = readyServer({ name: 'previous-server', auth: { type: 'none' } })
    const candidateServer = readyServer({ name: 'candidate-server', auth: { type: 'none' } })
    const previousManager = { disconnectAll: vi.fn().mockResolvedValue(undefined) }
    const coordinator = new AuthoritativeMcpFleetCoordinator(2, 2, true)
    coordinator.publishSnapshot(previousManager, [previousServer])
    const candidateStarted = deferred()
    const releaseCandidate = deferred()
    const candidateManager = {
      addServer: appliedAdmission(async () => {
        candidateStarted.resolve()
        await releaseCandidate.promise
      }),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
      recordAdmissionFailure: vi.fn(),
    }
    const installFleet = vi.fn()
    const replacement = replaceAuthoritativeMcpFleet({
      servers: [candidateServer],
      previousManager,
      createManager: () => candidateManager,
      getAuthToken: vi.fn(),
      installFleet,
      coordinator,
    })

    await candidateStarted.promise
    coordinator.publishSnapshot(previousManager, [previousServer])
    releaseCandidate.resolve()
    await replacement

    expect(installFleet).toHaveBeenCalledWith(
      candidateManager,
      new Map([[candidateServer.name, JSON.stringify(candidateServer)]])
    )
    expect(candidateManager.disconnectAll).not.toHaveBeenCalled()
    expect(previousManager.disconnectAll).toHaveBeenCalledTimes(1)
  })

  it('installs an HTTP 200 empty fleet before retiring the prior fleet', async () => {
    const effects: string[] = []
    const previousManager = {
      addServer: appliedAdmission(),
      disconnectAll: vi.fn(async () => {
        effects.push('retire-prior')
      }),
    }
    const candidateManager = {
      addServer: appliedAdmission(),
      disconnectAll: vi.fn(),
      recordAdmissionFailure: vi.fn(),
    }

    await replaceAuthoritativeMcpFleet({
      servers: [],
      previousManager,
      createManager: () => candidateManager,
      getAuthToken: vi.fn(),
      installFleet: (manager, serverState) => {
        effects.push('install')
        expect(manager).toBe(candidateManager)
        expect(serverState).toEqual(new Map())
      },
    })

    expect(effects).toEqual(['install', 'retire-prior'])
  })

  it('records an intentional not-ready admission without treating it as a hard failure', async () => {
    const notReady = readyServer({
      status: { deployed: true, ready: false, message: 'Deployment is progressing' },
    })
    const previousManager = {
      addServer: appliedAdmission(),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
    }
    const candidateManager = {
      addServer: appliedAdmission(),
      disconnectAll: vi.fn(),
      recordAdmissionFailure: vi.fn(),
    }
    const installFleet = vi.fn()

    await replaceAuthoritativeMcpFleet({
      servers: [notReady],
      previousManager,
      createManager: () => candidateManager,
      getAuthToken: vi.fn(() => {
        throw new Error('auth must not be fetched until the server is ready for admission')
      }),
      installFleet,
    })

    expect(candidateManager.addServer).toHaveBeenCalledWith(notReady, undefined, expect.any(Object))
    expect(installFleet).toHaveBeenCalledWith(
      candidateManager,
      new Map([[notReady.name, JSON.stringify(notReady)]])
    )
    expect(previousManager.disconnectAll).toHaveBeenCalledTimes(1)
  })

  it('records but never admits an explicitly non-authoritative ready server', async () => {
    const nonAuthoritative = readyServer({
      status: {
        deployed: true,
        ready: true,
        authoritative: false,
        message: 'Status identity could not be verified',
      },
    })
    const previousManager = {
      addServer: appliedAdmission(),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
    }
    const candidateManager = {
      addServer: appliedAdmission(),
      disconnectAll: vi.fn(),
      recordAdmissionFailure: vi.fn(),
    }
    const getAuthToken = vi.fn()
    const installFleet = vi.fn()

    await replaceAuthoritativeMcpFleet({
      servers: [nonAuthoritative],
      previousManager,
      createManager: () => candidateManager,
      getAuthToken,
      installFleet,
    })

    expect(getAuthToken).not.toHaveBeenCalled()
    expect(candidateManager.addServer).toHaveBeenCalledWith(
      nonAuthoritative,
      undefined,
      expect.any(Object)
    )
    expect(installFleet).toHaveBeenCalledWith(
      candidateManager,
      new Map([[nonAuthoritative.name, JSON.stringify(nonAuthoritative)]])
    )
  })

  it('publishes a real not-ready health entry for a non-authoritative cold snapshot', async () => {
    const nonAuthoritative = readyServer({
      status: {
        deployed: true,
        ready: true,
        authoritative: false,
        message: 'Status identity could not be verified',
      },
    })
    let installedManager: McpManager | undefined

    await replaceAuthoritativeMcpFleet({
      servers: [nonAuthoritative],
      previousManager: null,
      createManager: () => new McpManager(),
      getAuthToken: vi.fn(),
      installFleet: manager => {
        installedManager = manager
      },
    })

    expect(installedManager?.getConnectedServers()).toEqual([])
    expect(installedManager?.status.snapshot()).toEqual([
      expect.objectContaining({
        name: nonAuthoritative.name,
        state: 'failed',
        expected: true,
        reason: 'not_ready',
        message: 'Status identity could not be verified',
      }),
    ])
  })

  it('keeps the committed fleet when retiring the prior manager fails', async () => {
    const cleanupError = new Error('disconnect failed')
    const previousManager = {
      addServer: appliedAdmission(),
      disconnectAll: vi.fn().mockRejectedValue(cleanupError),
    }
    const candidateManager = {
      addServer: appliedAdmission(),
      disconnectAll: vi.fn(),
      recordAdmissionFailure: vi.fn(),
    }
    const installFleet = vi.fn()

    await expect(
      replaceAuthoritativeMcpFleet({
        servers: [],
        previousManager,
        createManager: () => candidateManager,
        getAuthToken: vi.fn(),
        installFleet,
      })
    ).resolves.toBeUndefined()

    expect(installFleet).toHaveBeenCalledWith(candidateManager, new Map())
    expect(previousManager.disconnectAll).toHaveBeenCalledTimes(1)
    expect(candidateManager.disconnectAll).not.toHaveBeenCalled()
  })
})

describe('reconcileAuthoritativeMcpSnapshot', () => {
  it('detaches every deletion synchronously while bounding deferred cleanup', async () => {
    const deletedServers = Array.from({ length: 3 }, (_, index) =>
      readyServer({ name: `deleted-${index}`, auth: { type: 'none' } })
    )
    const connected = new Set(deletedServers.map(server => server.name))
    const known = new Set(connected)
    const serverState = new Map(deletedServers.map(server => [server.name, JSON.stringify(server)]))
    const releaseCleanup = deferred()
    let activeCleanup = 0
    let maxActiveCleanup = 0
    const cleanupStarted = vi.fn()
    const manager = {
      addServer: appliedAdmission(),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(),
      detachServer: vi.fn((name: string) => {
        connected.delete(name)
        known.delete(name)
        return async () => {
          activeCleanup += 1
          maxActiveCleanup = Math.max(maxActiveCleanup, activeCleanup)
          cleanupStarted()
          await releaseCleanup.promise
          activeCleanup -= 1
        }
      }),
      getConnectedServers: vi.fn(() => [...connected]),
      getKnownServers: vi.fn(() => [...known]),
      recordAdmissionFailure: vi.fn(),
    }

    await reconcileAuthoritativeMcpSnapshot({
      servers: [],
      manager,
      serverState,
      getAuthToken: vi.fn(),
      coordinator: new AuthoritativeMcpFleetCoordinator(2, 2, true),
    })

    expect(manager.detachServer).toHaveBeenCalledTimes(deletedServers.length)
    expect(connected).toEqual(new Set())
    expect(known).toEqual(new Set())
    expect(serverState).toEqual(new Map())
    expect(cleanupStarted).toHaveBeenCalledTimes(2)
    expect(maxActiveCleanup).toBe(2)

    releaseCleanup.resolve()
    await vi.waitFor(() => expect(cleanupStarted).toHaveBeenCalledTimes(deletedServers.length))
    expect(maxActiveCleanup).toBe(2)
  })

  it('prioritizes authoritative deletions when every admission worker is slow', async () => {
    const slowServers = [
      readyServer({ name: 'slow-server-1', auth: { type: 'none' } }),
      readyServer({ name: 'slow-server-2', auth: { type: 'none' } }),
    ]
    const deletedServer = readyServer({ name: 'deleted-server', auth: { type: 'none' } })
    const serverState = new Map([[deletedServer.name, JSON.stringify(deletedServer)]])
    const allAdmissionsStarted = deferred()
    const releaseAdmissions = deferred()
    let startedAdmissions = 0
    const manager = {
      addServer: appliedAdmission(async () => {
        startedAdmissions += 1
        if (startedAdmissions === slowServers.length) {
          allAdmissionsStarted.resolve()
        }
        await releaseAdmissions.promise
      }),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn().mockResolvedValue(undefined),
      getConnectedServers: vi.fn(() => []),
      getKnownServers: vi.fn(() => [deletedServer.name]),
      recordAdmissionFailure: vi.fn(),
    }
    const reconciliation = reconcileAuthoritativeMcpSnapshot({
      servers: slowServers,
      manager,
      serverState,
      getAuthToken: vi.fn(),
      maxConcurrency: slowServers.length,
    })

    try {
      await allAdmissionsStarted.promise

      expect(manager.removeServer).toHaveBeenCalledWith(deletedServer.name)
      expect(serverState.has(deletedServer.name)).toBe(false)
    } finally {
      releaseAdmissions.resolve()
      await reconciliation
    }
  })

  it('reconciles healthy peers and authoritative deletions while another peer is slow', async () => {
    const slowServer = readyServer({ name: 'slow-server', auth: { type: 'none' } })
    const healthyServer = readyServer({ name: 'healthy-server', auth: { type: 'none' } })
    const deletedServer = readyServer({ name: 'deleted-server', auth: { type: 'none' } })
    const serverState = new Map([[deletedServer.name, JSON.stringify(deletedServer)]])
    const slowStarted = deferred()
    const releaseSlow = deferred()
    const knownServers = new Set([deletedServer.name])
    const manager = {
      addServer: appliedAdmission(async (server: McpServerInfo) => {
        if (server.name === slowServer.name) {
          slowStarted.resolve()
          await releaseSlow.promise
        }
        knownServers.add(server.name)
      }),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(async (serverName: string) => {
        knownServers.delete(serverName)
      }),
      getConnectedServers: vi.fn(() => []),
      getKnownServers: vi.fn(() => [...knownServers]),
      recordAdmissionFailure: vi.fn(),
    }
    const reconciliation = reconcileAuthoritativeMcpSnapshot({
      servers: [slowServer, healthyServer],
      manager,
      serverState,
      getAuthToken: vi.fn(),
      maxConcurrency: 2,
    })

    try {
      await slowStarted.promise
      await vi.waitFor(() => {
        expect(manager.addServer).toHaveBeenCalledWith(healthyServer, undefined, expect.any(Object))
        expect(manager.removeServer).toHaveBeenCalledWith(deletedServer.name)
      })
      expect(serverState.get(healthyServer.name)).toBe(JSON.stringify(healthyServer))
      expect(serverState.has(deletedServer.name)).toBe(false)
      expect(knownServers).not.toContain(deletedServer.name)
    } finally {
      releaseSlow.resolve()
      await reconciliation
    }

    expect(serverState.get(slowServer.name)).toBe(JSON.stringify(slowServer))
  })

  it('bounds concurrent authoritative snapshot effects without serializing distinct servers', async () => {
    const servers = Array.from({ length: 5 }, (_, index) =>
      readyServer({ name: `snapshot-server-${index}`, auth: { type: 'none' } })
    )
    const firstEffectStarted = deferred()
    const releaseEffects = deferred()
    let active = 0
    let maxActive = 0
    const manager = {
      addServer: appliedAdmission(async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        firstEffectStarted.resolve()
        await releaseEffects.promise
        active -= 1
      }),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => []),
      getKnownServers: vi.fn(() => []),
      recordAdmissionFailure: vi.fn(),
    }
    const reconciliation = reconcileAuthoritativeMcpSnapshot({
      servers,
      manager,
      serverState: new Map(),
      getAuthToken: vi.fn(),
      maxConcurrency: 2,
    })

    try {
      await firstEffectStarted.promise
      await Promise.resolve()
      await Promise.resolve()

      expect(manager.addServer).toHaveBeenCalledTimes(2)
      expect(maxActive).toBe(2)
    } finally {
      releaseEffects.resolve()
      await reconciliation
    }

    expect(manager.addServer).toHaveBeenCalledTimes(servers.length)
    expect(maxActive).toBe(2)
  })

  it('rejects invalid snapshot concurrency before reading or mutating manager state', async () => {
    const manager = {
      addServer: appliedAdmission(),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => []),
      getKnownServers: vi.fn(() => []),
      recordAdmissionFailure: vi.fn(),
    }

    await expect(
      reconcileAuthoritativeMcpSnapshot({
        servers: [readyServer({ auth: { type: 'none' } })],
        manager,
        serverState: new Map(),
        getAuthToken: vi.fn(),
        maxConcurrency: 0,
      })
    ).rejects.toThrow('MCP fleet reconciliation concurrency must be a positive integer')

    expect(manager.getConnectedServers).not.toHaveBeenCalled()
    expect(manager.getKnownServers).not.toHaveBeenCalled()
    expect(manager.addServer).not.toHaveBeenCalled()
    expect(manager.replaceServer).not.toHaveBeenCalled()
    expect(manager.removeServer).not.toHaveBeenCalled()
  })

  it('connects a ready desired candidate before retiring the previous connection', async () => {
    const previous = readyServer({ auth: { type: 'none' } })
    const modified = readyServer({
      auth: { type: 'none' },
      transport: { type: 'streamableHttp', url: 'http://replacement.test/mcp' },
      status: { deployed: true, ready: true, authoritative: true },
    })
    const connectError = new Error('replacement connect failed')
    const serverState = new Map([[previous.name, JSON.stringify(previous)]])
    const manager = {
      addServer: appliedAdmission(),
      replaceServer: appliedAdmission(
        vi.fn().mockRejectedValueOnce(connectError).mockResolvedValue(undefined)
      ),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => [previous.name]),
      getKnownServers: vi.fn(() => [previous.name]),
      recordAdmissionFailure: vi.fn(),
    }
    const options = {
      servers: [modified],
      manager,
      serverState,
      getAuthToken: vi.fn(),
    }

    await expect(reconcileAuthoritativeMcpSnapshot(options)).resolves.toBeUndefined()

    expect(manager.replaceServer).toHaveBeenCalledWith(modified, undefined, expect.any(Object))
    expect(manager.removeServer).not.toHaveBeenCalled()
    expect(manager.addServer).not.toHaveBeenCalled()
    expect(manager.recordAdmissionFailure).not.toHaveBeenCalled()
    expect(serverState.get(previous.name)).toBe(JSON.stringify(previous))

    await expect(reconcileAuthoritativeMcpSnapshot(options)).resolves.toBeUndefined()
    expect(manager.replaceServer).toHaveBeenCalledTimes(2)
    expect(serverState.get(modified.name)).toBe(JSON.stringify(modified))
  })

  it('revokes the old bearer before admitting a changed credential revision', async () => {
    const previous = readyServer({
      auth: undefined,
      authRequired: true,
      credentialRevision: 'credential-revision-1',
    })
    const rotated = readyServer({
      auth: undefined,
      authRequired: true,
      credentialRevision: 'credential-revision-2',
    })
    const connected = new Set([previous.name])
    const effects: string[] = []
    const manager = {
      addServer: appliedAdmission(),
      replaceServer: appliedAdmission(async (_server, authToken) => {
        effects.push(`replace:${authToken}`)
        connected.add(rotated.name)
      }),
      removeServer: vi.fn(),
      detachServer: vi.fn((name: string) => {
        effects.push('detach')
        connected.delete(name)
        return vi.fn().mockResolvedValue(undefined)
      }),
      getConnectedServers: vi.fn(() => [...connected]),
      getKnownServers: vi.fn(() => [previous.name]),
      recordAdmissionFailure: vi.fn(),
    }
    const getAuthToken = vi.fn(async () => {
      effects.push('credential')
      return 'rotated-token'
    })
    const serverState = new Map([[previous.name, JSON.stringify(previous)]])

    await reconcileAuthoritativeMcpSnapshot({
      servers: [rotated],
      manager,
      serverState,
      getAuthToken,
    })

    expect(effects[0]).toBe('detach')
    expect(getAuthToken).toHaveBeenCalledWith(rotated.name, 'credential-revision-2')
    expect(effects).toEqual(['detach', 'credential', 'replace:rotated-token'])
    expect(serverState.get(rotated.name)).toBe(JSON.stringify(rotated))
  })

  it('does not tear down a healthy connection for a status-only readiness degradation', async () => {
    const previous = readyServer()
    const degraded = readyServer({
      status: {
        deployed: false,
        ready: false,
        authoritative: false,
        message: 'Deployment status unknown',
      },
    })
    const serverState = new Map([[previous.name, JSON.stringify(previous)]])
    const manager = {
      addServer: appliedAdmission(),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => [previous.name]),
      getKnownServers: vi.fn(() => [previous.name]),
      recordAdmissionFailure: vi.fn(),
    }

    await reconcileAuthoritativeMcpSnapshot({
      servers: [degraded],
      manager,
      serverState,
      getAuthToken: vi.fn(),
    })

    expect(manager.removeServer).not.toHaveBeenCalled()
    expect(manager.addServer).not.toHaveBeenCalled()
    expect(serverState.get(previous.name)).toBe(JSON.stringify(degraded))
  })

  it('disconnects and marks not-ready when the false status is authoritative', async () => {
    const effects: string[] = []
    const previous = readyServer()
    const notReady = readyServer({
      status: {
        deployed: true,
        ready: false,
        authoritative: true,
        message: 'Secret validation failed',
      },
    })
    const serverState = new Map([[previous.name, JSON.stringify(previous)]])
    const manager = {
      addServer: appliedAdmission(async () => {
        effects.push('mark-not-ready')
      }),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(async () => {
        effects.push('remove')
      }),
      getConnectedServers: vi.fn(() => [previous.name]),
      getKnownServers: vi.fn(() => [previous.name]),
      recordAdmissionFailure: vi.fn(),
    }

    await reconcileAuthoritativeMcpSnapshot({
      servers: [notReady],
      manager,
      serverState,
      getAuthToken: vi.fn(),
    })

    expect(effects).toEqual(['remove', 'mark-not-ready'])
    expect(manager.addServer).toHaveBeenCalledWith(notReady, undefined, expect.any(Object))
    expect(serverState.get(previous.name)).toBe(JSON.stringify(notReady))
  })

  it.each([
    [
      'disabled',
      readyServer({
        enabled: false,
        status: { deployed: true, ready: true, authoritative: true },
      }),
    ],
    [
      'authoritatively not-ready',
      readyServer({
        status: { deployed: true, ready: false, authoritative: true },
      }),
    ],
    // Absent `authoritative` must keep the legacy fail-closed contract on the
    // synchronous revoke path too. Without this row the condition can be
    // narrowed to `authoritative === true` and every other test still passes.
    [
      'not-ready without an authoritative field',
      readyServer({
        status: { deployed: false, ready: false, message: 'Deployment not ready' },
      }),
    ],
  ])(
    'synchronously detaches a connected %s server before asynchronous reconciliation',
    async (_reason, next) => {
      const previous = readyServer()
      const detachServer = vi.fn(() => vi.fn().mockResolvedValue(undefined))
      const manager = {
        addServer: appliedAdmission(),
        replaceServer: appliedAdmission(),
        removeServer: vi.fn().mockResolvedValue(undefined),
        detachServer,
        getConnectedServers: vi.fn(() => [previous.name]),
        getKnownServers: vi.fn(() => [previous.name]),
        recordAdmissionFailure: vi.fn(),
      }

      const reconciliation = reconcileAuthoritativeMcpSnapshot({
        servers: [next],
        manager,
        serverState: new Map([[previous.name, JSON.stringify(previous)]]),
        getAuthToken: vi.fn(),
      })

      expect(detachServer).toHaveBeenCalledWith(previous.name)
      await reconciliation
    }
  )

  it('preserves the legacy fail-closed revocation contract when HCC omits authoritative', async () => {
    const previous = readyServer()
    const legacyNotReady = readyServer({
      status: { deployed: false, ready: false, message: 'Deployment not ready' },
    })
    const serverState = new Map([[previous.name, JSON.stringify(previous)]])
    const manager = {
      addServer: appliedAdmission(),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn().mockResolvedValue(undefined),
      getConnectedServers: vi.fn(() => [previous.name]),
      getKnownServers: vi.fn(() => [previous.name]),
      recordAdmissionFailure: vi.fn(),
    }

    await reconcileAuthoritativeMcpSnapshot({
      servers: [legacyNotReady],
      manager,
      serverState,
      getAuthToken: vi.fn(),
    })

    expect(manager.removeServer).toHaveBeenCalledWith(previous.name)
    expect(manager.addServer).toHaveBeenCalledWith(
      legacyNotReady,
      undefined,
      expect.objectContaining({ isCurrent: expect.any(Function) })
    )
    expect(serverState.get(previous.name)).toBe(JSON.stringify(legacyNotReady))
  })

  it('admits an unconnected server when its observed readiness becomes true', async () => {
    const notReady = readyServer({
      auth: { type: 'none' },
      status: { deployed: true, ready: false },
    })
    const ready = readyServer({
      auth: { type: 'none' },
      status: { deployed: true, ready: true, authoritative: true },
    })
    const serverState = new Map([[notReady.name, JSON.stringify(notReady)]])
    const manager = {
      addServer: appliedAdmission(),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => []),
      getKnownServers: vi.fn(() => [notReady.name]),
      recordAdmissionFailure: vi.fn(),
    }

    await reconcileAuthoritativeMcpSnapshot({
      servers: [ready],
      manager,
      serverState,
      getAuthToken: vi.fn(),
    })

    expect(manager.removeServer).not.toHaveBeenCalled()
    expect(manager.addServer).toHaveBeenCalledWith(ready, undefined, expect.any(Object))
    expect(serverState.get(ready.name)).toBe(JSON.stringify(ready))
  })

  it('records but never admits a new explicitly non-authoritative ready snapshot', async () => {
    const nonAuthoritative = readyServer({
      status: {
        deployed: true,
        ready: true,
        authoritative: false,
        message: 'Status identity could not be verified',
      },
    })
    const serverState = new Map<string, string>()
    const manager = {
      addServer: appliedAdmission(),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => []),
      getKnownServers: vi.fn(() => []),
      recordAdmissionFailure: vi.fn(),
    }
    const getAuthToken = vi.fn()

    await reconcileAuthoritativeMcpSnapshot({
      servers: [nonAuthoritative],
      manager,
      serverState,
      getAuthToken,
    })

    expect(getAuthToken).not.toHaveBeenCalled()
    expect(manager.addServer).toHaveBeenCalledWith(nonAuthoritative, undefined, expect.any(Object))
    expect(manager.removeServer).not.toHaveBeenCalled()
    expect(serverState.get(nonAuthoritative.name)).toBe(JSON.stringify(nonAuthoritative))
  })

  it('retires a changed desired revision without admitting non-authoritative status', async () => {
    const previous = readyServer()
    const modified = readyServer({
      transport: { type: 'streamableHttp', url: 'http://replacement.test/mcp' },
      status: {
        deployed: true,
        ready: true,
        authoritative: false,
        message: 'Status identity could not be verified',
      },
    })
    const serverState = new Map([[previous.name, JSON.stringify(previous)]])
    const manager = {
      addServer: appliedAdmission(),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn().mockResolvedValue(undefined),
      getConnectedServers: vi.fn(() => [previous.name]),
      getKnownServers: vi.fn(() => [previous.name]),
      recordAdmissionFailure: vi.fn(),
    }
    const getAuthToken = vi.fn()

    await reconcileAuthoritativeMcpSnapshot({
      servers: [modified],
      manager,
      serverState,
      getAuthToken,
    })

    expect(manager.removeServer).toHaveBeenCalledWith(previous.name)
    expect(getAuthToken).not.toHaveBeenCalled()
    expect(manager.addServer).toHaveBeenCalledWith(modified, undefined, expect.any(Object))
    expect(serverState.get(modified.name)).toBe(JSON.stringify(modified))
  })

  it('does not reconnect when desired objects differ only by key insertion order', async () => {
    const current = readyServer({
      auth: { type: 'bearer', secretRef: 'secured-server-auth', secretKey: 'token' },
    })
    const previousWithDifferentKeyOrder = {
      enabled: true,
      transport: {
        url: 'http://secured-server.test/mcp',
        type: 'streamableHttp',
      },
      contextRef: 'production',
      name: 'secured-server',
      auth: { secretKey: 'token', secretRef: 'secured-server-auth', type: 'bearer' },
      status: { ready: true, deployed: true },
    } as McpServerInfo
    const serverState = new Map([[current.name, JSON.stringify(previousWithDifferentKeyOrder)]])
    const manager = {
      addServer: appliedAdmission(),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => [current.name]),
      getKnownServers: vi.fn(() => [current.name]),
      recordAdmissionFailure: vi.fn(),
    }

    await reconcileAuthoritativeMcpSnapshot({
      servers: [current],
      manager,
      serverState,
      getAuthToken: vi.fn(),
    })

    expect(manager.replaceServer).not.toHaveBeenCalled()
    expect(manager.removeServer).not.toHaveBeenCalled()
    expect(manager.addServer).not.toHaveBeenCalled()
    expect(serverState.get(current.name)).toBe(JSON.stringify(current))
  })

  it('retains reconnect semantics for a desired transport change', async () => {
    const effects: string[] = []
    const previous = readyServer({ auth: { type: 'none' } })
    const modified = readyServer({
      auth: { type: 'none' },
      transport: { type: 'streamableHttp', url: 'http://replacement.test/mcp' },
      status: {
        deployed: false,
        ready: false,
        authoritative: true,
        message: 'Deployment not ready',
      },
    })
    const serverState = new Map([[previous.name, JSON.stringify(previous)]])
    const manager = {
      addServer: appliedAdmission(async () => {
        effects.push('add')
      }),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(async () => {
        effects.push('remove')
      }),
      getConnectedServers: vi.fn(() => [previous.name]),
      getKnownServers: vi.fn(() => [previous.name]),
      recordAdmissionFailure: vi.fn(),
    }

    await reconcileAuthoritativeMcpSnapshot({
      servers: [modified],
      manager,
      serverState,
      getAuthToken: vi.fn(),
    })

    expect(effects).toEqual(['remove', 'add'])
    expect(serverState.get(modified.name)).toBe(JSON.stringify(modified))
  })

  it('retains authoritative deletion semantics', async () => {
    const previous = readyServer({ auth: { type: 'none' } })
    const serverState = new Map([[previous.name, JSON.stringify(previous)]])
    const manager = {
      addServer: appliedAdmission(),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn().mockResolvedValue(undefined),
      getConnectedServers: vi.fn(() => [previous.name]),
      getKnownServers: vi.fn(() => [previous.name]),
      recordAdmissionFailure: vi.fn(),
    }

    await reconcileAuthoritativeMcpSnapshot({
      servers: [],
      manager,
      serverState,
      getAuthToken: vi.fn(),
    })

    expect(manager.removeServer).toHaveBeenCalledWith(previous.name)
    expect(serverState.has(previous.name)).toBe(false)
  })

  it('does not record a failed connection twice and leaves its revision retryable', async () => {
    const server = readyServer({ auth: { type: 'none' } })
    const serverState = new Map<string, string>()
    const connectError = new Error('MCP connect failed')
    const manager = {
      addServer: appliedAdmission(vi.fn().mockRejectedValueOnce(connectError)),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => []),
      getKnownServers: vi.fn(() => []),
      recordAdmissionFailure: vi.fn(),
    }
    const options = {
      servers: [server],
      manager,
      serverState,
      getAuthToken: vi.fn(),
    }

    await expect(reconcileAuthoritativeMcpSnapshot(options)).resolves.toBeUndefined()
    expect(serverState.has(server.name)).toBe(false)
    expect(manager.recordAdmissionFailure).not.toHaveBeenCalled()

    await expect(reconcileAuthoritativeMcpSnapshot(options)).resolves.toBeUndefined()
    expect(manager.addServer).toHaveBeenCalledTimes(2)
    expect(serverState.get(server.name)).toBe(JSON.stringify(server))
  })

  it('records an auth-discovery failure once and leaves its revision retryable', async () => {
    const server = readyServer()
    const serverState = new Map<string, string>()
    const authError = new Error('auth discovery failed')
    const manager = {
      addServer: appliedAdmission(),
      replaceServer: appliedAdmission(),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => []),
      getKnownServers: vi.fn(() => []),
      recordAdmissionFailure: vi.fn(),
    }

    await reconcileAuthoritativeMcpSnapshot({
      servers: [server],
      manager,
      serverState,
      getAuthToken: vi.fn().mockRejectedValue(authError),
    })

    expect(manager.addServer).not.toHaveBeenCalled()
    expect(manager.recordAdmissionFailure).toHaveBeenCalledTimes(1)
    expect(manager.recordAdmissionFailure).toHaveBeenCalledWith(server, authError)
    expect(serverState.has(server.name)).toBe(false)
  })
})
