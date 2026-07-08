/**
 * McpServer Reconciler - manages Kubernetes Deployments and Services
 * based on McpServer CRD state.
 *
 * Responsibilities:
 * - Create Deployment + Service when a new McpServer CRD appears
 * - Update Deployment when an McpServer CRD is modified
 * - Delete Deployment + Service when an McpServer CRD is removed
 * - Validate that referenced secrets exist before creating deployments
 * - Full reconciliation on startup (sync desired vs actual state)
 */
import * as k8s from '@kubernetes/client-node'
import { IntOrString } from '@kubernetes/client-node/dist/types.js'
import { classifyPluginImage } from '@clerum/image-policy'
import { isWorkflowRecipeDefaultAllowedCapability } from '@clerum/workflow-recipe-capability-policy'
import { config } from './config'
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, MCPSERVER_LABEL } from './constants'
import { mcpserverMissingSecret } from './metrics'
import { McpServerCRD, McpServerStatus } from './types'
import {
  getErrorCode,
  preserveDeploymentAnnotations,
  preserveObjectAnnotations,
  preserveServiceAssignedFields,
  replaceWithConflictRetry,
} from './utils'

/**
 * Result of validating an envSecret reference. When `ok` is false, `reason`
 * classifies the failure so the caller can surface it via status conditions.
 */
export type SecretValidationResult =
  | { ok: true }
  | {
      ok: false
      reason: 'SecretNotFound' | 'SecretMissingKey' | 'SecretAccessDenied' | 'ReadError'
      message: string
    }

/**
 * Condition written to `status.conditions[]` on an McpServer CRD.
 * `status` is the K8s-standard string tri-state, NOT a boolean.
 */
export interface McpServerCondition {
  type: string
  status: 'True' | 'False' | 'Unknown'
  reason: string
  message: string
  lastTransitionTime: string
}

type McpServerReconcilerDeps = {
  appsApi?: k8s.AppsV1Api
  coreApi?: k8s.CoreV1Api
  customApi?: k8s.CustomObjectsApi
  networkingApi?: k8s.NetworkingV1Api
}

// G2: Pre-deploy handshake constants
const PRE_DEPLOY_ANNOTATION = 'clerum.io/pre-deploy'
const NETWORK_READY_ANNOTATION = 'clerum.io/network-ready'

// Codex P0 fix (PR #101): sanitization constants for remote.authHeaders.
// Only standard HTTP header token chars — letters, digits, and '-'. Rejecting
// anything else prevents smuggling headers like `X: foo\r\nAuthorization`.
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/
// Bound the value length so a pathological CRD cannot blow up the ConfigMap.
const MAX_AUTH_HEADER_VALUE_LENGTH = 2048
const WRC_OWNED_RUNTIME_READY_REASON = 'WrcOwnedRuntimeRegistered'

function throwCleanupFailures(failures: unknown[], message: string): void {
  if (failures.length > 0) {
    throw new AggregateError(failures, message)
  }
}

export class McpServerReconciler {
  private readonly appsApi: k8s.AppsV1Api
  private readonly coreApi: k8s.CoreV1Api
  private readonly customApi: k8s.CustomObjectsApi
  private readonly networkingApi?: k8s.NetworkingV1Api

  /** Tracks the deployment status of each managed McpServer. */
  private readonly statusMap: Map<string, McpServerStatus> = new Map()

  /** G7: Tracks the initial `managed` value per McpServer to enforce immutability. */
  private readonly managedSnapshot: Map<string, boolean> = new Map()

  /** Active readiness poll timers — keyed by server name so they can be cancelled. */
  private readonly readinessTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

  /**
   * Tail promise of the in-flight reconcile chain per server name. Serializes
   * concurrent reconcile() calls for the same McpServer so the CRD watch and
   * SecretInformer can't race to replaceNamespacedDeployment() and produce
   * spurious 409 "object has been modified" errors.
   */
  private readonly inFlight: Map<string, Promise<void>> = new Map()

  constructor(kc: k8s.KubeConfig, deps?: McpServerReconcilerDeps) {
    this.appsApi = deps?.appsApi ?? kc.makeApiClient(k8s.AppsV1Api)
    this.coreApi = deps?.coreApi ?? kc.makeApiClient(k8s.CoreV1Api)
    this.customApi = deps?.customApi ?? kc.makeApiClient(k8s.CustomObjectsApi)
    this.networkingApi =
      deps?.networkingApi ??
      (typeof kc.makeApiClient === 'function' ? kc.makeApiClient(k8s.NetworkingV1Api) : undefined)
  }

  // ─── Status ────────────────────────────────────────────────────────

  /**
   * Get deployment status for an McpServer.
   * Returns unknown status if the server hasn't been reconciled yet.
   */
  getStatus(name: string): McpServerStatus {
    return (
      this.statusMap.get(name) ?? { deployed: false, ready: false, message: 'Not reconciled yet' }
    )
  }

  /**
   * Update the status of an McpServer after reconciliation.
   */
  private setStatus(name: string, status: McpServerStatus): void {
    this.statusMap.set(name, status)
  }

  /**
   * Remove status tracking for a deleted McpServer.
   */
  private clearStatus(name: string): void {
    this.statusMap.delete(name)
    this.managedSnapshot.delete(name)
    const timer = this.readinessTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.readinessTimers.delete(name)
    }
  }

  /**
   * Check deployment readiness by inspecting replicas.
   */
  private async checkDeploymentReady(name: string, namespace: string): Promise<boolean> {
    try {
      const deployment = await this.appsApi.readNamespacedDeployment({ name, namespace })
      const ready = (deployment.status?.readyReplicas ?? 0) > 0
      return ready
    } catch {
      return false
    }
  }

  /**
   * Poll deployment readiness until ready or maxAttempts reached.
   * Cancels any existing poll for the same server name.
   */
  private pollReadiness(
    name: string,
    namespace: string,
    intervalMs = 5000,
    maxAttempts = 12
  ): void {
    // Cancel any existing poll for this server
    const existing = this.readinessTimers.get(name)
    if (existing) {
      clearTimeout(existing)
      this.readinessTimers.delete(name)
    }

    let attempts = 0

    const poll = async () => {
      attempts++
      const ready = await this.checkDeploymentReady(name, namespace)

      if (ready) {
        this.setStatus(name, { deployed: true, ready: true, message: 'Running' })
        this.readinessTimers.delete(name)
        console.log(`[Reconciler] McpServer "${name}" is now ready (after ${attempts} poll(s))`)
        return
      }

      if (attempts >= maxAttempts) {
        this.readinessTimers.delete(name)
        console.warn(
          `[Reconciler] McpServer "${name}" not ready after ${maxAttempts} polls — giving up`
        )
        return
      }

      // Schedule next poll
      const timer = setTimeout(poll, intervalMs)
      this.readinessTimers.set(name, timer)
    }

    const timer = setTimeout(poll, intervalMs)
    this.readinessTimers.set(name, timer)
  }

  // ─── Secret Validation ──────────────────────────────────────────────

  /**
   * Validate that the referenced secret exists and contains all required keys.
   * Returns a discriminated result describing success or the exact failure mode.
   */
  async validateSecret(server: McpServerCRD): Promise<SecretValidationResult> {
    if (!server.spec.envSecret) return { ok: true }

    const secretName = server.spec.envSecret.name

    try {
      const secret = await this.coreApi.readNamespacedSecret({
        name: secretName,
        namespace: server.namespace,
      })

      const data = secret.data || {}

      for (const keyMapping of server.spec.envSecret.keys) {
        if (!(keyMapping.secretKey in data)) {
          const message =
            `Secret "${secretName}" is missing required key "${keyMapping.secretKey}" ` +
            `(needed for env var ${keyMapping.envVar})`
          console.error(`[Reconciler] ${message} in McpServer ${server.name}`)
          return { ok: false, reason: 'SecretMissingKey', message }
        }
      }

      console.log(`[Reconciler] Secret "${secretName}" validated for McpServer ${server.name}`)
      return { ok: true }
    } catch (error: unknown) {
      const code = getErrorCode(error)
      if (code === 404) {
        const message = `Secret "${secretName}" not found in namespace "${server.namespace}"`
        console.error(
          `[Reconciler] ${message}. McpServer ${server.name} will NOT be deployed. Create the secret first.`
        )
        return { ok: false, reason: 'SecretNotFound', message }
      }
      if (code === 401 || code === 403) {
        const message =
          `Access denied reading Secret "${secretName}" in namespace "${server.namespace}" ` +
          `(K8s API ${code})`
        console.error(`[Reconciler] ${message}. McpServer ${server.name} will be failed closed.`)
        return { ok: false, reason: 'SecretAccessDenied', message }
      }
      const errMsg = error instanceof Error ? error.message : String(error)
      console.error(`[Reconciler] Failed to read secret "${secretName}":`, error)
      return {
        ok: false,
        reason: 'ReadError',
        message: `Failed to read Secret "${secretName}": ${errMsg}`,
      }
    }
  }

  // ─── Resource Builders ──────────────────────────────────────────────

  // ─── Remote Egress Proxy ─────────────────────────────────────────

  /**
   * Check if this McpServer is a remote egress proxy (has spec.remote.baseUrl).
   */
  private isRemote(server: McpServerCRD): boolean {
    return !!server.spec.remote?.baseUrl
  }

  /**
   * Build nginx.conf ConfigMap for a remote MCP egress proxy.
   * Generates an nginx reverse proxy config that forwards to the external baseUrl.
   */
  /**
   * Validate and sanitize remote baseUrl to prevent SSRF and nginx.conf injection.
   * Returns safe URL reconstructed from parsed components.
   */
  private sanitizeRemoteUrl(rawUrl: string): { safeUrl: string; host: string; path: string } {
    const parsed = new URL(rawUrl) // throws on malformed — no silent fallback
    if (parsed.protocol !== 'https:') {
      throw new Error(`remote.baseUrl must use HTTPS (got ${parsed.protocol})`)
    }
    const host = parsed.hostname
    // Block IP-literal URLs entirely (IPv4 and IPv6) — require DNS hostnames only
    // This prevents IPv6 SSRF bypasses (::1, ::ffff:7f00:1, fd00::, etc.)
    const bareHost = host.replace(/^\[|\]$/g, '')
    if (/^[\d.:[\]]+$/.test(bareHost) || bareHost.includes(':')) {
      throw new Error(`remote.baseUrl must use a DNS hostname, not an IP address: ${host}`)
    }
    // Block internal cluster services (SSRF prevention)
    if (
      host.endsWith('.svc.cluster.local') ||
      host.endsWith('.svc') ||
      host === 'kubernetes.default'
    ) {
      throw new Error(`remote.baseUrl must not point to internal cluster services: ${host}`)
    }
    // Block RFC1918, link-local, loopback (defense in depth for edge cases)
    const PRIVATE_IP = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|0\.)/
    if (PRIVATE_IP.test(host)) {
      throw new Error(`remote.baseUrl must not point to private/reserved IP ranges: ${host}`)
    }
    // Reconstruct safe URL from parsed components (strips injected chars like newlines)
    const path = parsed.pathname
    const safeUrl = parsed.origin + path + parsed.search
    return { safeUrl, host: parsed.host, path }
  }

  /**
   * Codex P0 fix (PR #101): sanitize + validate authHeaders from the McpServer CRD
   * before emitting them as nginx `proxy_set_header` lines. Prevents nginx config
   * injection (breakouts from the quoted string) and HTTP header smuggling.
   *
   * Returns a safe { header, valueTemplate } tuple with the valueTemplate already
   * escaped for nginx double-quoted string context, or null if the entry is
   * rejected (a console.warn is emitted describing why).
   */
  private sanitizeAuthHeader(h: {
    header: string
    valueTemplate: string
  }): { header: string; valueTemplate: string } | null {
    // Validate header name — HTTP token chars only (RFC 7230 subset we allow).
    if (!HEADER_NAME_RE.test(h.header)) {
      console.warn(`[HCC] Rejecting authHeader with invalid name: ${h.header.slice(0, 32)}`)
      return null
    }
    // Bound the value length so a pathological CRD cannot blow up the ConfigMap.
    if (h.valueTemplate.length > MAX_AUTH_HEADER_VALUE_LENGTH) {
      console.warn(`[HCC] Rejecting authHeader value too long for header: ${h.header}`)
      return null
    }
    // CR/LF/NUL allow HTTP request smuggling and nginx directive injection.
    if (/[\r\n\0]/.test(h.valueTemplate)) {
      console.warn(`[HCC] Rejecting authHeader with CR/LF/NUL in value for header: ${h.header}`)
      return null
    }
    // Escape backslashes (first, to avoid double-escaping) then double quotes so
    // the value is safe inside nginx's `"..."` string context.
    const escaped = h.valueTemplate.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return { header: h.header, valueTemplate: escaped }
  }

  private buildNginxConfigMap(server: McpServerCRD): k8s.V1ConfigMap {
    const {
      safeUrl,
      host: upstreamHost,
      path: upstreamPath,
    } = this.sanitizeRemoteUrl(server.spec.remote!.baseUrl)
    const transportPort = server.spec.transport.port || 3000

    // Codex P1 fix (PR #101): forward credential secrets as upstream auth headers.
    // Each authHeader produces a `proxy_set_header` line; ${VAR} placeholders in
    // valueTemplate are resolved at pod startup by Clerum's nginx egress proxy
    // /etc/nginx/templates/ envsubst (env vars from envSecret are already mounted
    // into the egress-proxy container by buildDeployment).
    //
    // Codex P0 fix (PR #101): each entry is sanitized + validated via
    // sanitizeAuthHeader() before emission so an operator-authored CRD cannot
    // break out of the quoted string to inject arbitrary nginx config, and
    // cannot smuggle HTTP headers via CR/LF.
    const authHeaderLines = (server.spec.remote!.authHeaders ?? [])
      .map(h => this.sanitizeAuthHeader(h))
      .filter((h): h is { header: string; valueTemplate: string } => h !== null)
      .map(h => `        proxy_set_header ${h.header} "${h.valueTemplate}";`)
      .join('\n')

    const nginxConf = `# Auto-generated by Clerum HCC for remote MCP server: ${server.name}
# Stored as .conf.template; Clerum's nginx egress proxy runs envsubst at startup.
server {
    listen ${transportPort};

    # Mirror the upstream endpoint path locally so nginx URI replacement keeps
    # the remote endpoint path exactly once.
    location ${upstreamPath} {
        proxy_pass ${safeUrl};
        proxy_set_header Host ${upstreamHost};
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
${authHeaderLines ? '\n        # ── Credential auth headers (envsubst-resolved) ──\n' + authHeaderLines + '\n' : ''}
        # SSE/streaming support
        proxy_buffering off;
        proxy_cache off;
        proxy_connect_timeout 10s;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        chunked_transfer_encoding on;

        # TLS to upstream
        proxy_ssl_verify on;
        proxy_ssl_server_name on;
        proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
    }

    # Health check endpoint
    location /health {
        return 200 'ok';
        add_header Content-Type text/plain;
    }
}`

    const labels: Record<string, string> = {
      app: server.name,
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [MCPSERVER_LABEL]: server.name,
      'clerum.io/component': 'egress-proxy',
    }

    return {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: `${server.name}-nginx-conf`,
        namespace: server.namespace,
        labels,
        ...(server.uid && {
          ownerReferences: [
            {
              apiVersion: 'clerum.io/v1alpha1',
              kind: 'McpServer',
              name: server.name,
              uid: server.uid,
              controller: true,
              blockOwnerDeletion: true,
            },
          ],
        }),
      },
      data: {
        // Stored as .conf.template so Clerum's nginx egress proxy runs envsubst at
        // startup, resolving ${VAR} placeholders from env (sourced from envSecret).
        'default.conf.template': nginxConf,
      },
    }
  }

  /**
   * Ensure ConfigMap exists and is up to date (create or replace).
   */
  private async ensureConfigMap(server: McpServerCRD): Promise<void> {
    const cm = this.buildNginxConfigMap(server)
    try {
      await this.coreApi.createNamespacedConfigMap({
        namespace: server.namespace,
        body: cm,
      })
      console.log(`[Reconciler] Created nginx ConfigMap "${server.name}-nginx-conf"`)
    } catch (error: unknown) {
      if (getErrorCode(error) === 409) {
        const existing = await this.coreApi.readNamespacedConfigMap({
          name: `${server.name}-nginx-conf`,
          namespace: server.namespace,
        })
        const next = preserveObjectAnnotations(
          {
            ...cm,
            metadata: {
              ...cm.metadata,
              resourceVersion: existing.metadata?.resourceVersion,
            },
          },
          existing
        )
        await this.coreApi.replaceNamespacedConfigMap({
          name: `${server.name}-nginx-conf`,
          namespace: server.namespace,
          body: next,
        })
        console.log(`[Reconciler] Updated nginx ConfigMap "${server.name}-nginx-conf"`)
      } else {
        throw error
      }
    }
  }

  /**
   * Build a Deployment manifest for an McpServer.
   */
  /**
   * Sanitize CRD spec fields to prevent developer-supplied CRDs from
   * influencing platform-controlled deployment behavior.
   *
   * Policy: the platform ALWAYS wins. CRD fields that could escalate
   * privileges, override security, or DoS the cluster are stripped or
   * overridden with platform defaults.
   */
  private sanitizeCrdSpec(server: McpServerCRD): void {
    // ── CRITICAL: imagePullPolicy — platform decides, not the CRD ──
    // Remove CRD-supplied value; buildDeployment uses config.mcpServerImagePullPolicy
    delete server.spec.imagePullPolicy

    // ── CRITICAL: prevent root execution ──
    if (server.spec.security) {
      if (server.spec.security.runAsUser !== undefined && server.spec.security.runAsUser < 1) {
        console.warn(
          `[Security] McpServer "${server.name}": runAsUser=${server.spec.security.runAsUser} rejected (must be >= 1)`
        )
        server.spec.security.runAsUser = 1000
      }
      if (server.spec.security.runAsGroup !== undefined && server.spec.security.runAsGroup < 1) {
        console.warn(
          `[Security] McpServer "${server.name}": runAsGroup=${server.spec.security.runAsGroup} rejected (must be >= 1)`
        )
        server.spec.security.runAsGroup = 1000
      }
      if (server.spec.security.fsGroup !== undefined && server.spec.security.fsGroup < 1) {
        console.warn(
          `[Security] McpServer "${server.name}": fsGroup=${server.spec.security.fsGroup} rejected (must be >= 1)`
        )
        server.spec.security.fsGroup = 1000
      }

      // ── CRITICAL: strip dangerous capabilities ──
      if (server.spec.security.addCapabilities) {
        const original = server.spec.security.addCapabilities
        server.spec.security.addCapabilities = original.filter(cap => {
          if (!isWorkflowRecipeDefaultAllowedCapability(cap)) {
            console.warn(
              `[Security] McpServer "${server.name}": capability "${cap}" stripped (forbidden)`
            )
            return false
          }
          return true
        })
      }
    }

    // ── HIGH: sanitize env vars — block dangerous names ──
    const FORBIDDEN_ENV = new Set([
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'PATH',
      'NODE_OPTIONS',
      'PYTHONPATH',
      'JAVA_TOOL_OPTIONS',
      'KUBECONFIG',
      'KUBERNETES_SERVICE_HOST',
      'KUBERNETES_SERVICE_PORT',
    ])
    if (server.spec.env) {
      server.spec.env = server.spec.env.filter(e => {
        if (FORBIDDEN_ENV.has(e.name.toUpperCase())) {
          console.warn(
            `[Security] McpServer "${server.name}": env "${e.name}" stripped (forbidden)`
          )
          return false
        }
        return true
      })
    }

    // ── MEDIUM: clamp resources to platform limits ──
    if (server.spec.resources) {
      const MAX_CPU = '4000m'
      const MAX_MEM = '8Gi'
      if (server.spec.resources.limits) {
        if (server.spec.resources.limits.cpu && parseInt(server.spec.resources.limits.cpu) > 4000) {
          server.spec.resources.limits.cpu = MAX_CPU
        }
        if (
          server.spec.resources.limits.memory &&
          parseInt(server.spec.resources.limits.memory) > 8192
        ) {
          server.spec.resources.limits.memory = MAX_MEM
        }
      }
    }
  }

  private buildDeployment(server: McpServerCRD): k8s.V1Deployment {
    // ── Platform hardening: sanitize CRD before building PodSpec ──
    this.sanitizeCrdSpec(server)

    const transportPort = server.spec.transport.port || 3000
    const isStdio = server.spec.transport.type === 'stdio'
    const isRemote = this.isRemote(server)
    const healthCheckPort = server.spec.healthCheck?.port

    // --- Env vars ---
    const env: k8s.V1EnvVar[] = []

    // Env vars derived from CRD fields via envMapping
    const mapping = server.spec.envMapping
    if (mapping) {
      if (mapping.transport) {
        env.push({ name: mapping.transport, value: 'http' })
      }
      if (mapping.httpHost) {
        env.push({ name: mapping.httpHost, value: '0.0.0.0' })
      }
      if (mapping.httpPort) {
        env.push({ name: mapping.httpPort, value: String(transportPort) })
      }
      if (mapping.healthCheckHost) {
        env.push({ name: mapping.healthCheckHost, value: '0.0.0.0' })
      }
      if (mapping.healthCheckPort && healthCheckPort) {
        env.push({ name: mapping.healthCheckPort, value: String(healthCheckPort) })
      }

      const sc = server.spec.serverConfig
      if (mapping.readOnly && sc?.readOnly !== undefined) {
        env.push({ name: mapping.readOnly, value: String(sc.readOnly) })
      }
      if (mapping.loggers && sc?.loggers) {
        env.push({ name: mapping.loggers, value: sc.loggers })
      }
      if (mapping.telemetry && sc?.telemetry) {
        env.push({ name: mapping.telemetry, value: sc.telemetry })
      }
    }

    // Additional plain env vars from CRD (server-specific extras)
    if (server.spec.env) {
      for (const e of server.spec.env) {
        env.push({ name: e.name, value: e.value })
      }
    }

    // Secret-backed env vars
    if (server.spec.envSecret) {
      for (const keyMapping of server.spec.envSecret.keys) {
        env.push({
          name: keyMapping.envVar,
          valueFrom: {
            secretKeyRef: {
              name: server.spec.envSecret.name,
              key: keyMapping.secretKey,
            },
          },
        })
      }
    }

    // Remote servers: ensure authHeaders ${VAR} placeholders have env vars
    // defined, even when credentials are optional and envSecret is absent.
    // Without this, nginx envsubst fails with "unknown variable" on startup.
    if (isRemote && server.spec.remote?.authHeaders) {
      const definedVars = new Set(env.map(e => e.name))
      for (const ah of server.spec.remote.authHeaders) {
        const matches = ah.valueTemplate.match(/\$\{(\w+)\}/g)
        if (!matches) continue
        for (const m of matches) {
          const varName = m.slice(2, -1)
          if (!definedVars.has(varName)) {
            env.push({ name: varName, value: '' })
            definedVars.add(varName)
          }
        }
      }
    }

    // --- Ports ---
    const ports: k8s.V1ContainerPort[] = [
      { name: 'http', containerPort: transportPort, protocol: 'TCP' },
    ]
    if (healthCheckPort) {
      ports.push({ name: 'healthcheck', containerPort: healthCheckPort, protocol: 'TCP' })
    }

    // --- Probes ---
    const probePort = healthCheckPort ? 'healthcheck' : 'http'

    // --- Resources ---
    let resources: k8s.V1ResourceRequirements | undefined
    if (server.spec.resources) {
      resources = {}
      if (server.spec.resources.requests) {
        resources.requests = {}
        if (server.spec.resources.requests.memory)
          resources.requests['memory'] = server.spec.resources.requests.memory
        if (server.spec.resources.requests.cpu)
          resources.requests['cpu'] = server.spec.resources.requests.cpu
      }
      if (server.spec.resources.limits) {
        resources.limits = {}
        if (server.spec.resources.limits.memory)
          resources.limits['memory'] = server.spec.resources.limits.memory
        if (server.spec.resources.limits.cpu)
          resources.limits['cpu'] = server.spec.resources.limits.cpu
      }
    }

    // --- Labels ---
    const labels: Record<string, string> = {
      app: server.name,
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [MCPSERVER_LABEL]: server.name,
    }
    const runAsUser = server.spec.security?.runAsUser ?? 1000
    const runAsGroup = server.spec.security?.runAsGroup ?? runAsUser
    const hardenedContainerSecurityContext: k8s.V1SecurityContext = {
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      runAsUser,
      runAsGroup,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
    }

    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: server.name,
        namespace: server.namespace,
        labels,
        // G5: ownerRef to McpServer CRD for garbage collection
        ...(server.uid && {
          ownerReferences: [
            {
              apiVersion: 'clerum.io/v1alpha1',
              kind: 'McpServer',
              name: server.name,
              uid: server.uid,
              controller: true,
              blockOwnerDeletion: true,
            },
          ],
        }),
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: { app: server.name },
        },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            // G1: Apply security context from McpServer CRD spec
            securityContext: {
              runAsNonRoot: true,
              runAsUser,
              runAsGroup,
              seccompProfile: { type: 'RuntimeDefault' },
              ...(server.spec.security?.fsGroup !== undefined && {
                fsGroup: server.spec.security.fsGroup,
              }),
            },
            // G6: Apply imagePullSecrets from McpServer CRD spec
            // Codex P2 fix (PR #101): CRD schema mandates [{name: string}] per K8s
            // LocalObjectReference; producers (mcpDelegation, registry install) now
            // normalize to objects, so we pass through directly without double-wrapping.
            ...(server.spec.imagePullSecrets?.length
              ? {
                  imagePullSecrets: server.spec.imagePullSecrets,
                }
              : {}),
            initContainers:
              isStdio && !isRemote
                ? [
                    {
                      name: 'copy-mcp-app',
                      image: server.spec.image,
                      imagePullPolicy:
                        server.spec.imagePullPolicy || config.mcpServerImagePullPolicy,
                      command: [
                        'sh',
                        '-c',
                        'cp -r /app/* /mcp-bin/ 2>/dev/null; cp -r /mcp-app/* /mcp-bin/ 2>/dev/null; true',
                      ],
                      securityContext: hardenedContainerSecurityContext,
                      volumeMounts: [{ name: 'mcp-bin', mountPath: '/mcp-bin' }],
                    },
                  ]
                : undefined,
            containers: [
              // Remote egress proxy: nginx container with ConfigMap mount
              ...(isRemote
                ? [
                    {
                      name: 'egress-proxy',
                      image: config.egressProxyImage,
                      imagePullPolicy: 'IfNotPresent' as const,
                      ports: [
                        { name: 'http', containerPort: transportPort, protocol: 'TCP' as const },
                      ],
                      env: env.length > 0 ? env : undefined,
                      // Codex P1 fix (PR #101): mount as templates so the nginx proxy
                      // entrypoint runs envsubst at startup and resolves ${VAR}
                      // placeholders in auth headers using env from envSecret.
                      volumeMounts: [
                        { name: 'nginx-conf', mountPath: '/etc/nginx/templates', readOnly: true },
                      ],
                      livenessProbe: {
                        httpGet: { path: '/health', port: transportPort as unknown as IntOrString },
                        initialDelaySeconds: 5,
                        periodSeconds: 15,
                      },
                      readinessProbe: {
                        httpGet: { path: '/health', port: transportPort as unknown as IntOrString },
                        initialDelaySeconds: 3,
                        periodSeconds: 10,
                      },
                      resources: {
                        requests: { memory: '32Mi', cpu: '25m' },
                        limits: { memory: '64Mi', cpu: '100m' },
                      },
                      securityContext: {
                        runAsNonRoot: true,
                        runAsUser: 101,
                        runAsGroup: 101,
                        capabilities: { drop: ['ALL'] },
                        allowPrivilegeEscalation: false,
                        seccompProfile: { type: 'RuntimeDefault' },
                      },
                    },
                  ]
                : []),
              // Local HTTP server (not stdio, not remote)
              ...(isStdio || isRemote
                ? []
                : [
                    {
                      name: 'mcp-server',
                      image: server.spec.image,
                      imagePullPolicy:
                        server.spec.imagePullPolicy || config.mcpServerImagePullPolicy,
                      command: server.spec.command || undefined,
                      args: server.spec.args || undefined,
                      ports,
                      env: env.length > 0 ? env : undefined,
                      // G1: Per-container security context — capabilities.add must be at container level
                      securityContext: {
                        allowPrivilegeEscalation: false,
                        runAsNonRoot: true,
                        runAsUser,
                        runAsGroup,
                        seccompProfile: { type: 'RuntimeDefault' },
                        capabilities: {
                          drop: ['ALL'],
                          ...(server.spec.security?.addCapabilities?.length
                            ? { add: server.spec.security.addCapabilities }
                            : {}),
                        },
                      },
                      livenessProbe: {
                        tcpSocket: { port: probePort as IntOrString },
                        initialDelaySeconds: 10,
                        periodSeconds: 15,
                      },
                      readinessProbe: {
                        tcpSocket: { port: probePort as IntOrString },
                        initialDelaySeconds: 5,
                        periodSeconds: 10,
                      },
                      resources,
                    },
                  ]),
              ...(isStdio
                ? [
                    {
                      name: 'stdio-bridge',
                      image: config.stdioBridgeImage, // G10: configurable bridge image
                      env: [
                        {
                          name: 'STDIO_COMMAND',
                          value: (server.spec.command || ['/mcp-bin/mcp-server'])[0],
                        },
                        {
                          name: 'STDIO_ARGS',
                          value: JSON.stringify(
                            server.spec.args || (server.spec.command || []).slice(1)
                          ),
                        },
                        { name: 'BRIDGE_PORT', value: String(transportPort) },
                        ...env,
                      ],
                      ports: [{ name: 'http', containerPort: transportPort, protocol: 'TCP' }],
                      securityContext: hardenedContainerSecurityContext,
                      livenessProbe: {
                        httpGet: { path: '/health', port: transportPort as unknown as IntOrString },
                        initialDelaySeconds: 15,
                        periodSeconds: 15,
                      },
                      readinessProbe: {
                        httpGet: { path: '/health', port: transportPort as unknown as IntOrString },
                        initialDelaySeconds: 10,
                        periodSeconds: 10,
                      },
                      volumeMounts: [{ name: 'mcp-bin', mountPath: '/mcp-bin' }],
                      // G4: Independent resource limits for stdio-bridge sidecar
                      resources: {
                        requests: config.stdioBridgeResources.requests,
                        limits: config.stdioBridgeResources.limits,
                      },
                    },
                  ]
                : []),
            ],
            volumes: (() => {
              const v: k8s.V1Volume[] = []
              if (isStdio) v.push({ name: 'mcp-bin', emptyDir: {} })
              if (isRemote)
                v.push({ name: 'nginx-conf', configMap: { name: `${server.name}-nginx-conf` } })
              return v.length > 0 ? v : undefined
            })(),
          },
        },
      },
    }
  }

  /**
   * Build a Service manifest for an McpServer.
   */
  private buildService(server: McpServerCRD): k8s.V1Service {
    const transportPort = server.spec.transport.port || 3000

    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: server.name,
        namespace: server.namespace,
        labels: {
          app: server.name,
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [MCPSERVER_LABEL]: server.name,
        },
        // G5: ownerRef to McpServer CRD for garbage collection
        ...(server.uid && {
          ownerReferences: [
            {
              apiVersion: 'clerum.io/v1alpha1',
              kind: 'McpServer',
              name: server.name,
              uid: server.uid,
              controller: true,
              blockOwnerDeletion: true,
            },
          ],
        }),
      },
      spec: {
        type: 'ClusterIP',
        ports: [
          {
            port: transportPort,
            targetPort: 'http' as IntOrString,
            protocol: 'TCP',
            name: 'http',
          },
        ],
        selector: { app: server.name },
      },
    }
  }

  // ─── Reconciliation Actions ─────────────────────────────────────────

  /**
   * Ensure a Deployment exists and is up to date.
   */
  private async ensureDeployment(server: McpServerCRD): Promise<void> {
    const deployment = this.buildDeployment(server)

    try {
      await this.appsApi.createNamespacedDeployment({
        namespace: server.namespace,
        body: deployment,
      })
      console.log(`[Reconciler] Created Deployment "${server.name}"`)
      return
    } catch (error: unknown) {
      if (getErrorCode(error) !== 409) {
        throw error
      }
      // Already exists — read+replace with conflict retry. Races with the
      // K8s Deployment controller (which bumps resourceVersion as pods +
      // status conditions evolve) and with concurrent reconciles for the
      // same server (CRD watch + SecretInformer) routinely produce stale
      // resourceVersion errors. Helper does jittered backoff up to its
      // attempt cap then re-throws — silently swallowing would hide
      // immutable-field changes, quota exhaustion, etc.
      await replaceWithConflictRetry({
        description: `Deployment "${server.name}"`,
        logPrefix: '[Reconciler]',
        body: deployment,
        mergeExisting: preserveDeploymentAnnotations,
        read: () =>
          this.appsApi.readNamespacedDeployment({
            name: server.name,
            namespace: server.namespace,
          }),
        replace: body =>
          this.appsApi.replaceNamespacedDeployment({
            name: server.name,
            namespace: server.namespace,
            body,
          }),
      })
    }
  }

  /**
   * Ensure a Service exists and is up to date.
   */
  private async ensureService(server: McpServerCRD): Promise<void> {
    const service = this.buildService(server)

    try {
      await this.coreApi.createNamespacedService({
        namespace: server.namespace,
        body: service,
      })
    } catch (error: unknown) {
      if (getErrorCode(error) === 409) {
        await replaceWithConflictRetry({
          description: `Service "${server.name}"`,
          logPrefix: '[Reconciler]',
          body: service,
          mergeExisting: preserveServiceAssignedFields,
          read: () =>
            this.coreApi.readNamespacedService({
              name: server.name,
              namespace: server.namespace,
            }),
          replace: body =>
            this.coreApi.replaceNamespacedService({
              name: server.name,
              namespace: server.namespace,
              body,
            }),
        })
      } else {
        throw error
      }
    }
  }

  /**
   * Delete HCC-owned Deployment, Service, and remote ConfigMap for an McpServer.
   * Name matches are not enough: WRC-owned `managed:false` runtimes can share
   * names with McpServer CRDs, so every delete verifies HCC ownership labels.
   */
  private async deleteResources(name: string, namespace: string): Promise<void> {
    const failures: unknown[] = []
    for (const cleanup of [
      () => this.deleteDeploymentIfHccOwned(name, namespace),
      () => this.deleteConfigMapIfHccOwned(`${name}-nginx-conf`, namespace, name),
      () => this.deleteServiceIfHccOwned(name, namespace),
    ]) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    throwCleanupFailures(
      failures,
      `Failed to delete runtime Kubernetes resources for McpServer "${name}"`
    )
  }

  private isHccOwnedMcpResource(
    resource: { metadata?: { labels?: Record<string, string> } },
    serverName: string
  ): boolean {
    const labels = resource.metadata?.labels ?? {}
    return labels[MANAGED_BY_LABEL] === MANAGED_BY_VALUE && labels[MCPSERVER_LABEL] === serverName
  }

  private async deleteDeploymentIfHccOwned(name: string, namespace: string): Promise<void> {
    let deployment: k8s.V1Deployment
    try {
      deployment = await this.appsApi.readNamespacedDeployment({ name, namespace })
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        console.log(`[Reconciler] Deployment "${name}" already gone`)
      } else {
        console.error(`[Reconciler] Failed to read Deployment "${name}" ownership:`, error)
        throw error
      }
      return
    }

    if (!this.isHccOwnedMcpResource(deployment, name)) {
      console.warn(`[Reconciler] Skipping Deployment "${name}" delete — not HCC-owned`)
      return
    }

    try {
      await this.appsApi.deleteNamespacedDeployment({ name, namespace })
      console.log(`[Reconciler] Deleted Deployment "${name}"`)
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        console.log(`[Reconciler] Deployment "${name}" already gone`)
      } else {
        console.error(`[Reconciler] Failed to delete Deployment "${name}":`, error)
        throw error
      }
    }
  }

  private async deleteConfigMapIfHccOwned(
    configMapName: string,
    namespace: string,
    serverName: string
  ): Promise<void> {
    let configMap: k8s.V1ConfigMap
    try {
      configMap = await this.coreApi.readNamespacedConfigMap({ name: configMapName, namespace })
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        console.log(`[Reconciler] ConfigMap "${configMapName}" already gone`)
      } else {
        console.error(`[Reconciler] Failed to read ConfigMap "${configMapName}" ownership:`, error)
        throw error
      }
      return
    }

    if (!this.isHccOwnedMcpResource(configMap, serverName)) {
      console.warn(`[Reconciler] Skipping ConfigMap "${configMapName}" delete — not HCC-owned`)
      return
    }

    try {
      await this.coreApi.deleteNamespacedConfigMap({ name: configMapName, namespace })
      console.log(`[Reconciler] Deleted nginx ConfigMap "${configMapName}"`)
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        console.log(`[Reconciler] ConfigMap "${configMapName}" already gone`)
      } else {
        console.error(`[Reconciler] Failed to delete ConfigMap "${configMapName}":`, error)
        throw error
      }
    }
  }

  private async deleteServiceIfHccOwned(name: string, namespace: string): Promise<void> {
    let service: k8s.V1Service
    try {
      service = await this.coreApi.readNamespacedService({ name, namespace })
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        console.log(`[Reconciler] Service "${name}" already gone`)
      } else {
        console.error(`[Reconciler] Failed to read Service "${name}" ownership:`, error)
        throw error
      }
      return
    }

    if (!this.isHccOwnedMcpResource(service, name)) {
      console.warn(`[Reconciler] Skipping Service "${name}" delete — not HCC-owned`)
      return
    }

    try {
      await this.coreApi.deleteNamespacedService({ name, namespace })
      console.log(`[Reconciler] Deleted Service "${name}"`)
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        console.log(`[Reconciler] Service "${name}" already gone`)
      } else {
        console.error(`[Reconciler] Failed to delete Service "${name}":`, error)
        throw error
      }
    }
  }

  private async deleteNetworkPoliciesForServer(name: string, namespace: string): Promise<void> {
    if (!this.networkingApi) return
    const failures: unknown[] = []
    const namespaces = [...new Set([namespace, config.hostNamespace, config.rpcProxyNamespace])]
    for (const policyNamespace of namespaces) {
      try {
        const policies = await this.networkingApi.listNamespacedNetworkPolicy({
          namespace: policyNamespace,
        })
        for (const policy of policies.items ?? []) {
          if (policy.metadata?.labels?.[MCPSERVER_LABEL] !== name) continue
          const policyName = policy.metadata.name
          if (!policyName) continue
          try {
            await this.networkingApi.deleteNamespacedNetworkPolicy({
              name: policyName,
              namespace: policyNamespace,
            })
            console.log(
              `[Reconciler] Deleted NetworkPolicy "${policyName}" in "${policyNamespace}"`
            )
          } catch (error: unknown) {
            if (getErrorCode(error) !== 404) {
              console.error(
                `[Reconciler] Failed to delete NetworkPolicy "${policyName}" in "${policyNamespace}":`,
                error
              )
              failures.push(error)
            }
          }
        }
      } catch (error: unknown) {
        if (getErrorCode(error) !== 404) {
          console.error(
            `[Reconciler] Failed to list NetworkPolicies in "${policyNamespace}" for "${name}":`,
            error
          )
          failures.push(error)
        }
      }
    }

    throwCleanupFailures(failures, `Failed to delete NetworkPolicies for McpServer "${name}"`)
  }

  private async deleteRuntimeResources(name: string, namespace: string): Promise<void> {
    const failures: unknown[] = []
    try {
      await this.deleteResources(name, namespace)
    } catch (error) {
      failures.push(error)
    }
    try {
      await this.deleteNetworkPoliciesForServer(name, namespace)
    } catch (error) {
      failures.push(error)
    }
    throwCleanupFailures(failures, `Failed to delete runtime resources for McpServer "${name}"`)
  }

  // ─── CRD Status & Annotation Patching ──────────────────────────────

  /**
   * G2: Set `clerum.io/network-ready: "true"` annotation on McpServer CRD.
   * Completes the pre-deploy handshake so WRC knows NetworkPolicies are applied.
   */
  private async setNetworkReadyAnnotation(server: McpServerCRD): Promise<void> {
    // Use merge-patch (plain object body) instead of JSON Patch (array body).
    // JSON Patch op:"add" on /metadata/annotations/<key> requires /metadata/annotations
    // to already exist — it fails with 422 when the CRD was created without annotations.
    // Merge-patch creates the map if absent. Errors are re-thrown so the caller (reconcile)
    // knows the handshake was not completed — WRC will time out and fail rather than proceed
    // silently without NetworkPolicies in place.
    await this.customApi.patchNamespacedCustomObject(
      {
        group: 'clerum.io',
        version: 'v1alpha1',
        namespace: server.namespace,
        plural: 'mcpservers',
        name: server.name,
        body: {
          metadata: {
            annotations: {
              [NETWORK_READY_ANNOTATION]: 'true',
            },
          },
        },
      },
      {
        middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')],
      }
    )
  }

  /**
   * Keep remote egress proxy CRDs aligned with the platform-owned runtime image.
   *
   * Remote servers are rendered as nginx egress proxies and never run
   * `server.spec.image`, but stale CR specs can mislead scanners or future
   * tooling. Patch only the declarative image field; Deployment rendering still
   * uses `config.egressProxyImage` as the authority.
   *
   * This stays internally non-throwing because image canonicalization is
   * best-effort cleanup; a failed CRD patch must not block ConfigMap,
   * Service, or Deployment reconciliation for the actual proxy runtime.
   */
  private async canonicalizeRemoteEgressProxyImage(server: McpServerCRD): Promise<void> {
    if (!this.isRemote(server)) {
      return
    }
    if (server.spec.image === config.egressProxyImage) {
      await this.writeStatusCondition(server, {
        type: 'ImageCanonicalized',
        status: 'True',
        reason: 'RemoteEgressProxyImageMatches',
        message: 'Remote McpServer spec.image matches the platform egress proxy image',
      })
      return
    }

    try {
      await this.customApi.patchNamespacedCustomObject(
        {
          group: 'clerum.io',
          version: 'v1alpha1',
          namespace: server.namespace,
          plural: 'mcpservers',
          name: server.name,
          body: {
            spec: {
              image: config.egressProxyImage,
            },
          },
        },
        {
          middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')],
        }
      )
      server.spec.image = config.egressProxyImage
      console.log(
        `[Reconciler] Canonicalized remote McpServer "${server.name}" image to ${config.egressProxyImage}`
      )
      await this.writeStatusCondition(server, {
        type: 'ImageCanonicalized',
        status: 'True',
        reason: 'RemoteEgressProxyImageMatches',
        message: 'Remote McpServer spec.image matches the platform egress proxy image',
      })
    } catch (err) {
      console.warn(
        `[Reconciler] Failed to canonicalize remote McpServer "${server.name}" image to ${config.egressProxyImage}:`,
        err
      )
      await this.writeStatusCondition(server, {
        type: 'ImageCanonicalized',
        status: 'False',
        reason: 'RemoteEgressProxyImagePatchFailed',
        message: 'Failed to patch remote McpServer spec.image to the platform egress proxy image',
      })
    }
  }

  /**
   * G11: Update status conditions on McpServer CRD.
   * Sets NetworkReady and DeploymentReady conditions so WRC can watch
   * for status changes instead of polling with sleeps.
   */
  private async updateStatusConditions(
    server: McpServerCRD,
    deploymentReady: boolean
  ): Promise<void> {
    try {
      await this.writeStatusCondition(server, {
        type: 'NetworkReady',
        status: 'True',
        reason: 'NetworkPoliciesApplied',
        message: 'NetworkPolicies and Service created',
      })
      await this.writeStatusCondition(server, {
        type: 'DeploymentReady',
        status: deploymentReady ? 'True' : 'False',
        reason: deploymentReady ? 'ReplicasAvailable' : 'WaitingForReplicas',
        message: deploymentReady
          ? 'Deployment has ready replicas'
          : 'Waiting for pods to become ready',
      })
      console.log(
        `[Reconciler] Updated status conditions on "${server.name}" (DeploymentReady=${deploymentReady})`
      )
    } catch (error) {
      // Status subresource may not exist yet — log but don't fail reconciliation
      console.warn(`[Reconciler] Failed to update status conditions on "${server.name}":`, error)
    }
  }

  /**
   * Write (or merge) a single status condition on the McpServer CRD.
   *
   * Merge semantics:
   *   - Condition with same `type` and unchanged `status` → keep existing
   *     `lastTransitionTime`, refresh `reason` / `message`.
   *   - Condition with same `type` but different `status` → bump
   *     `lastTransitionTime` to now.
   *   - New type → append with fresh `lastTransitionTime`.
   *
   * Side-effect: updates the `clerum_hcc_mcpserver_missing_secret` gauge for
   * `SecretResolved` conditions (1 when False, 0 when True).
   *
   * Failure modes:
   *   - 404 (CRD deleted mid-reconcile) → log + swallow.
   *   - Other errors → log + swallow (status writes are best-effort).
   */
  async writeStatusCondition(
    server: McpServerCRD,
    condition: Omit<McpServerCondition, 'lastTransitionTime'>
  ): Promise<void> {
    const now = new Date().toISOString()

    // Fetch current status to preserve existing conditions.
    let existingConditions: McpServerCondition[] = []
    let hasStatusObject = false
    try {
      const current = (await this.customApi.getNamespacedCustomObjectStatus({
        group: 'clerum.io',
        version: 'v1alpha1',
        namespace: server.namespace,
        plural: 'mcpservers',
        name: server.name,
      })) as { status?: { conditions?: McpServerCondition[] } }
      hasStatusObject = typeof current.status === 'object' && current.status !== null
      existingConditions = current.status?.conditions ?? []
    } catch (error) {
      if (getErrorCode(error) === 404) {
        console.warn(
          `[Reconciler] McpServer "${server.name}" deleted mid-reconcile — skipping status update`
        )
        return
      }
      console.warn(
        `[Reconciler] Failed to read status for "${server.name}" — skipping status update for type "${condition.type}" to avoid clobbering other status fields:`,
        error
      )
      return
    }

    const prior = existingConditions.find(c => c.type === condition.type)
    const unchanged =
      prior !== undefined &&
      prior.status === condition.status &&
      prior.reason === condition.reason &&
      prior.message === condition.message

    // Update the missing-secret gauge for SecretResolved conditions.
    // Do this BEFORE the no-op short-circuit so the gauge stays current
    // across reconciles even when we skip the API patch.
    if (condition.type === 'SecretResolved' && server.spec.envSecret) {
      const labels = {
        namespace: server.namespace,
        name: server.name,
        secret_name: server.spec.envSecret.name,
      }
      mcpserverMissingSecret.set(labels, condition.status === 'False' ? 1 : 0)
    }

    // Skip the patch when the condition is identical to what's already on
    // the CRD. Without this, every reconcile bumps the McpServer's
    // resourceVersion, fires another watch event, triggers another
    // reconcile — a tight self-loop that also amplifies NetworkPolicy
    // optimistic-lock contention downstream.
    if (unchanged) {
      return
    }

    const lastTransitionTime =
      prior && prior.status === condition.status ? prior.lastTransitionTime : now

    const merged: McpServerCondition = {
      type: condition.type,
      status: condition.status,
      reason: condition.reason,
      message: condition.message,
      lastTransitionTime,
    }

    const nextConditions = [...existingConditions.filter(c => c.type !== condition.type), merged]

    const statusPatch = hasStatusObject
      ? [{ op: 'add', path: '/status/conditions', value: nextConditions }]
      : [{ op: 'add', path: '/status', value: { conditions: nextConditions } }]

    try {
      // The generated client prefers JSON Patch for this endpoint. Send an
      // actual patch document so status writes keep working across client
      // upgrades instead of relying on merge-patch object bodies.
      await this.customApi.patchNamespacedCustomObjectStatus({
        group: 'clerum.io',
        version: 'v1alpha1',
        namespace: server.namespace,
        plural: 'mcpservers',
        name: server.name,
        body: statusPatch,
      })
    } catch (error) {
      if (getErrorCode(error) === 404) {
        console.warn(
          `[Reconciler] McpServer "${server.name}" deleted mid-reconcile — status patch skipped`
        )
        return
      }
      console.warn(
        `[Reconciler] Failed to write status condition ${condition.type}=${condition.status} on "${server.name}":`,
        error
      )
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Reconcile a created or modified McpServer.
   *
   * Concurrent calls for the same server name are serialized through
   * `inFlight` so we never run two reconciles in parallel for one server.
   * A prior failure does not block the next call; the chain absorbs it so
   * the next reconcile still runs.
   */
  async reconcile(server: McpServerCRD): Promise<void> {
    const key = server.name
    const prev = this.inFlight.get(key) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(() => this.performReconcile(server))
    this.inFlight.set(key, next)
    try {
      await next
    } finally {
      if (this.inFlight.get(key) === next) {
        this.inFlight.delete(key)
      }
    }
  }

  private async performReconcile(server: McpServerCRD): Promise<void> {
    // G7: Enforce managed field immutability — once set, cannot change
    const currentManaged = server.spec.managed ?? true
    const previousManaged = this.managedSnapshot.get(server.name)
    if (previousManaged !== undefined && previousManaged !== currentManaged) {
      console.error(
        `[Reconciler] McpServer "${server.name}": managed field changed from ${previousManaged} to ${currentManaged}. ` +
          `This is not allowed — delete and recreate the McpServer to change ownership.`
      )
      this.setStatus(server.name, {
        deployed: false,
        ready: false,
        message: `managed field is immutable (was ${previousManaged}, attempted ${currentManaged})`,
      })
      return
    }
    this.managedSnapshot.set(server.name, currentManaged)

    // If disabled, respect ownership before any cleanup. managed:false means
    // WRC owns runtime resources; HCC only marks discovery status disabled.
    if (server.spec.enabled === false) {
      if (currentManaged) {
        console.log(
          `[Reconciler] McpServer "${server.name}" is disabled — removing HCC-owned resources`
        )
        await this.deleteRuntimeResources(server.name, server.namespace)
      } else {
        console.log(
          `[Reconciler] McpServer "${server.name}" is disabled but WRC-owned; skipping runtime cleanup`
        )
      }
      this.setStatus(server.name, { deployed: false, ready: false, message: 'Disabled' })
      await this.writeStatusCondition(server, {
        type: 'Ready',
        status: 'False',
        reason: 'Disabled',
        message: 'McpServer is disabled',
      })
      return
    }

    if (!currentManaged) {
      await this.reconcileWrcOwnedServer(server)
      return
    }

    // Validate secret before creating/updating
    const secretResult = await this.validateSecret(server)
    if (!secretResult.ok) {
      console.error(
        `[Reconciler] Skipping deployment of "${server.name}" — secret validation failed`
      )
      if (this.shouldFailClosedForSecretFailure(secretResult)) {
        await this.deleteRuntimeResources(server.name, server.namespace)
      } else {
        console.warn(
          `[Reconciler] Preserving existing runtime for "${server.name}" after transient Secret read failure`
        )
      }
      this.setStatus(server.name, {
        deployed: false,
        ready: false,
        message: secretResult.message,
      })
      await this.writeStatusCondition(server, {
        type: 'SecretResolved',
        status: 'False',
        reason: secretResult.reason,
        message: secretResult.message,
      })
      await this.writeStatusCondition(server, {
        type: 'Ready',
        status: 'False',
        reason: 'SecretValidationFailed',
        message: secretResult.message,
      })
      return
    }

    // Ensure resources exist and are up to date
    try {
      // Remote egress proxy: create nginx ConfigMap before Deployment
      if (this.isRemote(server)) {
        await this.canonicalizeRemoteEgressProxyImage(server)
        await this.ensureConfigMap(server)
      } else {
        // Phase 2.3: plugin image-host allowlist. Audit mode (default) logs a
        // would-be denial and still builds; enforce mode blocks the workload.
        const decision = classifyPluginImage(server.spec.image, {
          allowedPrefixes: config.allowedPluginImagePrefixes,
          rejectLatest: false,
        })
        if (!decision.ok) {
          const message = `Image "${server.spec.image}" is not permitted by the plugin image allowlist (${decision.reason})`
          if (config.enforcePluginImageAllowlist) {
            console.warn(`[Reconciler] ${message} — blocking "${server.name}" (enforce mode)`)
            await this.writeStatusCondition(server, {
              type: 'Ready',
              status: 'False',
              reason: 'ImageNotAllowed',
              message,
            })
            this.setStatus(server.name, { deployed: false, ready: false, message })
            return
          }
          console.warn(
            `[Reconciler] ${message} for "${server.name}" — audit mode, allowing (set CONTEXT_MAPPER_ENFORCE_IMAGE_ALLOWLIST=true to block)`
          )
        }
      }
      await this.ensureService(server)
      await this.ensureDeployment(server)
    } catch (err) {
      this.setStatus(server.name, {
        deployed: false,
        ready: false,
        message: `Resource sync failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }

    // G2: Complete pre-deploy handshake — set network-ready annotation
    // after Deployment + Service are created, signaling WRC that
    // NetworkPolicies are in place and workload can proceed.
    if (
      server.annotations?.[PRE_DEPLOY_ANNOTATION] === 'true' &&
      server.annotations?.[NETWORK_READY_ANNOTATION] !== 'true'
    ) {
      try {
        await this.setNetworkReadyAnnotation(server)
      } catch (err) {
        this.setStatus(server.name, {
          deployed: false,
          ready: false,
          message: `Pre-deploy handshake failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        return
      }
    }

    // Check readiness after reconciliation
    const ready = await this.checkDeploymentReady(server.name, server.namespace)
    this.setStatus(server.name, {
      deployed: true,
      ready,
      message: ready ? 'Running' : 'Deployment created, waiting for pods to become ready',
    })

    // G11: Update status conditions on McpServer CRD
    await this.updateStatusConditions(server, ready)

    // PR-B B1: record SecretResolved=True + Ready=True after a successful
    // reconcile. This is additive to updateStatusConditions (NetworkReady /
    // DeploymentReady); the merge logic in writeStatusCondition preserves
    // the existing conditions by type.
    if (server.spec.envSecret) {
      await this.writeStatusCondition(server, {
        type: 'SecretResolved',
        status: 'True',
        reason: 'SecretFound',
        message: 'Secret resolved and validated',
      })
    }
    await this.writeStatusCondition(server, {
      type: 'Ready',
      status: ready ? 'True' : 'Unknown',
      reason: ready ? 'ReconcileSuccess' : 'WaitingForReplicas',
      message: ready
        ? 'Deployment created'
        : 'Deployment created, waiting for pods to become ready',
    })

    // If not ready yet, poll until it becomes ready
    if (!ready) {
      this.pollReadiness(server.name, server.namespace)
    }
  }

  private shouldFailClosedForSecretFailure(
    result: Exclude<SecretValidationResult, { ok: true }>
  ): boolean {
    return (
      result.reason === 'SecretNotFound' ||
      result.reason === 'SecretMissingKey' ||
      result.reason === 'SecretAccessDenied'
    )
  }

  private async reconcileWrcOwnedServer(server: McpServerCRD): Promise<void> {
    console.log(
      `[Reconciler] McpServer "${server.name}" is WRC-owned (managed:false); ` +
        'skipping HCC runtime creation/deletion and updating discovery status.'
    )

    const secretResult = await this.validateSecret(server)
    if (!secretResult.ok) {
      this.setStatus(server.name, {
        deployed: true,
        ready: false,
        message: secretResult.message,
      })
      if (server.spec.envSecret) {
        await this.writeStatusCondition(server, {
          type: 'SecretResolved',
          status: 'False',
          reason: secretResult.reason,
          message: secretResult.message,
        })
      }
      await this.writeStatusCondition(server, {
        type: 'Ready',
        status: 'False',
        reason: 'SecretValidationFailed',
        message: secretResult.message,
      })
      return
    }

    this.setStatus(server.name, {
      deployed: true,
      ready: true,
      message: 'WRC-owned runtime registered',
    })
    if (server.spec.envSecret) {
      await this.writeStatusCondition(server, {
        type: 'SecretResolved',
        status: 'True',
        reason: 'SecretFound',
        message: 'Secret resolved and validated',
      })
    }
    await this.writeStatusCondition(server, {
      type: 'Ready',
      status: 'True',
      reason: WRC_OWNED_RUNTIME_READY_REASON,
      message: 'WRC-owned runtime registered for HCC discovery',
    })
  }

  /**
   * Reconcile a deleted McpServer.
   */
  async reconcileDelete(name: string, namespace: string): Promise<void> {
    console.log(`[Reconciler] McpServer "${name}" deleted — cleaning up resources`)
    await this.deleteRuntimeResources(name, namespace)
    this.clearStatus(name)
  }

  /**
   * Full reconciliation pass — sync desired state with actual state.
   * Called on startup to handle CRDs that were created while the skill-mapper was down.
   */
  async fullReconcile(desiredServers: McpServerCRD[]): Promise<void> {
    console.log(
      `[Reconciler] Running full reconciliation for ${desiredServers.length} McpServer(s)`
    )

    // Get all deployments managed by skill-mapper
    const existingDeployments = await this.listManagedDeployments()
    const desiredNames = new Set(
      desiredServers
        .filter(s => s.spec.enabled !== false && (s.spec.managed ?? true))
        .map(s => s.name)
    )

    // Create or update desired servers
    for (const server of desiredServers) {
      await this.reconcile(server)
    }

    // Delete orphaned deployments (managed by us but no longer desired)
    for (const deployment of existingDeployments) {
      const name = deployment.metadata?.name || ''
      if (!desiredNames.has(name)) {
        const namespace = deployment.metadata?.namespace || config.namespace
        console.log(`[Reconciler] Removing orphaned resources for "${name}"`)
        await this.deleteRuntimeResources(name, namespace)
      }
    }

    console.log('[Reconciler] Full reconciliation complete')
  }

  /**
   * List all Deployments managed by skill-mapper (by label selector).
   */
  private async listManagedDeployments(): Promise<k8s.V1Deployment[]> {
    try {
      const response = await this.appsApi.listNamespacedDeployment({
        namespace: config.namespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
      })
      return response.items || []
    } catch (error) {
      console.error('[Reconciler] Failed to list managed deployments:', error)
      return []
    }
  }
}
