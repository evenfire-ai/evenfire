/**
 * Configuration settings loaded from environment variables.
 */
import { DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES } from '@clerum/image-policy'
import { parseK8sApiCidrs, parseNodeLocalDnsCidr } from './k8sApiCidrs'
import { ContextCRD, McpServerCRD } from './types'

export const DEFAULT_EGRESS_PROXY_IMAGE = 'clerum/nginx-egress-proxy:0.1.0'
export interface Config {
  // Dev mode - if true, reads servers from env var instead of K8s
  devMode: boolean

  // Server port
  port: number

  // Kubernetes namespace where MCP servers and Context CRDs live
  namespace: string

  // Kubernetes namespace where control-plane gateway services live
  controlPlaneNamespace: string

  // Kubernetes namespace where mcp-host pods run (used for NetworkPolicy generation)
  hostNamespace: string

  // Kubernetes namespace and service port where gfsc runs.
  gfsNamespace: string
  gfscPort: number

  // Kubernetes namespace where rpc-proxy runs (for L2 egress NetworkPolicy generation)
  rpcProxyNamespace: string

  // Kubernetes namespace where per-Host channel-reader Deployments live
  channelsNamespace: string

  // Kubernetes namespace where LlmHook image workloads (guardrail hook pods)
  // live and where the LlmHook CRDs are watched.
  llmHooksNamespace: string

  // Periodic LlmHook fullReconcile interval (seconds). Drives the reference-
  // counted orphan sweep (guardrails phase-4 §3) and readiness convergence when
  // a watch drops events. 0 disables.
  llmHookResyncIntervalSec: number

  // Container image used for per-Host channel-reader Deployments
  channelReaderImage: string

  // imagePullPolicy applied to per-Host channel-reader Deployments
  channelReaderImagePullPolicy: string

  // Internal handoff port exposed by per-Host channel-reader Services.
  channelReaderHandoffPort: number

  // Dev mode: MCP servers from CLERUM_MCP_SERVERS JSON
  devMcpServers: McpServerCRD[]

  // Dev mode: Contexts from CLERUM_CONTEXTS JSON
  devContexts: ContextCRD[]

  // Dev mode: Auth tokens from CLERUM_MCP_AUTH JSON (serverName -> token)
  devAuthTokens: Map<string, string>

  // Egress proxy image for remote MCP servers
  egressProxyImage: string

  // stdio-bridge sidecar image for managed stdio MCP servers
  stdioBridgeImage: string

  // Default resource limits for the stdio-bridge sidecar
  stdioBridgeResources: {
    requests: { memory: string; cpu: string }
    limits: { memory: string; cpu: string }
  }

  // Runtime namespaces where L0 deny-all + L1 infrastructure policies apply
  runtimeNamespaces: string[]

  // Subset of `runtimeNamespaces` that get only deny-all + DNS egress —
  // explicitly NOT allow-hcc-api or allow-k8s-api. Lets us opt out namespaces
  // whose pods aren't K8s clients and don't consume the HCC discovery API.
  minimalInfraNamespaces: string[]

  // K8s API server CIDRs for allow-k8s-api-egress-* policies. Empty = fall
  // back to KUBERNETES_SERVICE_HOST. Validated fail-closed at module load.
  k8sApiCidrs: string[]

  // DNS infrastructure CIDR for GKE NodeLocal DNSCache / kube-dns. When set,
  // allow-dns-egress-* policies append an ipBlock egress rule on port 53 so
  // pod DNS can reach the target cluster's kube-dns Service IP under Calico.
  // Empty (default) -> no extra rule, behavior unchanged.
  nodeLocalDnsCidr: string

  // Host runtime reconciliation defaults
  hostImage: string
  hostImagePullPolicy: 'Always' | 'IfNotPresent' | 'Never'
  // Pull policy override for STATELESS host pods (Stage 6, W5). Empty =
  // inherit hostImagePullPolicy. IfNotPresent is honored only for immutable
  // image references (@sha256: digest or a sha-<gitsha> tag); a mutable
  // reference is refused loudly (error log + StatelessPullPolicyRejected
  // condition) and the pod keeps Always — see hostReconciler's
  // resolveStatelessImagePullPolicy.
  statelessImagePullPolicy: '' | 'Always' | 'IfNotPresent' | 'Never'
  mcpServerImagePullPolicy: 'Always' | 'IfNotPresent' | 'Never'
  hostImagePullSecretName: string
  hostPort: number
  hostConfigMapName: string
  hostServiceAccountName: string
  hostWorkspaceStorageClassName: string
  hostWorkspaceStorageSize: string
  hostWorkspacePath: string
  hostResources: {
    requests: { memory: string; cpu: string }
    limits: { memory: string; cpu: string }
  }

  // Desktop image and resource defaults (used when Host CRD has spec.desktop)
  desktopImage: string
  desktopPort: number
  desktopResources: {
    requests: { memory: string; cpu: string }
    limits: { memory: string; cpu: string }
  }

  // Service token for desktop API endpoints (empty = skip auth, e.g. dev mode)
  desktopApiToken: string

  // workspace-files-controller (per-SharedFileSystem) reconciliation defaults
  wfcImage: string
  wfcImagePullPolicy: 'Always' | 'IfNotPresent' | 'Never'
  wfcImagePullSecretName: string
  wfcPort: number
  wfcInitImage: string
  wfcResources: {
    requests: { memory: string; cpu: string }
    limits: { memory: string; cpu: string }
  }
  /** ConfigMap that exposes the JWT public key the wfc uses to verify browsing JWTs. */
  wfcJwtPublicKeyConfigMapName: string
  wfcJwtPublicKeyConfigMapKey: string
  /** WSF_MAX_* limits forwarded to the wfc container as env. */
  wfcMaxUploadBytes: number
  wfcMaxListEntries: number
  wfcMaxPathDepth: number

  // Cluster-internal control-api base URL — HCC calls this directly (NOT via
  // the public workflow-approval-gateway) to issue mcpHost runtime tokens for the
  // mcp-host pods it provisions. Provisioner issuance is direct;
  // runtime traffic from mcp-host pods still flows through the gateway.
  controlApiBaseUrl: string
  governedTracingEnabled: boolean

  // HS256 secret used by HCC to sign per-request InternalControl JWTs
  // for control-api token issuance.
  internalControlJwtHccHmacSecret: string

  // Namespace HCC targets when asking control-api to issue the shared
  // 1st-party mcp-host credentials.
  hccTargetNamespace: string

  // URL of the nginx gateway that mediates mcp-host → control-api traffic.
  // Injected into mcp-host pods as MCP_HOST_GATEWAY_URL. Per the architecture
  // diagram this is the "nginx (only /mcp-host)" allowlist-proxy.
  mcpHostGatewayUrl: string

  // Periodic Host fullReconcile interval (seconds). Guards against silent
  // event drops on long K8s watch disconnects. 0 disables.
  hostResyncIntervalSec: number

  // Per-request deadline for finite Kubernetes calls on the serialized Host
  // convergence path. Watches keep their independent long-lived lifecycle.
  hostK8sRequestTimeoutMs: number

  // Bounded cross-Host concurrency for a full/lifecycle Host fleet pass. Urgent
  // per-Host events (ADDED/MODIFIED/DELETED/wake) are admitted outside this
  // budget. Integer 1..8, default 2 (see parseHostFullReconcileConcurrency).
  hostFullReconcileConcurrency: number

  // Periodic SharedFileSystem fullReconcile interval (seconds). The SFS watch
  // fires only on SFS CRD changes, not on PVC binding / wfc pod readiness, so
  // this drives truthful-status auto-recovery (#592): a SharedFileSystem stuck
  // in Initializing/Degraded converges to Ready once the volume binds. 0 disables.
  sfsResyncIntervalSec: number

  // Periodic GlobalFileSystem fullReconcile interval (seconds). Same rationale as
  // SFS: the gfs watch fires only on the CRD changing, not on the gfsc writer
  // Deployment becoming Available — so a GlobalFileSystem reported Initializing
  // converges to Ready (and its root-directory seed runs) once the writer is up.
  // 0 disables.
  gfsResyncIntervalSec: number

  // How long before refresh expiry HCC should refresh the bootstrap
  // credential Secret for future pod starts. This does not by itself roll
  // healthy running pods.
  mcpHostBootstrapRefreshBeforeSec: number

  // Rotate the mcp-host bootstrap runtime-token Secret when the refresh
  // token's REAL expiry (the JWT `exp` claim, decoded without signature
  // verification) is closer than this many seconds. Set via
  // CONTEXT_MAPPER_RUNTIME_TOKEN_ROTATE_BEFORE_S; default 24h (86400).
  // Bounded at decision time to half the token's observed lifetime so
  // short-lived dev/test tokens cannot rotate on every reconcile.
  runtimeTokenRotateBeforeSec: number

  // Periodic external-egress DNS resync interval (seconds). Re-resolves
  // McpServer.spec.egressBindings so DNS changes and failures converge without
  // requiring a watch event. 0 disables. Must sit below externalEgressOverlapSec
  // so accumulated IPs never expire between refreshes (issue #299).
  externalEgressResyncIntervalSec: number

  // Deadline for one DNS resolution attempt. A silent resolver cannot block
  // safety convergence indefinitely.
  externalEgressDnsResolveTimeoutMs: number

  // Grace kept after a DNS TTL before an accumulated /32 may expire (seconds).
  // The sliding window that fixes #299: entries live for TTL + overlap, so a
  // provider that rotates a single A record still resolves through the union of
  // recently-live IPs. Set via HCC_EXTERNAL_EGRESS_OVERLAP_SEC.
  externalEgressOverlapSec: number

  // Minimum sane refresh interval (seconds); guards against a hot-loop resync.
  // Set via HCC_EXTERNAL_EGRESS_REFRESH_FLOOR_SEC.
  externalEgressRefreshFloorSec: number

  // Per-FQDN accumulated-entry cap. On overflow the core evicts the
  // least-recently-observed IP (never rejects the policy). Set via
  // HCC_EXTERNAL_EGRESS_MAX_ENTRIES.
  externalEgressMaxEntries: number

  // Plugin image-host allowlist (Phase 2.3). Trusted raw-image prefixes for
  // local-mode McpServer images. Audit mode (default) logs would-be denials
  // without blocking; enforce mode blocks the workload build.
  allowedPluginImagePrefixes: string[]
  enforcePluginImageAllowlist: boolean

  // ─── Stateless heartbeat + D8 idle gate (Stage 3) ─────────────────────
  // Idle window before a stateless Host is drain-eligible (minutes).
  statelessIdleMinutes: number
  // Platform floor for the idle window: effective T_idle = max(idle, floor).
  statelessIdleFloorMinutes: number
  // Grace after a drain:true verdict before suspending without a drained report.
  statelessDrainGraceMs: number
  // Max pod uptime ceiling — an older pod drains regardless of activity (hours).
  statelessMaxUptimeHours: number
  // Cadence of HCC's control-api heartbeat poll (ms). mcp-host heartbeats
  // are ingested by control-api's /mcp-host facade (Host JWT verified there);
  // HCC only CONSUMES them via the InternalControl feed
  // (GET /api/v1/auth/mcp-host/heartbeats) — it never verifies Host JWTs.
  heartbeatPollMs: number
}

function getEnv(key: string, defaultValue?: string): string | undefined {
  return process.env[key] ?? defaultValue
}

function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key]
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  return isNaN(parsed) ? defaultValue : parsed
}

export function parseExternalEgressDnsTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 5_000
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new Error(
      `HCC_EXTERNAL_EGRESS_DNS_TIMEOUT_MS must be a positive integer no greater than 2147483647, got '${raw}'`
    )
  }
  return parsed
}

/**
 * Loud integer env parser for the external-egress knobs (audit R1-L1). Unlike
 * getEnvInt (parseInt), this rejects non-canonical values instead of silently
 * coercing them: '60.5'->60 or '60abc'->60 would pass getEnvInt AND the
 * range invariant (which re-checks the already-truncated value), letting an
 * in-range typo through quietly. Canonical unsigned base-10 only; empty -> default.
 */
function getExternalEgressEnvInt(key: string, defaultValue: number): number {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return defaultValue
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${key} must be an unsigned base-10 integer (seconds), got '${raw}'`)
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${key} is out of the safe integer range, got '${raw}'`)
  }
  return parsed
}

/**
 * CONTEXT_MAPPER_HEARTBEAT_POLL_MS — cadence of HCC's control-api heartbeat
 * poll. Fails config load loudly on a non-positive-integer value: a silent
 * default over garbage would hide a typo'd cadence in production.
 */
export function parseHeartbeatPollMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 10_000
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `CONTEXT_MAPPER_HEARTBEAT_POLL_MS must be a positive integer (milliseconds), got '${raw}'`
    )
  }
  return parsed
}

export function parseHostK8sRequestTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return 30_000
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `HCC_HOST_K8S_REQUEST_TIMEOUT_MS must be a positive integer (milliseconds), got '${raw}'`
    )
  }
  return parsed
}

/**
 * HCC_HOST_FULL_RECONCILE_CONCURRENCY — bounded cross-Host concurrency for a
 * full/lifecycle Host fleet pass. Urgent per-Host events are admitted OUTSIDE
 * this budget, so a low default optimizes for Kubernetes API stability rather
 * than convergence speed. Integer 1..8 (1 = diagnostic serial mode), default 2.
 * Fails config load loudly on garbage: a silent default over a typo'd value
 * would mask an operator's intended concurrency in production.
 */
export function parseHostFullReconcileConcurrency(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 2
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 8) {
    throw new Error(
      `HCC_HOST_FULL_RECONCILE_CONCURRENCY must be an integer from 1 through 8, got '${raw}'`
    )
  }
  return parsed
}

export function validateRemovedStatelessCommunicationChannelPolicy(raw: string | undefined): void {
  if (raw === undefined || raw.trim() === '') return
  throw new Error(
    "CLERUM_STATELESS_COMMUNICATION_CHANNEL_POLICY is no longer supported; CommunicationChannel-connected Hosts are always kept active until channel wake/redrive is implemented (got '" +
      raw +
      "')"
  )
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]
  if (!value) return defaultValue
  return value.toLowerCase() === 'true' || value === '1'
}

/**
 * Parse CLERUM_MCP_SERVERS JSON for dev mode.
 * Format: [{"name": "...", "spec": {"contextRef": "...", "transport": {...}}}]
 */
function parseDevMcpServers(): McpServerCRD[] {
  const serversJson = process.env.CLERUM_MCP_SERVERS
  if (!serversJson) {
    return []
  }

  try {
    const parsed = JSON.parse(serversJson) as McpServerCRD[]
    console.log(`[Config] Parsed ${parsed.length} dev MCP server(s) from CLERUM_MCP_SERVERS`)
    for (const server of parsed) {
      console.log(`[Config]   - ${server.name}: ${server.spec.transport?.url || 'no url'}`)
    }
    return parsed
  } catch (error) {
    console.error('[Config] Failed to parse CLERUM_MCP_SERVERS:', error)
    return []
  }
}

/**
 * Parse CLERUM_CONTEXTS JSON for dev mode.
 * Format: [{"name": "ctx1", "spec": {"contextId": "ctx1", "mcpServers": ["server-a"]}}]
 */
function parseDevContexts(): ContextCRD[] {
  const contextsJson = process.env.CLERUM_CONTEXTS
  if (!contextsJson) {
    return []
  }

  try {
    const parsed = JSON.parse(contextsJson) as ContextCRD[]
    console.log(`[Config] Parsed ${parsed.length} dev Context(s) from CLERUM_CONTEXTS`)
    for (const ctx of parsed) {
      console.log(`[Config]   - ${ctx.name}: mcpServers=[${ctx.spec.mcpServers.join(', ')}]`)
    }
    return parsed
  } catch (error) {
    console.error('[Config] Failed to parse CLERUM_CONTEXTS:', error)
    return []
  }
}

/**
 * Parse CLERUM_MCP_AUTH JSON for dev mode.
 * Format: {"serverName": "token", ...}
 */
function parseDevAuthTokens(): Map<string, string> {
  const authJson = process.env.CLERUM_MCP_AUTH
  if (!authJson) {
    return new Map()
  }

  try {
    const parsed = JSON.parse(authJson) as Record<string, string>
    const tokens = new Map<string, string>()
    for (const [name, token] of Object.entries(parsed)) {
      tokens.set(name, token)
      console.log(`[Config]   - Auth token configured for: ${name}`)
    }
    return tokens
  } catch (error) {
    console.error('[Config] Failed to parse CLERUM_MCP_AUTH:', error)
    return new Map()
  }
}

const devMode = getEnvBool('CLERUM_DEV_MODE', false)

validateRemovedStatelessCommunicationChannelPolicy(
  getEnv('CLERUM_STATELESS_COMMUNICATION_CHANNEL_POLICY')
)

/**
 * Enforce the external-egress sliding-window invariant (issue #299):
 *   refreshFloor >= 1, overlap > 0, maxEntries >= 1, and when the periodic
 *   resync is enabled (interval > 0): floor <= interval <= overlap/2.
 * The interval MUST stay at or below HALF the overlap so an accumulated /32 is
 * refreshed before it can expire (the renewal-write window is only overlap/2
 * wide); otherwise a gap reopens and the pod loses egress on the next rotation.
 * Fails loud at startup rather than degrading silently.
 */
// Upper bounds (audit M-C, port of commit 3f968956). The one-hour cadence
// ceiling keeps every timer far below Node's signed-32-bit setTimeout limit
// (2^31-1 ms ≈ 24.8 days) — an unbounded seconds value multiplied to ms would
// overflow and Node clamps it to 1ms, turning the self-rescheduling resync into
// a back-to-back DNS hot loop. The entry ceiling is a coarse COUNT alarm cap
// matching WRC (1300); the real bound on the annotation size is the core's
// byte-aware eviction (MAX_ANNOTATION_BYTES in network-policy-core), which trims
// long-FQDN sets well before this count is reached (R1-M5 — the previous 4096
// claim of "matches WRC" was false; WRC is 1300 and 4096 never bounds bytes).
const MAX_EXTERNAL_EGRESS_CADENCE_SEC = 60 * 60
const MAX_EXTERNAL_EGRESS_MAX_ENTRIES = 1300

export function validateExternalEgressResyncInvariant(cfg: {
  externalEgressResyncIntervalSec: number
  externalEgressOverlapSec: number
  externalEgressRefreshFloorSec: number
  externalEgressMaxEntries: number
}): void {
  const interval = cfg.externalEgressResyncIntervalSec
  const overlap = cfg.externalEgressOverlapSec
  const floor = cfg.externalEgressRefreshFloorSec
  const max = cfg.externalEgressMaxEntries

  if (!Number.isInteger(overlap) || overlap <= 0 || overlap > MAX_EXTERNAL_EGRESS_CADENCE_SEC) {
    throw new Error(
      `HCC_EXTERNAL_EGRESS_OVERLAP_SEC must be an integer between 1 and ` +
        `${MAX_EXTERNAL_EGRESS_CADENCE_SEC} (seconds), got '${overlap}'`
    )
  }
  if (!Number.isInteger(floor) || floor < 1 || floor > MAX_EXTERNAL_EGRESS_CADENCE_SEC) {
    throw new Error(
      `HCC_EXTERNAL_EGRESS_REFRESH_FLOOR_SEC must be an integer between 1 and ` +
        `${MAX_EXTERNAL_EGRESS_CADENCE_SEC} (seconds), got '${floor}'`
    )
  }
  if (!Number.isInteger(max) || max < 1 || max > MAX_EXTERNAL_EGRESS_MAX_ENTRIES) {
    throw new Error(
      `HCC_EXTERNAL_EGRESS_MAX_ENTRIES must be an integer between 1 and ` +
        `${MAX_EXTERNAL_EGRESS_MAX_ENTRIES}, got '${max}'`
    )
  }
  // A negative interval is a typo, not "disabled" — reject it loudly so it can't
  // silently reinstate the #299 drift bug (audit F4). 0 = explicitly disabled.
  // The upper cap (M-C) prevents a signed-32-bit setTimeout overflow.
  if (!Number.isInteger(interval) || interval < 0 || interval > MAX_EXTERNAL_EGRESS_CADENCE_SEC) {
    throw new Error(
      `HCC_EXTERNAL_EGRESS_RESYNC_SEC must be an integer between 0 and ` +
        `${MAX_EXTERNAL_EGRESS_CADENCE_SEC} (0 disables), got '${interval}'`
    )
  }
  // interval 0 disables periodic resync; only enforce ordering when enabled.
  if (interval > 0) {
    if (interval < floor) {
      throw new Error(
        `HCC_EXTERNAL_EGRESS_RESYNC_SEC (${interval}) must be >= the refresh floor (${floor})`
      )
    }
    // Audit L2: the renewal-write window is only overlap/2 wide, so the interval
    // must be <= overlap/2 (not just < overlap) — otherwise the persisted window
    // can lapse between refreshes and a rotated-away IP is pruned with grace ~=
    // interval instead of TTL+overlap.
    if (interval * 2 > overlap) {
      throw new Error(
        `HCC_EXTERNAL_EGRESS_RESYNC_SEC (${interval}) must be <= half the overlap window ` +
          `(${overlap}/2 = ${overlap / 2}) so the persisted window never lapses between refreshes (issue #299)`
      )
    }
  }
}

export const config: Config = {
  devMode,

  // Server port
  port: getEnvInt('CONTEXT_MAPPER_PORT', 8081),

  // Kubernetes namespace (where MCP servers run)
  namespace: getEnv('CONTEXT_MAPPER_NAMESPACE', 'mcp-server')!,

  // Kubernetes namespace where host-context-controller API gateway runs
  controlPlaneNamespace: getEnv('CONTEXT_MAPPER_CONTROL_PLANE_NAMESPACE', 'control-plane')!,

  // Host namespace (where mcp-host pods run — for NetworkPolicy generation)
  hostNamespace: getEnv('CONTEXT_MAPPER_HOST_NAMESPACE', 'mcp-host')!,

  // Global File System controller namespace and service port.
  gfsNamespace: getEnv('CONTEXT_MAPPER_GFS_NAMESPACE', 'gfs')!,
  gfscPort: getEnvInt('CONTEXT_MAPPER_GFSC_PORT', 8087),

  // rpc-proxy namespace
  rpcProxyNamespace: getEnv('CONTEXT_MAPPER_RPC_PROXY_NAMESPACE', 'rpc-proxy')!,

  // Per-Host channel-reader Deployments namespace
  channelsNamespace: getEnv('CONTEXT_MAPPER_CHANNELS_NAMESPACE', 'channels')!,

  // LlmHook image-workload / CRD-watch namespace (guardrails phase-4).
  llmHooksNamespace: getEnv('CONTEXT_MAPPER_LLM_HOOKS_NAMESPACE', 'llm-hooks')!,

  // Periodic LlmHook resync (default 5 min, matching hostResyncIntervalSec).
  llmHookResyncIntervalSec: getEnvInt('CONTEXT_MAPPER_LLM_HOOK_RESYNC_SEC', 300),

  // Per-Host channel-reader Deployment image (matches deploy/base/channels/channel-reader.yaml)
  channelReaderImage: getEnv('CONTEXT_MAPPER_CHANNEL_READER_IMAGE', 'clerum/channel-reader:0.9.5')!,

  // imagePullPolicy for per-Host channel-reader Deployments. Default 'Always'
  // matches production (pull from registry). Minikube overlay sets
  // 'IfNotPresent' to use locally-loaded images.
  channelReaderImagePullPolicy: getEnv(
    'CONTEXT_MAPPER_CHANNEL_READER_IMAGE_PULL_POLICY',
    'Always'
  )!,
  channelReaderHandoffPort: getEnvInt('CONTEXT_MAPPER_CHANNEL_READER_HANDOFF_PORT', 8099),

  // Egress proxy image for remote MCP servers (nginx-based, per-server proxy)
  egressProxyImage: getEnv('CONTEXT_MAPPER_EGRESS_PROXY_IMAGE', DEFAULT_EGRESS_PROXY_IMAGE)!,

  // stdio-bridge sidecar image
  stdioBridgeImage: getEnv(
    'CONTEXT_MAPPER_STDIO_BRIDGE_IMAGE',
    'us-central1-docker.pkg.dev/your-gcp-project/clerum/stdio-bridge:0.1.0'
  )!,

  // stdio-bridge sidecar resource defaults
  stdioBridgeResources: {
    requests: {
      memory: getEnv('CONTEXT_MAPPER_STDIO_BRIDGE_REQUEST_MEMORY', '32Mi')!,
      cpu: getEnv('CONTEXT_MAPPER_STDIO_BRIDGE_REQUEST_CPU', '50m')!,
    },
    limits: {
      memory: getEnv('CONTEXT_MAPPER_STDIO_BRIDGE_LIMIT_MEMORY', '128Mi')!,
      cpu: getEnv('CONTEXT_MAPPER_STDIO_BRIDGE_LIMIT_CPU', '200m')!,
    },
  },

  // Runtime namespaces where L0 deny-all + L1 infrastructure policies apply.
  //
  // llm-hooks is deliberately NOT listed: this list is a package deal, and its
  // L1 pass grants namespace-wide DNS (`ensureDnsEgress` uses podSelector: {})
  // plus HCC-gateway egress to every pod carrying clerum.io/managed-by — which
  // hook pod templates do. That would hand a pure `/v1` responder the implicit
  // DNS N5 forbids. The llm-hooks baseline is static instead
  // (deploy/base/llm-hooks/networkpolicies.yaml: deny-all ingress + egress),
  // with per-pod-key ingress and scoped CoreDNS emitted by LlmHookReconciler
  // only for hooks that declare egressBindings.
  runtimeNamespaces: getEnv(
    'CONTEXT_MAPPER_RUNTIME_NAMESPACES',
    'mcp-server,mcp-host,sandbox-recipes,rpc-proxy'
  )!.split(','),

  // DNS infrastructure CIDR for GKE NodeLocal DNSCache / kube-dns. Empty
  // (default) keeps only the kube-system selector. Validated fail-closed as a
  // single IPv4 /32 because GKE requires KUBE_DNS_SVC_CLUSTER_IP/32.
  nodeLocalDnsCidr: parseNodeLocalDnsCidr(getEnv('CONTEXT_MAPPER_NODELOCAL_DNS_CIDR')),

  // Subset of runtime namespaces that get only the minimal infrastructure
  // egress (deny-all + DNS) — and explicitly NOT allow-hcc-api or
  // allow-k8s-api. Use this for namespaces whose pods are not K8s clients
  // and don't consume the HCC discovery API (e.g. third-party UI workloads
  // that only need to serve HTTP back to a single ingress source).
  // Empty by default → all runtime namespaces get the full infra set.
  minimalInfraNamespaces: getEnv('CONTEXT_MAPPER_MINIMAL_INFRA_NAMESPACES', '')!
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0),

  // Validated at module load — a malformed/over-broad value crashes startup
  // rather than programming a permissive allow-k8s-api-egress NetworkPolicy.
  k8sApiCidrs: parseK8sApiCidrs(getEnv('CONTEXT_MAPPER_K8S_API_CIDRS')),

  // Dev mode MCP servers
  devMcpServers: devMode ? parseDevMcpServers() : [],

  // Dev mode contexts
  devContexts: devMode ? parseDevContexts() : [],

  // Dev mode auth tokens
  devAuthTokens: devMode ? parseDevAuthTokens() : new Map(),

  // Host runtime defaults
  hostImage: getEnv(
    'CONTEXT_MAPPER_HOST_IMAGE',
    'us-central1-docker.pkg.dev/your-gcp-project/clerum/mcp-host:0.6.0'
  )!,
  hostImagePullPolicy: getEnv('CONTEXT_MAPPER_HOST_IMAGE_PULL_POLICY', 'Always') as
    | 'Always'
    | 'IfNotPresent'
    | 'Never',
  statelessImagePullPolicy: getEnv('CONTEXT_MAPPER_STATELESS_IMAGE_PULL_POLICY', '') as
    | ''
    | 'Always'
    | 'IfNotPresent'
    | 'Never',
  mcpServerImagePullPolicy: getEnv('CONTEXT_MAPPER_MCPSERVER_IMAGE_PULL_POLICY', 'IfNotPresent') as
    | 'Always'
    | 'IfNotPresent'
    | 'Never',
  hostImagePullSecretName: getEnv('CONTEXT_MAPPER_HOST_IMAGE_PULL_SECRET', 'clerum')!,
  hostPort: getEnvInt('CONTEXT_MAPPER_HOST_PORT', 8080),
  hostConfigMapName: getEnv('CONTEXT_MAPPER_HOST_CONFIGMAP_NAME', 'mcp-host-config')!,
  hostServiceAccountName: getEnv('CONTEXT_MAPPER_HOST_SERVICE_ACCOUNT', 'mcp-host')!,
  hostWorkspaceStorageClassName: getEnv(
    'CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS',
    'do-block-storage-retain'
  )!,
  hostWorkspaceStorageSize: getEnv('CONTEXT_MAPPER_HOST_WORKSPACE_SIZE', '10Gi')!,
  hostWorkspacePath: getEnv('CONTEXT_MAPPER_HOST_WORKSPACE_PATH', '/workspace')!,
  hostResources: {
    requests: {
      memory: getEnv('CONTEXT_MAPPER_HOST_RESOURCES_REQUEST_MEMORY', '128Mi')!,
      cpu: getEnv('CONTEXT_MAPPER_HOST_RESOURCES_REQUEST_CPU', '100m')!,
    },
    limits: {
      memory: getEnv('CONTEXT_MAPPER_HOST_RESOURCES_LIMIT_MEMORY', '512Mi')!,
      cpu: getEnv('CONTEXT_MAPPER_HOST_RESOURCES_LIMIT_CPU', '500m')!,
    },
  },

  // Desktop image and resource defaults
  desktopImage: getEnv('CONTEXT_MAPPER_DESKTOP_IMAGE', 'clerum/mcp-host-desktop:latest')!,
  desktopPort: getEnvInt('CONTEXT_MAPPER_DESKTOP_PORT', 3000),
  desktopResources: {
    requests: {
      memory: getEnv('CONTEXT_MAPPER_DESKTOP_RESOURCES_REQUEST_MEMORY', '256Mi')!,
      cpu: getEnv('CONTEXT_MAPPER_DESKTOP_RESOURCES_REQUEST_CPU', '250m')!,
    },
    limits: {
      memory: getEnv('CONTEXT_MAPPER_DESKTOP_RESOURCES_LIMIT_MEMORY', '4Gi')!,
      cpu: getEnv('CONTEXT_MAPPER_DESKTOP_RESOURCES_LIMIT_CPU', '1000m')!,
    },
  },

  // Service token for desktop API endpoints (empty = skip auth for dev mode)
  desktopApiToken: getEnv('CONTEXT_MAPPER_DESKTOP_API_TOKEN', '')!,

  // workspace-files-controller (per-SharedFileSystem) reconciliation defaults
  wfcImage: getEnv(
    'CONTEXT_MAPPER_WFC_IMAGE',
    'us-central1-docker.pkg.dev/your-gcp-project/clerum/workspace-files-controller:0.1.0'
  )!,
  wfcImagePullPolicy: getEnv('CONTEXT_MAPPER_WFC_IMAGE_PULL_POLICY', 'IfNotPresent') as
    | 'Always'
    | 'IfNotPresent'
    | 'Never',
  wfcImagePullSecretName: getEnv('CONTEXT_MAPPER_WFC_IMAGE_PULL_SECRET', 'clerum')!,
  wfcPort: getEnvInt('CONTEXT_MAPPER_WFC_PORT', 8086),
  wfcInitImage: getEnv('CONTEXT_MAPPER_WFC_INIT_IMAGE', 'busybox:1.36')!,
  wfcResources: {
    requests: {
      memory: getEnv('CONTEXT_MAPPER_WFC_RESOURCES_REQUEST_MEMORY', '64Mi')!,
      cpu: getEnv('CONTEXT_MAPPER_WFC_RESOURCES_REQUEST_CPU', '50m')!,
    },
    limits: {
      memory: getEnv('CONTEXT_MAPPER_WFC_RESOURCES_LIMIT_MEMORY', '128Mi')!,
      cpu: getEnv('CONTEXT_MAPPER_WFC_RESOURCES_LIMIT_CPU', '200m')!,
    },
  },
  wfcJwtPublicKeyConfigMapName: getEnv('CONTEXT_MAPPER_WFC_JWT_PUBLIC_KEY_CM', 'mcp-host-config')!,
  wfcJwtPublicKeyConfigMapKey: getEnv(
    'CONTEXT_MAPPER_WFC_JWT_PUBLIC_KEY_CM_KEY',
    'CLERUM_AUTH_JWT_PUBLIC_KEY'
  )!,
  wfcMaxUploadBytes: getEnvInt('CONTEXT_MAPPER_WFC_MAX_UPLOAD_BYTES', 100 * 1024 * 1024),
  wfcMaxListEntries: getEnvInt('CONTEXT_MAPPER_WFC_MAX_LIST_ENTRIES', 5000),
  wfcMaxPathDepth: getEnvInt('CONTEXT_MAPPER_WFC_MAX_PATH_DEPTH', 32),

  // Cluster-internal control-api endpoint (issuance is direct, NOT via gateway)
  controlApiBaseUrl: getEnv(
    'CONTROL_API_BASE_URL',
    'http://control-api.control-plane.svc.cluster.local:8090'
  )!,
  governedTracingEnabled: getEnvBool('GOVERNED_TRACING_ENABLED', true),

  // HCC signs InternalControl JWTs for direct control-api issuance calls.
  internalControlJwtHccHmacSecret: getEnv('INTERNAL_CONTROL_JWT_HCC_HMAC_SECRET', '')!,

  // HCC provisions the shared 1st-party mcp-host credentials by default.
  hccTargetNamespace: getEnv('HCC_TARGET_NAMESPACE')?.trim() || 'mcp-host',

  // URL of the nginx gateway that mediates mcp-host → control-api traffic.
  // Injected into mcp-host pods as MCP_HOST_GATEWAY_URL. Per the architecture
  // diagram this is the "nginx (only /mcp-host)" allowlist-proxy.
  mcpHostGatewayUrl: getEnv(
    'MCP_HOST_GATEWAY_URL',
    'http://nginx-workflow-approval-gateway.control-plane.svc.cluster.local:8092'
  )!,

  // Periodic Host resync (default 5 min). 0 disables watches-only self-heal
  // for runtime-auth degraded mcp-host pods; use only for diagnostic runs.
  hostResyncIntervalSec: getEnvInt('CONTEXT_MAPPER_HOST_RESYNC_SEC', 300),

  // Every finite Kubernetes request that can hold Host convergence gets its
  // own deadline. Watch streams are intentionally excluded.
  hostK8sRequestTimeoutMs: parseHostK8sRequestTimeoutMs(getEnv('HCC_HOST_K8S_REQUEST_TIMEOUT_MS')),
  hostFullReconcileConcurrency: parseHostFullReconcileConcurrency(
    getEnv('HCC_HOST_FULL_RECONCILE_CONCURRENCY')
  ),

  // Periodic SharedFileSystem resync (default 60s). Re-evaluates PVC bind + wfc
  // readiness so a transient Initializing/Degraded converges to Ready (#592).
  sfsResyncIntervalSec: getEnvInt('CONTEXT_MAPPER_SFS_RESYNC_SEC', 60),
  gfsResyncIntervalSec: getEnvInt('CONTEXT_MAPPER_GFS_RESYNC_SEC', 60),

  // Bootstrap runtime credential refresh margin. The reconciler bounds this
  // against hostResyncIntervalSec and the issuer-provided refresh TTL.
  mcpHostBootstrapRefreshBeforeSec: getEnvInt(
    'HCC_MCP_HOST_RUNTIME_BOOTSTRAP_REFRESH_BEFORE_SEC',
    900
  ),

  // Refresh-token near-expiry rotation window (default 24h). Documented in
  // the ClerumConfig interface above.
  runtimeTokenRotateBeforeSec: getEnvInt('CONTEXT_MAPPER_RUNTIME_TOKEN_ROTATE_BEFORE_S', 86_400),

  // Periodic external-egress DNS resync. Lowered from the legacy 5 min to 60s so
  // it sits below the 300s overlap window: accumulated IPs are refreshed before
  // they expire, closing the #299 rotation gap. 0 disables (reintroduces the
  // stale-snapshot risk; only for operators who explicitly opt out).
  externalEgressResyncIntervalSec: getExternalEgressEnvInt('HCC_EXTERNAL_EGRESS_RESYNC_SEC', 60),
  externalEgressDnsResolveTimeoutMs: parseExternalEgressDnsTimeoutMs(
    getEnv('HCC_EXTERNAL_EGRESS_DNS_TIMEOUT_MS')
  ),
  externalEgressOverlapSec: getExternalEgressEnvInt('HCC_EXTERNAL_EGRESS_OVERLAP_SEC', 300),
  externalEgressRefreshFloorSec: getExternalEgressEnvInt(
    'HCC_EXTERNAL_EGRESS_REFRESH_FLOOR_SEC',
    5
  ),
  externalEgressMaxEntries: getExternalEgressEnvInt('HCC_EXTERNAL_EGRESS_MAX_ENTRIES', 128),

  // Plugin image-host allowlist (Phase 2.3). Permissive default = current
  // fleet hosts + registry.evenfire.ai; enforce defaults to false (audit mode).
  allowedPluginImagePrefixes: getEnv(
    'CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES',
    [...DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES].join(',')
  )!
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0),
  enforcePluginImageAllowlist: getEnvBool('CONTEXT_MAPPER_ENFORCE_IMAGE_ALLOWLIST', false),

  // Stateless heartbeat + D8 idle gate (Stage 3).
  statelessIdleMinutes: getEnvInt('CONTEXT_MAPPER_STATELESS_IDLE_MINUTES', 30),
  statelessIdleFloorMinutes: getEnvInt('CONTEXT_MAPPER_STATELESS_IDLE_FLOOR_MINUTES', 15),
  statelessDrainGraceMs: getEnvInt('CONTEXT_MAPPER_STATELESS_DRAIN_GRACE_MS', 60000),
  statelessMaxUptimeHours: getEnvInt('CONTEXT_MAPPER_STATELESS_MAX_UPTIME_HOURS', 72),
  heartbeatPollMs: parseHeartbeatPollMs(getEnv('CONTEXT_MAPPER_HEARTBEAT_POLL_MS')),
}

// Fail loud at import time if the external-egress sliding-window knobs are
// inconsistent (issue #299) — a silent misconfig would reopen the rotation gap.
validateExternalEgressResyncInvariant(config)
