/**
 * NetworkPolicy Reconciler — generates Kubernetes NetworkPolicies
 * based on Context CRDs and McpServer egress bindings.
 *
 * Policy layers:
 *   L0: deny-all ingress + egress to all managed pods (per runtime namespace)
 *   L1: infrastructure egress (DNS, HCC API, K8s API) per runtime namespace
 *   L1: allow-api ingress to host-context-controller from mcp-host namespace
 *   L2: context-allow ingress per (context, server) pair
 *   L3: external-egress per McpServer with egressBindings (CIDR or DNS)
 *
 * When a Context CRD is created/updated the reconciler creates or updates
 * one NetworkPolicy per (context, server) pair.
 * When a Context CRD is deleted, all its NetworkPolicies are removed.
 */
import * as k8s from '@kubernetes/client-node'
import * as dns from 'node:dns/promises'
import { isIP } from 'node:net'
import { STATE_ANNOTATION, classifyDnsError } from '@clerum/network-policy-core'
import { config } from './config'
import {
  EXTERNAL_EGRESS_POLICY_TYPE,
  INFRA_POLICY_TYPE,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  MCPSERVER_LABEL,
  POLICY_TYPE_LABEL,
} from './constants'
import { accumulateHostExactHostEgress } from './externalEgressAccumulator'
import {
  ContextCRD,
  EgressBinding,
  McpServerCRD,
  McpServerCondition,
  McpServerCrdStatus,
  McpServerResolvedEgressIP,
} from './types'
import { applyNetworkPolicy, getErrorCode } from './utils'

type JsonPatchOperation = {
  op: 'add' | 'replace' | 'remove'
  path: string
  value?: unknown
}

const GROUP = 'clerum.io'
const VERSION = 'v1alpha1'
const PLURAL_MCPSERVERS = 'mcpservers'
const CONTEXT_LABEL = 'clerum.io/context'
const EGRESS_CLASS_LABEL = 'clerum.io/egress-class'
const RPC_PROXY_EGRESS_POLICY_TYPE = 'rpc-proxy-egress'
const RPC_PROXY_APP_LABEL = 'rpc-proxy'
export const PUBLIC_EGRESS_EXCEPT_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.31.196.0/24',
  '192.52.193.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '192.175.48.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
]

function ipv4ToNumber(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined
    value = (value << 8) + octet
  }
  return value >>> 0
}

function cidrRange(cidr: string): { start: number; end: number } | undefined {
  const [ip, prefixText] = cidr.split('/')
  if (!ip || prefixText === undefined) return undefined
  const prefix = Number(prefixText)
  const ipNumber = ipv4ToNumber(ip)
  if (ipNumber === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return undefined
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const start = (ipNumber & mask) >>> 0
  const size = 2 ** (32 - prefix)
  return { start, end: (start + size - 1) >>> 0 }
}

function cidrOverlaps(left: string, right: string): boolean {
  const a = cidrRange(left)
  const b = cidrRange(right)
  if (!a || !b) return false
  return a.start <= b.end && b.start <= a.end
}

export function isAllowedExternalEgressCidr(cidr: string): boolean {
  if (!cidrRange(cidr)) return false
  return !PUBLIC_EGRESS_EXCEPT_CIDRS.some(blocked => cidrOverlaps(cidr, blocked))
}

/**
 * Recursively canonicalize a value: sort every object's keys while preserving
 * array order. Used to compare policy egress without JSON.stringify key-order
 * fragility.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k])
    return out
  }
  return value
}

/**
 * A representation-independent signature of a policy's egress: a canonical
 * (deep key-sorted) JSON of `spec.egress`. Decides whether a write is needed
 * WITHOUT the key-ordering fragility of a raw JSON.stringify (audit R2-1). Unlike
 * the earlier tuple-only signature (ipBlock cidr/port), this captures the FULL
 * rule including selector-based `to` entries (audit H1). It also projects
 * `podSelector` and `policyTypes` (audit H-C), not just `spec.egress`, so a
 * policy whose selector or policy types drifted out-of-band (same destination
 * rules) counts as changed and the reconcile re-owns it instead of leaving
 * egress applied to the wrong pods. `policyTypes` is order-insensitive (sorted).
 * HCC external-egress policies are ipBlock-only today, so H1 does not bite here,
 * but this keeps the gate correct and mirrors WRC's `egressSignature`.
 */
export function egressSignature(policy: k8s.V1NetworkPolicy): string {
  const spec = policy.spec
  return JSON.stringify(
    canonicalize({
      podSelector: spec?.podSelector ?? {},
      policyTypes: [...(spec?.policyTypes ?? [])].sort(),
      egress: spec?.egress ?? [],
    })
  )
}

export function isPublicDnsHostname(host: string): boolean {
  if (host !== host.trim()) return false
  if (host !== host.toLowerCase()) return false
  if (host.includes('*') || host.includes('/') || host.includes(':')) return false
  if (isIP(host) !== 0) return false
  if (!host.includes('.')) return false
  if (
    host === 'localhost' ||
    host === 'metadata.goog' ||
    host === 'kubernetes.default' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.svc') ||
    host.endsWith('.cluster.local')
  ) {
    return false
  }
  return host.split('.').every(label => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}

function hccApiEgressPodSelector(namespace: string): k8s.V1LabelSelector {
  if (namespace === config.hostNamespace) {
    return { matchLabels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE } }
  }
  if (namespace === config.namespace) {
    return { matchLabels: { app: 'mcp-proxy' } }
  }
  if (namespace === config.rpcProxyNamespace) {
    return { matchLabels: { app: RPC_PROXY_APP_LABEL } }
  }
  if (namespace === 'sandbox-recipes') {
    return { matchLabels: { 'clerum.io/component': 'workflow-mcp-host' } }
  }
  return { matchLabels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE } }
}

function k8sApiEgressPodSelector(namespace: string): k8s.V1LabelSelector {
  if (namespace === config.hostNamespace) {
    return { matchLabels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE } }
  }

  // Runtime workload namespaces are deny-by-default for apiserver access. A
  // future controller that genuinely needs Kubernetes API access must opt in
  // with this platform-owned label instead of inheriting namespace-wide egress.
  return { matchLabels: { 'clerum.io/k8s-api-egress': 'true' } }
}

export class NetworkPolicyReconciler {
  private networkingApi: k8s.NetworkingV1Api
  private customApi: k8s.CustomObjectsApi

  /** Reference to the MCP server cache so we can look up ports. */
  private serverCache: Map<string, McpServerCRD>

  // H2 (issue #299): smallest DNS TTL (ms) observed across external-egress
  // resolutions. The resync loop advances to <= this/2 so a rotating low-TTL host
  // is sampled every rotation. Ratchets down and never recovers until restart —
  // over-resyncing is cheap (writes are no-ops via the F2 gate) and the safe
  // direction; under-resyncing would reopen #299.
  private externalEgressMinObservedTtlMs = Infinity

  constructor(kc: k8s.KubeConfig, serverCache: Map<string, McpServerCRD>) {
    this.networkingApi = kc.makeApiClient(k8s.NetworkingV1Api)
    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi)
    this.serverCache = serverCache
  }

  /**
   * The smallest DNS TTL (ms) observed so far across external-egress
   * resolutions, or Infinity if none. The resync loop reads this to advance to
   * <= TTL/2 (H2, issue #299).
   */
  get externalEgressRefreshMinTtlMs(): number {
    return this.externalEgressMinObservedTtlMs
  }

  /**
   * Whether an external-egress policy actually needs a write (audit F2/L1):
   * write when it is new, when the ENFORCED spec.egress differs from the live
   * policy (covers ip-set changes AND out-of-band drift self-heal), or once to
   * migrate a legacy policy to the new-format state annotation. A pure
   * timestamp-only refresh (spec identical, annotation already present) is a
   * no-op — no apiserver/CNI churn. The DNS branch additionally forces a write
   * on renewalDue (audit M1), handled at the call site.
   */
  private externalEgressWriteNeeded(
    existing: k8s.V1NetworkPolicy | null,
    desired: k8s.V1NetworkPolicy
  ): boolean {
    if (!existing) return true
    if (egressSignature(existing) !== egressSignature(desired)) {
      return true
    }
    const desiredState = desired.metadata?.annotations?.[STATE_ANNOTATION]
    return Boolean(desiredState) && !existing.metadata?.annotations?.[STATE_ANNOTATION]
  }

  private externalEgressPolicyName(serverName: string, binding: EgressBinding): string | null {
    if (binding.egressClass === 'public-web') {
      return `ext-egress-${serverName}-public-web`.slice(0, 253)
    }
    const suffix =
      typeof binding.dns === 'string' && binding.dns.trim()
        ? binding.dns
        : typeof binding.cidr === 'string' && binding.cidr.trim()
          ? binding.cidr.replace(/[/.]/g, '-')
          : null
    if (!suffix) return null
    return `ext-egress-${serverName}-${suffix}-${binding.port}`.slice(0, 253)
  }

  // ─── Default Policies (L0 + L1) ─────────────────────────────────────

  /**
   * Ensure the baseline policies exist across all runtime namespaces:
   *   L0: deny-all ingress + egress per runtime namespace
   *   L1: infrastructure egress (DNS, HCC API, K8s API) per runtime namespace
   *   L1: allow ingress to host-context-controller API
   */
  async ensureDefaultPolicies(): Promise<void> {
    await this.ensureDefaultDeny()
    await this.ensureInfrastructurePolicies()
    await this.ensureAllowContextMapperApi()
    await this.deleteLegacyStaticPolicy(config.rpcProxyNamespace, 'allow-desktop-egress-rpc-proxy')
    await this.deleteLegacyStaticPolicy(config.namespace, 'allow-rpc-proxy-to-managed-mcp-servers')
    console.log('[NetPol] Default policies ensured')
  }

  /**
   * L0: Default-deny ingress + egress in every runtime namespace.
   * Empty ingress/egress arrays = deny all traffic in both directions.
   */
  private async ensureDefaultDeny(): Promise<void> {
    for (const ns of config.runtimeNamespaces) {
      const name = `deny-all-${ns}`
      const policy: k8s.V1NetworkPolicy = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: {
          name,
          namespace: ns,
          labels: {
            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
            [POLICY_TYPE_LABEL]: 'default-deny',
          },
        },
        spec: {
          podSelector: {},
          policyTypes: ['Ingress', 'Egress'],
        },
      }

      await applyNetworkPolicy(this.networkingApi, name, ns, policy, '[NetPol]')
    }
  }

  /**
   * L1: Infrastructure egress policies per runtime namespace.
   * Allows DNS for all runtime pods, but scopes HCC/K8s API access to the
   * platform pod classes that actually need those internal routes.
   *
   * Namespaces listed in `config.minimalInfraNamespaces` only get the DNS
   * egress (no HCC API, no K8s API) — appropriate for namespaces whose pods
   * are not K8s clients and don't consume the HCC discovery API.
   */
  private async ensureInfrastructurePolicies(): Promise<void> {
    const minimalSet = new Set(config.minimalInfraNamespaces)
    for (const ns of config.runtimeNamespaces) {
      await this.ensureDnsEgress(ns)
      if (!minimalSet.has(ns)) {
        await this.ensureHccApiEgress(ns)
        await this.ensureK8sApiEgress(ns)
      }
    }
  }

  /** Allow DNS egress (UDP+TCP port 53) to kube-system CoreDNS / kube-dns. */
  private async ensureDnsEgress(namespace: string): Promise<void> {
    const name = `allow-dns-egress-${namespace}`
    const egress: k8s.V1NetworkPolicyEgressRule[] = [
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
            },
          },
        ],
        ports: [
          { port: 53, protocol: 'UDP' },
          { port: 53, protocol: 'TCP' },
        ],
      },
    ]

    // GKE NodeLocal DNSCache with NetworkPolicy requires an ipBlock allow to
    // the target cluster's kube-dns Service IP. A namespaceSelector alone does
    // not close that DNS gate under legacy Calico enforcement. Empty (default)
    // leaves the egress exactly as the kube-system selector above.
    if (config.nodeLocalDnsCidr) {
      egress.push({
        to: [{ ipBlock: { cidr: config.nodeLocalDnsCidr } }],
        ports: [
          { port: 53, protocol: 'UDP' },
          { port: 53, protocol: 'TCP' },
        ],
      })
    }

    const policy: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name,
        namespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [POLICY_TYPE_LABEL]: INFRA_POLICY_TYPE,
        },
      },
      spec: {
        podSelector: {},
        policyTypes: ['Egress'],
        egress,
      },
    }
    await applyNetworkPolicy(this.networkingApi, name, namespace, policy, '[NetPol]')
  }

  /** Allow egress to host-context-controller API gateway in control-plane namespace. */
  private async ensureHccApiEgress(namespace: string): Promise<void> {
    const name = `allow-hcc-api-egress-${namespace}`
    const policy: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name,
        namespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [POLICY_TYPE_LABEL]: INFRA_POLICY_TYPE,
        },
      },
      spec: {
        podSelector: hccApiEgressPodSelector(namespace),
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.controlPlaneNamespace },
                },
                podSelector: {
                  matchLabels: { app: 'host-context-controller-api-gateway' },
                },
              },
            ],
            ports: [{ port: config.port, protocol: 'TCP' }],
          },
        ],
      },
    }
    await applyNetworkPolicy(this.networkingApi, name, namespace, policy, '[NetPol]')
  }

  /**
   * Allow egress to the Kubernetes API server (HTTPS 443).
   *
   * On GKE's legacy Calico datapath, NetworkPolicy egress is enforced against
   * the post-DNAT apiserver endpoint IP (an RFC1918 address), not the
   * `kubernetes` Service ClusterIP. `CONTEXT_MAPPER_K8S_API_CIDRS` carries
   * both — the ClusterIP and the endpoint — so the rule holds whichever IP
   * Calico evaluates. When unset, fall back to KUBERNETES_SERVICE_HOST (the
   * ClusterIP); this preserves behaviour on clusters not yet migrated.
   */
  private async ensureK8sApiEgress(namespace: string): Promise<void> {
    const name = `allow-k8s-api-egress-${namespace}`
    const cidrs =
      config.k8sApiCidrs.length > 0
        ? config.k8sApiCidrs
        : [
            process.env.KUBERNETES_SERVICE_HOST
              ? `${process.env.KUBERNETES_SERVICE_HOST}/32`
              : '10.96.0.1/32',
          ]
    const policy: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name,
        namespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [POLICY_TYPE_LABEL]: INFRA_POLICY_TYPE,
        },
      },
      spec: {
        podSelector: k8sApiEgressPodSelector(namespace),
        policyTypes: ['Egress'],
        egress: [
          {
            to: cidrs.map(cidr => ({ ipBlock: { cidr } })),
            ports: [{ port: 443, protocol: 'TCP' }],
          },
        ],
      },
    }
    await applyNetworkPolicy(this.networkingApi, name, namespace, policy, '[NetPol]')
  }

  /**
   * Always allow ingress to the host-context-controller API pod from the host namespace.
   */
  private async ensureAllowContextMapperApi(): Promise<void> {
    const name = 'allow-host-context-controller-api'
    const policy: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name,
        namespace: config.namespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [POLICY_TYPE_LABEL]: 'allow-api',
        },
      },
      spec: {
        podSelector: {
          matchLabels: {
            app: 'host-context-controller',
          },
        },
        policyTypes: ['Ingress'],
        ingress: [
          {
            _from: [
              {
                namespaceSelector: {
                  matchLabels: {
                    'kubernetes.io/metadata.name': config.hostNamespace,
                  },
                },
              },
            ],
            ports: [{ port: config.port, protocol: 'TCP' }],
          },
        ],
      },
    }

    await this.applyPolicy(name, policy)
  }

  // ─── Context-Based Policies ──────────────────────────────────────────

  /**
   * Reconcile NetworkPolicies for a Context CRD.
   * Creates one policy per allowed MCP server.
   */
  async reconcileContext(context: ContextCRD): Promise<void> {
    const contextId = context.spec.contextId
    const allowedServers = context.spec.mcpServers || []

    console.log(
      `[NetPol] Reconciling context "${contextId}" — allowed servers: [${allowedServers.join(', ')}]`
    )

    // Build desired policy names
    const desiredNames = new Set(
      allowedServers.map(serverName => this.policyName(contextId, serverName))
    )

    // Get existing policies for this context
    const existingPolicies = await this.listPoliciesForContext(contextId)

    // Create or update policies for each allowed server
    for (const serverName of allowedServers) {
      const server = this.serverCache.get(serverName)
      if (!server) {
        console.warn(
          `[NetPol] McpServer "${serverName}" not found in cache — skipping policy for context "${contextId}"`
        )
        continue
      }

      const name = this.policyName(contextId, serverName)
      const port = server.spec.transport.port || 3000

      // L2 ingress: allow scoped mcp-host/rpc-proxy access to this MCP server.
      const ingressPolicy: k8s.V1NetworkPolicy = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: {
          name,
          namespace: config.namespace,
          labels: {
            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
            [POLICY_TYPE_LABEL]: 'context-allow',
            [CONTEXT_LABEL]: contextId,
            [MCPSERVER_LABEL]: serverName,
          },
        },
        spec: {
          podSelector: {
            matchLabels: {
              [MCPSERVER_LABEL]: serverName,
            },
          },
          policyTypes: ['Ingress'],
          ingress: [
            {
              _from: [
                {
                  namespaceSelector: {
                    matchLabels: {
                      'kubernetes.io/metadata.name': config.hostNamespace,
                    },
                  },
                  podSelector: {
                    matchLabels: {
                      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
                      [CONTEXT_LABEL]: context.name,
                    },
                  },
                },
                {
                  namespaceSelector: {
                    matchLabels: {
                      'kubernetes.io/metadata.name': config.rpcProxyNamespace,
                    },
                  },
                  podSelector: {
                    matchLabels: {
                      app: RPC_PROXY_APP_LABEL,
                    },
                  },
                },
                {
                  // MCP Proxy ingress: allow proxy to reach MCP servers
                  namespaceSelector: {
                    matchLabels: {
                      'kubernetes.io/metadata.name': config.namespace,
                    },
                  },
                  podSelector: {
                    matchLabels: {
                      app: 'mcp-proxy',
                    },
                  },
                },
              ],
              ports: [{ port, protocol: 'TCP' }],
            },
          ],
        },
      }

      await this.applyPolicy(name, ingressPolicy)

      // L2 egress counterpart: allow traffic FROM mcp-host pods TO this MCP server
      // Without this, L0 egress deny-all blocks agents from reaching MCP servers.
      const egressName = `${name}-egress`
      const egressPolicy: k8s.V1NetworkPolicy = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: {
          name: egressName,
          namespace: config.hostNamespace,
          labels: {
            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
            [POLICY_TYPE_LABEL]: 'context-allow',
            [CONTEXT_LABEL]: contextId,
            [MCPSERVER_LABEL]: serverName,
          },
        },
        spec: {
          podSelector: {
            matchLabels: {
              [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
              [CONTEXT_LABEL]: context.name,
            },
          },
          policyTypes: ['Egress'],
          egress: [
            {
              to: [
                {
                  namespaceSelector: {
                    matchLabels: {
                      'kubernetes.io/metadata.name': config.namespace,
                    },
                  },
                  podSelector: {
                    matchLabels: {
                      [MCPSERVER_LABEL]: serverName,
                    },
                  },
                },
              ],
              ports: [{ port, protocol: 'TCP' }],
            },
          ],
        },
      }

      await applyNetworkPolicy(
        this.networkingApi,
        egressName,
        config.hostNamespace,
        egressPolicy,
        '[NetPol]'
      )

      // L2 rpc-proxy egress: allow rpc-proxy pods to reach this MCP server
      await this.ensureRpcProxyEgress(contextId, serverName, port)
    }

    // Delete policies for servers no longer in the context
    for (const existing of existingPolicies) {
      const existingName = existing.metadata?.name || ''
      if (!desiredNames.has(existingName)) {
        console.log(`[NetPol] Deleting orphaned policy "${existingName}"`)
        await this.deletePolicy(existingName)
      }
    }

    // Delete orphaned L2 egress counterparts in mcp-host namespace
    const existingEgressPolicies = await this.listEgressPoliciesForContext(contextId)
    const desiredEgressNames = new Set(
      allowedServers.map(serverName => `${this.policyName(contextId, serverName)}-egress`)
    )
    for (const existing of existingEgressPolicies) {
      const existingName = existing.metadata?.name || ''
      if (!desiredEgressNames.has(existingName)) {
        console.log(`[NetPol] Deleting orphaned L2 egress policy "${existingName}"`)
        await this.deleteEgressPolicy(existingName)
      }
    }

    // Delete orphaned rpc-proxy egress counterparts. Keeping these after a
    // server is removed from a Context would preserve an old in-cluster route.
    const existingRpcProxyPolicies = await this.listRpcProxyEgressPoliciesForContext(contextId)
    const desiredRpcProxyNames = new Set(
      allowedServers.map(serverName => `rpc-egress-${contextId}-${serverName}`)
    )
    for (const existing of existingRpcProxyPolicies) {
      const existingName = existing.metadata?.name || ''
      if (!desiredRpcProxyNames.has(existingName)) {
        console.log(`[NetPol] Deleting orphaned rpc-proxy egress policy "${existingName}"`)
        await this.deletePolicyInNamespace(config.rpcProxyNamespace, existingName)
      }
    }
  }

  /**
   * Delete all NetworkPolicies for a deleted Context.
   */
  async reconcileDeleteContext(contextId: string): Promise<void> {
    console.log(`[NetPol] Context "${contextId}" deleted — removing all policies`)

    const policies = await this.listPoliciesForContext(contextId)
    for (const policy of policies) {
      const name = policy.metadata?.name || ''
      await this.deletePolicy(name)
    }

    // Also delete L2 egress counterparts in mcp-host namespace
    const egressPolicies = await this.listEgressPoliciesForContext(contextId)
    for (const policy of egressPolicies) {
      const name = policy.metadata?.name || ''
      await this.deleteEgressPolicy(name)
    }

    // Also delete L2 rpc-proxy egress policies
    await this.deleteRpcProxyPoliciesForContext(contextId)
  }

  /**
   * Full reconciliation on startup — sync desired vs actual policies.
   */
  async fullReconcile(
    contexts: ContextCRD[],
    servers: McpServerCRD[] = [],
    options: { serverInventoryComplete?: boolean; ensureDefaults?: boolean } = {}
  ): Promise<void> {
    console.log(`[NetPol] Running full reconciliation for ${contexts.length} Context(s)`)

    if (options.ensureDefaults !== false) {
      await this.ensureDefaultPolicies()
    }

    // Reconcile each context
    for (const context of contexts) {
      await this.reconcileContext(context)
    }

    // Reconcile external egress for all existing servers on startup so a
    // controller restart converges pre-existing McpServer CRDs too.
    for (const server of servers) {
      await this.reconcileExternalEgress(server)
    }

    // Delete policies for contexts that no longer exist
    const desiredContextIds = new Set(contexts.map(c => c.spec.contextId))
    const allContextPolicies = await this.listAllContextPolicies()

    for (const policy of allContextPolicies) {
      const contextId = policy.metadata?.labels?.[CONTEXT_LABEL]
      if (contextId && !desiredContextIds.has(contextId)) {
        const name = policy.metadata?.name || ''
        console.log(
          `[NetPol] Deleting orphaned policy "${name}" (context "${contextId}" no longer exists)`
        )
        await this.deletePolicy(name)
      }
    }

    // Also clean up orphaned rpc-proxy egress policies
    const allRpcProxyPolicies = await this.listAllRpcProxyEgressPolicies()
    for (const policy of allRpcProxyPolicies) {
      const ctxId = policy.metadata?.labels?.[CONTEXT_LABEL]
      if (ctxId && !desiredContextIds.has(ctxId)) {
        const pName = policy.metadata?.name || ''
        console.log(`[NetPol] Deleting orphaned rpc-proxy egress policy "${pName}"`)
        await this.deletePolicyInNamespace(config.rpcProxyNamespace, pName)
      }
    }

    // Clean up external egress policies for servers that no longer exist.
    if (options.serverInventoryComplete !== false) {
      const desiredServerNames = new Set(servers.map(s => s.name))
      const allExternalPolicies = await this.listAllExternalEgressPolicies()
      for (const policy of allExternalPolicies) {
        const serverName = policy.metadata?.labels?.[MCPSERVER_LABEL]
        if (serverName && !desiredServerNames.has(serverName)) {
          const name = policy.metadata?.name || ''
          console.log(`[NetPol] Deleting orphaned external egress policy "${name}"`)
          await this.deletePolicyInNamespace(config.namespace, name)
        }
      }
    } else {
      console.warn(
        '[NetPol] Skipping external egress orphan cleanup because server inventory is incomplete'
      )
    }

    console.log('[NetPol] Full reconciliation complete')
  }

  // ─── L3 External Egress ────────────────────────────────────────────

  /**
   * Reconcile external egress policies for an McpServer with egressBindings.
   * For DNS bindings, resolves hostnames to IPs and creates ipBlock rules.
   * For CIDR bindings, creates ipBlock rules directly.
   */
  async reconcileExternalEgress(server: McpServerCRD): Promise<void> {
    let existingPolicies: k8s.V1NetworkPolicy[]
    try {
      existingPolicies = await this.listExternalEgressPoliciesForServer(
        server.name,
        server.namespace
      )
    } catch (error) {
      await this.writeExternalEgressStatus(
        server,
        [],
        'False',
        'InventoryListFailed',
        `Failed to list existing external egress policies: ${this.errorMessage(error)}`
      )
      throw error
    }

    const bindings = server.spec.egressBindings
    if (!bindings || bindings.length === 0) {
      try {
        await this.cleanupExternalEgress(server.name, server.namespace, existingPolicies)
      } catch (error) {
        await this.writeExternalEgressStatus(
          server,
          [],
          'False',
          'CleanupFailed',
          `Failed to delete stale external egress policies: ${this.errorMessage(error)}`
        )
        throw error
      }
      await this.writeExternalEgressStatus(
        server,
        [],
        'True',
        'NoEgressBindings',
        'No external egress bindings declared'
      )
      return
    }

    console.log(
      `[NetPol] Reconciling ${bindings.length} external egress binding(s) for "${server.name}"`
    )

    const desiredPolicyNames = new Set<string>()
    const resolvedEgressIPs: McpServerResolvedEgressIP[] = []
    const failures: string[] = []
    const resolvedAt = new Date().toISOString()

    for (const binding of bindings) {
      const egressClass = binding.egressClass ?? 'exact-host'
      if (egressClass !== 'exact-host' && egressClass !== 'public-web') {
        failures.push(`egressClass "${String(binding.egressClass)}" is not supported`)
        continue
      }

      let cidrs: string[]
      // Sliding-window state annotations to persist on the policy (issue #299).
      // Only the DNS branch sets this; CIDR/public-web bindings leave it undefined.
      let stateAnnotations: Record<string, string> | undefined
      // The DNS branch sets this when the accumulator's persisted window is aging
      // (audit M1): we must re-persist even if the ip-set is unchanged so a
      // stable-then-rotated IP keeps its overlap grace.
      let egressRenewalDue = false
      // H-E: a rename onto the same ip/port is spec-identical, so the rendered
      // egress gate would skip it and discard the re-attributed state annotation.
      // accumulated.changed is over (fqdn,ip,port,protocol), so it forces the
      // write that re-persists the identity and preserves the overlap grace.
      let egressStateChanged = false
      const name = this.externalEgressPolicyName(server.name, binding)
      if (!name) {
        failures.push('exact-host external egress bindings must declare dns or cidr')
        continue
      }
      // Look up the live policy once: used to rehydrate the window (DNS branch)
      // AND to decide whether a write is actually needed (audit F2/L1) — the
      // write is gated on the ENFORCED spec.egress, so identical static policies
      // never churn and out-of-band drift self-heals, for every egress class.
      const existingPolicy = existingPolicies.find(p => p.metadata?.name === name) ?? null

      if (egressClass === 'public-web') {
        if (
          binding.dns ||
          binding.cidr ||
          binding.port !== undefined ||
          binding.protocol !== undefined
        ) {
          failures.push(
            'public-web external egress bindings must not declare dns, cidr, port, or protocol'
          )
          continue
        }

        desiredPolicyNames.add(name)

        const policy: k8s.V1NetworkPolicy = {
          apiVersion: 'networking.k8s.io/v1',
          kind: 'NetworkPolicy',
          metadata: {
            name,
            namespace: server.namespace,
            labels: {
              [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
              [POLICY_TYPE_LABEL]: EXTERNAL_EGRESS_POLICY_TYPE,
              [MCPSERVER_LABEL]: server.name,
              [EGRESS_CLASS_LABEL]: egressClass,
            },
          },
          spec: {
            podSelector: {
              matchLabels: { [MCPSERVER_LABEL]: server.name },
            },
            policyTypes: ['Egress'],
            egress: [
              {
                to: [
                  {
                    ipBlock: {
                      cidr: '0.0.0.0/0',
                      except: PUBLIC_EGRESS_EXCEPT_CIDRS,
                    },
                  },
                ],
                ports: [
                  { port: 443, protocol: 'TCP' },
                  { port: 80, protocol: 'TCP' },
                ],
              },
            ],
          },
        }

        // public-web is a static policy — write only when new/changed/drifted so
        // the TTL-accelerated resync does not rewrite it every tick (audit F2).
        if (this.externalEgressWriteNeeded(existingPolicy, policy)) {
          await applyNetworkPolicy(this.networkingApi, name, server.namespace, policy, '[NetPol]')
        }
        continue
      }

      const protocol = binding.protocol ?? 'TCP'
      if (
        binding.port === undefined ||
        !Number.isInteger(binding.port) ||
        binding.port < 1 ||
        binding.port > 65535
      ) {
        failures.push(
          'exact-host external egress bindings must declare an integer port from 1-65535'
        )
        continue
      }

      if (binding.cidr) {
        if (!isAllowedExternalEgressCidr(binding.cidr)) {
          failures.push(
            `CIDR "${binding.cidr}" overlaps private, metadata, link-local, multicast, documentation, or reserved ranges`
          )
          continue
        }
        cidrs = [binding.cidr]
      } else if (binding.dns) {
        if (!isPublicDnsHostname(binding.dns)) {
          failures.push(
            `hostname "${binding.dns}" is private, internal, metadata, local, or otherwise disallowed`
          )
          continue
        }
        // Sliding-window accumulation (issue #299): a single-generation snapshot
        // pins one rotating IP of a provider that serves 1 A record/response, so
        // the pod's next resolution lands on an un-pinned IP and egress drops.
        // We fold each snapshot into the set persisted on THIS policy's
        // annotations and render the union of recently-live IPs. On a transient
        // resolver failure we fail-static: keep serving the accumulated set
        // rather than deleting the policy (the pre-#299 catch dropped egress on
        // any DNS hiccup).
        const previousAnnotations = existingPolicy?.metadata?.annotations
        const now = Date.parse(resolvedAt)
        const coreConfig = {
          overlapMs: config.externalEgressOverlapSec * 1000,
          maxEntries: config.externalEgressMaxEntries,
        }
        try {
          const records = await dns.resolve4(binding.dns, { ttl: true })
          const uniqueIps = [...new Set(records.map(r => r.address))].sort()
          if (uniqueIps.length === 0) {
            failures.push(`hostname "${binding.dns}" resolved to no IPv4 addresses`)
            continue
          }
          const invalidIps = uniqueIps.filter(ip => isIP(ip) !== 4)
          if (invalidIps.length > 0) {
            failures.push(
              `hostname "${binding.dns}" resolved invalid IPv4 answer(s): ${invalidIps.join(', ')}`
            )
            continue
          }
          const freshCidrs = uniqueIps.map(ip => `${ip}/32`)
          const disallowedCidrs = freshCidrs.filter(cidr => !isAllowedExternalEgressCidr(cidr))
          if (disallowedCidrs.length > 0) {
            failures.push(
              `hostname "${binding.dns}" resolved disallowed address(es): ${disallowedCidrs.join(', ')}`
            )
            continue
          }
          // Security gates above ran on the FRESH snapshot; only validated IPs
          // enter the accumulator, so the union can never contain a blocked IP.
          const ttlSeconds = records.length > 0 ? Math.min(...records.map(r => r.ttl)) : 0
          if (ttlSeconds > 0) {
            this.externalEgressMinObservedTtlMs = Math.min(
              this.externalEgressMinObservedTtlMs,
              ttlSeconds * 1000
            )
          }
          const accumulated = accumulateHostExactHostEgress({
            fqdn: binding.dns,
            port: binding.port,
            protocol,
            resolution: { kind: 'ok', ips: uniqueIps, ttlSeconds },
            previousAnnotations,
            now,
            config: coreConfig,
          })
          // Defense-in-depth (audit M3): rehydrated IPs (from the policy's own
          // annotations) bypass the fresh-snapshot CIDR gate, so a tampered/corrupt
          // state annotation could union a blocked/private IP. Re-validate the
          // effective set against the blocked ranges before rendering.
          cidrs = accumulated.cidrs.filter(c => isAllowedExternalEgressCidr(c))
          stateAnnotations = accumulated.annotations
          egressRenewalDue = accumulated.renewalDue
          egressStateChanged = accumulated.changed
          resolvedEgressIPs.push({
            dns: binding.dns,
            ips: cidrs.map(cidr => cidr.replace(/\/32$/, '')),
            resolvedAt,
          })
          if (accumulated.overCap) {
            console.warn(
              `[NetPol] "${binding.dns}" egress set hit the cap (${config.externalEgressMaxEntries}); evicted ${accumulated.evicted} least-recently-observed IP(s)`
            )
          }
          console.log(`[NetPol] Resolved ${binding.dns} → [${cidrs.join(', ')}]`)
        } catch (err) {
          // Fail-static (H1): freeze the accumulated set on a transient resolver
          // failure; fail loud when there is nothing to serve (bootstrap, or a
          // permanent no-records answer).
          const kind = classifyDnsError(err)
          const accumulated = accumulateHostExactHostEgress({
            fqdn: binding.dns,
            port: binding.port,
            protocol,
            resolution: { kind },
            previousAnnotations,
            now,
            config: coreConfig,
          })
          if (accumulated.cidrs.length === 0) {
            failures.push(`failed to resolve hostname "${binding.dns}": ${this.errorMessage(err)}`)
            continue
          }
          // Defense-in-depth (audit M3): rehydrated IPs (from the policy's own
          // annotations) bypass the fresh-snapshot CIDR gate, so a tampered/corrupt
          // state annotation could union a blocked/private IP. Re-validate the
          // effective set against the blocked ranges before rendering.
          cidrs = accumulated.cidrs.filter(c => isAllowedExternalEgressCidr(c))
          stateAnnotations = accumulated.annotations
          // A freeze keeps the SAME set as the live policy → changed=false → no
          // write (no churn while DNS is failing); a genuine change still writes.
          egressRenewalDue = accumulated.renewalDue
          egressStateChanged = accumulated.changed
          resolvedEgressIPs.push({
            dns: binding.dns,
            ips: cidrs.map(cidr => cidr.replace(/\/32$/, '')),
            resolvedAt,
          })
          console.warn(
            `[NetPol] ${kind} DNS failure for "${binding.dns}"; serving ${cidrs.length} accumulated IP(s) (fail-static, issue #299): ${this.errorMessage(err)}`
          )
        }
      } else {
        continue
      }

      desiredPolicyNames.add(name)

      const policy: k8s.V1NetworkPolicy = {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: {
          name,
          namespace: server.namespace,
          labels: {
            [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
            [POLICY_TYPE_LABEL]: EXTERNAL_EGRESS_POLICY_TYPE,
            [MCPSERVER_LABEL]: server.name,
            [EGRESS_CLASS_LABEL]: egressClass,
          },
          // Persist the sliding-window state so the next reconcile rehydrates the
          // accumulated set instead of collapsing to a single snapshot (#299).
          ...(stateAnnotations ? { annotations: stateAnnotations } : {}),
        },
        spec: {
          podSelector: {
            matchLabels: { [MCPSERVER_LABEL]: server.name },
          },
          policyTypes: ['Egress'],
          egress: cidrs.map(cidr => ({
            to: [{ ipBlock: { cidr } }],
            ports: [{ port: binding.port, protocol }],
          })),
        },
      }

      // Write only when the enforced rules changed / the policy is new / drifted
      // (audit F2 no-churn + L1 self-heal), OR when the DNS window is aging and
      // must be re-persisted (audit M1). A pure timestamp refresh is a no-op.
      if (
        this.externalEgressWriteNeeded(existingPolicy, policy) ||
        egressRenewalDue ||
        egressStateChanged
      ) {
        await applyNetworkPolicy(this.networkingApi, name, server.namespace, policy, '[NetPol]')
      } else {
        console.log(`[NetPol] External egress "${name}" unchanged — no-op (issue #299 no-churn)`)
      }
    }

    try {
      await this.cleanupExternalEgress(
        server.name,
        server.namespace,
        existingPolicies.filter(policy => {
          const name = policy.metadata?.name
          return Boolean(name) && !desiredPolicyNames.has(name!)
        })
      )
    } catch (error) {
      await this.writeExternalEgressStatus(
        server,
        resolvedEgressIPs,
        'False',
        'CleanupFailed',
        `Failed to delete stale external egress policies: ${this.errorMessage(error)}`
      )
      throw error
    }

    if (failures.length > 0) {
      const message = failures.join('; ')
      await this.writeExternalEgressStatus(
        server,
        resolvedEgressIPs,
        'False',
        'ExternalEgressRejected',
        message
      )
      throw new Error(`External egress reconciliation failed for "${server.name}": ${message}`)
    }

    await this.writeExternalEgressStatus(
      server,
      this.sortResolvedEgressIPs(resolvedEgressIPs),
      'True',
      'Reconciled',
      bindings.some(binding => binding.egressClass === 'public-web')
        ? 'External egress policies reconciled; public-web allows public TCP 80/443 with private and special ranges excluded'
        : 'External egress policies reconciled'
    )
  }

  /**
   * Delete all external egress policies for a given McpServer.
   */
  async cleanupExternalEgress(
    serverName: string,
    namespace: string,
    policies?: k8s.V1NetworkPolicy[]
  ): Promise<void> {
    const policiesToDelete =
      policies ?? (await this.listExternalEgressPoliciesForServer(serverName, namespace))

    for (const policy of policiesToDelete) {
      const name = policy.metadata?.name
      if (!name) continue
      try {
        await this.networkingApi.deleteNamespacedNetworkPolicy({ name, namespace })
        console.log(`[NetPol] Deleted external egress policy "${name}"`)
      } catch (error: unknown) {
        if (getErrorCode(error) !== 404) {
          console.error(`[NetPol] Failed to delete external egress policy "${name}":`, error)
          throw error
        }
      }
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private mergeStatusCondition(
    existingConditions: McpServerCondition[],
    condition: Omit<McpServerCondition, 'lastTransitionTime'>
  ): McpServerCondition[] {
    const now = new Date().toISOString()
    const prior = existingConditions.find(c => c.type === condition.type)
    const lastTransitionTime =
      prior && prior.status === condition.status ? prior.lastTransitionTime : now
    const next: McpServerCondition = {
      type: condition.type,
      status: condition.status,
      reason: condition.reason,
      message: condition.message,
      lastTransitionTime,
      ...(condition.observedGeneration !== undefined && {
        observedGeneration: condition.observedGeneration,
      }),
    }
    return [...existingConditions.filter(c => c.type !== condition.type), next]
  }

  private sortResolvedEgressIPs(
    resolvedEgressIPs: McpServerResolvedEgressIP[]
  ): McpServerResolvedEgressIP[] {
    return resolvedEgressIPs
      .map(entry => ({ ...entry, ips: [...entry.ips].sort() }))
      .sort((a, b) => a.dns.localeCompare(b.dns) || a.ips.join(',').localeCompare(b.ips.join(',')))
  }

  private resolvedEgressIPsComparable(
    resolvedEgressIPs: McpServerResolvedEgressIP[] | undefined
  ): Array<{ dns: string; ips: string[] }> {
    return this.sortResolvedEgressIPs(resolvedEgressIPs ?? []).map(({ dns, ips }) => ({
      dns,
      ips,
    }))
  }

  /**
   * Content-stable view of status conditions for the no-op gate in
   * `writeExternalEgressStatus`.
   *
   * The Kubernetes apiserver canonicalizes CRD `.status` JSON with object keys
   * in ALPHABETICAL order, while the controller rebuilds condition objects in
   * code insertion order ({type,status,reason,message,...}). A raw
   * `JSON.stringify` equality check is therefore key-order sensitive and never
   * matches across a read->rebuild round-trip — so the gate would re-patch
   * status on every reconcile, and because each McpServer status write
   * self-triggers the McpServer watch, that produces an unbounded reconcile
   * loop (observed OOM-looping HCC on a remote-egress McpServer in prod).
   *
   * Normalize both sides to a fixed key order and sort by `type` so the
   * comparison reflects condition content, not serialization or array order.
   * Mirrors `resolvedEgressIPsComparable`.
   */
  private conditionsComparable(conditions: McpServerCondition[] | undefined): McpServerCondition[] {
    return [...(conditions ?? [])]
      .map(c => ({
        type: c.type,
        status: c.status,
        reason: c.reason,
        message: c.message,
        lastTransitionTime: c.lastTransitionTime,
        observedGeneration: c.observedGeneration,
      }))
      .sort((a, b) => a.type.localeCompare(b.type))
  }

  private async writeExternalEgressStatus(
    server: McpServerCRD,
    resolvedEgressIPs: McpServerResolvedEgressIP[],
    status: 'True' | 'False' | 'Unknown',
    reason: string,
    message: string
  ): Promise<void> {
    let currentStatus: McpServerCrdStatus = {}
    let hasStatusObject = false

    try {
      const current = (await this.customApi.getNamespacedCustomObjectStatus({
        group: GROUP,
        version: VERSION,
        namespace: server.namespace,
        plural: PLURAL_MCPSERVERS,
        name: server.name,
      })) as { status?: McpServerCrdStatus }
      hasStatusObject = typeof current.status === 'object' && current.status !== null
      currentStatus = current.status ?? {}
    } catch (error) {
      if (getErrorCode(error) === 404) {
        console.warn(
          `[NetPol] McpServer "${server.name}" deleted mid-reconcile — external egress status skipped`
        )
        return
      }
      console.warn(
        `[NetPol] Failed to read external egress status for "${server.name}" — skipping status update:`,
        error
      )
      throw error
    }

    const nextConditions = this.mergeStatusCondition(currentStatus.conditions ?? [], {
      type: 'ExternalEgressReady',
      status,
      reason,
      message,
      ...(server.generation !== undefined && { observedGeneration: server.generation }),
    })
    const stableResolvedEgressIPs = this.sortResolvedEgressIPs(resolvedEgressIPs)
    const nextStatus: McpServerCrdStatus = {
      ...currentStatus,
      resolvedEgressIPs: stableResolvedEgressIPs,
      conditions: nextConditions,
    }

    if (
      JSON.stringify(this.resolvedEgressIPsComparable(currentStatus.resolvedEgressIPs)) ===
        JSON.stringify(this.resolvedEgressIPsComparable(stableResolvedEgressIPs)) &&
      JSON.stringify(this.conditionsComparable(currentStatus.conditions)) ===
        JSON.stringify(this.conditionsComparable(nextStatus.conditions))
    ) {
      return
    }

    const statusPatch: JsonPatchOperation[] = hasStatusObject
      ? [
          { op: 'add', path: '/status/resolvedEgressIPs', value: stableResolvedEgressIPs },
          { op: 'add', path: '/status/conditions', value: nextConditions },
        ]
      : [{ op: 'add', path: '/status', value: nextStatus }]

    try {
      await this.customApi.patchNamespacedCustomObjectStatus({
        group: GROUP,
        version: VERSION,
        namespace: server.namespace,
        plural: PLURAL_MCPSERVERS,
        name: server.name,
        body: statusPatch,
      })
    } catch (error) {
      console.warn(
        `[NetPol] Failed to write ExternalEgressReady=${status} on "${server.name}":`,
        error
      )
      throw error
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  /** Policy name for a (context, server) pair. */
  private policyName(contextId: string, serverName: string): string {
    return `ctx-${contextId}-${serverName}`
  }

  /** List all context-allow policies for a given context. */
  private async listPoliciesForContext(contextId: string): Promise<k8s.V1NetworkPolicy[]> {
    try {
      const response = await this.networkingApi.listNamespacedNetworkPolicy({
        namespace: config.namespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${POLICY_TYPE_LABEL}=context-allow,${CONTEXT_LABEL}=${contextId}`,
      })
      return response.items || []
    } catch (error) {
      console.error(`[NetPol] Failed to list policies for context "${contextId}":`, error)
      throw error
    }
  }

  /** List all context-allow policies (any context). */
  private async listAllContextPolicies(): Promise<k8s.V1NetworkPolicy[]> {
    try {
      const response = await this.networkingApi.listNamespacedNetworkPolicy({
        namespace: config.namespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${POLICY_TYPE_LABEL}=context-allow`,
      })
      return response.items || []
    } catch (error) {
      console.error('[NetPol] Failed to list all context policies:', error)
      throw error
    }
  }

  /** List all external-egress policies in the MCP server namespace. */
  private async listAllExternalEgressPolicies(): Promise<k8s.V1NetworkPolicy[]> {
    try {
      const response = await this.networkingApi.listNamespacedNetworkPolicy({
        namespace: config.namespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${POLICY_TYPE_LABEL}=${EXTERNAL_EGRESS_POLICY_TYPE}`,
      })
      return response.items || []
    } catch (error) {
      console.error('[NetPol] Failed to list all external egress policies:', error)
      throw error
    }
  }

  /** List all external-egress policies for a single McpServer. */
  private async listExternalEgressPoliciesForServer(
    serverName: string,
    namespace: string
  ): Promise<k8s.V1NetworkPolicy[]> {
    const response = await this.networkingApi.listNamespacedNetworkPolicy({
      namespace,
      labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${POLICY_TYPE_LABEL}=${EXTERNAL_EGRESS_POLICY_TYPE},${MCPSERVER_LABEL}=${serverName}`,
    })
    return response.items || []
  }

  /** Create or update a NetworkPolicy. */
  private async applyPolicy(name: string, policy: k8s.V1NetworkPolicy): Promise<void> {
    await applyNetworkPolicy(this.networkingApi, name, config.namespace, policy, '[NetPol]')
  }

  /** Delete a NetworkPolicy in mcp-server namespace. */
  private async deletePolicy(name: string): Promise<void> {
    try {
      await this.networkingApi.deleteNamespacedNetworkPolicy({
        name,
        namespace: config.namespace,
      })
      console.log(`[NetPol] Deleted policy "${name}"`)
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        console.log(`[NetPol] Policy "${name}" already gone`)
      } else {
        console.error(`[NetPol] Failed to delete policy "${name}":`, error)
        throw error
      }
    }
  }

  /** List L2 egress counterpart policies in mcp-host namespace for a given context. */
  private async listEgressPoliciesForContext(contextId: string): Promise<k8s.V1NetworkPolicy[]> {
    try {
      const response = await this.networkingApi.listNamespacedNetworkPolicy({
        namespace: config.hostNamespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${POLICY_TYPE_LABEL}=context-allow,${CONTEXT_LABEL}=${contextId}`,
      })
      return response.items || []
    } catch (error) {
      console.error(`[NetPol] Failed to list egress policies for context "${contextId}":`, error)
      throw error
    }
  }

  /** Delete a NetworkPolicy in mcp-host namespace (L2 egress counterpart). */
  private async deleteEgressPolicy(name: string): Promise<void> {
    try {
      await this.networkingApi.deleteNamespacedNetworkPolicy({
        name,
        namespace: config.hostNamespace,
      })
      console.log(`[NetPol] Deleted L2 egress policy "${name}"`)
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        console.log(`[NetPol] L2 egress policy "${name}" already gone`)
      } else {
        console.error(`[NetPol] Failed to delete L2 egress policy "${name}":`, error)
        throw error
      }
    }
  }

  // ─── RPC-Proxy Egress (L2) ──────────────────────────────────────────

  /**
   * Create or update an egress policy in the rpc-proxy namespace allowing
   * rpc-proxy pods to reach a specific MCP server on a given port.
   */
  private async ensureRpcProxyEgress(
    contextId: string,
    serverName: string,
    port: number
  ): Promise<void> {
    const name = `rpc-egress-${contextId}-${serverName}`
    const policy: k8s.V1NetworkPolicy = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name,
        namespace: config.rpcProxyNamespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [POLICY_TYPE_LABEL]: RPC_PROXY_EGRESS_POLICY_TYPE,
          [CONTEXT_LABEL]: contextId,
          [MCPSERVER_LABEL]: serverName,
        },
      },
      spec: {
        podSelector: { matchLabels: { app: RPC_PROXY_APP_LABEL } },
        policyTypes: ['Egress'],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.namespace },
                },
                podSelector: { matchLabels: { [MCPSERVER_LABEL]: serverName } },
              },
            ],
            ports: [{ port, protocol: 'TCP' }],
          },
        ],
      },
    }
    await applyNetworkPolicy(this.networkingApi, name, config.rpcProxyNamespace, policy, '[NetPol]')
  }

  /** Delete all rpc-proxy egress policies for a given context. */
  private async deleteRpcProxyPoliciesForContext(contextId: string): Promise<void> {
    try {
      const policies = await this.listRpcProxyEgressPoliciesForContext(contextId)
      for (const policy of policies) {
        const name = policy.metadata?.name || ''
        await this.deletePolicyInNamespace(config.rpcProxyNamespace, name)
      }
    } catch (error) {
      console.error(
        `[NetPol] Failed to delete rpc-proxy egress policies for context "${contextId}":`,
        error
      )
      throw error
    }
  }

  /** List rpc-proxy egress policies for a given context. */
  private async listRpcProxyEgressPoliciesForContext(
    contextId: string
  ): Promise<k8s.V1NetworkPolicy[]> {
    try {
      const response = await this.networkingApi.listNamespacedNetworkPolicy({
        namespace: config.rpcProxyNamespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${POLICY_TYPE_LABEL}=${RPC_PROXY_EGRESS_POLICY_TYPE},${CONTEXT_LABEL}=${contextId}`,
      })
      return response.items || []
    } catch (error) {
      console.error(
        `[NetPol] Failed to list rpc-proxy egress policies for context "${contextId}":`,
        error
      )
      throw error
    }
  }

  /** List all rpc-proxy egress policies across all contexts. */
  private async listAllRpcProxyEgressPolicies(): Promise<k8s.V1NetworkPolicy[]> {
    try {
      const response = await this.networkingApi.listNamespacedNetworkPolicy({
        namespace: config.rpcProxyNamespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${POLICY_TYPE_LABEL}=${RPC_PROXY_EGRESS_POLICY_TYPE}`,
      })
      return response.items || []
    } catch (error) {
      console.error('[NetPol] Failed to list all rpc-proxy egress policies:', error)
      throw error
    }
  }

  /** Delete a NetworkPolicy in an arbitrary namespace. */
  private async deletePolicyInNamespace(namespace: string, name: string): Promise<void> {
    try {
      await this.networkingApi.deleteNamespacedNetworkPolicy({ name, namespace })
      console.log(`[NetPol] Deleted rpc-proxy egress policy "${name}"`)
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        console.log(`[NetPol] rpc-proxy egress policy "${name}" already gone`)
      } else {
        console.error(`[NetPol] Failed to delete policy "${name}" in ${namespace}:`, error)
        throw error
      }
    }
  }

  /** Delete a formerly static NetworkPolicy that is now generated dynamically. */
  private async deleteLegacyStaticPolicy(namespace: string, name: string): Promise<void> {
    try {
      await this.networkingApi.deleteNamespacedNetworkPolicy({ name, namespace })
      console.log(`[NetPol] Deleted legacy static policy "${name}" in "${namespace}"`)
    } catch (error: unknown) {
      if (getErrorCode(error) !== 404) {
        console.error(
          `[NetPol] Failed to delete legacy static policy "${name}" in "${namespace}":`,
          error
        )
        throw error
      }
    }
  }
}
