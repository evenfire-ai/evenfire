/**
 * Host Context Controller - Main entry point.
 *
 * This service watches McpServer CRDs and:
 *  1. Automatically manages Deployments + Services for each McpServer
 *  2. Validates that referenced secrets exist before deploying
 *  3. Provides a REST API for mcp-host to query available MCP servers
 *
 * In dev mode, it reads MCP servers from environment variables
 * and skips Kubernetes reconciliation.
 */
import { config } from './config'
import { HeartbeatPoller } from './heartbeatPoller'
import { SecretInformer } from './informers/secretInformer'
import {
  McpServerProvider,
  McpServerWatcher,
  createMcpAuthorizationStore,
  createMcpServerProvider,
  getKubeConfig,
} from './k8sClient'
import { McpApiAuthenticator } from './mcpApiAuthentication'
import { McpAuthorizationService } from './mcpAuthorization'
import {
  resolveHostAuthoritativeFn,
  resolveProbeAuthoritativeFn,
  resolveProviderAuthoritativeFn,
  resolveReadinessDetailFn,
} from './readinessGate'
import { ContextMapperServer } from './server'
import { StatelessLifecycleTracker } from './statelessLifecycleTracker'
import {
  assertInternalControlJwtHmacSecret,
  signInternalControlJwt,
} from './utils/internalControlSigner'

let provider: McpServerProvider | null = null
let server: ContextMapperServer | null = null
let secretInformer: SecretInformer | null = null
let channelSecretInformer: SecretInformer | null = null
let llmHooksSecretInformer: SecretInformer | null = null
let lifecycleTracker: StatelessLifecycleTracker | null = null
let heartbeatPoller: HeartbeatPoller | null = null
let isShuttingDown = false

/**
 * Graceful shutdown handler.
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log('[Main] Shutdown already in progress...')
    return
  }
  isShuttingDown = true

  console.log(`[Main] Received ${signal}, shutting down`)

  secretInformer?.stop()
  channelSecretInformer?.stop()
  llmHooksSecretInformer?.stop()
  heartbeatPoller?.stop()
  lifecycleTracker?.stop()
  await provider?.stop()
  await server?.stop()

  process.exit(0)
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  console.log('='.repeat(50))
  console.log('Host Context Controller - Starting')
  console.log('='.repeat(50))
  console.log(`[Main] Mode: ${config.devMode ? 'DEV' : 'PRODUCTION'}`)
  console.log(`[Main] Port: ${config.port}`)

  if (!config.devMode && !config.desktopApiToken) {
    console.warn(
      '[HCC] WARNING: CONTEXT_MAPPER_DESKTOP_API_TOKEN is empty in production mode — ' +
        'desktop API endpoints have no service-token auth. Set this to match RPC_PROXY_DESKTOP_API_TOKEN.'
    )
  }

  // HCC signs InternalControl JWTs for control-api token issuance. Refuse to
  // start in production if its HMAC secret is missing or still carries
  // the canary placeholder.
  if (!config.devMode) {
    try {
      assertInternalControlJwtHmacSecret(config.internalControlJwtHccHmacSecret)
    } catch (err) {
      console.error(`[HCC] FATAL: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }

  if (!config.hccTargetNamespace.trim()) {
    console.error('[HCC] FATAL: HCC_TARGET_NAMESPACE must not be empty')
    process.exit(1)
  }
  if (config.hccTargetNamespace !== config.hostNamespace) {
    console.error(
      '[HCC] FATAL: HCC_TARGET_NAMESPACE must equal CONTEXT_MAPPER_HOST_NAMESPACE for caller-bound Host credentials'
    )
    process.exit(1)
  }

  let mcpAuthenticator: McpApiAuthenticator
  try {
    mcpAuthenticator = new McpApiAuthenticator({
      publicKey: config.mcpHostJwtPublicKey,
      issuer: config.mcpHostJwtIssuer,
      hostNamespace: config.hostNamespace,
      maxTokenLifetimeSeconds: config.mcpHostJwtMaxTtlSeconds,
    })
  } catch (err) {
    console.error(
      `[HCC] FATAL: ${err instanceof Error ? err.message : 'MCP JWT verifier configuration failed'}`
    )
    process.exit(1)
    return
  }
  if (!config.devMode) {
    console.log(`[Main] Namespace: ${config.namespace}`)
    console.log(`[Main] Reconciler: ENABLED (will manage Deployments + Services)`)
  }

  // Create and start the provider (K8s watcher + reconciler, or dev provider)
  provider = createMcpServerProvider()

  provider.onChange(() => {
    console.log(`[Main] McpServer cache updated, total: ${provider?.getAllServers().length || 0}`)
  })

  // Create and start the REST API server
  // Extract hostReconciler from production provider for desktop spec checks
  const watcher = provider instanceof McpServerWatcher ? provider : null
  const hostReconciler = watcher ? watcher.getHostReconciler() : undefined
  const hasDesktopFn = hostReconciler
    ? (hostRef: string) => hostReconciler.hasDesktop(hostRef)
    : undefined
  // Dev (no watcher) gets an explicit always-authoritative gate: no inventory
  // to certify there, and the server's fail-closed default would otherwise pin
  // /ready at 503 forever (R3-B1). See resolveProviderAuthoritativeFn.
  const providerAuthoritativeFn = resolveProviderAuthoritativeFn(watcher)
  // Desktop status gates on Host inventory authority alone (not full readiness).
  // Dev (no watcher) mirrors the provider gate above: there is no Host inventory
  // to certify, so authority is unconditional (permissive) — otherwise the
  // server's fail-closed default would pin /api/v1/desktop/* at 503 forever in
  // dev (R2-M1). See resolveHostAuthoritativeFn.
  const hostAuthoritativeFn = resolveHostAuthoritativeFn(watcher)
  const readinessDetailFn = resolveReadinessDetailFn(watcher)
  // /ready uses watch freshness only. Phase-2 certification stays on the
  // per-request gate (providerAuthoritativeFn). Omitting this 10th argument
  // would keep /ready on the 6-clause predicate and kubelet would evict
  // during an uncertified safety window.
  const probeAuthoritativeFn = resolveProbeAuthoritativeFn(watcher)

  // Stateless heartbeat consumption — mcp-host pods authenticate their
  // heartbeats toward control-api's /mcp-host facade (control-api is the
  // ONLY verifier of plane JWTs); HCC POLLS the ingested rows via the
  // InternalControl feed and feeds the lifecycle tracker, which DECIDES.
  // The drain decision is made durable as status.lifecycle.state='draining'
  // and control-api answers the emitter's {drain} from the Host CR.
  if (watcher && hostReconciler) {
    const tracker = new StatelessLifecycleTracker({
      idleMinutes: config.statelessIdleMinutes,
      idleFloorMinutes: config.statelessIdleFloorMinutes,
      drainGraceMs: config.statelessDrainGraceMs,
      maxUptimeHours: config.statelessMaxUptimeHours,
      reconciler: hostReconciler,
      getHost: hostRef => watcher.getHost(hostRef),
    })
    lifecycleTracker = tracker
    heartbeatPoller = new HeartbeatPoller({
      pollIntervalMs: config.heartbeatPollMs,
      controlApiBaseUrl: config.controlApiBaseUrl,
      tracker,
      getHost: hostRef => watcher.getHost(hostRef),
      markHostDraining: (host, entryWakeHandledGeneration) =>
        hostReconciler.markHostDrainingFromHeartbeat(host, entryWakeHandledGeneration),
      signInternalControlJwt: () => signInternalControlJwt(),
    })
    heartbeatPoller.start()
    console.log(
      `[Main] Stateless heartbeat poller started (interval=${config.heartbeatPollMs}ms, ` +
        `target=${config.controlApiBaseUrl})`
    )
  }
  const mcpAuthorization = new McpAuthorizationService(createMcpAuthorizationStore(provider))
  server = new ContextMapperServer(
    provider,
    config.port,
    hostReconciler,
    hasDesktopFn,
    providerAuthoritativeFn,
    hostAuthoritativeFn,
    mcpAuthenticator,
    mcpAuthorization,
    readinessDetailFn,
    probeAuthoritativeFn
  )
  await server.start()

  // One-shot legacy sweep: delete the static `clerum-channel-reader`
  // Deployment if it still exists in the channels namespace. MUST run
  // BEFORE provider.start(): provider startup establishes the Host inventory
  // watch and schedules its initial fleet convergence, which creates per-Host
  // channel-reader Deployments in the background. If the static is still alive
  // when that work begins, both pods compete on the same bot's getUpdates and
  // Telegram 409s one of them. Sweeping first guarantees zero overlap.
  // Idempotent; 404 (already gone) is the steady state. See issue #273
  // for the empirical reproduction.
  if (!config.devMode && hostReconciler) {
    await hostReconciler.sweepLegacyStaticChannelReader()
  }

  await provider.start()
  console.log(`[Main] Provider started, loaded ${provider.getAllServers().length} McpServer(s)`)
  server.setReady(true)

  // Start SecretInformer (production only) — reacts to Secret lifecycle events
  // so McpServers referencing a missing Secret reconcile once the Secret
  // appears (or disappears).
  if (!config.devMode && provider instanceof McpServerWatcher) {
    const kc = getKubeConfig()
    if (kc) {
      const watcher = provider
      secretInformer = new SecretInformer(kc, config.namespace, evt => {
        watcher.reconcileByEnvSecret(evt.name, evt.namespace).catch(err => {
          console.error('[Main] reconcileByEnvSecret failed:', err)
        })
      })
      try {
        const running = await secretInformer.start()
        if (running) {
          console.log(`[Main] SecretInformer started on namespace ${config.namespace}`)
        } else {
          console.warn(
            `[Main] SecretInformer degraded on namespace ${config.namespace}; reconnect will continue in background`
          )
        }
      } catch (err) {
        console.error('[Main] SecretInformer failed to start:', err)
      }
    }
  }

  // Second SecretInformer: per-host channel-reader credentials Secrets in
  // the channels namespace. Events drive rolling restarts of channel-reader
  // pods via the credentials-revision annotation.
  //
  // reconcileChannelReaderRevision is self-contained (does not throw), so
  // the .catch here is defensive — it catches any unexpected runtime error
  // in the SecretInformer's own callback path.
  if (!config.devMode && watcher) {
    const kc = getKubeConfig()
    if (kc) {
      channelSecretInformer = new SecretInformer(kc, config.channelsNamespace, evt => {
        watcher.reconcileChannelReaderRevision(evt.name, evt.namespace).catch(err => {
          console.error('[Main] reconcileChannelReaderRevision failed:', err)
        })
      })
      try {
        await channelSecretInformer.start()
        console.log(
          `[Main] channels SecretInformer started on namespace ${config.channelsNamespace}`
        )
      } catch (err) {
        console.error('[Main] channels SecretInformer failed to start:', err)
      }
    }
  }

  // Third SecretInformer: hook credential Secrets in the llm-hooks namespace.
  // A rotation re-stamps the credentials-revision and rolls the hook pod
  // (§8.2, mirroring the McpServer envSecret informer above).
  if (!config.devMode && provider instanceof McpServerWatcher) {
    const kc = getKubeConfig()
    if (kc) {
      const watcher = provider
      llmHooksSecretInformer = new SecretInformer(kc, config.llmHooksNamespace, evt => {
        watcher.reconcileLlmHookByEnvSecret(evt.name, evt.namespace).catch(err => {
          console.error('[Main] reconcileLlmHookByEnvSecret failed:', err)
        })
      })
      try {
        await llmHooksSecretInformer.start()
        console.log(
          `[Main] llm-hooks SecretInformer started on namespace ${config.llmHooksNamespace}`
        )
      } catch (err) {
        console.error('[Main] llm-hooks SecretInformer failed to start:', err)
      }
    }
  }

  console.log('\n[Main] Host Context Controller running. Press Ctrl+C to exit.\n')

  // Handle graceful shutdown (use 'once' to prevent multiple handlers)
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

// Run main
main().catch(error => {
  console.error('[Main] Fatal error:', error)
  process.exit(1)
})
