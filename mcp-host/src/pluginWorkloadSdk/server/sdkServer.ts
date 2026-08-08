import express, { type Express } from 'express'
import type http from 'http'
import type { PluginWorkloadSdkCapability } from '../../config'
import { type RuntimeJwtBinding, getJwtRuntimeBinding } from '../../workflow/mcpHostRuntimeJwt'
import type { ClientNotificationsHandler } from '../clientNotifications/handler'
import type {
  PluginWorkloadSdkBootstrapProof,
  PluginWorkloadSdkClientNotificationsBootstrapProof,
} from '../promptBridge/controlApiClient'
import type { PromptBridgeHandler } from '../promptBridge/handler'
import { type PluginWorkloadSdkReadiness, registerSdkRoutes } from './routes'

// ─── Namespace-bound activation gate (plan §3.5 / §6.3) ──────────────────
// The SDK server starts if and only if ALL three conditions hold:
//   1. PLUGIN_WORKLOAD_SDK_ENABLED=true            (explicit operator opt-in)
//   2. runtime JWT recipeNamespace === 'sandbox-recipes'
//                                                  (only recipe-bound hosts)
//   3. MCP_HOST_POD_NAMESPACE === 'sandbox-recipes' (downward API,
//                                                  defense-in-depth)
// Any other combination — including an empty downward API value — fails
// CLOSED. Non-recipe mcp-hosts never expose the SDK endpoint, which
// enforces spec §19 conformance #1 at the infrastructure layer.

export const PLUGIN_WORKLOAD_SDK_REQUIRED_NAMESPACE = 'sandbox-recipes'

/** Validate the WRC credential-broker base URL before any SDK listener binds. */
export function validatePluginWorkloadSdkCredentialBrokerUrl(value: string): string | null {
  const raw = value.trim()
  if (!raw) return 'CLERUM_WRC_URL is required when Plugin Workload SDK is enabled'
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return 'CLERUM_WRC_URL must be an absolute http(s) URL'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'CLERUM_WRC_URL must use http or https'
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return 'CLERUM_WRC_URL must not contain credentials, query parameters, or fragments'
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    return 'CLERUM_WRC_URL must be a service base URL without a path'
  }
  return null
}

export function shouldStartPluginWorkloadSdk(config: {
  pluginWorkloadSdkEnabled: boolean
  pluginWorkloadSdkCapabilities: readonly PluginWorkloadSdkCapability[]
  mcpHostRuntimeAccessToken: string
  podNamespace: string
  pluginWorkloadSdkCredentialBrokerUrl?: string
}): { start: boolean; reason: string } {
  if (!config.pluginWorkloadSdkEnabled) {
    return { start: false, reason: 'PLUGIN_WORKLOAD_SDK_ENABLED is not set' }
  }

  if (config.pluginWorkloadSdkCapabilities.length === 0) {
    return { start: false, reason: 'PLUGIN_WORKLOAD_SDK_CAPABILITIES is empty' }
  }

  if (config.pluginWorkloadSdkCapabilities.includes('promptBridge')) {
    const brokerUrlError = validatePluginWorkloadSdkCredentialBrokerUrl(
      config.pluginWorkloadSdkCredentialBrokerUrl ?? ''
    )
    if (brokerUrlError) return { start: false, reason: brokerUrlError }
  }

  const runtimeBinding = getJwtRuntimeBinding(config.mcpHostRuntimeAccessToken)
  if (runtimeBinding?.recipeNamespace !== PLUGIN_WORKLOAD_SDK_REQUIRED_NAMESPACE) {
    return {
      start: false,
      reason: `recipeNamespace is '${runtimeBinding?.recipeNamespace ?? 'null'}', expected '${PLUGIN_WORKLOAD_SDK_REQUIRED_NAMESPACE}'`,
    }
  }

  const podNamespace = config.podNamespace.trim()
  if (podNamespace !== PLUGIN_WORKLOAD_SDK_REQUIRED_NAMESPACE) {
    return {
      start: false,
      reason: `MCP_HOST_POD_NAMESPACE is '${podNamespace || '(empty)'}', expected '${PLUGIN_WORKLOAD_SDK_REQUIRED_NAMESPACE}'`,
    }
  }

  return { start: true, reason: 'all three gate conditions satisfied' }
}

// ─── SDK HTTP server (plan §3.2) ─────────────────────────────────────────

export interface SdkServerOptions {
  port: number
  recipeName: string
  capabilities: readonly PluginWorkloadSdkCapability[]
  workloadTokens: ReadonlyMap<string, string>
  promptBridgeHandler?: PromptBridgeHandler
  clientNotificationsHandler?: ClientNotificationsHandler
  readiness: () => PluginWorkloadSdkReadiness
  maxConnections?: number
  maxRequestsPerMinutePerWorkload?: number
  maxConcurrentPerWorkload?: number
  /**
   * Live runtime binding source. The startup gate validates the boot token,
   * but the runtime token rotates in place (~300s); this callback lets every
   * request re-check that the CURRENT token still binds this recipe to the
   * required namespace. Fails closed with 503 on any drift.
   */
  getRuntimeBinding?: () => RuntimeJwtBinding | null
  verifyClientNotificationsBootstrap?: () => Promise<PluginWorkloadSdkClientNotificationsBootstrapProof>
}

/**
 * Per-request re-validation of the rotating runtime JWT binding. Returns
 * null when the live binding still matches the boot-time gate conditions,
 * or a human-readable reason when the server must refuse the request.
 */
export function checkLiveRuntimeBinding(
  live: RuntimeJwtBinding | null,
  expectedRecipeName: string
): string | null {
  if (!live) return 'runtime token has no decodable recipe binding'
  if (live.recipeNamespace !== PLUGIN_WORKLOAD_SDK_REQUIRED_NAMESPACE) {
    return `runtime token namespace drifted to '${live.recipeNamespace}'`
  }
  if (live.recipeName !== expectedRecipeName) {
    return `runtime token recipe drifted to '${live.recipeName}' (expected '${expectedRecipeName}')`
  }
  return null
}

export class PluginWorkloadSdkServer {
  private readonly app: Express
  private server: http.Server | null = null

  constructor(private readonly opts: SdkServerOptions) {
    this.app = express()
    this.app.use(express.json({ limit: '1mb' }))
    if (opts.getRuntimeBinding) {
      this.app.use((req, res, next) => {
        if (req.path === '/health' || req.path === '/live' || req.path === '/healthz') return next()
        const reason = checkLiveRuntimeBinding(opts.getRuntimeBinding!(), opts.recipeName)
        if (reason) {
          console.error(`[PluginWorkloadSdk] request refused (binding drift): ${reason}`)
          return res
            .status(503)
            .json({ error: 'sdk_unavailable', message: 'SDK binding invalid', retryable: true })
        }
        next()
      })
    }
    registerSdkRoutes(this.app, {
      capabilities: opts.capabilities,
      workloadTokens: opts.workloadTokens,
      promptBridgeHandler: opts.promptBridgeHandler,
      clientNotificationsHandler: opts.clientNotificationsHandler,
      readiness: opts.readiness,
      maxRequestsPerMinutePerWorkload: opts.maxRequestsPerMinutePerWorkload ?? 100,
      maxConcurrentPerWorkload: opts.maxConcurrentPerWorkload ?? 10,
    })
  }

  verifyPromptBridgeBootstrapV2(
    expectedProvider: string,
    expectedModel: string
  ): Promise<PluginWorkloadSdkBootstrapProof> {
    if (!this.opts.promptBridgeHandler) {
      return Promise.reject(new Error('promptBridge bootstrap verifier is not configured'))
    }
    return this.opts.promptBridgeHandler.verifyBootstrapV2(expectedProvider, expectedModel)
  }

  verifyClientNotificationsBootstrap(): Promise<PluginWorkloadSdkClientNotificationsBootstrapProof> {
    if (!this.opts.verifyClientNotificationsBootstrap) {
      return Promise.reject(new Error('clientNotifications bootstrap verifier is not configured'))
    }
    return this.opts.verifyClientNotificationsBootstrap()
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      // Bind to 0.0.0.0 inside the pod; the SDK port is reachable only from
      // sandbox-recipes pods via NetworkPolicy (Phase 6.1) — it is never
      // exposed through a public Service.
      const server = this.app.listen(this.opts.port, '0.0.0.0', () => resolve())
      server.once('error', reject)
      // Connection pool ceiling across all workloads (plan §5.5).
      server.maxConnections = this.opts.maxConnections ?? 100
      this.server = server
    })
    console.log(
      `[PluginWorkloadSdk] SDK server starting on port ${this.opts.port} (recipe=${this.opts.recipeName}, namespace=${PLUGIN_WORKLOAD_SDK_REQUIRED_NAMESPACE})`
    )
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    await new Promise<void>(resolve => {
      // Guard against double-resolve: server.close callback and the
      // 5-second drain timeout both call resolve(); only the first wins.
      let resolved = false
      const done = () => {
        if (!resolved) {
          resolved = true
          resolve()
        }
      }
      server.close(done)
      // Drain window: refuse to hang shutdown on idle keep-alive sockets.
      server.closeIdleConnections?.()
      setTimeout(() => {
        server.closeAllConnections?.()
        done()
      }, 5_000).unref()
    })
    console.log('[PluginWorkloadSdk] SDK server stopped')
  }
}
