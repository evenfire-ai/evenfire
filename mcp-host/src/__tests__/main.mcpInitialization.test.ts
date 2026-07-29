import { describe, expect, it, vi } from 'vitest'
import {
  admitDevelopmentMcpServers,
  createCoalescedPollRunner,
  reconcileAuthoritativeMcpSnapshot,
  replaceAuthoritativeMcpFleet,
  runAuthoritativeMcpInitialization,
  startContextMapperPolling,
  stopContextMapperPolling,
} from '../main'
import { McpManager } from '../mcp/manager'
import type { McpServerInfo } from '../types'

function readyServer(overrides: Partial<McpServerInfo> = {}): McpServerInfo {
  return {
    name: 'secured-server',
    contextRef: 'production',
    transport: { type: 'streamableHttp', url: 'http://secured-server.test/mcp' },
    auth: { type: 'bearer', secretRef: 'secured-server-auth' },
    enabled: true,
    status: { deployed: true, ready: true },
    ...overrides,
  }
}

describe('admitDevelopmentMcpServers', () => {
  it('continues admitting peers when one development server is unavailable', async () => {
    const firstServer = readyServer({ name: 'first-server', auth: { type: 'none' } })
    const failedServer = readyServer({ name: 'failed-server', auth: { type: 'none' } })
    const thirdServer = readyServer({ name: 'third-server', auth: { type: 'none' } })
    const addServer = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('MCP connect failed'))
      .mockResolvedValueOnce(undefined)

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
      listServersByContext: vi.fn(async () => {
        effects.push('snapshot')
        return []
      }),
    }

    await runAuthoritativeMcpInitialization({
      contextRef: 'production',
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
        contextRef: 'production',
        client: {
          healthCheck: vi.fn().mockResolvedValue(true),
          listServersByContext: vi.fn().mockRejectedValue(discoveryError),
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

  it('fails explicitly after readiness retry exhaustion without replacing the prior fleet', async () => {
    const replaceFleet = vi.fn()
    const sleep = vi.fn().mockResolvedValue(undefined)
    const healthCheck = vi.fn().mockResolvedValue(false)
    const listServersByContext = vi.fn()

    await expect(
      runAuthoritativeMcpInitialization({
        contextRef: 'production',
        client: { healthCheck, listServersByContext },
        replaceFleet,
        sleep,
        maxRetries: 2,
      })
    ).rejects.toThrow('Context Mapper was not ready after 2 attempts')

    expect(healthCheck).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(listServersByContext).not.toHaveBeenCalled()
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

describe('context-mapper polling lifecycle', () => {
  it('keeps exactly one interval producer when polling is started again', () => {
    vi.useFakeTimers()
    try {
      startContextMapperPolling('first-context')
      expect(vi.getTimerCount()).toBe(1)

      startContextMapperPolling('replacement-context')
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      stopContextMapperPolling()
      vi.useRealTimers()
    }
  })
})

describe('replaceAuthoritativeMcpFleet', () => {
  it('publishes healthy servers, retains the failed admission status, and leaves its revision retryable', async () => {
    const firstServer = readyServer({ name: 'first-server', auth: { type: 'none' } })
    const failedServer = readyServer({ name: 'failed-server', auth: { type: 'none' } })
    const thirdServer = readyServer({ name: 'third-server', auth: { type: 'none' } })
    const connectError = new Error('MCP connect failed')
    const candidateManager = {
      addServer: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(connectError)
        .mockResolvedValueOnce(undefined),
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
      addServer: vi.fn(),
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
      addServer: vi.fn(),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
    }
    const candidateManager = {
      addServer: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(connectError),
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

    expect(candidateManager.addServer).toHaveBeenNthCalledWith(1, firstServer, undefined)
    expect(candidateManager.addServer).toHaveBeenNthCalledWith(2, failingServer, undefined)
    expect(candidateManager.recordAdmissionFailure).not.toHaveBeenCalled()
    expect(installFleet).not.toHaveBeenCalled()
    expect(candidateManager.disconnectAll).toHaveBeenCalledTimes(1)
    expect(previousManager.disconnectAll).not.toHaveBeenCalled()
  })

  it('installs an HTTP 200 empty fleet before retiring the prior fleet', async () => {
    const effects: string[] = []
    const previousManager = {
      addServer: vi.fn(),
      disconnectAll: vi.fn(async () => {
        effects.push('retire-prior')
      }),
    }
    const candidateManager = {
      addServer: vi.fn(),
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
      addServer: vi.fn(),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
    }
    const candidateManager = {
      addServer: vi.fn().mockResolvedValue(undefined),
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

    expect(candidateManager.addServer).toHaveBeenCalledWith(notReady, undefined)
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
      addServer: vi.fn(),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
    }
    const candidateManager = {
      addServer: vi.fn(),
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
    expect(candidateManager.addServer).toHaveBeenCalledWith(nonAuthoritative, undefined)
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
      addServer: vi.fn(),
      disconnectAll: vi.fn().mockRejectedValue(cleanupError),
    }
    const candidateManager = {
      addServer: vi.fn(),
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
      addServer: vi.fn(),
      replaceServer: vi.fn().mockRejectedValueOnce(connectError).mockResolvedValueOnce(undefined),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => [previous.name]),
      recordAdmissionFailure: vi.fn(),
    }
    const options = {
      servers: [modified],
      manager,
      serverState,
      getAuthToken: vi.fn(),
    }

    await expect(reconcileAuthoritativeMcpSnapshot(options)).resolves.toBeUndefined()

    expect(manager.replaceServer).toHaveBeenCalledWith(modified, undefined)
    expect(manager.removeServer).not.toHaveBeenCalled()
    expect(manager.addServer).not.toHaveBeenCalled()
    expect(manager.recordAdmissionFailure).not.toHaveBeenCalled()
    expect(serverState.get(previous.name)).toBe(JSON.stringify(previous))

    await expect(reconcileAuthoritativeMcpSnapshot(options)).resolves.toBeUndefined()
    expect(manager.replaceServer).toHaveBeenCalledTimes(2)
    expect(serverState.get(modified.name)).toBe(JSON.stringify(modified))
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
      addServer: vi.fn(),
      replaceServer: vi.fn(),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => [previous.name]),
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
      addServer: vi.fn(async () => {
        effects.push('mark-not-ready')
      }),
      replaceServer: vi.fn(),
      removeServer: vi.fn(async () => {
        effects.push('remove')
      }),
      getConnectedServers: vi.fn(() => [previous.name]),
      recordAdmissionFailure: vi.fn(),
    }

    await reconcileAuthoritativeMcpSnapshot({
      servers: [notReady],
      manager,
      serverState,
      getAuthToken: vi.fn(),
    })

    expect(effects).toEqual(['remove', 'mark-not-ready'])
    expect(manager.addServer).toHaveBeenCalledWith(notReady, undefined)
    expect(serverState.get(previous.name)).toBe(JSON.stringify(notReady))
  })

  it('retains legacy fail-closed teardown when status authority is undefined', async () => {
    const previous = readyServer()
    const legacyNotReady = readyServer({
      status: { deployed: false, ready: false, message: 'Deployment not ready' },
    })
    const serverState = new Map([[previous.name, JSON.stringify(previous)]])
    const manager = {
      addServer: vi.fn().mockResolvedValue(undefined),
      replaceServer: vi.fn(),
      removeServer: vi.fn().mockResolvedValue(undefined),
      getConnectedServers: vi.fn(() => [previous.name]),
      recordAdmissionFailure: vi.fn(),
    }

    await reconcileAuthoritativeMcpSnapshot({
      servers: [legacyNotReady],
      manager,
      serverState,
      getAuthToken: vi.fn(),
    })

    expect(manager.removeServer).toHaveBeenCalledWith(previous.name)
    expect(manager.addServer).toHaveBeenCalledWith(legacyNotReady, undefined)
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
      addServer: vi.fn().mockResolvedValue(undefined),
      replaceServer: vi.fn(),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => []),
      recordAdmissionFailure: vi.fn(),
    }

    await reconcileAuthoritativeMcpSnapshot({
      servers: [ready],
      manager,
      serverState,
      getAuthToken: vi.fn(),
    })

    expect(manager.removeServer).not.toHaveBeenCalled()
    expect(manager.addServer).toHaveBeenCalledWith(ready, undefined)
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
      addServer: vi.fn(),
      replaceServer: vi.fn(),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => []),
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
    expect(manager.addServer).toHaveBeenCalledWith(nonAuthoritative, undefined)
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
      addServer: vi.fn(),
      replaceServer: vi.fn(),
      removeServer: vi.fn().mockResolvedValue(undefined),
      getConnectedServers: vi.fn(() => [previous.name]),
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
    expect(manager.addServer).toHaveBeenCalledWith(modified, undefined)
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
      addServer: vi.fn(),
      replaceServer: vi.fn(),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => [current.name]),
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
      addServer: vi.fn(async () => {
        effects.push('add')
      }),
      replaceServer: vi.fn(),
      removeServer: vi.fn(async () => {
        effects.push('remove')
      }),
      getConnectedServers: vi.fn(() => [previous.name]),
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
      addServer: vi.fn(),
      replaceServer: vi.fn(),
      removeServer: vi.fn().mockResolvedValue(undefined),
      getConnectedServers: vi.fn(() => [previous.name]),
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
      addServer: vi.fn().mockRejectedValueOnce(connectError).mockResolvedValueOnce(undefined),
      replaceServer: vi.fn(),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => []),
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
      addServer: vi.fn(),
      replaceServer: vi.fn(),
      removeServer: vi.fn(),
      getConnectedServers: vi.fn(() => []),
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
