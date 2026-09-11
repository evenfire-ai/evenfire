/**
 * OpenAI-compatible Egress Broker Reconciler — for every local
 * openai-compatible endpoint a Host declares (`spec.model.baseURL` when the
 * primary provider is `openai-compatible`, or `spec.llmPolicy.fallbacks[i].baseURL`
 * for a local fallback), provisions a dedicated per-slot egress broker in the
 * `llm-egress` namespace. The broker is the ONLY pod population with a route to
 * the operator's private LAN; the mcp-host dials the broker's in-cluster Service
 * and never the LAN address directly (phase 5 wires the dial).
 *
 * Each slot gets, keyed by a deterministic broker name:
 *   - a Deployment (reusing the hardened nginx-egress-proxy image; a NEW,
 *     http-plain config generator — NOT reconciler.ts's HTTPS-only, private-
 *     rejecting one),
 *   - a ClusterIP Service on BROKER_PORT,
 *   - a ConfigMap holding the value-blind nginx `default.conf.template`,
 *   - a mirror Secret carrying ONLY the `openai-compatible-api-key` slot copied
 *     from the Host's own `spec.secretRef` Secret (mcp-host namespace),
 *   - a `/32` egress NetworkPolicy broker→LAN (the single LAN route; no DNS),
 *   - an ingress NetworkPolicy admitting only this Host's mcp-host pods,
 *   - a mcp-host→broker egress NetworkPolicy in the host namespace.
 *
 * Mirrors LlmHookReconciler: per-key serialization, create-then-409
 * replaceWithConflictRetry, ownership-verifying deletes, label-owned GC, and a
 * global orphan sweep. Serialization is per `host:<name>` (a Host's slots are
 * reconciled together).
 *
 * NAMING SCHEME: the slotId, the broker-name hash and the in-cluster FQDN all
 * live in `@clerum/egress-policy` — `PRIMARY_SLOT_ID`, `fallbackSlotId(i)` (i =
 * the RAW index into spec.llmPolicy.fallbacks), `brokerNameFor(host, slotId)`
 * and `brokerInternalUrl`. HCC reimplements NONE of them: it imports the
 * constants/helpers so mcp-host (phase 5) derives the IDENTICAL Service without
 * a handshake, and a future schema change in the shared package is followed by
 * both sides at once instead of drifting. The human `(host, slotId)` pair lives
 * in labels/annotations for observability.
 */
import * as k8s from '@kubernetes/client-node'
import { IntOrString } from '@kubernetes/client-node/dist/types.js'
import { createHash } from 'crypto'
import {
  type LanBaseUrlReason,
  OAI_EGRESS_BROKERS_CONDITION_TYPE,
  PRIMARY_SLOT_ID,
  brokerNameFor,
  classifyLanBaseURL,
  fallbackSlotId,
  ipv4ToInt,
} from '@clerum/egress-policy'
import { config } from './config'
import {
  HOST_LABEL,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  OAI_EGRESS_BROKER_LABEL,
  OAI_EGRESS_COMPONENT_VALUE,
  POLICY_TYPE_LABEL,
} from './constants'
import { hccLogger } from './logger'
import {
  type SlotOutcome,
  buildBrokersCondition,
  writeBrokersCondition,
} from './openaiEgressBrokerStatus'
import { HostCRD } from './types'
import {
  configMapMatchesDesired,
  deploymentMatchesDesired,
  getErrorCode,
  networkPolicyMatchesDesired,
  observeCreate,
  observeExistenceRead,
  preserveDeploymentAnnotations,
  preserveObjectAnnotations,
  preserveServiceAssignedFields,
  replaceWithConflictRetry,
  serviceMatchesDesired,
} from './utils'

const log = hccLogger.child({ module: 'oai-egress-broker' })

const CREDENTIALS_REVISION_ANNOTATION = 'clerum.io/credentials-revision'
const COMPONENT_LABEL = 'clerum.io/component'
const SLOT_ANNOTATION = 'clerum.io/oai-egress-source'
const OPENAI_COMPATIBLE_PROVIDER = 'openai-compatible'
// The single credential slot for the openai-compatible provider (canonical key
// inside the Host LLM Secret and inside the mirror Secret). Env var the nginx
// image reads at startup via envsubst. Kept in sync with
// @clerum/llm-providers PROVIDER_CREDENTIAL_SLOTS['openai-compatible'][0].
const OPENAI_COMPATIBLE_API_KEY_SLOT = 'openai-compatible-api-key'
const OPENAI_COMPATIBLE_API_KEY_ENV = 'OPENAI_COMPATIBLE_API_KEY'

/**
 * Emitted (warn) when `fullReconcile` refuses to run because the Host inventory
 * is not authoritative. The full pass derives `desired` from the in-memory Host
 * cache and its orphan sweep deletes every broker not in that set — so an empty
 * or stale cache (cold-start LIST failed, or a watch is recovering) would wipe
 * the live broker fleet. Mirrors NETWORKPOLICY_ORPHAN_SWEEP_CAPPED_MESSAGE.
 */
export const OAI_EGRESS_FULL_RECONCILE_SKIPPED_MESSAGE =
  'openai-compatible egress full reconcile skipped: Host inventory not authoritative'

type OpenAiEgressBrokerReconcilerDeps = {
  appsApi?: k8s.AppsV1Api
  coreApi?: k8s.CoreV1Api
  networkingApi?: k8s.NetworkingV1Api
  customApi?: k8s.CustomObjectsApi
  /**
   * Authority fence for the Host-cache-fed full reconcile + orphan sweep. When
   * it returns false the cache may be empty or stale, so the sweep would delete
   * every live broker; `fullReconcile` no-ops instead. ABSENT ⇒ fail-closed
   * (`() => false`): no full pass runs until a caller wires the predicate. Per-
   * Host event paths (reconcileForHost/reconcileDelete) are NOT gated — they act
   * on the Host carried by the watch event, not on the cache.
   */
  hostInventoryAuthoritative?: () => boolean
}

/** Machine reason a slot was NOT provisioned (validateSlot drops + provision failure). */
type SlotDropReason =
  | 'cluster_internal_guard_unconfigured'
  | LanBaseUrlReason
  | 'url_unparseable'
  | 'scheme_unsupported'
  | 'port_invalid'
  | 'path_unsafe'
  | 'provision_failed'

/** A validated local slot that must have a broker. */
type DesiredBroker = {
  slotId: string
  brokerName: string
  ip: string
  lanPort: number
  scheme: 'http:' | 'https:'
  path: string
  /** Data key to read from the Host's own Secret for this slot's credential. */
  credentialDataKey: string
}

// The slotId constants, the deterministic broker name and the in-cluster FQDN
// all live in @clerum/egress-policy (PRIMARY_SLOT_ID / fallbackSlotId /
// brokerNameFor / brokerServiceHost / brokerInternalUrl) so mcp-host (phase 5)
// derives the IDENTICAL Service without a handshake — neither the slotId scheme
// nor the drift-critical hash is duplicated here. brokerNameFor is re-exported
// so existing importers of this module keep working.
export { brokerNameFor }

/**
 * True when a Host declares an openai-compatible provider on its primary model
 * or any fallback (baseURL validity NOT checked). Lets the watch fan-out skip
 * the broker reconcile — and its list calls — for the common case of a Host with
 * no local endpoint, while still running teardown when a Host FLIPS AWAY from
 * openai-compatible (the caller ORs this over the pre- and post-event snapshots).
 */
export function hostDeclaresOpenAiCompatible(host: HostCRD | undefined): boolean {
  if (!host) return false
  if (host.spec.model?.provider?.trim() === OPENAI_COMPATIBLE_PROVIDER) return true
  return (host.spec.llmPolicy?.fallbacks ?? []).some(
    fb => fb.provider?.trim() === OPENAI_COMPATIBLE_PROVIDER
  )
}

/**
 * The cluster-internal CIDR set the LAN classifier rejects a baseURL against,
 * plus whether the operator actually configured the guard. `cidrs` unions every
 * source HCC knows — the apiserver CIDRs, the nodelocal DNS CIDR, the
 * operator-declared cluster-internal ranges — and a zero-config FLOOR: the
 * apiserver ClusterIP as a /32 from KUBERNETES_SERVICE_HOST (the same expression
 * the k8s-api egress NetworkPolicy uses). The floor is IPv4-only (an IPv6 or
 * malformed value yields no floor entry rather than a CIDR the classifier would
 * ignore). `guardConfigured` reflects ONLY the operator's explicit
 * clusterInternalEgressCidrs — the floor is a safety net, not evidence the guard
 * was set — so the fail-closed check still trips when only the floor is present.
 */
export function resolveClusterInternalCidrs(): { cidrs: string[]; guardConfigured: boolean } {
  const floor: string[] = []
  const apiHost = process.env.KUBERNETES_SERVICE_HOST
  if (apiHost && ipv4ToInt(apiHost) !== null) floor.push(`${apiHost}/32`)
  const cidrs = [
    ...config.k8sApiCidrs,
    ...(config.nodeLocalDnsCidr ? [config.nodeLocalDnsCidr] : []),
    ...config.clusterInternalEgressCidrs,
    ...floor,
  ]
  return { cidrs, guardConfigured: config.clusterInternalEgressCidrs.length > 0 }
}

export class OpenAiEgressBrokerReconciler {
  private readonly appsApi: k8s.AppsV1Api
  private readonly coreApi: k8s.CoreV1Api
  private readonly networkingApi: k8s.NetworkingV1Api
  private readonly customApi: k8s.CustomObjectsApi

  /** Cache of Host CRs by name (owned by the watcher). */
  private readonly hosts: Map<string, HostCRD>

  /** Authority fence for the cache-fed full reconcile; fail-closed when absent. */
  private readonly hostInventoryAuthoritative: () => boolean

  private readonly inFlight: Map<string, Promise<void>> = new Map()

  constructor(
    kc: k8s.KubeConfig,
    hostCache: Map<string, HostCRD>,
    deps?: OpenAiEgressBrokerReconcilerDeps
  ) {
    this.appsApi = deps?.appsApi ?? kc.makeApiClient(k8s.AppsV1Api)
    this.coreApi = deps?.coreApi ?? kc.makeApiClient(k8s.CoreV1Api)
    this.networkingApi = deps?.networkingApi ?? kc.makeApiClient(k8s.NetworkingV1Api)
    this.customApi = deps?.customApi ?? kc.makeApiClient(k8s.CustomObjectsApi)
    this.hosts = hostCache
    this.hostInventoryAuthoritative = deps?.hostInventoryAuthoritative ?? (() => false)
  }

  // ─── Serialization ──────────────────────────────────────────────────

  private runSerialized(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.inFlight.get(key) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(fn)
    this.inFlight.set(key, next)
    return (async () => {
      try {
        await next
      } finally {
        if (this.inFlight.get(key) === next) this.inFlight.delete(key)
      }
    })()
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /** Reconcile all broker slots for a created/modified Host. */
  async reconcileForHost(host: HostCRD): Promise<void> {
    await this.runSerialized(`host:${host.name}`, () => this.reconcileHostBrokers(host))
  }

  /** Tear down every broker of a deleted Host. */
  async reconcileDelete(hostName: string): Promise<void> {
    await this.runSerialized(`host:${hostName}`, () => this.gcHostBrokers(hostName, new Set()))
  }

  /** Full pass (startup + periodic resync): reconcile every Host, then sweep. */
  async fullReconcile(hosts: HostCRD[]): Promise<void> {
    // Authority fence: the sweep below deletes every broker not derived from the
    // Host cache, so an empty/stale cache would wipe the live fleet. Refuse the
    // whole pass — the per-Host event paths keep converging in the meantime, and
    // the next authoritative resync tick catches up. Same guard the other cache-
    // fed consumers use (performHostFleetReconcileOnce, hostReconciler authority).
    if (!this.hostInventoryAuthoritative()) {
      log.warn(OAI_EGRESS_FULL_RECONCILE_SKIPPED_MESSAGE, { hosts: hosts.length })
      return
    }
    log.info('Running full reconciliation', { hosts: hosts.length })
    for (const host of hosts) {
      await this.runSerialized(`host:${host.name}`, () => this.reconcileHostBrokers(host))
    }
    await this.sweepOrphans()
    log.info('Full reconciliation complete')
  }

  // ─── Desired-state derivation ───────────────────────────────────────

  /**
   * Every local openai-compatible slot of a Host that survives fail-closed
   * re-validation. A slot whose baseURL is not a clean RFC1918 IP-literal (per
   * classifyLanBaseURL) or whose path/port cannot be parsed safely is DROPPED —
   * no broker is provisioned for it. control-api admission (phase 3) already
   * guarantees the shape; this is defense-in-depth against a direct cluster
   * write that bypassed control-api.
   */
  private buildDesiredBrokers(host: HostCRD): { desired: DesiredBroker[]; dropped: SlotOutcome[] } {
    const desired: DesiredBroker[] = []
    const dropped: SlotOutcome[] = []
    const seenSlotIds = new Set<string>()

    const consider = (
      slotId: string,
      provider: string | undefined,
      baseURL: string | undefined,
      credentialDataKey: string
    ): void => {
      if (provider?.trim() !== OPENAI_COMPATIBLE_PROVIDER) return
      if (!baseURL) return
      if (seenSlotIds.has(slotId)) return
      seenSlotIds.add(slotId)
      const result = this.validateSlot(host.name, slotId, baseURL, credentialDataKey)
      if ('reason' in result) {
        dropped.push({ slotId, reason: result.reason })
      } else {
        desired.push(result)
      }
    }

    consider(
      PRIMARY_SLOT_ID,
      host.spec.model?.provider,
      host.spec.model?.baseURL,
      OPENAI_COMPATIBLE_API_KEY_SLOT
    )

    const fallbacks = host.spec.llmPolicy?.fallbacks ?? []
    fallbacks.forEach((fb, i) => {
      // credentialSlot (when set) is the literal Secret data key that feeds this
      // fallback's key — mirroring mcp-host's fallback resolution. Absent ⇒ the
      // provider's canonical slot key.
      const dataKey = fb.credentialSlot?.trim() || OPENAI_COMPATIBLE_API_KEY_SLOT
      consider(fallbackSlotId(i), fb.provider, fb.baseURL, dataKey)
    })

    return { desired, dropped }
  }

  private validateSlot(
    hostName: string,
    slotId: string,
    baseURL: string,
    credentialDataKey: string
  ): DesiredBroker | { reason: SlotDropReason } {
    // Cluster-internal ranges HCC rejects a baseURL against (see
    // resolveClusterInternalCidrs). The floor pins the apiserver ClusterIP even
    // with zero config, but the floor alone is NOT a configured guard.
    const { cidrs: clusterInternalCidrs, guardConfigured } = resolveClusterInternalCidrs()
    // Fail-closed: without operator-declared cluster-internal ranges the
    // classifier cannot distinguish cluster space (apiserver/pod ClusterIPs) from
    // a real private LAN, so it would accept a cluster-internal baseURL. Refuse to
    // provision any slot until the guard is configured. The escape hatch is
    // CONTEXT_MAPPER_OAI_EGRESS_REQUIRE_CLUSTER_CIDRS=false, for a deploy that
    // deliberately runs without it.
    if (!guardConfigured && config.oaiEgressRequireClusterCidrs) {
      log.error(
        'cluster-internal CIDR guard unconfigured — refusing to provision broker; set CONTEXT_MAPPER_CLUSTER_INTERNAL_CIDRS (or opt out with CONTEXT_MAPPER_OAI_EGRESS_REQUIRE_CLUSTER_CIDRS=false)',
        { host: hostName, slotId }
      )
      return { reason: 'cluster_internal_guard_unconfigured' }
    }
    const decision = classifyLanBaseURL(
      baseURL,
      clusterInternalCidrs.length ? { clusterInternalCidrs } : undefined
    )
    if (!decision.ok) {
      log.warn('baseURL failed fail-closed LAN validation — slot not provisioned', {
        host: hostName,
        slotId,
        reason: decision.reason,
      })
      return { reason: decision.reason }
    }
    let parsed: URL
    try {
      parsed = new URL(baseURL)
    } catch {
      log.warn('baseURL is not a parseable URL — slot not provisioned', { host: hostName, slotId })
      return { reason: 'url_unparseable' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      log.warn('baseURL scheme unsupported — slot not provisioned', {
        host: hostName,
        slotId,
        scheme: parsed.protocol,
      })
      return { reason: 'scheme_unsupported' }
    }
    // Take the LAN address from the classifier (validated RFC1918 IPv4 literal),
    // never from the raw string. Port + path come from the parsed URL components,
    // never from string slicing — anti-injection for the generated nginx config.
    const lanPort = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
    if (!Number.isInteger(lanPort) || lanPort < 1 || lanPort > 65535) {
      log.warn('baseURL port invalid — slot not provisioned', { host: hostName, slotId })
      return { reason: 'port_invalid' }
    }
    const path = parsed.pathname || '/'
    // Reject anything that could break the nginx quoted/directive context. URL
    // parsing already percent-encodes CR/LF/space, but reject defensively so a
    // path can never carry a newline, quote, backslash, NUL, whitespace — or the
    // metacharacters that survive URL parsing and are meaningful in nginx: `$`
    // (proxy_pass runtime variable interpolation — `.../v1$request_uri` would
    // rewrite the upstream), `#` (starts a comment), and backtick.
    if (/[\r\n\t "'\\;{}$#`\0]/.test(path) || path.length > 1024) {
      log.warn('baseURL path unsafe — slot not provisioned', { host: hostName, slotId })
      return { reason: 'path_unsafe' }
    }
    return {
      slotId,
      brokerName: brokerNameFor(hostName, slotId),
      ip: decision.ip,
      lanPort,
      scheme: parsed.protocol,
      path,
      credentialDataKey,
    }
  }

  // ─── Per-host reconcile ─────────────────────────────────────────────

  private async reconcileHostBrokers(host: HostCRD): Promise<void> {
    const { desired, dropped } = this.buildDesiredBrokers(host)
    const desiredNames = new Set(desired.map(d => d.brokerName))

    // Every slot NOT reflected as a live broker, so the Host status condition
    // below reports the full outcome: slots dropped by validateSlot plus any that
    // fail mid-provision.
    const outcomes: SlotOutcome[] = [...dropped]
    let provisioned = 0
    for (const broker of desired) {
      try {
        const credentialB64 = await this.readHostCredential(host, broker.credentialDataKey)
        const revision = createHash('sha256').update(credentialB64).digest('hex')
        await this.ensureSecret(host, broker, credentialB64)
        await this.ensureConfigMap(host, broker)
        await this.ensureDeployment(host, broker, revision)
        await this.ensureService(host, broker)
        await this.ensureBrokerIngressPolicy(host, broker)
        await this.ensureBrokerLanEgressPolicy(host, broker)
        await this.ensureHostToBrokerPolicy(host, broker)
        provisioned += 1
      } catch (err) {
        log.error('Failed to provision broker', {
          host: host.name,
          slotId: broker.slotId,
          broker: broker.brokerName,
          err,
        })
        outcomes.push({ slotId: broker.slotId, reason: 'provision_failed' })
      }
    }

    // Remove brokers this Host no longer wants (e.g. a fallback removed, or the
    // provider flipped away from openai-compatible).
    await this.gcHostBrokers(host.name, desiredNames)

    // Reflect the outcome on Host status so control-api/control-ui — which run the
    // CIDR-blind classifier and never learn what HCC did — can surface a drop.
    await this.writeHostBrokersCondition(host, provisioned, outcomes)
  }

  /**
   * Best-effort Host status write of the egress-broker condition. Skips the fresh
   * GET entirely for the common case of a Host that neither declares an
   * openai-compatible slot nor already carries the condition — no write, no GET.
   */
  private async writeHostBrokersCondition(
    host: HostCRD,
    provisioned: number,
    dropped: SlotOutcome[]
  ): Promise<void> {
    const declaresOpenAiCompatible = hostDeclaresOpenAiCompatible(host)
    const hasCondition = host.status?.conditions?.some(
      c => c.type === OAI_EGRESS_BROKERS_CONDITION_TYPE
    )
    if (!declaresOpenAiCompatible && !hasCondition) return
    await writeBrokersCondition(this.customApi, host, fresh =>
      buildBrokersCondition(fresh, { declaresOpenAiCompatible, provisioned, dropped })
    )
  }

  /** Read one credential slot (base64, as stored) from the Host's own Secret. */
  private async readHostCredential(host: HostCRD, dataKey: string): Promise<string> {
    const secretName = host.spec.secretRef
    if (!secretName) return ''
    try {
      const secret = await this.coreApi.readNamespacedSecret({
        name: secretName,
        namespace: config.hostNamespace,
      })
      return secret.data?.[dataKey] ?? ''
    } catch (error) {
      if (getErrorCode(error) === 404) return ''
      throw error
    }
  }

  // ─── Labels ─────────────────────────────────────────────────────────

  private brokerLabels(host: HostCRD, broker: DesiredBroker): Record<string, string> {
    return {
      app: broker.brokerName,
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [COMPONENT_LABEL]: OAI_EGRESS_COMPONENT_VALUE,
      [OAI_EGRESS_BROKER_LABEL]: broker.brokerName,
      [HOST_LABEL]: host.name,
    }
  }

  private brokerAnnotations(host: HostCRD, broker: DesiredBroker): Record<string, string> {
    return { [SLOT_ANNOTATION]: `${host.name}/${broker.slotId}` }
  }

  // ─── Builders ───────────────────────────────────────────────────────

  private buildSecret(host: HostCRD, broker: DesiredBroker, credentialB64: string): k8s.V1Secret {
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      type: 'Opaque',
      metadata: {
        name: `${broker.brokerName}-key`,
        namespace: config.llmEgressNamespace,
        labels: this.brokerLabels(host, broker),
        annotations: this.brokerAnnotations(host, broker),
      },
      // Always carry the canonical slot key (empty string when the Host has no
      // credential) so the Deployment's secretKeyRef always resolves and the env
      // var is always DEFINED — envsubst then substitutes "" and the nginx `map`
      // omits the Authorization header. A missing key would leave the ${...}
      // literal unsubstituted. The value is the base64 as stored on the source
      // Secret; the plaintext never transits this reconciler as a string.
      data: { [OPENAI_COMPATIBLE_API_KEY_SLOT]: credentialB64 },
    }
  }

  /**
   * NEW http-plain nginx config generator (do NOT reuse reconciler.ts's
   * buildNginxConfigMap — that one forces HTTPS and rejects private ranges, the
   * exact opposite of a LAN broker). The LAN IP is the validated RFC1918 literal
   * from the classifier; port + path are parsed URL components. The credential
   * never appears here: only the `${OPENAI_COMPATIBLE_API_KEY}` placeholder,
   * resolved at pod start by the image's envsubst entrypoint (value-blind).
   */
  private buildNginxConfigMap(host: HostCRD, broker: DesiredBroker): k8s.V1ConfigMap {
    const port = config.openaiEgressBrokerPort
    const upstream = `${broker.scheme}//${broker.ip}:${broker.lanPort}${broker.path}`
    const httpsUpstream = broker.scheme === 'https:'

    const nginxConf = `# Auto-generated by Clerum HCC — openai-compatible egress broker
# host=${host.name} slot=${broker.slotId}
# Stored as .conf.template; the nginx egress-proxy image runs envsubst at startup.

# Conditional upstream auth. An empty key ⇒ no Authorization header (nginx omits
# a header whose value is the empty string). The env var is always defined by the
# Deployment, so envsubst never leaves the \${...} literal in the rendered config.
map "\${${OPENAI_COMPATIBLE_API_KEY_ENV}}" $oai_auth_header {
    ""      "";
    default "Bearer \${${OPENAI_COMPATIBLE_API_KEY_ENV}}";
}

server {
    listen ${port};

    location = /health {
        access_log off;
        return 200 'ok';
        add_header Content-Type text/plain;
    }

    location ${broker.path} {
        # No access log: request/response bodies carry prompt payloads in clear.
        access_log off;
        proxy_pass ${upstream};
        proxy_set_header Authorization $oai_auth_header;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        # SSE/streaming: no buffering, long read/send timeouts.
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_connect_timeout 10s;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;${
          httpsUpstream
            ? `
        # Upstream over TLS: the LAN endpoint's certificate is operator-managed
        # and typically self-signed, so verification is off (the /32 egress
        # policy is what pins the destination, not PKI).
        proxy_ssl_verify off;
        proxy_ssl_server_name on;`
            : ''
        }
    }
}`

    return {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: `${broker.brokerName}-nginx-conf`,
        namespace: config.llmEgressNamespace,
        labels: this.brokerLabels(host, broker),
        annotations: this.brokerAnnotations(host, broker),
      },
      data: { 'default.conf.template': nginxConf },
    }
  }

  private buildDeployment(
    host: HostCRD,
    broker: DesiredBroker,
    credentialsRevision: string
  ): k8s.V1Deployment {
    const port = config.openaiEgressBrokerPort
    const labels = this.brokerLabels(host, broker)
    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: broker.brokerName,
        namespace: config.llmEgressNamespace,
        labels,
        annotations: this.brokerAnnotations(host, broker),
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: broker.brokerName } },
        template: {
          metadata: {
            labels,
            // Rotating the credential changes this digest → pod template →
            // rolling restart onto the new key.
            annotations: { [CREDENTIALS_REVISION_ANNOTATION]: credentialsRevision },
          },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 101,
              runAsGroup: 101,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            containers: [
              {
                name: 'egress-proxy',
                image: config.egressProxyImage,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ name: 'http', containerPort: port, protocol: 'TCP' }],
                // The credential env is always defined (secretKeyRef, not
                // optional) so envsubst always substitutes; see buildSecret.
                env: [
                  {
                    name: OPENAI_COMPATIBLE_API_KEY_ENV,
                    valueFrom: {
                      secretKeyRef: {
                        name: `${broker.brokerName}-key`,
                        key: OPENAI_COMPATIBLE_API_KEY_SLOT,
                      },
                    },
                  },
                ],
                volumeMounts: [
                  { name: 'nginx-conf', mountPath: '/etc/nginx/templates', readOnly: true },
                ],
                livenessProbe: {
                  httpGet: { path: '/health', port: port as unknown as IntOrString },
                  initialDelaySeconds: 5,
                  periodSeconds: 15,
                },
                readinessProbe: {
                  httpGet: { path: '/health', port: port as unknown as IntOrString },
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
            ],
            volumes: [
              { name: 'nginx-conf', configMap: { name: `${broker.brokerName}-nginx-conf` } },
            ],
          },
        },
      },
    }
  }

  private buildService(host: HostCRD, broker: DesiredBroker): k8s.V1Service {
    const port = config.openaiEgressBrokerPort
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: broker.brokerName,
        namespace: config.llmEgressNamespace,
        labels: this.brokerLabels(host, broker),
        annotations: this.brokerAnnotations(host, broker),
      },
      spec: {
        type: 'ClusterIP',
        ports: [{ port, targetPort: 'http' as IntOrString, protocol: 'TCP', name: 'http' }],
        selector: { app: broker.brokerName },
      },
    }
  }

  /** Ingress NP in llm-egress: only THIS host's mcp-host pods may reach the broker. */
  private buildBrokerIngressPolicy(host: HostCRD, broker: DesiredBroker): k8s.V1NetworkPolicy {
    const port = config.openaiEgressBrokerPort
    return {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: `${broker.brokerName}-ingress`,
        namespace: config.llmEgressNamespace,
        labels: { ...this.brokerLabels(host, broker), [POLICY_TYPE_LABEL]: 'oai-egress-ingress' },
      },
      spec: {
        podSelector: { matchLabels: { app: broker.brokerName } },
        policyTypes: ['Ingress'],
        ingress: [
          {
            _from: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.hostNamespace },
                },
                podSelector: { matchLabels: { [HOST_LABEL]: host.name } },
              },
            ],
            ports: [{ port, protocol: 'TCP' }],
          },
        ],
      },
    }
  }

  /**
   * Egress NP in llm-egress: broker → the single LAN /32 on the dial port only.
   * No DNS egress — the destination is an IP literal. This is the only route to
   * the private LAN in the whole cluster.
   */
  private buildBrokerLanEgressPolicy(host: HostCRD, broker: DesiredBroker): k8s.V1NetworkPolicy {
    return {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: `${broker.brokerName}-egress`,
        namespace: config.llmEgressNamespace,
        labels: { ...this.brokerLabels(host, broker), [POLICY_TYPE_LABEL]: 'oai-egress-lan' },
      },
      spec: {
        podSelector: { matchLabels: { app: broker.brokerName } },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [{ ipBlock: { cidr: `${broker.ip}/32` } }],
            ports: [{ port: broker.lanPort, protocol: 'TCP' }],
          },
        ],
      },
    }
  }

  /** Egress NP in the host namespace: this host's pods → this broker on BROKER_PORT. */
  private buildHostToBrokerPolicy(host: HostCRD, broker: DesiredBroker): k8s.V1NetworkPolicy {
    const port = config.openaiEgressBrokerPort
    return {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: `${broker.brokerName}-src`,
        namespace: config.hostNamespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [COMPONENT_LABEL]: OAI_EGRESS_COMPONENT_VALUE,
          [OAI_EGRESS_BROKER_LABEL]: broker.brokerName,
          [HOST_LABEL]: host.name,
          [POLICY_TYPE_LABEL]: 'oai-egress-source',
        },
        annotations: this.brokerAnnotations(host, broker),
      },
      spec: {
        podSelector: {
          matchLabels: { [HOST_LABEL]: host.name, [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
        },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.llmEgressNamespace },
                },
                podSelector: { matchLabels: { app: broker.brokerName } },
              },
            ],
            ports: [{ port, protocol: 'TCP' }],
          },
        ],
      },
    }
  }

  // ─── Apply helpers (create-then-409 replaceWithConflictRetry) ─────────

  private async ensureSecret(
    host: HostCRD,
    broker: DesiredBroker,
    credentialB64: string
  ): Promise<void> {
    const secret = this.buildSecret(host, broker, credentialB64)
    const name = secret.metadata!.name!
    const namespace = config.llmEgressNamespace
    try {
      await observeCreate('Secret', () =>
        this.coreApi.createNamespacedSecret({ namespace, body: secret })
      )
      log.info('Created mirror Secret', { broker: broker.brokerName, secret: name })
      return
    } catch (error) {
      if (getErrorCode(error) !== 409) throw error
    }
    await replaceWithConflictRetry({
      description: `Secret "${name}"`,
      logPrefix: '[oai-egress]',
      body: secret,
      mergeExisting: preserveObjectAnnotations,
      isUpToDate: (next, existing) =>
        (next as k8s.V1Secret).data?.[OPENAI_COMPATIBLE_API_KEY_SLOT] ===
        (existing as k8s.V1Secret).data?.[OPENAI_COMPATIBLE_API_KEY_SLOT],
      read: () =>
        observeExistenceRead('Secret', () =>
          this.coreApi.readNamespacedSecret({ name, namespace })
        ),
      replace: body => this.coreApi.replaceNamespacedSecret({ name, namespace, body }),
    })
  }

  private async ensureConfigMap(host: HostCRD, broker: DesiredBroker): Promise<void> {
    const cm = this.buildNginxConfigMap(host, broker)
    const name = cm.metadata!.name!
    const namespace = config.llmEgressNamespace
    try {
      await observeCreate('ConfigMap', () =>
        this.coreApi.createNamespacedConfigMap({ namespace, body: cm })
      )
      log.info('Created broker ConfigMap', { broker: broker.brokerName, configMap: name })
      return
    } catch (error) {
      if (getErrorCode(error) !== 409) throw error
    }
    await replaceWithConflictRetry({
      description: `ConfigMap "${name}"`,
      logPrefix: '[oai-egress]',
      body: cm,
      mergeExisting: preserveObjectAnnotations,
      isUpToDate: configMapMatchesDesired,
      read: () =>
        observeExistenceRead('ConfigMap', () =>
          this.coreApi.readNamespacedConfigMap({ name, namespace })
        ),
      replace: body => this.coreApi.replaceNamespacedConfigMap({ name, namespace, body }),
    })
  }

  private async ensureDeployment(
    host: HostCRD,
    broker: DesiredBroker,
    credentialsRevision: string
  ): Promise<void> {
    const deployment = this.buildDeployment(host, broker, credentialsRevision)
    const name = deployment.metadata!.name!
    const namespace = config.llmEgressNamespace
    try {
      await observeCreate('Deployment', () =>
        this.appsApi.createNamespacedDeployment({ namespace, body: deployment })
      )
      log.info('Created broker Deployment', { broker: broker.brokerName })
      return
    } catch (error) {
      if (getErrorCode(error) !== 409) throw error
    }
    await replaceWithConflictRetry({
      description: `Deployment "${name}"`,
      logPrefix: '[oai-egress]',
      body: deployment,
      mergeExisting: preserveDeploymentAnnotations,
      isUpToDate: deploymentMatchesDesired,
      read: () =>
        observeExistenceRead('Deployment', () =>
          this.appsApi.readNamespacedDeployment({ name, namespace })
        ),
      replace: body => this.appsApi.replaceNamespacedDeployment({ name, namespace, body }),
    })
  }

  private async ensureService(host: HostCRD, broker: DesiredBroker): Promise<void> {
    const service = this.buildService(host, broker)
    const name = service.metadata!.name!
    const namespace = config.llmEgressNamespace
    try {
      await observeCreate('Service', () =>
        this.coreApi.createNamespacedService({ namespace, body: service })
      )
      log.info('Created broker Service', { broker: broker.brokerName })
      return
    } catch (error) {
      if (getErrorCode(error) !== 409) throw error
    }
    await replaceWithConflictRetry({
      description: `Service "${name}"`,
      logPrefix: '[oai-egress]',
      body: service,
      mergeExisting: preserveServiceAssignedFields,
      isUpToDate: serviceMatchesDesired,
      read: () =>
        observeExistenceRead('Service', () =>
          this.coreApi.readNamespacedService({ name, namespace })
        ),
      replace: body => this.coreApi.replaceNamespacedService({ name, namespace, body }),
    })
  }

  private ensureBrokerIngressPolicy(host: HostCRD, broker: DesiredBroker): Promise<void> {
    return this.applyNetworkPolicy(this.buildBrokerIngressPolicy(host, broker))
  }

  private ensureBrokerLanEgressPolicy(host: HostCRD, broker: DesiredBroker): Promise<void> {
    return this.applyNetworkPolicy(this.buildBrokerLanEgressPolicy(host, broker))
  }

  private ensureHostToBrokerPolicy(host: HostCRD, broker: DesiredBroker): Promise<void> {
    return this.applyNetworkPolicy(this.buildHostToBrokerPolicy(host, broker))
  }

  private async applyNetworkPolicy(policy: k8s.V1NetworkPolicy): Promise<void> {
    const name = policy.metadata!.name!
    const namespace = policy.metadata!.namespace!
    try {
      await observeCreate('NetworkPolicy', () =>
        this.networkingApi.createNamespacedNetworkPolicy({ namespace, body: policy })
      )
      log.info('Created NetworkPolicy', { networkPolicy: name, namespace })
      return
    } catch (error) {
      if (getErrorCode(error) !== 409) throw error
    }
    await replaceWithConflictRetry({
      description: `NetworkPolicy "${name}"`,
      logPrefix: '[oai-egress]',
      body: policy,
      mergeExisting: preserveObjectAnnotations,
      isUpToDate: networkPolicyMatchesDesired,
      read: () =>
        observeExistenceRead('NetworkPolicy', () =>
          this.networkingApi.readNamespacedNetworkPolicy({ name, namespace })
        ),
      replace: body => this.networkingApi.replaceNamespacedNetworkPolicy({ name, namespace, body }),
    })
  }

  // ─── Label-owned GC + orphan sweep ──────────────────────────────────

  private isHccOwned(resource: { metadata?: { labels?: Record<string, string> } }): boolean {
    return resource.metadata?.labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE
  }

  /**
   * Delete every broker of `hostName` whose broker name is NOT in `keep`. Lists
   * the host's Deployments in llm-egress (label-scoped), the host's mirror
   * Secrets in llm-egress, and the host's source NetworkPolicies in the host
   * namespace, so a broker survives a missed delete event or a partial create.
   * Anchoring on the Secret too matters for teardown: if the Deployment create
   * failed AFTER the Secret + ConfigMap were created, a Deployment-only listing
   * would miss the broker and leave its credential-bearing Secret orphaned until
   * the next full-reconcile sweep. Symmetric to sweepOrphans.
   */
  private async gcHostBrokers(hostName: string, keep: Set<string>): Promise<void> {
    const hostSelector = `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${COMPONENT_LABEL}=${OAI_EGRESS_COMPONENT_VALUE},${HOST_LABEL}=${hostName}`
    const inEgress = await this.listBrokerDeploymentNames(hostSelector)
    const inSecrets = await this.listBrokerSecretNames(hostSelector)
    const inHost = await this.listHostSourcePolicyBrokerNames(hostName)
    const all = new Set<string>([...inEgress, ...inSecrets, ...inHost])
    for (const brokerName of all) {
      if (keep.has(brokerName)) continue
      await this.gcBroker(brokerName)
    }
  }

  private async listBrokerDeploymentNames(labelSelector: string): Promise<string[]> {
    try {
      const resp = await this.appsApi.listNamespacedDeployment({
        namespace: config.llmEgressNamespace,
        labelSelector,
      })
      return (resp.items ?? [])
        .map(d => d.metadata?.labels?.[OAI_EGRESS_BROKER_LABEL])
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
    } catch (error) {
      log.error('Failed to list broker Deployments', { err: error })
      return []
    }
  }

  private async listHostSourcePolicyBrokerNames(hostName: string): Promise<string[]> {
    try {
      const resp = await this.networkingApi.listNamespacedNetworkPolicy({
        namespace: config.hostNamespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${COMPONENT_LABEL}=${OAI_EGRESS_COMPONENT_VALUE},${HOST_LABEL}=${hostName}`,
      })
      return (resp.items ?? [])
        .map(np => np.metadata?.labels?.[OAI_EGRESS_BROKER_LABEL])
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
    } catch (error) {
      log.error('Failed to list host source NetworkPolicies', { err: error })
      return []
    }
  }

  /** Delete all objects of one broker (both namespaces), ownership-verified. */
  private async gcBroker(brokerName: string): Promise<void> {
    const egressNs = config.llmEgressNamespace
    const hostNs = config.hostNamespace
    await this.deleteIfOwned(
      'Deployment',
      brokerName,
      () => this.appsApi.readNamespacedDeployment({ name: brokerName, namespace: egressNs }),
      () => this.appsApi.deleteNamespacedDeployment({ name: brokerName, namespace: egressNs })
    )
    await this.deleteIfOwned(
      'Service',
      brokerName,
      () => this.coreApi.readNamespacedService({ name: brokerName, namespace: egressNs }),
      () => this.coreApi.deleteNamespacedService({ name: brokerName, namespace: egressNs })
    )
    await this.deleteIfOwned(
      'ConfigMap',
      `${brokerName}-nginx-conf`,
      () =>
        this.coreApi.readNamespacedConfigMap({
          name: `${brokerName}-nginx-conf`,
          namespace: egressNs,
        }),
      () =>
        this.coreApi.deleteNamespacedConfigMap({
          name: `${brokerName}-nginx-conf`,
          namespace: egressNs,
        })
    )
    await this.deleteIfOwned(
      'Secret',
      `${brokerName}-key`,
      () => this.coreApi.readNamespacedSecret({ name: `${brokerName}-key`, namespace: egressNs }),
      () => this.coreApi.deleteNamespacedSecret({ name: `${brokerName}-key`, namespace: egressNs })
    )
    await this.deleteIfOwned(
      'NetworkPolicy',
      `${brokerName}-ingress`,
      () =>
        this.networkingApi.readNamespacedNetworkPolicy({
          name: `${brokerName}-ingress`,
          namespace: egressNs,
        }),
      () =>
        this.networkingApi.deleteNamespacedNetworkPolicy({
          name: `${brokerName}-ingress`,
          namespace: egressNs,
        })
    )
    await this.deleteIfOwned(
      'NetworkPolicy',
      `${brokerName}-egress`,
      () =>
        this.networkingApi.readNamespacedNetworkPolicy({
          name: `${brokerName}-egress`,
          namespace: egressNs,
        }),
      () =>
        this.networkingApi.deleteNamespacedNetworkPolicy({
          name: `${brokerName}-egress`,
          namespace: egressNs,
        })
    )
    await this.deleteIfOwned(
      'NetworkPolicy',
      `${brokerName}-src`,
      () =>
        this.networkingApi.readNamespacedNetworkPolicy({
          name: `${brokerName}-src`,
          namespace: hostNs,
        }),
      () =>
        this.networkingApi.deleteNamespacedNetworkPolicy({
          name: `${brokerName}-src`,
          namespace: hostNs,
        })
    )
  }

  private async deleteIfOwned(
    kind: string,
    name: string,
    read: () => Promise<{ metadata?: { labels?: Record<string, string> } }>,
    del: () => Promise<unknown>
  ): Promise<void> {
    try {
      const existing = await read()
      if (this.isHccOwned(existing)) {
        await del()
        log.info('Deleted orphaned broker object', { kind, name })
      } else {
        log.warn('Skipping delete — not HCC-owned', { kind, name })
      }
    } catch (error) {
      if (getErrorCode(error) !== 404) throw error
    }
  }

  /**
   * Startup / periodic orphan sweep: delete any egress broker whose broker name
   * is not desired by any live Host. Covers brokers orphaned by a missed Host
   * delete event or a crash mid-teardown. Also sweeps the host-namespace source
   * policies whose broker is gone.
   */
  private async sweepOrphans(): Promise<void> {
    const desired = new Set<string>()
    for (const host of this.hosts.values()) {
      for (const broker of this.buildDesiredBrokers(host).desired) desired.add(broker.brokerName)
    }
    const egressOrphans = await this.listBrokerDeploymentNames(
      `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${COMPONENT_LABEL}=${OAI_EGRESS_COMPONENT_VALUE}`
    )
    // Also anchor on the mirror Secret: a broker whose Deployment create failed
    // AFTER its Secret + ConfigMap were created would be invisible to the
    // Deployment-only listing and its credential-bearing Secret would orphan
    // permanently. Discovering by Secret closes that leak (gcBroker then removes
    // the Secret + ConfigMap even though the Deployment 404s).
    const secretOrphans = await this.listBrokerSecretNames(
      `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${COMPONENT_LABEL}=${OAI_EGRESS_COMPONENT_VALUE}`
    )
    const hostOrphans = await this.listAllSourcePolicyBrokerNames()
    const all = new Set<string>([...egressOrphans, ...secretOrphans, ...hostOrphans])
    for (const brokerName of all) {
      if (desired.has(brokerName)) continue
      log.info('Orphan sweep: deleting broker not desired by any Host', { broker: brokerName })
      // Serialized under a `gc:` key rather than the `host:` key a live reconcile
      // uses (the sweep does not know the owning host name). This cannot race a
      // concurrent reconcile of a still-desired broker: the Host cache is updated
      // synchronously before reconcileForHost is dispatched, so any broker an
      // in-flight reconcile is creating is already in `desired` here and skipped.
      await this.runSerialized(`gc:${brokerName}`, () => this.gcBroker(brokerName))
    }
  }

  private async listBrokerSecretNames(labelSelector: string): Promise<string[]> {
    try {
      const resp = await this.coreApi.listNamespacedSecret({
        namespace: config.llmEgressNamespace,
        labelSelector,
      })
      return (resp.items ?? [])
        .map(s => s.metadata?.labels?.[OAI_EGRESS_BROKER_LABEL])
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
    } catch (error) {
      log.error('Failed to list broker Secrets for sweep', { err: error })
      return []
    }
  }

  private async listAllSourcePolicyBrokerNames(): Promise<string[]> {
    try {
      const resp = await this.networkingApi.listNamespacedNetworkPolicy({
        namespace: config.hostNamespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${COMPONENT_LABEL}=${OAI_EGRESS_COMPONENT_VALUE}`,
      })
      return (resp.items ?? [])
        .map(np => np.metadata?.labels?.[OAI_EGRESS_BROKER_LABEL])
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
    } catch (error) {
      log.error('Failed to list source NetworkPolicies for sweep', { err: error })
      return []
    }
  }
}
