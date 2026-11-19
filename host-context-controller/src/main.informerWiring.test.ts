import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import type { DeploymentObservation } from './informers/deploymentInformer'
import type { SecretEvent } from './informers/secretInformer'

// main.ts is the composition root: it starts at import time and, through
// startMcpServerInformers (src/informers/mcpServerInformers.ts), wires the
// Deployment informer and the three Secret informers to the watcher. Secret-change
// evidence (#1338) depends on the event type reaching the watcher unchanged: a
// MODIFIED or DELETED records evidence, an ADDED does not. Every collaborator is
// replaced below, so the wiring in main.ts and mcpServerInformers.ts is the code
// under test.

type CapturedSecretInformer = {
  namespace: string
  consumer: (evt: SecretEvent) => void
  options: unknown
  started: boolean
}

type CapturedDeploymentInformer = {
  namespace: string
  consumer: (observation: DeploymentObservation) => void
  list: unknown
  started: boolean
}

const h = vi.hoisted(() => ({
  secretInformers: [] as CapturedSecretInformer[],
  deploymentInformers: [] as CapturedDeploymentInformer[],
  stopOrder: [] as string[],
  // The Deployment informer's start never settles here: main must not wait for it.
  deploymentStart: new Promise<boolean>(() => {}),
  watcher: null as null | {
    handleSecretEvent: ReturnType<typeof vi.fn>
    handleDeploymentObservation: ReturnType<typeof vi.fn>
    reconcileChannelReaderRevision: ReturnType<typeof vi.fn>
    reconcileLlmHookByEnvSecret: ReturnType<typeof vi.fn>
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('./config', () => ({
  config: {
    devMode: false,
    port: 8081,
    desktopApiToken: 'desktop-api-token-for-tests',
    internalControlJwtHccHmacSecret: 'hmac-secret-for-tests',
    hccTargetNamespace: 'mcp-host',
    hostNamespace: 'mcp-host',
    mcpHostJwtPublicKey: 'public-key-for-tests',
    mcpHostJwtIssuer: 'issuer-for-tests',
    mcpHostJwtMaxTtlSeconds: 900,
    namespace: 'mcp-server',
    channelsNamespace: 'channels',
    llmHooksNamespace: 'llm-hooks',
    k8sRequestTimeoutMs: 30_000,
  },
}))

vi.mock('./logger', () => ({ hccLogger: h.logger }))

vi.mock('./heartbeatPoller', () => ({
  HeartbeatPoller: class {
    start(): void {}
    stop(): void {}
  },
}))

vi.mock('./statelessLifecycleTracker', () => ({
  StatelessLifecycleTracker: class {
    stop(): void {}
  },
}))

vi.mock('./k8s/k8sRequestDeadline', () => ({
  makeK8sApiClientWithDeadline: (_kc: unknown, type: unknown, timeoutMs: number) => ({
    client: type,
    timeoutMs,
  }),
}))

vi.mock('./informers/secretInformer', () => ({
  secretListFromCoreApi: (api: unknown) => ({ secretListOf: api }),
  SecretInformer: class {
    private readonly captured: CapturedSecretInformer
    constructor(
      _kc: unknown,
      namespace: string,
      consumer: (evt: SecretEvent) => void,
      options: unknown
    ) {
      this.captured = { namespace, consumer, options, started: false }
      h.secretInformers.push(this.captured)
    }
    async start(): Promise<boolean> {
      this.captured.started = true
      return true
    }
    stop(): void {
      h.stopOrder.push(`secret:${this.captured.namespace}`)
    }
  },
}))

vi.mock('./informers/deploymentInformer', () => ({
  managedDeploymentListFromAppsApi: (api: unknown, namespace: string) => ({
    deploymentListOf: api,
    namespace,
  }),
  ManagedDeploymentInformer: class {
    private readonly captured: CapturedDeploymentInformer
    constructor(
      _kc: unknown,
      namespace: string,
      consumer: (observation: DeploymentObservation) => void,
      list: unknown
    ) {
      this.captured = { namespace, consumer, list, started: false }
      h.deploymentInformers.push(this.captured)
    }
    start(): Promise<boolean> {
      this.captured.started = true
      return h.deploymentStart
    }
    stop(): void {
      h.stopOrder.push('deployment')
    }
  },
}))

vi.mock('./k8sClient', () => {
  class McpServerWatcher {
    readonly handleSecretEvent = vi.fn()
    readonly handleDeploymentObservation = vi.fn()
    readonly reconcileChannelReaderRevision = vi.fn(async () => undefined)
    readonly reconcileLlmHookByEnvSecret = vi.fn(async () => undefined)
    getHostReconciler(): undefined {
      return undefined
    }
    onChange(): void {}
    getAllServers(): unknown[] {
      return []
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }
  return {
    McpServerWatcher,
    createMcpServerProvider: () => {
      const watcher = new McpServerWatcher()
      h.watcher = watcher
      return watcher
    },
    createMcpAuthorizationStore: () => ({}),
    getKubeConfig: () => ({}),
  }
})

vi.mock('./mcpApiAuthentication', () => ({ McpApiAuthenticator: class {} }))
vi.mock('./mcpAuthorization', () => ({ McpAuthorizationService: class {} }))

vi.mock('./readinessGate', () => ({
  resolveHostAuthoritativeFn: () => () => true,
  resolveProbeAuthoritativeFn: () => () => true,
  resolveProviderAuthoritativeFn: () => () => true,
  resolveReadinessDetailFn: () => () => undefined,
}))

vi.mock('./server', () => ({
  ContextMapperServer: class {
    async start(): Promise<void> {}
    setReady(): void {}
    async stop(): Promise<void> {}
  },
}))

vi.mock('./utils/internalControlSigner', () => ({
  assertInternalControlJwtHmacSecret: () => undefined,
  signInternalControlJwt: () => 'signed-for-tests',
}))

const RUNNING_LINE = '[Main] Host Context Controller running. Press Ctrl+C to exit.'

const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
  throw new Error(`main.ts called process.exit(${String(code)})`)
})
const originalOnce = process.once.bind(process)
const shutdownListeners = new Map<string, (...args: unknown[]) => unknown>()
const onceSpy = vi
  .spyOn(process, 'once')
  .mockImplementation((event: string | symbol, listener: (...args: unknown[]) => void) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      shutdownListeners.set(event, listener)
      return process
    }
    return originalOnce(event, listener)
  })

afterAll(() => {
  exitSpy.mockRestore()
  onceSpy.mockRestore()
})

beforeAll(async () => {
  await import('./main')
  await vi.waitFor(() => expect(h.logger.info).toHaveBeenCalledWith(RUNNING_LINE))
})

function secretInformerFor(namespace: string): CapturedSecretInformer {
  const matches = h.secretInformers.filter(informer => informer.namespace === namespace)
  expect(matches).toHaveLength(1)
  return matches[0]!
}

describe('main.ts informer wiring (#1338)', () => {
  it('hands every mcp-server Secret event to the watcher with its own type', () => {
    // Liveness: main ran to its end and started the three Secret informers.
    expect([...shutdownListeners.keys()]).toEqual(['SIGTERM', 'SIGINT'])
    expect(h.secretInformers.map(informer => informer.namespace)).toEqual([
      'mcp-server',
      'channels',
      'llm-hooks',
    ])
    expect(h.secretInformers.every(informer => informer.started)).toBe(true)
    const watcher = h.watcher
    expect(watcher).not.toBeNull()

    const events: SecretEvent[] = [
      { type: 'MODIFIED', name: 'pg-creds', namespace: 'mcp-server' },
      { type: 'DELETED', name: 'pg-creds', namespace: 'mcp-server' },
      { type: 'ADDED', name: 'api-key', namespace: 'mcp-server' },
    ]
    for (const evt of events) secretInformerFor('mcp-server').consumer(evt)
    expect(watcher!.handleSecretEvent.mock.calls).toEqual(events.map(evt => [evt]))

    // The other two informers feed their own consumers, not handleSecretEvent.
    secretInformerFor('channels').consumer({
      type: 'MODIFIED',
      name: 'reader-creds',
      namespace: 'channels',
    })
    secretInformerFor('llm-hooks').consumer({
      type: 'MODIFIED',
      name: 'hook-creds',
      namespace: 'llm-hooks',
    })
    expect(watcher!.reconcileChannelReaderRevision).toHaveBeenCalledExactlyOnceWith(
      'reader-creds',
      'channels'
    )
    expect(watcher!.reconcileLlmHookByEnvSecret).toHaveBeenCalledExactlyOnceWith(
      'hook-creds',
      'llm-hooks'
    )
    expect(watcher!.handleSecretEvent).toHaveBeenCalledTimes(events.length)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('runs only the mcp-server Secret informer in resume mode, with a list adapter on the request deadline', () => {
    expect(secretInformerFor('mcp-server').options).toEqual({
      mode: 'resume',
      list: { secretListOf: { client: k8s.CoreV1Api, timeoutMs: 30_000 } },
    })
    expect(secretInformerFor('channels').options).toEqual({ mode: 'replay' })
    expect(secretInformerFor('llm-hooks').options).toEqual({ mode: 'replay' })
  })

  it('starts the Deployment informer without waiting for it and hands its observations to the watcher', () => {
    expect(h.deploymentInformers).toHaveLength(1)
    const [deployment] = h.deploymentInformers
    expect(deployment.namespace).toBe('mcp-server')
    expect(deployment.list).toEqual({
      deploymentListOf: { client: k8s.AppsV1Api, timeoutMs: 30_000 },
      namespace: 'mcp-server',
    })
    // Its start never settles, yet main reached its running line.
    expect(deployment.started).toBe(true)
    expect(h.logger.info).toHaveBeenCalledWith(RUNNING_LINE)

    const observation: DeploymentObservation = {
      name: 'stuck-server',
      deleted: true,
      ready: false,
      generation: 0,
    }
    deployment.consumer(observation)
    expect(h.watcher!.handleDeploymentObservation.mock.calls).toEqual([[observation]])
  })

  it('SIGTERM stops the Deployment informer, then the three Secret informers', async () => {
    expect(h.stopOrder).toEqual([])

    await expect(shutdownListeners.get('SIGTERM')!()).rejects.toThrow(
      'main.ts called process.exit(0)'
    )

    expect(h.stopOrder).toEqual([
      'deployment',
      'secret:mcp-server',
      'secret:channels',
      'secret:llm-hooks',
    ])
  })
})
