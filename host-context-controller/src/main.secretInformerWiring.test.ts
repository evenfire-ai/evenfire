import { afterAll, describe, expect, it, vi } from 'vitest'
import type { SecretEvent } from './informers/secretInformer'

// main.ts is the composition root: it starts at import time and wires the
// mcp-server SecretInformer to the watcher's handleSecretEvent. Secret-change
// evidence (#1338) depends on the event type reaching the watcher unchanged: a
// MODIFIED or DELETED records evidence, an ADDED does not. Every collaborator is
// replaced below so that the wiring in main.ts is the code under test.

type CapturedInformer = {
  namespace: string
  consumer: (evt: SecretEvent) => void
  started: boolean
}

const h = vi.hoisted(() => ({
  informers: [] as CapturedInformer[],
  watcher: null as null | {
    handleSecretEvent: ReturnType<typeof vi.fn>
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

vi.mock('./informers/secretInformer', () => ({
  SecretInformer: class {
    private readonly captured: CapturedInformer
    constructor(_kc: unknown, namespace: string, consumer: (evt: SecretEvent) => void) {
      this.captured = { namespace, consumer, started: false }
      h.informers.push(this.captured)
    }
    async start(): Promise<boolean> {
      this.captured.started = true
      return true
    }
    stop(): void {}
  },
}))

vi.mock('./k8sClient', () => {
  class McpServerWatcher {
    readonly handleSecretEvent = vi.fn()
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
const shutdownSignals: string[] = []
const onceSpy = vi
  .spyOn(process, 'once')
  .mockImplementation((event: string | symbol, listener: (...args: unknown[]) => void) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      shutdownSignals.push(event)
      return process
    }
    return originalOnce(event, listener)
  })

afterAll(() => {
  exitSpy.mockRestore()
  onceSpy.mockRestore()
})

async function startMain(): Promise<void> {
  await import('./main')
  await vi.waitFor(() => expect(h.logger.info).toHaveBeenCalledWith(RUNNING_LINE))
}

function informerFor(namespace: string): CapturedInformer {
  const matches = h.informers.filter(informer => informer.namespace === namespace)
  expect(matches).toHaveLength(1)
  return matches[0]!
}

describe('main.ts Secret informer wiring (#1338)', () => {
  it('hands every mcp-server Secret event to the watcher with its own type', async () => {
    await startMain()

    // Liveness: main ran to its end and started the three informers.
    expect(shutdownSignals).toEqual(['SIGTERM', 'SIGINT'])
    expect(h.informers.map(informer => informer.namespace)).toEqual([
      'mcp-server',
      'channels',
      'llm-hooks',
    ])
    expect(h.informers.every(informer => informer.started)).toBe(true)
    const watcher = h.watcher
    expect(watcher).not.toBeNull()

    const mcpServer = informerFor('mcp-server')
    const events: SecretEvent[] = [
      { type: 'MODIFIED', name: 'pg-creds', namespace: 'mcp-server' },
      { type: 'DELETED', name: 'pg-creds', namespace: 'mcp-server' },
      { type: 'ADDED', name: 'api-key', namespace: 'mcp-server' },
    ]
    for (const evt of events) mcpServer.consumer(evt)

    expect(watcher!.handleSecretEvent.mock.calls).toEqual(events.map(evt => [evt]))

    // The other two informers feed their own consumers, not handleSecretEvent.
    informerFor('channels').consumer({
      type: 'MODIFIED',
      name: 'reader-creds',
      namespace: 'channels',
    })
    informerFor('llm-hooks').consumer({
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
})
