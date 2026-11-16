import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextMapperRequestError } from '../contextMapperClient'
import {
  type ContextMapperPollState,
  contextMapperPollState,
  createContextMapperPoll,
} from '../main'
import { AuthoritativeMcpFleetCoordinator } from '../mcp/authoritativeFleet'
import type { McpServerInfo } from '../types'

/**
 * BR-15 (#1491): the adapter that binds runContextMapperPoll to the process
 * state. main() builds its poll with createContextMapperPoll, so these tests
 * run the adapter production runs, with the state a test can observe.
 */

function readyServer(name = 'secured-server'): McpServerInfo {
  return {
    name,
    transport: { type: 'streamableHttp', url: `http://${name}.test/mcp` },
    auth: { type: 'bearer', secretRef: `${name}-auth` },
    enabled: true,
    credentialRevision: 'rev-1',
    status: { deployed: true, ready: true, authoritative: true },
  }
}

function fakeManager() {
  const connected = new Set<string>()
  return {
    connected,
    getConnectedServers: vi.fn(() => [...connected]),
    getKnownServers: vi.fn(() => [...connected]),
    replaceServer: vi.fn(async () => 'applied' as const),
    recordAdmissionFailure: vi.fn(),
    removeServer: vi.fn(async (name: string) => {
      connected.delete(name)
    }),
    addServer: vi.fn(
      async (
        server: McpServerInfo,
        _authToken?: string,
        control?: { isCurrent?: () => boolean; onCommit?: () => void }
      ) => {
        if (control?.isCurrent?.() === false) return 'stale' as const
        connected.add(server.name)
        control?.onCommit?.()
        return 'applied' as const
      }
    ),
  }
}

type Manager = ReturnType<typeof fakeManager>

function harness(overrides: Partial<ContextMapperPollState<Manager>> = {}) {
  const manager = fakeManager()
  const client = {
    pollServers: vi.fn(async () => ({ servers: [readyServer()], timestamp: 't' })),
    getAuthToken: vi.fn(async () => 'token-for-secured-server'),
  }
  const serverState = new Map<string, string>()
  const state: ContextMapperPollState<Manager> = {
    getClient: () => client,
    getManager: () => manager,
    isShuttingDown: () => false,
    initialize: vi.fn(async () => {}),
    getServerState: () => serverState,
    coordinator: new AuthoritativeMcpFleetCoordinator(2, 2),
    recordSuccess: vi.fn(),
    lastSuccessAt: () => Date.now(),
    revoke: vi.fn(),
    ...overrides,
  }
  return { manager, client, serverState, state, poll: createContextMapperPoll(state) }
}

describe('createContextMapperPoll (BR-15, #1491): the adapter main() polls with', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('A1 a successful poll reconciles the snapshot into the current manager and state, then records success', async () => {
    const h = harness()
    const publish = vi.spyOn(h.state.coordinator, 'publishSnapshot')

    await h.poll()

    expect(h.client.pollServers).toHaveBeenCalledTimes(1)
    // The fleet coordinator this process holds published the snapshot.
    expect(publish).toHaveBeenCalledTimes(1)
    // The snapshot reached the manager this process holds, with a token from this client.
    expect(h.manager.addServer).toHaveBeenCalledTimes(1)
    expect(h.manager.addServer.mock.calls[0][0]).toMatchObject({ name: 'secured-server' })
    expect(h.manager.addServer.mock.calls[0][1]).toBe('token-for-secured-server')
    expect(h.client.getAuthToken).toHaveBeenCalledWith('secured-server', 'rev-1')
    // The revision landed in the server state this process holds.
    expect(h.serverState.has('secured-server')).toBe(true)
    expect(h.state.recordSuccess).toHaveBeenCalledTimes(1)
    expect(h.state.revoke).not.toHaveBeenCalled()
    expect(h.state.initialize).not.toHaveBeenCalled()
  })

  it('A2 without a client the poll does nothing', async () => {
    // A stale last success: a poll that ran without a client would fail and revoke.
    const h = harness({ getClient: () => null, lastSuccessAt: () => 1 })

    await h.poll()

    // Witness for the negatives below: the same harness with a client polls (A1).
    expect(h.state.initialize).not.toHaveBeenCalled()
    expect(h.state.recordSuccess).not.toHaveBeenCalled()
    expect(h.manager.addServer).not.toHaveBeenCalled()
    expect(h.state.revoke).not.toHaveBeenCalled()
  })

  it('A3 without a published manager the poll runs the initialization and nothing else', async () => {
    const h = harness({ getManager: () => null })

    await h.poll()

    expect(h.state.initialize).toHaveBeenCalledTimes(1)
    expect(h.client.pollServers).not.toHaveBeenCalled()
    expect(h.state.recordSuccess).not.toHaveBeenCalled()
  })

  it('A4 a snapshot that resolves after shutdown began is not published and records no success', async () => {
    let shuttingDown = false
    const h = harness({ isShuttingDown: () => shuttingDown })
    h.client.pollServers.mockImplementationOnce(async () => {
      shuttingDown = true
      return { servers: [readyServer()], timestamp: 't' }
    })

    await h.poll()

    // Witness: the fetch ran and resolved.
    expect(h.client.pollServers).toHaveBeenCalledTimes(1)
    expect(h.manager.addServer).not.toHaveBeenCalled()
    expect(h.state.recordSuccess).not.toHaveBeenCalled()
  })

  it('A5 an inventory-authority revocation from HCC revokes through the process state', async () => {
    const h = harness()
    h.client.pollServers.mockRejectedValueOnce(
      new ContextMapperRequestError(404, 'inventory', false)
    )

    await h.poll()

    expect(h.state.revoke).toHaveBeenCalledTimes(1)
    expect(h.state.revoke).toHaveBeenCalledWith('inventory_not_found', true)
    expect(h.state.recordSuccess).not.toHaveBeenCalled()
  })

  it('A6 an unavailable HCC revokes only once the last success is older than the staleness bound', async () => {
    const fresh = harness({ lastSuccessAt: () => Date.now() })
    fresh.client.pollServers.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    await fresh.poll()
    // Witness: the failure path ran (the poll was attempted and no success recorded).
    expect(fresh.client.pollServers).toHaveBeenCalledTimes(1)
    expect(fresh.state.recordSuccess).not.toHaveBeenCalled()
    expect(fresh.state.revoke).not.toHaveBeenCalled()

    const stale = harness({ lastSuccessAt: () => 1 })
    stale.client.pollServers.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    await stale.poll()
    expect(stale.state.revoke).toHaveBeenCalledWith('authority_stale', true)

    const unpublished = harness({ lastSuccessAt: () => 1 })
    let calls = 0
    // The manager is published when the poll starts and withdrawn when it fails.
    unpublished.state.getManager = () => (calls++ === 0 ? unpublished.manager : null)
    const poll = createContextMapperPoll(unpublished.state)
    unpublished.client.pollServers.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    await poll()
    expect(unpublished.client.pollServers).toHaveBeenCalledTimes(1)
    expect(unpublished.state.revoke).not.toHaveBeenCalled()
  })
})

describe('contextMapperPollState (BR-15): the state main() passes to the adapter', () => {
  it('A7 recordSuccess moves the last success the failure path reads, and revoke clears it', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-16T00:00:00Z'))
      contextMapperPollState.recordSuccess()
      expect(contextMapperPollState.lastSuccessAt()).toBe(Date.now())

      contextMapperPollState.revoke('br15-test', false)
      expect(contextMapperPollState.lastSuccessAt()).toBe(0)
      expect(contextMapperPollState.getManager()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
