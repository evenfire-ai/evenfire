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
  networkPolicySafetyPassDurationSeconds,
  networkPolicySafetyPassPoliciesTotal,
} from './metrics'
import {
  ContextCRD,
  EgressBinding,
  McpServerCRD,
  McpServerCondition,
  McpServerCrdStatus,
  McpServerResolvedEgressIP,
} from './types'
import { applyNetworkPolicy, getErrorCode, replaceWithConflictRetry } from './utils'

type JsonPatchOperation = {
  op: 'add' | 'replace' | 'remove' | 'test'
  path: string
  value?: unknown
}

type NetworkPolicyMutationOptions = {
  isCurrent?: () => boolean
  existingPolicies?: k8s.V1NetworkPolicy[]
  onRevoked?: () => void
}

export function sameContextDesiredRevision(expected: ContextCRD, current: ContextCRD): boolean {
  return (
    expected.name === current.name &&
    expected.namespace === current.namespace &&
    expected.uid === current.uid &&
    expected.generation === current.generation &&
    JSON.stringify(canonicalizeNetworkPolicyValue(expected.spec)) ===
      JSON.stringify(canonicalizeNetworkPolicyValue(current.spec))
  )
}

function canonicalizeNetworkPolicyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeNetworkPolicyValue)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeNetworkPolicyValue(entry)])
  )
}

function sameNetworkPolicySpec(
  existing: k8s.V1NetworkPolicy,
  desired: k8s.V1NetworkPolicy
): boolean {
  return (
    JSON.stringify(canonicalizeNetworkPolicyValue(existing.spec)) ===
    JSON.stringify(canonicalizeNetworkPolicyValue(desired.spec))
  )
}

function hasExpectedPolicyOwnership(policy: k8s.V1NetworkPolicy, policyType: string): boolean {
  const labels = policy.metadata?.labels ?? {}
  return labels[MANAGED_BY_LABEL] === MANAGED_BY_VALUE && labels[POLICY_TYPE_LABEL] === policyType
}

const GROUP = 'clerum.io'
const VERSION = 'v1alpha1'
const PLURAL_MCPSERVERS = 'mcpservers'
const PLURAL_CONTEXTS = 'contexts'
const CONTEXT_LABEL = 'clerum.io/context'
const EGRESS_CLASS_LABEL = 'clerum.io/egress-class'
const RPC_PROXY_EGRESS_POLICY_TYPE = 'rpc-proxy-egress'
const RPC_PROXY_APP_LABEL = 'rpc-proxy'

type SafetyInventoryLane =
  | 'context-ingress'
  | 'context-host-egress'
  | 'context-rpc-egress'
  | 'external-egress'

type SafetyInventoryClassification = 'owned' | 'repairable' | 'ambiguous' | 'unrelated'

function policyHasOwnerShape(policy: k8s.V1NetworkPolicy, lane: SafetyInventoryLane): boolean {
  const labels = policy.metadata?.labels ?? {}
  const hasServerOwner = Boolean(labels[MCPSERVER_LABEL])
  if (lane === 'external-egress') return hasServerOwner
  return Boolean(labels[CONTEXT_LABEL]) && hasServerOwner
}

function policyHasReservedName(policy: k8s.V1NetworkPolicy, lane: SafetyInventoryLane): boolean {
  const name = policy.metadata?.name ?? ''
  switch (lane) {
    case 'context-ingress':
      return name.startsWith('ctx-')
    case 'context-host-egress':
      return name.startsWith('ctx-') && name.endsWith('-egress')
    case 'context-rpc-egress':
      return name.startsWith('rpc-egress-')
    case 'external-egress':
      return name.startsWith('ext-egress-')
  }
}

function policyNameBelongsToDifferentLane(
  policy: k8s.V1NetworkPolicy,
  lane: SafetyInventoryLane
): boolean {
  const name = policy.metadata?.name ?? ''
  if (lane === 'context-ingress') return name.startsWith('ext-egress-')
  if (lane === 'external-egress') return name.startsWith('ctx-')
  return false
}

function expectedPolicyType(lane: SafetyInventoryLane): string {
  return lane === 'context-rpc-egress'
    ? RPC_PROXY_EGRESS_POLICY_TYPE
    : lane === 'external-egress'
      ? EXTERNAL_EGRESS_POLICY_TYPE
      : 'context-allow'
}

/**
 * Classify broad namespace inventory without taking ownership of unrelated
 * policies. A single missing HCC marker is recoverable only when owner labels
 * corroborate the lane. Reserved HCC names and conflicting ownership markers
 * are never adopted implicitly.
 */
function classifySafetyInventoryPolicy(
  policy: k8s.V1NetworkPolicy,
  lane: SafetyInventoryLane
): SafetyInventoryClassification {
  const labels = policy.metadata?.labels ?? {}
  const managedBy = labels[MANAGED_BY_LABEL]
  const policyType = labels[POLICY_TYPE_LABEL]
  const expectedType = expectedPolicyType(lane)
  const managedMatches = managedBy === MANAGED_BY_VALUE
  const typeMatches = policyType === expectedType
  const managedMissing = managedBy === undefined
  const typeMissing = policyType === undefined
  const reservedName = policyHasReservedName(policy, lane)
  const ownerShape = policyHasOwnerShape(policy, lane)

  if (managedMatches && typeMatches) return 'owned'

  const oneMarkerMissing = (managedMatches && typeMissing) || (managedMissing && typeMatches)
  if (managedMissing && typeMatches && ownerShape) {
    return reservedName ? 'repairable' : 'ambiguous'
  }
  if (managedMatches && typeMissing && ownerShape) {
    if (reservedName) return 'repairable'
    if (policyNameBelongsToDifferentLane(policy, lane)) return 'unrelated'
    return 'ambiguous'
  }

  const knownOtherHccType =
    policyType !== undefined &&
    ['context-allow', RPC_PROXY_EGRESS_POLICY_TYPE, EXTERNAL_EGRESS_POLICY_TYPE].includes(
      policyType
    ) &&
    !typeMatches
  const hasRawConflictingMarker =
    (managedBy !== undefined && !managedMatches) || (policyType !== undefined && !typeMatches)
  const hasConflictingMarker =
    (managedBy !== undefined && !managedMatches) ||
    (policyType !== undefined && !typeMatches && !knownOtherHccType)
  if (
    reservedName &&
    ((managedMissing && typeMissing) || hasRawConflictingMarker || oneMarkerMissing)
  ) {
    return 'ambiguous'
  }
  if (ownerShape && hasConflictingMarker) {
    return 'ambiguous'
  }

  return 'unrelated'
}

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
  /**
   * Monotonic desired-state revisions fence ordinary watch events that arrive
   * after an owner has completed its safety turn. Watch generations remain the
   * separate authority fence for LIST -> WATCH recovery.
   */
  contextDesiredRevision?: () => number
  serverDesiredRevision?: () => number
  /**
   * Called only after every authoritative orphan-allow revocation lane has
   * completed. Additive Context/McpServer convergence intentionally happens
   * afterwards and must not delay this safety boundary.
   */
  onAuthoritativeRevocationComplete?: () => void
}

export class NetworkPolicyReconciler {
  private networkingApi: k8s.NetworkingV1Api
  private customApi: k8s.CustomObjectsApi

  /** Reference to the MCP server cache so we can look up ports. */
  private serverCache: Map<string, McpServerCRD>

  /**
   * Set whenever an authoritative safety pass ends without certifying, cleared
   * as soon as one certifies again. Only that pass enumerates the bounded
   * namespaces and classifies every object it finds; the scoped delta lane sees
   * nothing but its own label selectors. A delta therefore cannot vouch for a
   * namespace whose classified inventory is still stuck on an unresolved
   * policy, and must not certify readiness on its behalf.
   */
  private safetyPassLeftUncertified = false

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

      await this.applyFixedPolicy(name, ns, policy, 'default-deny')
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
    await this.applyFixedPolicy(name, namespace, policy, INFRA_POLICY_TYPE)
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
    await this.applyFixedPolicy(name, namespace, policy, INFRA_POLICY_TYPE)
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
    await this.applyFixedPolicy(name, namespace, policy, INFRA_POLICY_TYPE)
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

    await this.applyFixedPolicy(name, config.namespace, policy, 'allow-api')
  }

  // ─── Context-Based Policies ──────────────────────────────────────────

  private buildContextAllowPolicies(
    context: ContextCRD,
    server: McpServerCRD
  ): {
    ingress: k8s.V1NetworkPolicy
    hostEgress: k8s.V1NetworkPolicy
    rpcProxyEgress: k8s.V1NetworkPolicy
  } {
    const contextId = context.spec.contextId
    const serverName = server.name
    const name = this.policyName(contextId, serverName)
    const port = server.spec.transport.port || 3000

    return {
      ingress: {
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
      },
      hostEgress: {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: {
          name: `${name}-egress`,
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
      },
      rpcProxyEgress: this.buildRpcProxyEgressPolicy(contextId, serverName, port),
    }
  }

  /**
   * Reconcile NetworkPolicies for a Context CRD.
   * Creates one policy per allowed MCP server.
   */
  /**
   * Returns whether this Context's stale-allow revocation ran to completion.
   * Callers that certify readiness from a scoped delta MUST honour it: the pass
   * aborts as soon as its authority fence breaks, and an aborted pass leaves
   * stale allows live.
   */
  async reconcileContext(
    context: ContextCRD,
    options: NetworkPolicyMutationOptions = {}
  ): Promise<boolean> {
    const callerIsCurrent = options.isCurrent ?? (() => true)
    if (!callerIsCurrent()) return false
    const contextId = context.spec.contextId
    const allowedServers = context.spec.mcpServers || []
    const selectedServers = new Map(
      allowedServers.map(serverName => [serverName, this.serverCache.get(serverName)])
    )
    const isCurrent = (): boolean =>
      callerIsCurrent() &&
      allowedServers.every(serverName => {
        const selected = selectedServers.get(serverName)
        const current = this.serverCache.get(serverName)
        if (!selected || !current) return selected === current
        return sameMcpServerDesiredRevision(selected, current)
      })
    if (!isCurrent()) return false

    console.log(
      `[NetPol] Reconciling context "${contextId}" — allowed servers: [${allowedServers.join(', ')}]`
    )

    // Create or update policies for each allowed server.
    for (const serverName of allowedServers) {
      if (!isCurrent()) return false
      const server = this.serverCache.get(serverName)
      if (!server) {
        console.warn(
          `[NetPol] McpServer "${serverName}" not found in cache — skipping policy for context "${contextId}"`
        )
        continue
      }

      const desired = this.buildContextAllowPolicies(context, server)
      const ingressName = desired.ingress.metadata!.name!
      await this.applyContextIngressPolicy(ingressName, desired.ingress, isCurrent)
      if (!isCurrent()) return false

      const hostEgressName = desired.hostEgress.metadata!.name!
      await this.applyOwnedPolicy(
        hostEgressName,
        config.hostNamespace,
        desired.hostEgress,
        'context-host-egress',
        isCurrent
      )
      if (!isCurrent()) return false

      const rpcProxyEgressName = desired.rpcProxyEgress.metadata!.name!
      await this.applyOwnedPolicy(
        rpcProxyEgressName,
        config.rpcProxyNamespace,
        desired.rpcProxyEgress,
        'context-rpc-egress',
        isCurrent
      )
    }

    // Re-LIST every lane after writes so a same-name policy that was just
    // replaced is compared in its new form and cannot delete itself.
    const revoked = await this.revokeStaleContextAllows(context, isCurrent)
    if (revoked && this.safetyPassLeftUncertified) {
      console.warn(
        `[NetPol] Not certifying the scoped delta for context "${contextId}": the last authoritative safety pass ended without certifying its namespace-wide inventory`
      )
      return false
    }
    return revoked
  }

  private async revokeStaleContextAllows(
    context: ContextCRD,
    isCurrent: () => boolean,
    listedPolicies?: {
      context?: k8s.V1NetworkPolicy[]
      hostEgress?: k8s.V1NetworkPolicy[]
      rpcProxyEgress?: k8s.V1NetworkPolicy[]
    },
    onRevoked?: () => void
  ): Promise<boolean> {
    if (!isCurrent()) return false
    const safetySnapshotProvided = listedPolicies !== undefined
    // A delete whose uid/resourceVersion preconditions were rejected revoked
    // nothing. The scoped lane has no second source of truth to reclassify
    // from, so it finishes its remaining work and then declines to certify.
    let lostDeleteFence = false
    const contextId = context.spec.contextId
    const allowedServers = context.spec.mcpServers || []
    const desiredIngress = new Map<string, k8s.V1NetworkPolicy>()
    const desiredHostEgress = new Map<string, k8s.V1NetworkPolicy>()
    const desiredRpcProxyEgress = new Map<string, k8s.V1NetworkPolicy>()
    for (const serverName of allowedServers) {
      const server = this.serverCache.get(serverName)
      if (!server) continue
      const desired = this.buildContextAllowPolicies(context, server)
      desiredIngress.set(desired.ingress.metadata!.name!, desired.ingress)
      desiredHostEgress.set(desired.hostEgress.metadata!.name!, desired.hostEgress)
      desiredRpcProxyEgress.set(desired.rpcProxyEgress.metadata!.name!, desired.rpcProxyEgress)
    }

    const existingPolicies =
      listedPolicies?.context ?? (await this.listPoliciesForContext(contextId))
    if (!isCurrent()) return false
    for (const existing of existingPolicies) {
      if (!isCurrent()) return false
      const existingName = existing.metadata?.name || ''
      const desired = desiredIngress.get(existingName)
      if (!desired) {
        console.log(`[NetPol] Deleting orphaned policy "${existingName}"`)
        if (safetySnapshotProvided) {
          if (
            !(await this.deleteSafetyPolicySnapshot(
              config.namespace,
              existing,
              isCurrent,
              undefined,
              'report'
            ))
          ) {
            return false
          }
        } else if (
          !(await this.deleteSafetyPolicySnapshot(
            config.namespace,
            existing,
            isCurrent,
            undefined,
            'report'
          ))
        ) {
          lostDeleteFence = true
        }
        onRevoked?.()
      } else if (
        !sameNetworkPolicySpec(existing, desired) ||
        !hasExpectedPolicyOwnership(existing, 'context-allow')
      ) {
        console.log(`[NetPol] Replacing stale same-name policy "${existingName}"`)
        if (safetySnapshotProvided) {
          if (
            !(await this.replaceSafetyPolicySnapshot(
              config.namespace,
              existing,
              desired,
              'context-ingress',
              isCurrent
            ))
          ) {
            return false
          }
        } else {
          await this.replaceSafetyPolicySnapshot(
            config.namespace,
            existing,
            desired,
            'context-ingress',
            isCurrent
          )
        }
        onRevoked?.()
      }
    }

    const existingEgressPolicies =
      listedPolicies?.hostEgress ?? (await this.listEgressPoliciesForContext(contextId))
    if (!isCurrent()) return false
    for (const existing of existingEgressPolicies) {
      if (!isCurrent()) return false
      const existingName = existing.metadata?.name || ''
      const desired = desiredHostEgress.get(existingName)
      if (!desired) {
        console.log(`[NetPol] Deleting orphaned L2 egress policy "${existingName}"`)
        if (safetySnapshotProvided) {
          if (
            !(await this.deleteSafetyPolicySnapshot(
              config.hostNamespace,
              existing,
              isCurrent,
              undefined,
              'report'
            ))
          ) {
            return false
          }
        } else if (
          !(await this.deleteSafetyPolicySnapshot(
            config.hostNamespace,
            existing,
            isCurrent,
            undefined,
            'report'
          ))
        ) {
          lostDeleteFence = true
        }
        onRevoked?.()
      } else if (
        !sameNetworkPolicySpec(existing, desired) ||
        !hasExpectedPolicyOwnership(existing, 'context-allow')
      ) {
        console.log(`[NetPol] Replacing stale same-name L2 egress policy "${existingName}"`)
        if (safetySnapshotProvided) {
          if (
            !(await this.replaceSafetyPolicySnapshot(
              config.hostNamespace,
              existing,
              desired,
              'context-host-egress',
              isCurrent
            ))
          ) {
            return false
          }
        } else {
          await this.replaceSafetyPolicySnapshot(
            config.hostNamespace,
            existing,
            desired,
            'context-host-egress',
            isCurrent
          )
        }
        onRevoked?.()
      }
    }

    const existingRpcProxyPolicies =
      listedPolicies?.rpcProxyEgress ?? (await this.listRpcProxyEgressPoliciesForContext(contextId))
    if (!isCurrent()) return false
    for (const existing of existingRpcProxyPolicies) {
      if (!isCurrent()) return false
      const existingName = existing.metadata?.name || ''
      const desired = desiredRpcProxyEgress.get(existingName)
      if (!desired) {
        console.log(`[NetPol] Deleting orphaned rpc-proxy egress policy "${existingName}"`)
        if (safetySnapshotProvided) {
          if (
            !(await this.deleteSafetyPolicySnapshot(
              config.rpcProxyNamespace,
              existing,
              isCurrent,
              undefined,
              'report'
            ))
          ) {
            return false
          }
        } else if (
          !(await this.deleteSafetyPolicySnapshot(
            config.rpcProxyNamespace,
            existing,
            isCurrent,
            undefined,
            'report'
          ))
        ) {
          lostDeleteFence = true
        }
        onRevoked?.()
      } else if (
        !sameNetworkPolicySpec(existing, desired) ||
        !hasExpectedPolicyOwnership(existing, RPC_PROXY_EGRESS_POLICY_TYPE)
      ) {
        console.log(`[NetPol] Replacing stale same-name rpc-proxy egress policy "${existingName}"`)
        if (safetySnapshotProvided) {
          if (
            !(await this.replaceSafetyPolicySnapshot(
              config.rpcProxyNamespace,
              existing,
              desired,
              'context-rpc-egress',
              isCurrent
            ))
          ) {
            return false
          }
        } else {
          await this.replaceSafetyPolicySnapshot(
            config.rpcProxyNamespace,
            existing,
            desired,
            'context-rpc-egress',
            isCurrent
          )
        }
        onRevoked?.()
      }
    }

    return isCurrent() && !lostDeleteFence
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
      if (deleteAllowed && !(await deleteAllowed())) return
      await this.deleteSafetyPolicySnapshot(config.namespace, policy)
    }

    // Also delete L2 egress counterparts in mcp-host namespace
    const egressPolicies = await this.listEgressPoliciesForContext(contextId)
    for (const policy of egressPolicies) {
      if (deleteAllowed && !(await deleteAllowed())) return
      await this.deleteSafetyPolicySnapshot(config.hostNamespace, policy)
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
    const onAuthoritativeRevocationComplete = options.onAuthoritativeRevocationComplete
    if (!onAuthoritativeRevocationComplete) {
      await this.fullReconcileInternal(contexts, servers, options)
      return
    }

    const safetyPassStartedAt = performance.now()
    let safetyPassDurationRecorded = false
    const recordSafetyPassDuration = (outcome: 'completed' | 'failed'): void => {
      if (safetyPassDurationRecorded) return
      safetyPassDurationRecorded = true
      // First outcome wins for both the sample and the delta fence: a pass that
      // certified and only then failed an additive effect still revoked every
      // stale allow its inventory implied.
      this.safetyPassLeftUncertified = outcome === 'failed'
      networkPolicySafetyPassDurationSeconds.observe(
        { outcome },
        (performance.now() - safetyPassStartedAt) / 1_000
      )
    }

    try {
      await this.fullReconcileInternal(contexts, servers, {
        ...options,
        onAuthoritativeRevocationComplete: () => {
          onAuthoritativeRevocationComplete()
          recordSafetyPassDuration('completed')
        },
      })
      // The pass returned without certifying: no exception, no certificate.
      // Operators alert on this exact condition, so it must produce a sample
      // rather than the absence of one.
      recordSafetyPassDuration('failed')
    } catch (error) {
      recordSafetyPassDuration('failed')
      throw error
    }
  }

  private async fullReconcileInternal(
    contexts: ContextCRD[],
    servers: McpServerCRD[] = [],
    options: NetworkPolicyFullReconcileOptions = {}
  ): Promise<void> {
    console.log(`[NetPol] Running full reconciliation for ${contexts.length} Context(s)`)

    // This is intentionally scoped to callers that use the authoritative
    // revocation callback. Ordinary additive reconciles must not be presented
    // as readiness safety passes.
    const measureSafetyPass = options.onAuthoritativeRevocationComplete !== undefined
    let safetyPassListedPolicies = 0
    let safetyPassRevokedPolicies = 0
    const recordSafetyPassRevocation = (): void => {
      if (measureSafetyPass) safetyPassRevokedPolicies += 1
    }

    // The revision fence starts at invocation, before any asynchronous
    // default-policy setup can interleave a watch update with this snapshot.
    const selectedContextDesiredRevision = options.contextDesiredRevision?.()
    const selectedServerDesiredRevision = options.serverDesiredRevision?.()
    const runContextEffect =
      options.runContextEffect ?? ((_contextId: string, work: () => Promise<void>) => work())
    const runServerEffect =
      options.runServerEffect ?? ((_serverName: string, work: () => Promise<void>) => work())
    const contextInventoryIsCurrent = (): boolean =>
      (options.contextInventoryAuthoritative?.() ?? true) &&
      (options.serverInventoryAuthoritative?.() ?? true)

    if (options.ensureDefaults !== false) {
      await this.ensureDefaultPolicies()
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

    const desiredContextIds = new Set(contexts.map(c => c.spec.contextId))
    const cleanupOrphanedContextPolicies = async (
      policies: k8s.V1NetworkPolicy[],
      deletePolicy: (policy: k8s.V1NetworkPolicy) => Promise<boolean>,
      describePolicy: (name: string, contextId: string) => string
    ): Promise<void> => {
      if (!contextCleanupAuthoritative()) return
      for (const policy of policies) {
        const contextId = policy.metadata?.labels?.[CONTEXT_LABEL]
        if (!contextId) {
          if (!contextCleanupAuthoritative()) return
          const name = policy.metadata?.name
          if (!name) {
            throw new Error('HCC-managed Context NetworkPolicy is missing its name and owner label')
          }
          console.warn(
            `[NetPol] Deleting malformed HCC-managed policy "${name}" without ${CONTEXT_LABEL}`
          )
          if (await deletePolicy(policy)) recordSafetyPassRevocation()
          continue
        }
        if (!desiredContextIds.has(contextId)) {
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
            if (await deletePolicy(policy)) recordSafetyPassRevocation()
          })
        }
      }
    }

    let allContextPolicies = contextCleanupAuthoritative()
      ? await this.listAllContextPolicies()
      : []
    let allContextEgressPolicies = contextCleanupAuthoritative()
      ? await this.listAllContextEgressPolicies()
      : []
    let allRpcProxyEgressPolicies = contextCleanupAuthoritative()
      ? await this.listAllRpcProxyEgressPolicies()
      : []
    let allExternalPolicies: k8s.V1NetworkPolicy[] = []
    if (options.serverInventoryComplete !== false && serverCleanupAuthoritative()) {
      allExternalPolicies = await this.listAllExternalEgressPolicies()
    }

    // Label selectors alone cannot prove safety: removing either ownership
    // marker would hide an active allow from the selected LIST. Audit the
    // bounded namespaces, then merge only owned or conservatively repairable
    // candidates into their lane. Ambiguous reserved names fail the pass.
    const needsMcpServerBroadInventory =
      contextCleanupAuthoritative() ||
      (options.serverInventoryComplete !== false && serverCleanupAuthoritative())
    const broadMcpServerPolicies = needsMcpServerBroadInventory
      ? await this.listNamespacePoliciesForSafety(config.namespace)
      : []
    const broadHostPolicies = contextCleanupAuthoritative()
      ? await this.listNamespacePoliciesForSafety(config.hostNamespace)
      : []
    const broadRpcProxyPolicies = contextCleanupAuthoritative()
      ? await this.listNamespacePoliciesForSafety(config.rpcProxyNamespace)
      : []

    if (contextCleanupAuthoritative()) {
      allContextPolicies = this.mergeSafetyLaneInventory(
        allContextPolicies,
        broadMcpServerPolicies,
        'context-ingress'
      )
      allContextEgressPolicies = this.mergeSafetyLaneInventory(
        allContextEgressPolicies,
        broadHostPolicies,
        'context-host-egress'
      )
      allRpcProxyEgressPolicies = this.mergeSafetyLaneInventory(
        allRpcProxyEgressPolicies,
        broadRpcProxyPolicies,
        'context-rpc-egress'
      )
    }
    if (options.serverInventoryComplete !== false && serverCleanupAuthoritative()) {
      allExternalPolicies = this.mergeSafetyLaneInventory(
        allExternalPolicies,
        broadMcpServerPolicies,
        'external-egress'
      )
    }
    safetyPassListedPolicies +=
      allContextPolicies.length +
      allContextEgressPolicies.length +
      allRpcProxyEgressPolicies.length +
      allExternalPolicies.length

    // Delete orphaned Context policies across every L2 lane. Each lane uses
    // the canonical contextId effect key and rechecks authority plus live CRD
    // presence immediately before its delete.
    await cleanupOrphanedContextPolicies(
      allContextPolicies,
      policy =>
        this.deleteSafetyPolicySnapshot(config.namespace, policy, contextCleanupAuthoritative),
      (name, contextId) =>
        `[NetPol] Deleting orphaned policy "${name}" (context "${contextId}" no longer exists)`
    )
    await cleanupOrphanedContextPolicies(
      allContextEgressPolicies,
      policy =>
        this.deleteSafetyPolicySnapshot(config.hostNamespace, policy, contextCleanupAuthoritative),
      name => `[NetPol] Deleting orphaned L2 egress policy "${name}"`
    )
    await cleanupOrphanedContextPolicies(
      allRpcProxyEgressPolicies,
      policy =>
        this.deleteSafetyPolicySnapshot(
          config.rpcProxyNamespace,
          policy,
          contextCleanupAuthoritative
        ),
      name => `[NetPol] Deleting orphaned rpc-proxy egress policy "${name}"`
    )

    let liveDesiredRevisionChanged = false
    for (const context of contexts) {
      const contextId = context.spec.contextId
      await runContextEffect(contextId, async () => {
        const current = options.resolveCurrentContext
          ? options.resolveCurrentContext(context.name)
          : context
        if (!current || current.spec.contextId !== contextId) {
          liveDesiredRevisionChanged = true
          return
        }
        const contextEffectIsCurrent = (): boolean => {
          if (!contextCleanupAuthoritative() || !serverCleanupAuthoritative()) return false
          if (!options.resolveCurrentContext) return true
          const latest = options.resolveCurrentContext(current.name)
          return latest !== undefined && sameContextDesiredRevision(current, latest)
        }
        const forContext = (policy: k8s.V1NetworkPolicy): boolean =>
          policy.metadata?.labels?.[CONTEXT_LABEL] === contextId
        const completed = await this.revokeStaleContextAllows(
          current,
          contextEffectIsCurrent,
          {
            context: allContextPolicies.filter(forContext),
            hostEgress: allContextEgressPolicies.filter(forContext),
            rpcProxyEgress: allRpcProxyEgressPolicies.filter(forContext),
          },
          recordSafetyPassRevocation
        )
        if (!completed && contextCleanupAuthoritative() && serverCleanupAuthoritative()) {
          liveDesiredRevisionChanged = true
        }
      })
    }

    // Clean up external egress policies for servers that no longer exist.
    if (options.serverInventoryComplete !== false && serverCleanupAuthoritative()) {
      const desiredServerNames = new Set(servers.map(s => s.name))
      for (const policy of allExternalPolicies) {
        const serverName = policy.metadata?.labels?.[MCPSERVER_LABEL]
        if (!serverName) {
          if (!serverCleanupAuthoritative()) break
          const name = policy.metadata?.name
          if (!name) {
            throw new Error(
              'HCC-managed external egress NetworkPolicy is missing its name and owner label'
            )
          }
          console.warn(
            `[NetPol] Deleting malformed HCC-managed policy "${name}" without ${MCPSERVER_LABEL}`
          )
          if (
            await this.deleteSafetyPolicySnapshot(
              config.namespace,
              policy,
              serverCleanupAuthoritative
            )
          ) {
            recordSafetyPassRevocation()
          }
          continue
        }
        if (!desiredServerNames.has(serverName)) {
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
            if (
              await this.deleteSafetyPolicySnapshot(
                config.namespace,
                policy,
                serverCleanupAuthoritative
              )
            ) {
              recordSafetyPassRevocation()
            }
          })
        }
      }
    } else if (options.serverInventoryComplete === false) {
      console.warn(
        '[NetPol] Skipping external egress orphan cleanup because server inventory is incomplete'
      )
    }

    if (options.serverInventoryComplete !== false) {
      for (const server of servers) {
        await runServerEffect(server.name, async () => {
          const current = options.resolveCurrentServer
            ? options.resolveCurrentServer(server.name)
            : server
          if (!current) {
            liveDesiredRevisionChanged = true
            return
          }
          const serverEffectIsCurrent = (): boolean => {
            if (!serverCleanupAuthoritative()) return false
            if (!options.resolveCurrentServer) return true
            const latest = options.resolveCurrentServer(current.name)
            return latest !== undefined && sameMcpServerDesiredRevision(current, latest)
          }
          const completed = await this.reconcileExternalEgressSafety(
            current,
            allExternalPolicies.filter(
              policy => policy.metadata?.labels?.[MCPSERVER_LABEL] === server.name
            ),
            serverEffectIsCurrent,
            recordSafetyPassRevocation
          )
          if (!completed && serverCleanupAuthoritative()) {
            liveDesiredRevisionChanged = true
          }
        })
      }
    }

    const inventoryDesiredRevisionChanged =
      (selectedContextDesiredRevision !== undefined &&
        options.contextDesiredRevision?.() !== selectedContextDesiredRevision) ||
      (selectedServerDesiredRevision !== undefined &&
        options.serverDesiredRevision?.() !== selectedServerDesiredRevision)
    if (
      (liveDesiredRevisionChanged || inventoryDesiredRevisionChanged) &&
      contextCleanupAuthoritative() &&
      serverCleanupAuthoritative()
    ) {
      throw new Error('Desired NetworkPolicy inventory changed during authoritative revocation')
    }

    if (
      options.serverInventoryComplete !== false &&
      contextCleanupAuthoritative() &&
      serverCleanupAuthoritative()
    ) {
      if (measureSafetyPass) {
        networkPolicySafetyPassPoliciesTotal.inc({ operation: 'listed' }, safetyPassListedPolicies)
        networkPolicySafetyPassPoliciesTotal.inc(
          { operation: 'revoked' },
          safetyPassRevokedPolicies
        )
      }
      options.onAuthoritativeRevocationComplete?.()
    }

    // Additive Context convergence happens only after every stale allow policy
    // implied by the authoritative inventory has been revoked. A slow or
    // failing positive effect therefore cannot extend a stale-permission
    // window after readiness becomes available. External egress creation and
    // DNS refresh intentionally do not run here:
    // ExternalEgressConvergenceCoordinator is their sole startup, retry, and
    // periodic-resync owner.
    const contextAdditiveFailures: unknown[] = []
    for (const context of contexts) {
      const contextId = context.spec.contextId
      try {
        await runContextEffect(contextId, async () => {
          const current = options.resolveCurrentContext
            ? options.resolveCurrentContext(context.name)
            : context
          if (!current || current.spec.contextId !== contextId) return
          const contextEffectIsCurrent = (): boolean => {
            if (!contextInventoryIsCurrent()) return false
            if (!options.resolveCurrentContext) return true
            const latest = options.resolveCurrentContext(current.name)
            return latest !== undefined && sameContextDesiredRevision(current, latest)
          }
          await this.reconcileContext(current, { isCurrent: contextEffectIsCurrent })
        })
      } catch (error) {
        contextAdditiveFailures.push(error)
        console.error(`[NetPol] Additive Context reconciliation failed for "${contextId}":`, error)
      }
    }

    if (contextAdditiveFailures.length > 0) {
      throw new AggregateError(
        contextAdditiveFailures,
        'One or more additive Context NetworkPolicy reconciliations failed'
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

  private buildPublicWebEgressPolicy(server: McpServerCRD, name: string): k8s.V1NetworkPolicy {
    return {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name,
        namespace: server.namespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [POLICY_TYPE_LABEL]: EXTERNAL_EGRESS_POLICY_TYPE,
          [MCPSERVER_LABEL]: server.name,
          [EGRESS_CLASS_LABEL]: 'public-web',
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
  }

  private buildExactHostEgressPolicy(
    server: McpServerCRD,
    name: string,
    binding: EgressBinding,
    cidrs: string[]
  ): k8s.V1NetworkPolicy {
    return {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name,
        namespace: server.namespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [POLICY_TYPE_LABEL]: EXTERNAL_EGRESS_POLICY_TYPE,
          [MCPSERVER_LABEL]: server.name,
          [EGRESS_CLASS_LABEL]: 'exact-host',
        },
      },
      spec: {
        podSelector: {
          matchLabels: { [MCPSERVER_LABEL]: server.name },
        },
        policyTypes: ['Egress'],
        egress: cidrs.map(cidr => ({
          to: [{ ipBlock: { cidr } }],
          ports: [{ port: binding.port!, protocol: binding.protocol ?? 'TCP' }],
        })),
      },
    }
  }

  private async resolveExternalEgressDns(hostname: string): Promise<string[]> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        dns.resolve4(hostname),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error(
                  `DNS resolution timed out after ${config.externalEgressDnsResolveTimeoutMs}ms`
                )
              ),
            config.externalEgressDnsResolveTimeoutMs
          )
        }),
      ])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  private async reconcileExternalEgressSafety(
    server: McpServerCRD,
    existingPolicies: k8s.V1NetworkPolicy[],
    isCurrent: () => boolean,
    onRevoked?: () => void
  ): Promise<boolean> {
    if (!isCurrent()) return false
    const desired = new Map<string, { binding: EgressBinding; policy?: k8s.V1NetworkPolicy }>()
    for (const binding of server.spec.egressBindings ?? []) {
      const name = this.externalEgressPolicyName(server.name, binding)
      if (!name) continue
      const egressClass = binding.egressClass ?? 'exact-host'
      if (
        egressClass === 'public-web' &&
        !binding.dns &&
        !binding.cidr &&
        binding.port === undefined &&
        binding.protocol === undefined
      ) {
        desired.set(name, { binding, policy: this.buildPublicWebEgressPolicy(server, name) })
      } else if (
        egressClass === 'exact-host' &&
        binding.cidr &&
        isAllowedExternalEgressCidr(binding.cidr) &&
        binding.port !== undefined &&
        Number.isInteger(binding.port) &&
        binding.port >= 1 &&
        binding.port <= 65535
      ) {
        desired.set(name, {
          binding,
          policy: this.buildExactHostEgressPolicy(server, name, binding, [binding.cidr]),
        })
      } else if (
        egressClass === 'exact-host' &&
        binding.dns &&
        isPublicDnsHostname(binding.dns) &&
        binding.port !== undefined &&
        Number.isInteger(binding.port) &&
        binding.port >= 1 &&
        binding.port <= 65535
      ) {
        desired.set(name, { binding })
      }
    }

    const stale: k8s.V1NetworkPolicy[] = []
    const unprovableDnsPolicies: k8s.V1NetworkPolicy[] = []
    const deterministicReplacements: Array<{
      snapshot: k8s.V1NetworkPolicy
      desired: k8s.V1NetworkPolicy
    }> = []
    for (const existing of existingPolicies) {
      const name = existing.metadata?.name
      const selected = name ? desired.get(name) : undefined
      if (!selected) {
        stale.push(existing)
        continue
      }
      desired.delete(name!)
      if (!selected.policy) {
        unprovableDnsPolicies.push(existing)
        continue
      }
      const retainable =
        sameNetworkPolicySpec(existing, selected.policy) &&
        hasExpectedPolicyOwnership(existing, EXTERNAL_EGRESS_POLICY_TYPE)
      if (!retainable) {
        deterministicReplacements.push({ snapshot: existing, desired: selected.policy })
      }
    }

    // Preserve traffic only with deterministic CIDR/public-web policies. A
    // renamed deterministic binding is created before its stale predecessor is
    // removed; a same-name conflict is converged only under the ownership
    // guard, which still refuses to adopt a foreign live object.
    if (stale.length > 0) {
      for (const selected of desired.values()) {
        if (!selected.policy) continue
        if (
          !(await this.createSafetyPolicy(
            server.namespace,
            selected.policy,
            'external-egress',
            isCurrent
          ))
        ) {
          return false
        }
      }
    }
    for (const replacement of deterministicReplacements) {
      if (
        !(await this.replaceSafetyPolicySnapshot(
          server.namespace,
          replacement.snapshot,
          replacement.desired,
          'external-egress',
          isCurrent
        ))
      ) {
        return false
      }
      onRevoked?.()
    }

    // DNS-derived /32s are unprovable without a fresh lookup. Revoke them
    // immediately; replacement belongs to the additive lane and must not put
    // external DNS latency back on the global readiness path.
    await this.cleanupExternalEgress(
      server.name,
      server.namespace,
      unprovableDnsPolicies,
      async () => isCurrent(),
      onRevoked
    )
    if (!isCurrent()) return false

    await this.cleanupExternalEgress(
      server.name,
      server.namespace,
      stale,
      async () => isCurrent(),
      onRevoked
    )
    return isCurrent()
  }

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
    let existingPolicies = options.existingPolicies
    if (!existingPolicies) {
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
    const resolvedAtMs = Date.now()
    const resolvedAt = new Date(resolvedAtMs).toISOString()

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
        await this.applyOwnedPolicy(
          name,
          server.namespace,
          this.buildPublicWebEgressPolicy(server, name),
          'external-egress',
          isCurrent
        )
        continue
      }

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
          const ips = await this.resolveExternalEgressDns(binding.dns)
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
      const desiredPolicy = this.buildExactHostEgressPolicy(server, name, binding, cidrs)
      await this.applyOwnedPolicy(
        name,
        server.namespace,
        desiredPolicy,
        'external-egress',
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
        async () => isCurrent(),
        options.onRevoked
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
    deleteAllowed?: () => Promise<boolean>,
    onDeleted?: () => void
  ): Promise<void> {
    const policiesToDelete =
      policies ?? (await this.listExternalEgressPoliciesForServer(serverName, namespace))

    for (const policy of policiesToDelete) {
      const name = policy.metadata?.name
      if (!name) continue
      try {
        if (deleteAllowed && !(await deleteAllowed())) return
        await this.deleteSafetyPolicySnapshot(namespace, policy, undefined, () => {
          console.log(`[NetPol] Deleted external egress policy "${name}"`)
          onDeleted?.()
        })
      } catch (error: unknown) {
        if (getErrorCode(error) !== 404) {
          console.error(`[NetPol] Failed to delete external egress policy "${name}":`, error)
          throw error
        }
        // A concurrent actor may already have removed the policy. The safety
        // invariant still holds, but this pass did not revoke it and must not
        // inflate the authoritative safety-pass `revoked` counter.
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

  /** Broad, namespace-bounded inventory used only by the safety pass. */
  private async listNamespacePoliciesForSafety(namespace: string): Promise<k8s.V1NetworkPolicy[]> {
    try {
      const response = await this.networkingApi.listNamespacedNetworkPolicy({ namespace })
      return response.items || []
    } catch (error) {
      console.error(`[NetPol] Failed to list broad NetworkPolicy inventory in ${namespace}:`, error)
      throw error
    }
  }

  private mergeSafetyLaneInventory(
    selected: k8s.V1NetworkPolicy[],
    broad: k8s.V1NetworkPolicy[],
    lane: SafetyInventoryLane
  ): k8s.V1NetworkPolicy[] {
    const result = new Map<string, k8s.V1NetworkPolicy>()
    const keyFor = (policy: k8s.V1NetworkPolicy, index: number): string =>
      policy.metadata?.uid ?? policy.metadata?.name ?? `unnamed-${index}`

    selected.forEach((policy, index) => result.set(keyFor(policy, index), policy))
    broad.forEach((policy, index) => {
      const classification = classifySafetyInventoryPolicy(policy, lane)
      if (classification === 'ambiguous') {
        const name = policy.metadata?.name ?? '<unnamed>'
        throw new Error(
          `Ambiguous NetworkPolicy ownership for reserved HCC ${lane} policy "${name}"`
        )
      }
      if (classification === 'owned' || classification === 'repairable') {
        result.set(keyFor(policy, selected.length + index), policy)
      } else {
        // The broad LIST is later and authoritative for this object identity.
        // Do not retain a selector snapshot after the same object was relabelled
        // out of HCC ownership.
        result.delete(keyFor(policy, selected.length + index))
      }
    })
    return [...result.values()]
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
  private async applyFixedPolicy(
    name: string,
    namespace: string,
    policy: k8s.V1NetworkPolicy,
    policyType: string
  ): Promise<void> {
    await applyNetworkPolicy(
      this.networkingApi,
      name,
      namespace,
      policy,
      '[NetPol]',
      undefined,
      existing => {
        if (!hasExpectedPolicyOwnership(existing, policyType)) {
          throw new Error(
            `NetworkPolicy "${name}" has conflicting ownership for the ${policyType} lane`
          )
        }
      }
    )
  }

  /** Create or update a Context ingress NetworkPolicy. */
  private async applyContextIngressPolicy(
    name: string,
    policy: k8s.V1NetworkPolicy,
    isCurrent?: () => boolean
  ): Promise<void> {
    await this.applyOwnedPolicy(name, config.namespace, policy, 'context-ingress', isCurrent)
  }

  private async applyOwnedPolicy(
    name: string,
    namespace: string,
    policy: k8s.V1NetworkPolicy,
    lane: SafetyInventoryLane,
    isCurrent?: () => boolean
  ): Promise<void> {
    await applyNetworkPolicy(
      this.networkingApi,
      name,
      namespace,
      policy,
      '[NetPol]',
      isCurrent,
      existing => this.assertPolicyOwnership(name, existing, policy, lane)
    )
  }

  private assertPolicyOwnership(
    name: string,
    existing: k8s.V1NetworkPolicy,
    desired: k8s.V1NetworkPolicy,
    lane: SafetyInventoryLane
  ): void {
    const classification = classifySafetyInventoryPolicy(existing, lane)
    const existingLabels = existing.metadata?.labels ?? {}
    const desiredLabels = desired.metadata?.labels ?? {}
    const ownerLabels =
      lane === 'external-egress' ? [MCPSERVER_LABEL] : [CONTEXT_LABEL, MCPSERVER_LABEL]
    if (
      (classification !== 'owned' && classification !== 'repairable') ||
      ownerLabels.some(label => existingLabels[label] !== desiredLabels[label])
    ) {
      throw new Error(`NetworkPolicy "${name}" has conflicting ownership for the ${lane} lane`)
    }
  }

  private safetyPolicyIdentity(policy: k8s.V1NetworkPolicy): {
    name: string
    uid: string
    resourceVersion: string
  } {
    const name = policy.metadata?.name
    const uid = policy.metadata?.uid
    const resourceVersion = policy.metadata?.resourceVersion
    if (!name || !uid || !resourceVersion) {
      throw new Error(
        `NetworkPolicy safety mutation requires name, uid, and resourceVersion for "${name ?? '<unnamed>'}"`
      )
    }
    return { name, uid, resourceVersion }
  }

  /**
   * Delete exactly the policy version classified by the authoritative safety
   * inventory. Kubernetes rejects the preconditions if the name was recreated
   * or changed after LIST, so HCC cannot delete a new or foreign object.
   */
  private async deleteSafetyPolicySnapshot(
    namespace: string,
    policy: k8s.V1NetworkPolicy,
    isCurrent?: () => boolean,
    onDeleted?: () => void,
    lostFenceOutcome: 'throw' | 'report' = 'throw'
  ): Promise<boolean> {
    if (isCurrent && !isCurrent()) return false
    const { name, uid, resourceVersion } = this.safetyPolicyIdentity(policy)
    try {
      await this.networkingApi.deleteNamespacedNetworkPolicy({
        name,
        namespace,
        body: { preconditions: { uid, resourceVersion } },
      })
      console.log(`[NetPol] Deleted safety-inventory policy "${name}" in ${namespace}`)
      onDeleted?.()
      return true
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) {
        console.log(`[NetPol] Safety-inventory policy "${name}" already gone`)
        return true
      }
      if (getErrorCode(error) === 409 && lostFenceOutcome === 'report') {
        // Kubernetes rejected the uid/resourceVersion preconditions, so the
        // object live under this name is not the one the authoritative
        // inventory classified. Nothing was revoked, and nothing may be
        // adopted. Callers that opt in act on this outcome by declining to
        // certify, which is the expected racy result rather than a failure.
        // Callers that cannot act on it keep the loud default.
        console.warn(
          `[NetPol] Lost the delete fence on safety-inventory policy "${name}" in ${namespace}; it changed identity after the authoritative inventory and was not revoked`
        )
        return false
      }
      console.error(
        `[NetPol] Failed identity-bound delete of safety-inventory policy "${name}" in ${namespace}:`,
        error
      )
      throw error
    }
  }

  /**
   * Replace only the exact live object classified by the safety inventory.
   * The fresh read closes ownership drift before mutation; resourceVersion on
   * the replace body closes the remaining read-to-write race.
   */
  private async replaceSafetyPolicySnapshot(
    namespace: string,
    snapshot: k8s.V1NetworkPolicy,
    desired: k8s.V1NetworkPolicy,
    lane: SafetyInventoryLane,
    isCurrent: () => boolean
  ): Promise<boolean> {
    if (!isCurrent()) return false
    const expected = this.safetyPolicyIdentity(snapshot)
    const live = await this.networkingApi.readNamespacedNetworkPolicy({
      name: expected.name,
      namespace,
    })
    if (!isCurrent()) return false
    const actual = this.safetyPolicyIdentity(live)
    if (actual.uid !== expected.uid || actual.resourceVersion !== expected.resourceVersion) {
      throw new Error(
        `NetworkPolicy "${expected.name}" changed identity or ownership after the authoritative safety inventory`
      )
    }
    this.assertPolicyOwnership(expected.name, live, desired, lane)
    await this.networkingApi.replaceNamespacedNetworkPolicy({
      name: expected.name,
      namespace,
      body: {
        ...desired,
        metadata: {
          ...desired.metadata,
          name: expected.name,
          namespace,
          resourceVersion: actual.resourceVersion,
        },
      },
    })
    return isCurrent()
  }

  private async createSafetyPolicy(
    namespace: string,
    desired: k8s.V1NetworkPolicy,
    lane: SafetyInventoryLane,
    isCurrent: () => boolean
  ): Promise<boolean> {
    if (!isCurrent()) return false
    let created: k8s.V1NetworkPolicy
    try {
      created = await this.networkingApi.createNamespacedNetworkPolicy({
        namespace,
        body: desired,
      })
    } catch (error: unknown) {
      if (getErrorCode(error) !== 409) throw error
      // This is the only creation route that does not go through
      // applyNetworkPolicy, so a same-name object used to abort the whole
      // safety pass and hold readiness down. Converge it exactly like every
      // other lane does: adopt it only under the ownership guard, which still
      // refuses a foreign or ambiguous object.
      const name = desired.metadata?.name
      if (!name) {
        throw new Error(`Cannot converge a conflicting ${lane} policy without a desired name`)
      }
      console.log(
        `[NetPol] Safety policy "${name}" in ${namespace} already exists — converging it to the desired spec`
      )
      await replaceWithConflictRetry<k8s.V1NetworkPolicy>({
        description: `policy "${name}" in ${namespace}`,
        logPrefix: '[NetPol]',
        body: desired,
        read: () => this.networkingApi.readNamespacedNetworkPolicy({ name, namespace }),
        replace: body =>
          this.networkingApi.replaceNamespacedNetworkPolicy({ name, namespace, body }),
        mutationAllowed: isCurrent,
        validateExisting: existing => this.assertPolicyOwnership(name, existing, desired, lane),
      })
      return isCurrent()
    }
    if (isCurrent()) return true

    // The mutation crossed its desired-state fence. Remove exactly the object
    // this request created, even though the old reconciliation is no longer
    // authoritative. The UID/resourceVersion preconditions ensure a
    // replacement or foreign policy with the same name is never deleted.
    await this.deleteSafetyPolicySnapshot(namespace, created)
    return false
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

  // ─── RPC-Proxy Egress (L2) ──────────────────────────────────────────

  private buildRpcProxyEgressPolicy(
    contextId: string,
    serverName: string,
    port: number
  ): k8s.V1NetworkPolicy {
    const name = `rpc-egress-${contextId}-${serverName}`
    return {
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
  }

  /** Delete all rpc-proxy egress policies for a given context. */
  private async deleteRpcProxyPoliciesForContext(
    contextId: string,
    deleteAllowed?: () => Promise<boolean>
  ): Promise<void> {
    try {
      const policies = await this.listRpcProxyEgressPoliciesForContext(contextId)
      for (const policy of policies) {
        if (deleteAllowed && !(await deleteAllowed())) return
        await this.deleteSafetyPolicySnapshot(config.rpcProxyNamespace, policy)
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

  /** Delete a formerly static NetworkPolicy that is now generated dynamically. */
  private async deleteLegacyStaticPolicy(namespace: string, name: string): Promise<void> {
    let existing: k8s.V1NetworkPolicy
    try {
      existing = await this.networkingApi.readNamespacedNetworkPolicy({ name, namespace })
    } catch (error: unknown) {
      if (getErrorCode(error) === 404) return
      throw error
    }
    if (existing.metadata?.labels?.[MANAGED_BY_LABEL] !== MANAGED_BY_VALUE) {
      throw new Error(`NetworkPolicy "${name}" has conflicting ownership for legacy cleanup`)
    }
    await this.deleteSafetyPolicySnapshot(namespace, existing)
    console.log(`[NetPol] Deleted legacy static policy "${name}" in "${namespace}"`)
  }
}
