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
import { config } from './config'
import {
  EXTERNAL_EGRESS_POLICY_TYPE,
  INFRA_POLICY_TYPE,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  MCPSERVER_LABEL,
  POLICY_TYPE_LABEL,
} from './constants'
import {
  confirmAuthoritativeMcpServerAbsence,
  sameMcpServerDesiredRevision,
} from './mcpServerSafety'
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
  op: 'add' | 'replace' | 'remove' | 'test'
  path: string
  value?: unknown
}

type NetworkPolicyMutationOptions = {
  isCurrent?: () => boolean
}

const GROUP = 'clerum.io'
const VERSION = 'v1alpha1'
const PLURAL_MCPSERVERS = 'mcpservers'
const PLURAL_CONTEXTS = 'contexts'
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

function isAllowedExternalEgressCidr(cidr: string): boolean {
  if (!cidrRange(cidr)) return false
  return !PUBLIC_EGRESS_EXCEPT_CIDRS.some(blocked => cidrOverlaps(cidr, blocked))
}

function isPublicDnsHostname(host: string): boolean {
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

export interface NetworkPolicyFullReconcileOptions {
  serverInventoryComplete?: boolean
  ensureDefaults?: boolean
  /**
   * Dynamic authority checks are intentionally callbacks: watch authority can
   * be lost after the startup snapshot but before an orphan delete begins.
   * Omitted callbacks preserve the historical authoritative-by-default API.
   */
  contextInventoryAuthoritative?: () => boolean
  serverInventoryAuthoritative?: () => boolean
  runContextEffect?: (contextId: string, work: () => Promise<void>) => Promise<void>
  runServerEffect?: (serverName: string, work: () => Promise<void>) => Promise<void>
  resolveCurrentContext?: (name: string) => ContextCRD | undefined
  resolveCurrentContextById?: (contextId: string) => ContextCRD | undefined
  resolveCurrentServer?: (name: string) => McpServerCRD | undefined
}

export class NetworkPolicyReconciler {
  private networkingApi: k8s.NetworkingV1Api
  private customApi: k8s.CustomObjectsApi

  /** Reference to the MCP server cache so we can look up ports. */
  private serverCache: Map<string, McpServerCRD>

  constructor(kc: k8s.KubeConfig, serverCache: Map<string, McpServerCRD>) {
    this.networkingApi = kc.makeApiClient(k8s.NetworkingV1Api)
    this.customApi = kc.makeApiClient(k8s.CustomObjectsApi)
    this.serverCache = serverCache
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
  async reconcileContext(
    context: ContextCRD,
    options: NetworkPolicyMutationOptions = {}
  ): Promise<void> {
    const callerIsCurrent = options.isCurrent ?? (() => true)
    if (!callerIsCurrent()) return
    const contextId = context.spec.contextId
    const allowedServers = context.spec.mcpServers || []
    const selectedServers = new Map(
      allowedServers.map(serverName => [serverName, this.serverCache.get(serverName)])
    )
    const isCurrent = (): boolean =>
      callerIsCurrent() &&
      allowedServers.every(
        serverName => this.serverCache.get(serverName) === selectedServers.get(serverName)
      )
    if (!isCurrent()) return

    console.log(
      `[NetPol] Reconciling context "${contextId}" — allowed servers: [${allowedServers.join(', ')}]`
    )

    // Build desired policy names
    const desiredNames = new Set(
      allowedServers.map(serverName => this.policyName(contextId, serverName))
    )

    // Get existing policies for this context
    const existingPolicies = await this.listPoliciesForContext(contextId)
    if (!isCurrent()) return

    // Create or update policies for each allowed server
    for (const serverName of allowedServers) {
      if (!isCurrent()) return
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

      await this.applyPolicy(name, ingressPolicy, isCurrent)
      if (!isCurrent()) return

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
        '[NetPol]',
        isCurrent
      )
      if (!isCurrent()) return

      // L2 rpc-proxy egress: allow rpc-proxy pods to reach this MCP server
      await this.ensureRpcProxyEgress(contextId, serverName, port, isCurrent)
    }

    // Delete policies for servers no longer in the context
    for (const existing of existingPolicies) {
      if (!isCurrent()) return
      const existingName = existing.metadata?.name || ''
      if (!desiredNames.has(existingName)) {
        console.log(`[NetPol] Deleting orphaned policy "${existingName}"`)
        await this.deletePolicy(existingName, isCurrent)
      }
    }

    // Delete orphaned L2 egress counterparts in mcp-host namespace
    const existingEgressPolicies = await this.listEgressPoliciesForContext(contextId)
    if (!isCurrent()) return
    const desiredEgressNames = new Set(
      allowedServers.map(serverName => `${this.policyName(contextId, serverName)}-egress`)
    )
    for (const existing of existingEgressPolicies) {
      if (!isCurrent()) return
      const existingName = existing.metadata?.name || ''
      if (!desiredEgressNames.has(existingName)) {
        console.log(`[NetPol] Deleting orphaned L2 egress policy "${existingName}"`)
        await this.deleteEgressPolicy(existingName, isCurrent)
      }
    }

    // Delete orphaned rpc-proxy egress counterparts. Keeping these after a
    // server is removed from a Context would preserve an old in-cluster route.
    const existingRpcProxyPolicies = await this.listRpcProxyEgressPoliciesForContext(contextId)
    if (!isCurrent()) return
    const desiredRpcProxyNames = new Set(
      allowedServers.map(serverName => `rpc-egress-${contextId}-${serverName}`)
    )
    for (const existing of existingRpcProxyPolicies) {
      if (!isCurrent()) return
      const existingName = existing.metadata?.name || ''
      if (!desiredRpcProxyNames.has(existingName)) {
        console.log(`[NetPol] Deleting orphaned rpc-proxy egress policy "${existingName}"`)
        await this.deletePolicyInNamespace(config.rpcProxyNamespace, existingName, isCurrent)
      }
    }
  }

  /**
   * Delete all NetworkPolicies for a deleted Context.
   */
  async reconcileDeleteContext(
    contextId: string,
    deleteAllowed?: () => Promise<boolean>
  ): Promise<void> {
    console.log(`[NetPol] Context "${contextId}" deleted — removing all policies`)

    const policies = await this.listPoliciesForContext(contextId)
    for (const policy of policies) {
      const name = policy.metadata?.name || ''
      if (deleteAllowed && !(await deleteAllowed())) return
      await this.deletePolicy(name)
    }

    // Also delete L2 egress counterparts in mcp-host namespace
    const egressPolicies = await this.listEgressPoliciesForContext(contextId)
    for (const policy of egressPolicies) {
      const name = policy.metadata?.name || ''
      if (deleteAllowed && !(await deleteAllowed())) return
      await this.deleteEgressPolicy(name)
    }

    // Also delete L2 rpc-proxy egress policies
    await this.deleteRpcProxyPoliciesForContext(contextId, deleteAllowed)
  }

  /**
   * Full reconciliation on startup — sync desired vs actual policies.
   */
  async fullReconcile(
    contexts: ContextCRD[],
    servers: McpServerCRD[] = [],
    options: NetworkPolicyFullReconcileOptions = {}
  ): Promise<void> {
    console.log(`[NetPol] Running full reconciliation for ${contexts.length} Context(s)`)

    if (options.ensureDefaults !== false) {
      await this.ensureDefaultPolicies()
    }

    const runContextEffect =
      options.runContextEffect ?? ((_contextId: string, work: () => Promise<void>) => work())
    const runServerEffect =
      options.runServerEffect ?? ((_serverName: string, work: () => Promise<void>) => work())
    const contextInventoryIsCurrent = (): boolean =>
      (options.contextInventoryAuthoritative?.() ?? true) &&
      (options.serverInventoryAuthoritative?.() ?? true)

    // Reconcile each context
    for (const context of contexts) {
      const contextId = context.spec.contextId
      await runContextEffect(contextId, async () => {
        const current = options.resolveCurrentContext
          ? options.resolveCurrentContext(context.name)
          : context
        if (!current || current.spec.contextId !== contextId) return
        const contextEffectIsCurrent = (): boolean =>
          contextInventoryIsCurrent() &&
          (!options.resolveCurrentContext ||
            options.resolveCurrentContext(current.name) === current)
        await this.reconcileContext(current, { isCurrent: contextEffectIsCurrent })
      })
    }

    // Reconcile external egress for all existing servers on startup so a
    // controller restart converges pre-existing McpServer CRDs too.
    for (const server of servers) {
      await runServerEffect(server.name, async () => {
        const current = options.resolveCurrentServer
          ? options.resolveCurrentServer(server.name)
          : server
        if (!current) return
        const serverEffectIsCurrent = (): boolean => {
          if (!(options.serverInventoryAuthoritative?.() ?? true)) return false
          if (!options.resolveCurrentServer) return true
          const latest = options.resolveCurrentServer(current.name)
          return latest !== undefined && sameMcpServerDesiredRevision(current, latest)
        }
        await this.reconcileExternalEgress(current, { isCurrent: serverEffectIsCurrent })
      })
    }

    // Authority is monotonic within this pass. Once a watch loses authority,
    // this inventory snapshot cannot safely become authoritative again even if
    // the callback flips back before the next delete.
    let contextAuthorityLost = false
    let contextAuthorityWarningLogged = false
    const contextCleanupAuthoritative = (): boolean => {
      if (
        !contextAuthorityLost &&
        options.contextInventoryAuthoritative &&
        !options.contextInventoryAuthoritative()
      ) {
        contextAuthorityLost = true
      }
      if (contextAuthorityLost && !contextAuthorityWarningLogged) {
        contextAuthorityWarningLogged = true
        console.warn(
          '[NetPol] Skipping remaining Context policy orphan cleanup because Context inventory authority was lost'
        )
      }
      return !contextAuthorityLost
    }

    const desiredContextIds = new Set(contexts.map(c => c.spec.contextId))
    const cleanupOrphanedContextPolicies = async (
      listPolicies: () => Promise<k8s.V1NetworkPolicy[]>,
      deletePolicy: (name: string) => Promise<void>,
      describePolicy: (name: string, contextId: string) => string
    ): Promise<void> => {
      if (!contextCleanupAuthoritative()) return
      const policies = await listPolicies()
      for (const policy of policies) {
        const contextId = policy.metadata?.labels?.[CONTEXT_LABEL]
        if (contextId && !desiredContextIds.has(contextId)) {
          const name = policy.metadata?.name || ''
          await runContextEffect(contextId, async () => {
            if (
              !(await this.contextOrphanDeleteAllowed(
                contextId,
                contextCleanupAuthoritative,
                options.resolveCurrentContextById
              ))
            ) {
              return
            }
            console.log(describePolicy(name, contextId))
            await deletePolicy(name)
          })
        }
      }
    }

    // Delete orphaned Context policies across every L2 lane. Each lane uses
    // the canonical contextId effect key and rechecks authority plus live CRD
    // presence immediately before its delete.
    await cleanupOrphanedContextPolicies(
      () => this.listAllContextPolicies(),
      name => this.deletePolicy(name),
      (name, contextId) =>
        `[NetPol] Deleting orphaned policy "${name}" (context "${contextId}" no longer exists)`
    )
    await cleanupOrphanedContextPolicies(
      () => this.listAllContextEgressPolicies(),
      name => this.deleteEgressPolicy(name),
      name => `[NetPol] Deleting orphaned L2 egress policy "${name}"`
    )
    await cleanupOrphanedContextPolicies(
      () => this.listAllRpcProxyEgressPolicies(),
      name => this.deletePolicyInNamespace(config.rpcProxyNamespace, name),
      name => `[NetPol] Deleting orphaned rpc-proxy egress policy "${name}"`
    )

    let serverAuthorityLost = false
    let serverAuthorityWarningLogged = false
    const serverCleanupAuthoritative = (): boolean => {
      if (
        !serverAuthorityLost &&
        options.serverInventoryAuthoritative &&
        !options.serverInventoryAuthoritative()
      ) {
        serverAuthorityLost = true
      }
      if (serverAuthorityLost && !serverAuthorityWarningLogged) {
        serverAuthorityWarningLogged = true
        console.warn(
          '[NetPol] Skipping remaining external egress orphan cleanup because McpServer inventory authority was lost'
        )
      }
      return !serverAuthorityLost
    }

    // Clean up external egress policies for servers that no longer exist.
    if (options.serverInventoryComplete !== false && serverCleanupAuthoritative()) {
      const desiredServerNames = new Set(servers.map(s => s.name))
      const allExternalPolicies = await this.listAllExternalEgressPolicies()
      for (const policy of allExternalPolicies) {
        const serverName = policy.metadata?.labels?.[MCPSERVER_LABEL]
        if (serverName && !desiredServerNames.has(serverName)) {
          const name = policy.metadata?.name || ''
          await runServerEffect(serverName, async () => {
            if (
              !(await confirmAuthoritativeMcpServerAbsence({
                inventoryAuthoritative: serverCleanupAuthoritative,
                resolveCurrent: () => options.resolveCurrentServer?.(serverName),
                readCurrent: () =>
                  this.customApi.getNamespacedCustomObject({
                    group: GROUP,
                    version: VERSION,
                    namespace: config.namespace,
                    plural: PLURAL_MCPSERVERS,
                    name: serverName,
                  }),
              }))
            ) {
              return
            }
            console.log(`[NetPol] Deleting orphaned external egress policy "${name}"`)
            await this.deletePolicyInNamespace(config.namespace, name)
          })
        }
      }
    } else if (options.serverInventoryComplete === false) {
      console.warn(
        '[NetPol] Skipping external egress orphan cleanup because server inventory is incomplete'
      )
    }

    console.log('[NetPol] Full reconciliation complete')
  }

  private async contextOrphanDeleteAllowed(
    contextId: string,
    inventoryAuthoritative: () => boolean,
    resolveCurrentContextById?: (contextId: string) => ContextCRD | undefined
  ): Promise<boolean> {
    if (!inventoryAuthoritative() || resolveCurrentContextById?.(contextId)) return false

    const response = (await this.customApi.listNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: config.namespace,
      plural: PLURAL_CONTEXTS,
    })) as { items?: Array<{ spec?: { contextId?: string } }> }
    if ((response.items ?? []).some(context => context.spec?.contextId === contextId)) return false

    return inventoryAuthoritative() && !resolveCurrentContextById?.(contextId)
  }

  // ─── L3 External Egress ────────────────────────────────────────────

  /**
   * Reconcile external egress policies for an McpServer with egressBindings.
   * For DNS bindings, resolves hostnames to IPs and creates ipBlock rules.
   * For CIDR bindings, creates ipBlock rules directly.
   */
  async reconcileExternalEgress(
    server: McpServerCRD,
    options: NetworkPolicyMutationOptions = {}
  ): Promise<void> {
    const isCurrent = options.isCurrent ?? (() => true)
    if (!isCurrent()) return
    let existingPolicies: k8s.V1NetworkPolicy[]
    try {
      existingPolicies = await this.listExternalEgressPoliciesForServer(
        server.name,
        server.namespace
      )
    } catch (error) {
      if (!isCurrent()) return
      await this.writeExternalEgressStatus(
        server,
        [],
        'False',
        'InventoryListFailed',
        `Failed to list existing external egress policies: ${this.errorMessage(error)}`,
        isCurrent
      )
      throw error
    }
    if (!isCurrent()) return

    const bindings = server.spec.egressBindings
    if (!bindings || bindings.length === 0) {
      try {
        await this.cleanupExternalEgress(
          server.name,
          server.namespace,
          existingPolicies,
          async () => isCurrent()
        )
      } catch (error) {
        if (!isCurrent()) return
        await this.writeExternalEgressStatus(
          server,
          [],
          'False',
          'CleanupFailed',
          `Failed to delete stale external egress policies: ${this.errorMessage(error)}`,
          isCurrent
        )
        throw error
      }
      if (!isCurrent()) return
      await this.writeExternalEgressStatus(
        server,
        [],
        'True',
        'NoEgressBindings',
        'No external egress bindings declared',
        isCurrent
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
      if (!isCurrent()) return
      const egressClass = binding.egressClass ?? 'exact-host'
      if (egressClass !== 'exact-host' && egressClass !== 'public-web') {
        failures.push(`egressClass "${String(binding.egressClass)}" is not supported`)
        continue
      }

      let cidrs: string[]
      const name = this.externalEgressPolicyName(server.name, binding)
      if (!name) {
        failures.push('exact-host external egress bindings must declare dns or cidr')
        continue
      }

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

        await applyNetworkPolicy(
          this.networkingApi,
          name,
          server.namespace,
          policy,
          '[NetPol]',
          isCurrent
        )
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
        try {
          const ips = await dns.resolve4(binding.dns)
          if (!isCurrent()) return
          const uniqueIps = [...new Set(ips)].sort()
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
          cidrs = uniqueIps.map(ip => `${ip}/32`)
          const disallowedCidrs = cidrs.filter(cidr => !isAllowedExternalEgressCidr(cidr))
          if (disallowedCidrs.length > 0) {
            failures.push(
              `hostname "${binding.dns}" resolved disallowed address(es): ${disallowedCidrs.join(', ')}`
            )
            continue
          }
          resolvedEgressIPs.push({ dns: binding.dns, ips: uniqueIps, resolvedAt })
          console.log(`[NetPol] Resolved ${binding.dns} → [${cidrs.join(', ')}]`)
        } catch (err) {
          failures.push(`failed to resolve hostname "${binding.dns}": ${this.errorMessage(err)}`)
          continue
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

      await applyNetworkPolicy(
        this.networkingApi,
        name,
        server.namespace,
        policy,
        '[NetPol]',
        isCurrent
      )
    }

    try {
      await this.cleanupExternalEgress(
        server.name,
        server.namespace,
        existingPolicies.filter(policy => {
          const name = policy.metadata?.name
          return Boolean(name) && !desiredPolicyNames.has(name!)
        }),
        async () => isCurrent()
      )
    } catch (error) {
      if (!isCurrent()) return
      await this.writeExternalEgressStatus(
        server,
        resolvedEgressIPs,
        'False',
        'CleanupFailed',
        `Failed to delete stale external egress policies: ${this.errorMessage(error)}`,
        isCurrent
      )
      throw error
    }
    if (!isCurrent()) return

    if (failures.length > 0) {
      const message = failures.join('; ')
      await this.writeExternalEgressStatus(
        server,
        resolvedEgressIPs,
        'False',
        'ExternalEgressRejected',
        message,
        isCurrent
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
        : 'External egress policies reconciled',
      isCurrent
    )
  }

  /**
   * Delete all external egress policies for a given McpServer.
   */
  async cleanupExternalEgress(
    serverName: string,
    namespace: string,
    policies?: k8s.V1NetworkPolicy[],
    deleteAllowed?: () => Promise<boolean>
  ): Promise<void> {
    const policiesToDelete =
      policies ?? (await this.listExternalEgressPoliciesForServer(serverName, namespace))

    for (const policy of policiesToDelete) {
      const name = policy.metadata?.name
      if (!name) continue
      try {
        if (deleteAllowed && !(await deleteAllowed())) return
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
    message: string,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    if (!isCurrent()) return
    let currentStatus: McpServerCrdStatus = {}
    let hasStatusObject = false
    let currentMetadata:
      | {
          uid?: string
          generation?: number
          resourceVersion?: string
        }
      | undefined

    try {
      const current = (await this.customApi.getNamespacedCustomObjectStatus({
        group: GROUP,
        version: VERSION,
        namespace: server.namespace,
        plural: PLURAL_MCPSERVERS,
        name: server.name,
      })) as {
        metadata?: {
          uid?: string
          generation?: number
          resourceVersion?: string
        }
        status?: McpServerCrdStatus
      }
      currentMetadata = current.metadata
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
    if (!isCurrent()) return

    if (
      (server.uid !== undefined && currentMetadata?.uid !== server.uid) ||
      (server.generation !== undefined && currentMetadata?.generation !== server.generation)
    ) {
      throw new Error(
        `Refusing to write external egress status for stale McpServer "${server.name}": ` +
          `expected uid=${String(server.uid)} generation=${String(server.generation)}, ` +
          `read uid=${String(currentMetadata?.uid)} generation=${String(
            currentMetadata?.generation
          )}`
      )
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

    const identityFence: JsonPatchOperation[] = []
    const expectedUid = server.uid ?? currentMetadata?.uid
    if (expectedUid !== undefined) {
      identityFence.push({ op: 'test', path: '/metadata/uid', value: expectedUid })
    }
    const expectedGeneration = server.generation ?? currentMetadata?.generation
    if (expectedGeneration !== undefined) {
      identityFence.push({
        op: 'test',
        path: '/metadata/generation',
        value: expectedGeneration,
      })
    }
    if (currentMetadata?.resourceVersion !== undefined) {
      identityFence.push({
        op: 'test',
        path: '/metadata/resourceVersion',
        value: currentMetadata.resourceVersion,
      })
    }
    const statusMutation: JsonPatchOperation[] = hasStatusObject
      ? [
          { op: 'add', path: '/status/resolvedEgressIPs', value: stableResolvedEgressIPs },
          { op: 'add', path: '/status/conditions', value: nextConditions },
        ]
      : [{ op: 'add', path: '/status', value: nextStatus }]
    const statusPatch = [...identityFence, ...statusMutation]

    try {
      if (!isCurrent()) return
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

  /** List all L2 context-allow egress policies in the mcp-host namespace. */
  private async listAllContextEgressPolicies(): Promise<k8s.V1NetworkPolicy[]> {
    try {
      const response = await this.networkingApi.listNamespacedNetworkPolicy({
        namespace: config.hostNamespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE},${POLICY_TYPE_LABEL}=context-allow`,
      })
      return response.items || []
    } catch (error) {
      console.error('[NetPol] Failed to list all Context egress policies:', error)
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
  private async applyPolicy(
    name: string,
    policy: k8s.V1NetworkPolicy,
    isCurrent?: () => boolean
  ): Promise<void> {
    await applyNetworkPolicy(
      this.networkingApi,
      name,
      config.namespace,
      policy,
      '[NetPol]',
      isCurrent
    )
  }

  /** Delete a NetworkPolicy in mcp-server namespace. */
  private async deletePolicy(name: string, isCurrent?: () => boolean): Promise<void> {
    try {
      if (isCurrent && !isCurrent()) return
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
  private async deleteEgressPolicy(name: string, isCurrent?: () => boolean): Promise<void> {
    try {
      if (isCurrent && !isCurrent()) return
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
    port: number,
    isCurrent?: () => boolean
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
    await applyNetworkPolicy(
      this.networkingApi,
      name,
      config.rpcProxyNamespace,
      policy,
      '[NetPol]',
      isCurrent
    )
  }

  /** Delete all rpc-proxy egress policies for a given context. */
  private async deleteRpcProxyPoliciesForContext(
    contextId: string,
    deleteAllowed?: () => Promise<boolean>
  ): Promise<void> {
    try {
      const policies = await this.listRpcProxyEgressPoliciesForContext(contextId)
      for (const policy of policies) {
        const name = policy.metadata?.name || ''
        if (deleteAllowed && !(await deleteAllowed())) return
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
  private async deletePolicyInNamespace(
    namespace: string,
    name: string,
    isCurrent?: () => boolean
  ): Promise<void> {
    try {
      if (isCurrent && !isCurrent()) return
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
