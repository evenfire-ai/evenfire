import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextMapperClient, ContextMapperRequestError } from '../../contextMapperClient'
import type { McpServerInfo } from '../../types'
import { AuthoritativeMcpFleetCoordinator } from '../authoritativeFleet'
import {
  createMcpAuthorityStalenessDeadline,
  handleMcpAuthorityPollFailure,
  revokeMcpAuthorityState,
} from '../authorityLifecycle'
import { McpClient } from '../client'
import { McpManager, SHARED_PRINCIPAL, serializeClientKey } from '../manager'

const securedServer: McpServerInfo = {
  name: 'secured-server',
  transport: { type: 'streamableHttp', url: 'http://secured-server.test/mcp' },
  enabled: true,
  authRequired: true,
  credentialRevision: 'credential-revision-1',
  status: { deployed: true, ready: true, authoritative: true },
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function retainedClient(
  manager: McpManager,
  serverName = securedServer.name
): McpClient | undefined {
  return (
    manager as unknown as {
      clients: Map<string, McpClient>
    }
  ).clients.get(serializeClientKey(serverName, SHARED_PRINCIPAL))
}

function pendingClient(
  manager: McpManager,
  serverName = securedServer.name
): McpClient | undefined {
  return (
    manager as unknown as {
      pendingAdmissions: Map<string, { client: McpClient }>
    }
  ).pendingAdmissions.get(serializeClientKey(serverName, SHARED_PRINCIPAL))?.client
}

function createLifecycleHarness(
  manager: McpManager,
  coordinator = new AuthoritativeMcpFleetCoordinator(1, 1, true)
) {
  let currentManager: McpManager | null = manager
  let serverState = new Map([[securedServer.name, 'credential-revision-1']])
  let lastSuccessAt = 10_000
  let generation = 7
  let pollerRunning = true
  let clearDeadline: () => void = () => undefined
  const effects: string[] = []
  const reasons: string[] = []

  const originalCloseManager = coordinator.closeManager.bind(coordinator)
  vi.spyOn(coordinator, 'closeManager').mockImplementation(closingManager => {
    effects.push('coordinator-close')
    originalCloseManager(closingManager)
  })
  const originalScheduleCleanup = coordinator.scheduleCleanup.bind(coordinator)
  vi.spyOn(coordinator, 'scheduleCleanup').mockImplementation(cleanup => {
    effects.push('cleanup-scheduled')
    originalScheduleCleanup(cleanup)
  })
  const originalManagerClose = manager.close.bind(manager)
  vi.spyOn(manager, 'close').mockImplementation(scheduleCleanup => {
    effects.push('manager-close')
    return originalManagerClose(scheduleCleanup)
  })

  const revoke = (reason: string, restartPolling: boolean): void => {
    reasons.push(reason)
    revokeMcpAuthorityState({
      reason,
      restartPolling,
      invalidateInitialization: () => {
        effects.push('generation-invalidated')
        generation += 1
      },
      stopPolling: () => {
        effects.push('polling-stopped')
        pollerRunning = false
      },
      clearStalenessDeadline: () => {
        effects.push('deadline-cleared')
        clearDeadline()
      },
      withdrawManager: () => {
        effects.push('manager-withdrawn')
        const closingManager = currentManager
        currentManager = null
        return closingManager
      },
      clearServerState: () => {
        effects.push('server-state-cleared')
        serverState = new Map()
      },
      clearLastSuccess: () => {
        effects.push('last-success-cleared')
        lastSuccessAt = 0
      },
      coordinator,
      onCleanupFailure: () => effects.push('cleanup-failed'),
      onRevoked: () => effects.push('revoked'),
      shouldRestartPolling: () => true,
      startPolling: () => {
        effects.push('polling-started')
        pollerRunning = true
      },
    })
  }

  return {
    coordinator,
    effects,
    reasons,
    revoke,
    setDeadlineClear: (clear: () => void) => {
      clearDeadline = clear
    },
    state: () => ({
      currentManager,
      serverState,
      lastSuccessAt,
      generation,
      pollerRunning,
    }),
  }
}

async function captureError(effect: () => Promise<unknown>): Promise<unknown> {
  try {
    await effect()
  } catch (error) {
    return error
  }
  throw new Error('Expected operation to reject')
}

describe('MCP authority lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it.each([
    { status: 401 as const, expectedFetches: 2, expectedRefreshes: 1 },
    { status: 403 as const, expectedFetches: 1, expectedRefreshes: 0 },
  ])(
    'withdraws the live fleet synchronously and restarts polling after persistent $status',
    async ({ status, expectedFetches, expectedRefreshes }) => {
      vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (this: McpClient) {
        // Mimic the real connect's JIT token resolution so the post-revoke wipe
        // assertion below exercises currentAuthToken.
        ;(this as unknown as { currentAuthToken?: string }).currentAuthToken = await (
          this as unknown as { tokenProvider?: { resolve(): Promise<string | undefined> } }
        ).tokenProvider?.resolve()
        ;(this as unknown as { connected: boolean }).connected = true
      })
      const manager = new McpManager()
      await manager.addServer(securedServer, 'sensitive-upstream-bearer')
      const installedClient = retainedClient(manager)
      expect(installedClient).toBeDefined()

      const harness = createLifecycleHarness(manager)
      harness.coordinator.publishSnapshot(manager, [securedServer])
      const refresh = vi.fn().mockResolvedValue(undefined)
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status }))
      vi.stubGlobal('fetch', fetchMock)
      const client = new ContextMapperClient('http://context-mapper.test', {
        authentication: {
          getAccessToken: () => 'host-access-token',
          refreshOnUnauthorized: refresh,
          onCallerAuthorizationFailure: rejectedStatus =>
            harness.revoke(`caller_${rejectedStatus}`, true),
        },
      })

      const error = await captureError(() => client.pollServers())
      expect(error).toBeInstanceOf(ContextMapperRequestError)
      const disposition = handleMcpAuthorityPollFailure(error, {
        hasPublishedManager: () => harness.state().currentManager !== null,
        lastSuccessAt: () => harness.state().lastSuccessAt,
        now: () => 70_000,
        maxStalenessMs: 60_000,
        revoke: harness.revoke,
        onCallerAuthorizationRejected: vi.fn(),
        onInventoryAuthorityRevoked: vi.fn(),
        onUnavailable: vi.fn(),
      })

      expect(disposition).toBe('caller_authorization_rejected')
      expect(fetchMock).toHaveBeenCalledTimes(expectedFetches)
      expect(refresh).toHaveBeenCalledTimes(expectedRefreshes)
      expect(harness.reasons).toEqual([`caller_${status}`])
      expect(harness.state()).toMatchObject({
        currentManager: null,
        lastSuccessAt: 0,
        generation: 8,
        pollerRunning: true,
      })
      expect(harness.state().serverState.size).toBe(0)
      expect(
        (installedClient as unknown as { currentAuthToken?: string }).currentAuthToken
      ).toBeUndefined()
      expect(manager.getConnectedServers()).toEqual([])
      expect(manager.getKnownServers()).toEqual([])
      expect(harness.effects).toEqual([
        'generation-invalidated',
        'polling-stopped',
        'deadline-cleared',
        'manager-withdrawn',
        'server-state-cleared',
        'last-success-cleared',
        'coordinator-close',
        'manager-close',
        'cleanup-scheduled',
        'revoked',
        'polling-started',
      ])
      await expect(manager.addServer(securedServer, 'new-bearer')).resolves.toBe('stale')
      await harness.coordinator.drainCleanups()
    }
  )

  it('classifies an actual inventory 404 as complete authority revocation', async () => {
    const manager = new McpManager()
    const harness = createLifecycleHarness(manager)
    harness.coordinator.publishSnapshot(manager, [securedServer])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    const client = new ContextMapperClient('http://context-mapper.test', {
      authentication: {
        getAccessToken: () => 'host-access-token',
        refreshOnUnauthorized: vi.fn(),
        onCallerAuthorizationFailure: vi.fn(),
      },
    })
    const error = await captureError(() => client.pollServers())
    const inventoryRevoked = vi.fn()

    const disposition = handleMcpAuthorityPollFailure(error, {
      hasPublishedManager: () => harness.state().currentManager !== null,
      lastSuccessAt: () => harness.state().lastSuccessAt,
      now: () => 70_000,
      maxStalenessMs: 60_000,
      revoke: harness.revoke,
      onCallerAuthorizationRejected: vi.fn(),
      onInventoryAuthorityRevoked: inventoryRevoked,
      onUnavailable: vi.fn(),
    })

    expect(disposition).toBe('inventory_not_found')
    expect(inventoryRevoked).toHaveBeenCalledTimes(1)
    expect(harness.reasons).toEqual(['inventory_not_found'])
    expect(harness.state()).toMatchObject({ currentManager: null, pollerRunning: true })
    await harness.coordinator.drainCleanups()
  })

  it('revokes the full state at the absolute staleness deadline and restarts recovery polling', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'))
    const manager = new McpManager()
    const harness = createLifecycleHarness(manager)
    harness.coordinator.publishSnapshot(manager, [securedServer])
    const deadline = createMcpAuthorityStalenessDeadline(60_000, () =>
      harness.revoke('authority_stale_deadline', true)
    )
    harness.setDeadlineClear(deadline.clear)

    deadline.recordSuccess()
    vi.advanceTimersByTime(60_000)

    expect(harness.reasons).toEqual(['authority_stale_deadline'])
    expect(harness.state()).toMatchObject({
      currentManager: null,
      lastSuccessAt: 0,
      generation: 8,
      pollerRunning: true,
    })
    expect(harness.state().serverState.size).toBe(0)
  })

  it('revokes an unavailable stale fleet through the poll-error path', async () => {
    const manager = new McpManager()
    const harness = createLifecycleHarness(manager)
    harness.coordinator.publishSnapshot(manager, [securedServer])
    const unavailable = vi.fn()

    const disposition = handleMcpAuthorityPollFailure(new Error('transport unavailable'), {
      hasPublishedManager: () => harness.state().currentManager !== null,
      lastSuccessAt: () => harness.state().lastSuccessAt,
      now: () => 70_000,
      maxStalenessMs: 60_000,
      revoke: harness.revoke,
      onCallerAuthorizationRejected: vi.fn(),
      onInventoryAuthorityRevoked: vi.fn(),
      onUnavailable: unavailable,
    })

    expect(disposition).toBe('authority_stale')
    expect(unavailable).toHaveBeenCalledTimes(1)
    expect(harness.reasons).toEqual(['authority_stale'])
    expect(harness.state()).toMatchObject({ currentManager: null, pollerRunning: true })
    await harness.coordinator.drainCleanups()
  })

  it('fences a delayed admission so revocation cannot republish its bearer or tools', async () => {
    const connectStarted = deferred()
    const releaseConnect = deferred()
    vi.spyOn(McpClient.prototype, 'connect').mockImplementation(async function (this: McpClient) {
      // Mimic the real connect's JIT token resolution before the transport pause
      // so the fencing assertions (bearer held, then wiped) observe it.
      ;(this as unknown as { currentAuthToken?: string }).currentAuthToken = await (
        this as unknown as { tokenProvider?: { resolve(): Promise<string | undefined> } }
      ).tokenProvider?.resolve()
      connectStarted.resolve()
      await releaseConnect.promise
      if ((this as unknown as { retired: boolean }).retired) {
        throw new Error('MCP client is closed')
      }
      ;(this as unknown as { connected: boolean }).connected = true
    })
    const manager = new McpManager()
    const coordinator = new AuthoritativeMcpFleetCoordinator(1, 1, true)
    const lease = coordinator.publishSnapshot(manager, [securedServer])
    const harness = createLifecycleHarness(manager, coordinator)
    const committed = vi.fn()
    let outcome: string | undefined
    const admission = coordinator.runAdmission(
      manager,
      securedServer.name,
      lease,
      async isCurrent => {
        outcome = await manager.addServer(securedServer, 'late-sensitive-bearer', {
          isCurrent,
          onCommit: committed,
          scheduleCleanup: cleanup => coordinator.scheduleCleanup(cleanup),
        })
      }
    )

    await connectStarted.promise
    const candidate = pendingClient(manager)
    expect(candidate).toBeDefined()
    expect((candidate as unknown as { currentAuthToken?: string }).currentAuthToken).toBe(
      'late-sensitive-bearer'
    )

    harness.revoke('caller_403', true)

    expect(harness.state().currentManager).toBeNull()
    expect((candidate as unknown as { currentAuthToken?: string }).currentAuthToken).toBeUndefined()
    expect(manager.getConnectedServers()).toEqual([])
    expect(manager.getKnownServers()).toEqual([])
    releaseConnect.resolve()
    await admission
    await coordinator.drainCleanups()

    expect(outcome).toBe('stale')
    expect(committed).not.toHaveBeenCalled()
    expect(manager.getAllTools()).toEqual([])
    expect(manager.getConnectedServers()).toEqual([])
    expect(harness.state().currentManager).toBeNull()
  })
})
