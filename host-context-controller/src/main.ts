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
import * as k8s from '@kubernetes/client-node'
import { config } from './config'
import { HeartbeatPoller } from './heartbeatPoller'
import {
  ManagedDeploymentInformer,
  managedDeploymentListFromAppsApi,
} from './informers/deploymentInformer'
import { SecretInformer, secretListFromCoreApi } from './informers/secretInformer'
import { makeK8sApiClientWithDeadline } from './k8s/k8sRequestDeadline'
import {
  McpServerProvider,
  McpServerWatcher,
  createMcpAuthorizationStore,
  createMcpServerProvider,
  getKubeConfig,
} from './k8sClient'
import { hccLogger } from './logger'
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
let deploymentInformer: ManagedDeploymentInformer | null = null
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
    hccLogger.info('[Main] Shutdown already in progress...')
    return
  }
  isShuttingDown = true

  hccLogger.info('[Main] Received signal, shutting down', { signal })

  deploymentInformer?.stop()
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
  hccLogger.info('[Main] Host Context Controller starting', {
    mode: config.devMode ? 'DEV' : 'PRODUCTION',
    port: config.port,
  })

  if (!config.devMode && !config.desktopApiToken) {
    hccLogger.warn(
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
      hccLogger.error('[Main] FATAL: InternalControl JWT HMAC secret is invalid', { err })
      process.exit(1)
    }
  }

  if (!config.hccTargetNamespace.trim()) {
    hccLogger.error('[Main] FATAL: HCC_TARGET_NAMESPACE must not be empty')
    process.exit(1)
  }
  if (config.hccTargetNamespace !== config.hostNamespace) {
    hccLogger.error(
      '[Main] FATAL: HCC_TARGET_NAMESPACE must equal CONTEXT_MAPPER_HOST_NAMESPACE for caller-bound Host credentials'
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
    hccLogger.error('[Main] FATAL: MCP JWT verifier configuration failed', { err })
    process.exit(1)
    return
  }
  if (!config.devMode) {
    hccLogger.info('[Main] Reconciler enabled (will manage Deployments + Services)', {
      namespace: config.namespace,
    })
  }

  // Create and start the provider (K8s watcher + reconciler, or dev provider)
  provider = createMcpServerProvider()

  provider.onChange(() => {
    hccLogger.info('[Main] McpServer cache updated', {
      total: provider?.getAllServers().length || 0,
    })
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
    hccLogger.info('[Main] Stateless heartbeat poller started', {
      intervalMs: config.heartbeatPollMs,
      target: config.controlApiBaseUrl,
    })
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
  hccLogger.info('[Main] Provider started', { mcpServers: provider.getAllServers().length })
  server.setReady(true)

  // Re-enqueues a server with a terminal RolloutIncomplete when its Deployment
  // moves. Not awaited: the watch request has no transport deadline, and an await
  // that hangs here would keep the SIGTERM handler below from ever registering.
  if (!config.devMode && provider instanceof McpServerWatcher) {
    const kc = getKubeConfig()
    if (kc) {
      const deploymentListApi = makeK8sApiClientWithDeadline(
        kc,
        k8s.AppsV1Api,
        config.k8sRequestTimeoutMs
      )
      deploymentInformer = new ManagedDeploymentInformer(
        kc,
        config.namespace,
        provider.handleDeploymentObservation,
        managedDeploymentListFromAppsApi(deploymentListApi, config.namespace)
      )
      void deploymentInformer.start().catch(err => {
        hccLogger.error('[Main] Deployment informer failed to start', { err })
      })
    }
  }

  // Start SecretInformer (production only) — reacts to Secret lifecycle events
  // so McpServers referencing a missing Secret reconcile once the Secret
  // appears (or disappears).
  if (!config.devMode && provider instanceof McpServerWatcher) {
    const kc = getKubeConfig()
    if (kc) {
      // #1338: only this informer runs in
      // resume mode. Each page of its list runs on HCC's request deadline.
      const secretListApi = makeK8sApiClientWithDeadline(
        kc,
        k8s.CoreV1Api,
        config.k8sRequestTimeoutMs
      )
      secretInformer = new SecretInformer(kc, config.namespace, provider.handleSecretEvent, {
        mode: 'resume',
        list: secretListFromCoreApi(secretListApi),
      })
      try {
        const running = await secretInformer.start()
        if (running) {
          hccLogger.info(`[Main] SecretInformer started on namespace ${config.namespace}`)
        } else {
          hccLogger.warn(
            `[Main] SecretInformer degraded on namespace ${config.namespace}; reconnect will continue in background`
          )
        }
      } catch (err) {
        hccLogger.error('[Main] SecretInformer failed to start', { err })
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
      channelSecretInformer = new SecretInformer(
        kc,
        config.channelsNamespace,
        evt => {
          watcher.reconcileChannelReaderRevision(evt.name, evt.namespace).catch(err => {
            hccLogger.error('[Main] reconcileChannelReaderRevision failed', { err })
          })
        },
        // Replay mode until this consumer has its own retry owner (#1360).
        { mode: 'replay' }
      )
      try {
        await channelSecretInformer.start()
        hccLogger.info(
          `[Main] channels SecretInformer started on namespace ${config.channelsNamespace}`
        )
      } catch (err) {
        hccLogger.error('[Main] channels SecretInformer failed to start', { err })
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
      llmHooksSecretInformer = new SecretInformer(
        kc,
        config.llmHooksNamespace,
        evt => {
          watcher.reconcileLlmHookByEnvSecret(evt.name, evt.namespace).catch(err => {
            hccLogger.error('[Main] reconcileLlmHookByEnvSecret failed', { err })
          })
        },
        // Replay mode until this consumer has its own retry owner (#1360).
        { mode: 'replay' }
      )
      try {
        await llmHooksSecretInformer.start()
        hccLogger.info(
          `[Main] llm-hooks SecretInformer started on namespace ${config.llmHooksNamespace}`
        )
      } catch (err) {
        hccLogger.error('[Main] llm-hooks SecretInformer failed to start', { err })
      }
    }
  }

  hccLogger.info('[Main] Host Context Controller running. Press Ctrl+C to exit.')

  // Handle graceful shutdown (use 'once' to prevent multiple handlers)
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))
}

// Run main
main().catch(error => {
  hccLogger.error('[Main] Fatal error', { err: error })
  process.exit(1)
})
