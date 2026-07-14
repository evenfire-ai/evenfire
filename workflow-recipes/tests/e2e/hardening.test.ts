/**
 * E8.1–E8.10: Phase 8 Hardening E2E tests — NetworkPolicy layered model.
 *
 * Validates the full L0→L3 NetworkPolicy stack in a live minikube cluster:
 * - L0: deny-all Ingress+Egress in all runtime namespaces
 * - L1: HCC-managed infrastructure egress in mcp-server, sandbox-recipes, rpc-proxy
 * - L1: static first-party mcp-host egress for HCC API, approval gateway, DNS, public HTTP(S)
 * - L2: context-allow bidirectional (ingress in mcp-server + egress in mcp-host)
 * - L3: binding-scoped policies created via HCC watch on McpServer annotations
 * - L3-egress: external egress policies for McpServer egressBindings
 *
 * Prerequisites:
 *   - Run scripts/minikube-setup.sh before these tests
 *   - Both WRC and HCC deployed in minikube (clerum-test profile)
 *   - These tests run AFTER bootstrap.test.ts (sequential mode)
 */
import { describe, expect, it } from 'vitest'
import {
  MCP_SERVER_NAMESPACE,
  RECIPE_NAMESPACE,
  SANDBOX_NAMESPACE,
  kubectl,
  kubectlJson,
  waitForResource,
} from './helpers'

const RUNTIME_NAMESPACES = ['mcp-server', 'mcp-host', 'sandbox-recipes', 'rpc-proxy']
const HCC_MANAGED_INFRA_NAMESPACES = ['mcp-server', 'sandbox-recipes', 'rpc-proxy']
const REDIS_RECIPE_NAME = 'mcp-redis-cache'
const REDIS_MCP_WORKLOAD_ID = 'redis-mcp'
const REDIS_WORKLOAD_ID = 'redis'
const REDIS_MCP_SERVER_NAME = `${REDIS_RECIPE_NAME}-${REDIS_MCP_WORKLOAD_ID}`
const REDIS_CONTEXT_REF = 'context1'
const REDIS_RECIPE_CONTEXT_NAME = `wf-${REDIS_RECIPE_NAME}`
const REDIS_CONTEXT_ALLOW_POLICY = `ctx-${REDIS_RECIPE_CONTEXT_NAME}-${REDIS_MCP_SERVER_NAME}`
const REDIS_CONTEXT_EGRESS_POLICY = `${REDIS_CONTEXT_ALLOW_POLICY}-egress`
const REDIS_BINDING_EGRESS_POLICY = `bind-${REDIS_RECIPE_NAME}-${REDIS_MCP_WORKLOAD_ID}-${REDIS_WORKLOAD_ID}-egress`
const REDIS_BINDING_INGRESS_POLICY = `bind-${REDIS_RECIPE_NAME}-${REDIS_MCP_WORKLOAD_ID}-${REDIS_WORKLOAD_ID}-ingress`
const EGRESS_RECIPE_NAME = 'e2e-hardening-egress-binding'
const EGRESS_WORKLOAD_ID = 'api-mcp'
const EGRESS_MCP_SERVER_NAME = `${EGRESS_RECIPE_NAME}-${EGRESS_WORKLOAD_ID}`
const EGRESS_EXTERNAL_DNS = 'example.com'
const EGRESS_POLICY_NAME = `ext-egress-${EGRESS_MCP_SERVER_NAME}-${EGRESS_EXTERNAL_DNS}-443`
const PRIVATE_EGRESS_RECIPE_NAME = 'e2e-hardening-private-egress-binding'
const PRIVATE_EGRESS_WORKLOAD_ID = 'private-api-mcp'
const PRIVATE_EGRESS_RECIPE_MCP_SERVER_NAME = `${PRIVATE_EGRESS_RECIPE_NAME}-${PRIVATE_EGRESS_WORKLOAD_ID}`
const PRIVATE_EGRESS_MCP_SERVER_NAME = 'test-private-egress'
const PUBLIC_EGRESS_EXCEPT_CIDRS = [
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

function isBlockedPublicEgressCidr(cidr: string): boolean {
  return PUBLIC_EGRESS_EXCEPT_CIDRS.some(blocked => cidrOverlaps(cidr, blocked))
}

type LabelSelector = {
  matchLabels?: Record<string, string>
  matchExpressions?: Array<{ key?: string; operator?: string; values?: string[] }>
}

type NetworkPolicyTarget = {
  ipBlock?: { cidr?: string }
  namespaceSelector?: LabelSelector
  podSelector?: LabelSelector
}

type NetworkPolicyRule = {
  to?: NetworkPolicyTarget[]
  ports?: Array<{ port?: number; protocol?: string }>
}

type NetworkPolicyItem = {
  metadata: { name: string; labels?: Record<string, string> }
  spec: {
    podSelector?: LabelSelector
    egress?: NetworkPolicyRule[]
  }
}

function selectorMatches(
  selector: LabelSelector | undefined,
  labels: Record<string, string>
): boolean {
  for (const [key, value] of Object.entries(selector?.matchLabels ?? {})) {
    if (labels[key] !== value) return false
  }

  for (const expression of selector?.matchExpressions ?? []) {
    const key = expression.key
    const operator = expression.operator
    const values = expression.values ?? []
    if (!key || !operator) {
      throw new Error(`unsupported selector expression ${JSON.stringify(expression)}`)
    }

    const exists = Object.prototype.hasOwnProperty.call(labels, key)
    const value = labels[key]
    if (operator === 'In' && (!exists || !values.includes(value))) return false
    if (operator === 'NotIn' && exists && values.includes(value)) return false
    if (operator === 'Exists' && !exists) return false
    if (operator === 'DoesNotExist' && exists) return false
    if (!['In', 'NotIn', 'Exists', 'DoesNotExist'].includes(operator)) {
      throw new Error(`unsupported selector operator ${operator}`)
    }
  }

  return true
}

function firstPodLabels(namespace: string, labelSelector: string): Record<string, string> {
  const pods = kubectlJson<{
    items: Array<{ metadata: { name: string; labels?: Record<string, string> } }>
  }>(`get pod -l ${labelSelector} -n ${namespace}`)
  expect(pods.items.length, `expected at least one pod matching ${labelSelector}`).toBeGreaterThan(
    0
  )
  return pods.items[0].metadata.labels ?? {}
}

function cleanupRedisRecipeArtifacts(): void {
  const commands = [
    `delete workflowrecipe ${REDIS_RECIPE_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found --wait=false`,
    `delete mcpservers.clerum.io ${REDIS_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --wait=false`,
    `delete contexts.clerum.io ${REDIS_RECIPE_CONTEXT_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --wait=false`,
    `delete svc ${REDIS_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --wait=false`,
    `delete deploy ${REDIS_MCP_WORKLOAD_ID} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --wait=false`,
    `delete deploy ${REDIS_WORKLOAD_ID} -n ${SANDBOX_NAMESPACE} --ignore-not-found --wait=false`,
    `delete svc ${REDIS_WORKLOAD_ID} -n ${SANDBOX_NAMESPACE} --ignore-not-found --wait=false`,
    `delete networkpolicy ${REDIS_CONTEXT_EGRESS_POLICY} -n mcp-host --ignore-not-found --wait=false`,
    `delete networkpolicy ${REDIS_CONTEXT_ALLOW_POLICY} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --wait=false`,
    `delete networkpolicy ${REDIS_BINDING_EGRESS_POLICY} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --wait=false`,
    `delete networkpolicy ${REDIS_BINDING_INGRESS_POLICY} -n ${SANDBOX_NAMESPACE} --ignore-not-found --wait=false`,
    `delete networkpolicy ${REDIS_RECIPE_NAME}-mcp-servers-egress-internet -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --wait=false`,
  ]

  for (const command of commands) {
    try {
      kubectl(command)
    } catch {
      /* best-effort cleanup */
    }
  }
}

async function waitForRedisRecipeCleanup(): Promise<void> {
  const waits: Array<Promise<void>> = [
    waitForResource(`workflowrecipe ${REDIS_RECIPE_NAME}`, RECIPE_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    }),
    waitForResource(`mcpservers.clerum.io ${REDIS_MCP_SERVER_NAME}`, MCP_SERVER_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    }),
    waitForResource(`contexts.clerum.io ${REDIS_RECIPE_CONTEXT_NAME}`, MCP_SERVER_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    }),
    waitForResource(`svc ${REDIS_MCP_SERVER_NAME}`, MCP_SERVER_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    }),
    waitForResource(`svc ${REDIS_WORKLOAD_ID}`, SANDBOX_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    }),
    waitForResource(`deploy ${REDIS_MCP_WORKLOAD_ID}`, MCP_SERVER_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    }),
    waitForResource(`deploy ${REDIS_WORKLOAD_ID}`, SANDBOX_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    }),
    waitForResource(`networkpolicy ${REDIS_CONTEXT_EGRESS_POLICY}`, 'mcp-host', {
      shouldExist: false,
      timeoutMs: 30_000,
    }),
    waitForResource(`networkpolicy ${REDIS_CONTEXT_ALLOW_POLICY}`, MCP_SERVER_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    }),
    waitForResource(`networkpolicy ${REDIS_BINDING_EGRESS_POLICY}`, MCP_SERVER_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    }),
    waitForResource(`networkpolicy ${REDIS_BINDING_INGRESS_POLICY}`, SANDBOX_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    }),
    waitForResource(
      `networkpolicy ${REDIS_RECIPE_NAME}-mcp-servers-egress-internet`,
      MCP_SERVER_NAMESPACE,
      { shouldExist: false, timeoutMs: 30_000 }
    ),
  ]
  await Promise.all(waits)
}

async function installRedisRecipeFixture(): Promise<void> {
  cleanupRedisRecipeArtifacts()
  await waitForRedisRecipeCleanup()

  const recipeFile = `${__dirname}/../../samples/mcp-redis-cache.yaml`
  const result = kubectl(`apply -f ${recipeFile}`)
  expect(result).toContain('workflowrecipe')
  await waitForResource(`mcpservers.clerum.io ${REDIS_MCP_SERVER_NAME}`, MCP_SERVER_NAMESPACE, {
    timeoutMs: 60_000,
  })
}

function cleanupEgressRecipeArtifacts(): void {
  const commands = [
    `delete workflowrecipe ${EGRESS_RECIPE_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found --wait=false`,
    `delete mcpservers.clerum.io ${EGRESS_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --wait=false`,
    `delete networkpolicy -l clerum.io/policy-type=external-egress,clerum.io/mcpserver=${EGRESS_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --wait=false`,
    `delete networkpolicy ${EGRESS_POLICY_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --wait=false`,
  ]

  for (const command of commands) {
    try {
      kubectl(command)
    } catch {
      /* best-effort cleanup */
    }
  }
}

async function waitForEgressRecipeCleanup(): Promise<void> {
  await Promise.all([
    waitForResource(`workflowrecipe ${EGRESS_RECIPE_NAME}`, RECIPE_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    }),
    waitForResource(`mcpservers.clerum.io ${EGRESS_MCP_SERVER_NAME}`, MCP_SERVER_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    }),
    waitForResource(`networkpolicy ${EGRESS_POLICY_NAME}`, MCP_SERVER_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    }),
    waitForResource(
      `networkpolicy -l clerum.io/policy-type=external-egress,clerum.io/mcpserver=${EGRESS_MCP_SERVER_NAME}`,
      MCP_SERVER_NAMESPACE,
      { shouldExist: false, timeoutMs: 30_000 }
    ),
  ])
}

function assertNoBroadOrPrivateRecipeMcpEgress(): void {
  const redisMcpPodLabels = firstPodLabels(
    MCP_SERVER_NAMESPACE,
    `clerum.io/mcpserver=${REDIS_MCP_SERVER_NAME}`
  )
  const policies = kubectlJson<{ items: NetworkPolicyItem[] }>(
    `get networkpolicy -n ${MCP_SERVER_NAMESPACE}`
  )

  const recipePolicies = policies.items.filter(policy =>
    selectorMatches(policy.spec.podSelector, redisMcpPodLabels)
  )

  expect(recipePolicies.length).toBeGreaterThan(0)
  for (const policy of recipePolicies) {
    for (const [index, rule] of (policy.spec.egress ?? []).entries()) {
      if (policy.metadata.name === 'allow-dns-egress-mcp-server') {
        expect(
          rule.to,
          `${policy.metadata.name} egress[${index}] must target kube-dns`
        ).toHaveLength(1)
        expect(rule.to?.[0]?.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name']).toBe(
          'kube-system'
        )
        expect(rule.ports?.map(port => `${port.protocol ?? 'TCP'}/${port.port}`).sort()).toEqual([
          'TCP/53',
          'UDP/53',
        ])
        continue
      }

      expect(
        rule.to,
        `${policy.metadata.name} egress[${index}] must be target-scoped`
      ).toBeDefined()
      expect(
        rule.to,
        `${policy.metadata.name} egress[${index}] must not allow all destinations`
      ).not.toHaveLength(0)
      expect(
        rule.ports,
        `${policy.metadata.name} egress[${index}] must be port-scoped`
      ).toBeDefined()
      expect(
        rule.ports,
        `${policy.metadata.name} egress[${index}] must not allow all ports`
      ).not.toHaveLength(0)
      for (const target of rule.to ?? []) {
        const cidr = target.ipBlock?.cidr
        if (cidr) {
          throw new Error(`${policy.metadata.name} must not allow external ipBlock egress ${cidr}`)
        }
        expect(
          target.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'],
          `${policy.metadata.name} egress[${index}] internal target must be namespace-scoped`
        ).toBeDefined()
        expect(
          target.podSelector?.matchLabels,
          `${policy.metadata.name} egress[${index}] internal target must be pod-scoped`
        ).toBeDefined()
      }
    }
  }
}

// ─── L0: Deny-All (Ingress + Egress) ─────────────────────────────────

describe('L0 — Deny-All Hardening', () => {
  for (const ns of RUNTIME_NAMESPACES) {
    it(`E8.1 — deny-all-${ns} exists with Ingress+Egress policyTypes`, () => {
      const np = kubectlJson<{
        metadata: { name: string; labels: Record<string, string> }
        spec: { podSelector: Record<string, unknown>; policyTypes: string[] }
      }>(`get networkpolicy deny-all-${ns} -n ${ns}`)

      expect(np.metadata.name).toBe(`deny-all-${ns}`)
      expect(np.metadata.labels['clerum.io/policy-type']).toBe('default-deny')
      if (ns !== 'mcp-host') {
        expect(np.metadata.labels['clerum.io/managed-by']).toBe('host-context-controller')
      }
      // Empty podSelector = all pods in namespace
      expect(np.spec.podSelector).toEqual({})
      // Phase 8: deny BOTH directions — defense-in-depth baseline
      expect(np.spec.policyTypes).toContain('Ingress')
      expect(np.spec.policyTypes).toContain('Egress')
    })
  }
})

// ─── L1: Infrastructure Egress ────────────────────────────────────────

describe('L1 — Infrastructure Policies', () => {
  for (const ns of HCC_MANAGED_INFRA_NAMESPACES) {
    it(`E8.2 — DNS egress policy exists in ${ns} (port 53 UDP+TCP)`, () => {
      const np = kubectlJson<{
        metadata: { name: string; labels: Record<string, string> }
        spec: {
          policyTypes: string[]
          egress: Array<{
            ports: Array<{ port: number; protocol: string }>
            to: Array<{ namespaceSelector: { matchLabels: Record<string, string> } }>
          }>
        }
      }>(`get networkpolicy allow-dns-egress-${ns} -n ${ns}`)

      expect(np.metadata.labels['clerum.io/policy-type']).toBe('infrastructure')
      expect(np.spec.policyTypes).toEqual(['Egress'])

      const ports = np.spec.egress[0].ports
      expect(ports).toContainEqual({ port: 53, protocol: 'UDP' })
      expect(ports).toContainEqual({ port: 53, protocol: 'TCP' })

      // Targets kube-system namespace (CoreDNS)
      const ns_selector = np.spec.egress[0].to[0].namespaceSelector.matchLabels
      expect(ns_selector['kubernetes.io/metadata.name']).toBe('kube-system')
    })

    it(`E8.3 — HCC API egress policy exists in ${ns}`, () => {
      const np = kubectlJson<{
        metadata: { name: string; labels: Record<string, string> }
        spec: { policyTypes: string[] }
      }>(`get networkpolicy allow-hcc-api-egress-${ns} -n ${ns}`)

      expect(np.metadata.labels['clerum.io/policy-type']).toBe('infrastructure')
      expect(np.spec.policyTypes).toEqual(['Egress'])
    })

    it(`E8.4 — K8s API egress policy exists in ${ns}`, () => {
      const np = kubectlJson<{
        metadata: { name: string; labels: Record<string, string> }
        spec: { policyTypes: string[] }
      }>(`get networkpolicy allow-k8s-api-egress-${ns} -n ${ns}`)

      expect(np.metadata.labels['clerum.io/policy-type']).toBe('infrastructure')
      expect(np.spec.policyTypes).toEqual(['Egress'])
    })
  }

  it('E8.5 — HCC-managed namespaces include the core infrastructure policies', () => {
    for (const ns of HCC_MANAGED_INFRA_NAMESPACES) {
      const policies = kubectlJson<{
        items: Array<{ metadata: { name: string } }>
      }>(`get networkpolicy -l clerum.io/policy-type=infrastructure -n ${ns}`)
      const names = policies.items.map(policy => policy.metadata.name)
      expect(names).toContain(`allow-dns-egress-${ns}`)
      expect(names).toContain(`allow-hcc-api-egress-${ns}`)
      expect(names).toContain(`allow-k8s-api-egress-${ns}`)
    }
  })

  it('E8.5b — static mcp-host policy allows only explicit internal lanes and public HTTP(S)', () => {
    const np = kubectlJson<{
      metadata: { name: string }
      spec: {
        podSelector: { matchLabels: Record<string, string> }
        policyTypes: string[]
        ingress?: unknown[]
        egress: Array<{
          ports?: Array<{ port: number; protocol: string }>
          to?: Array<{
            namespaceSelector?: { matchLabels: Record<string, string> }
            podSelector?: { matchLabels: Record<string, string> }
            ipBlock?: { cidr: string; except?: string[] }
          }>
        }>
      }
    }>('get networkpolicy mcp-host -n mcp-host')

    expect(np.spec.podSelector.matchLabels['clerum.io/managed-by']).toBe('host-context-controller')
    expect(np.spec.policyTypes).toContain('Ingress')
    expect(np.spec.policyTypes).toContain('Egress')
    expect(np.spec.ingress ?? []).toEqual([])

    const rulePorts = (rule: (typeof np.spec.egress)[number]): string[] =>
      (rule.ports ?? []).map(port => `${port.protocol}/${port.port}`).sort()

    const targetsSinglePod = (
      rule: (typeof np.spec.egress)[number],
      namespace: string,
      podLabel: Record<string, string>
    ): boolean =>
      rule.to?.length === 1 &&
      rule.to.some(peer => {
        const nsLabels = peer.namespaceSelector?.matchLabels ?? {}
        const podLabels = peer.podSelector?.matchLabels ?? {}
        return (
          nsLabels['kubernetes.io/metadata.name'] === namespace &&
          Object.entries(podLabel).every(([key, value]) => podLabels[key] === value)
        )
      })

    const isPublicHttpRule = (rule: (typeof np.spec.egress)[number], port: 80 | 443): boolean =>
      rulePorts(rule).join(',') === `TCP/${port}` &&
      rule.to?.length === 1 &&
      rule.to[0].ipBlock?.cidr === '0.0.0.0/0' &&
      JSON.stringify(rule.to[0].ipBlock?.except ?? []) ===
        JSON.stringify(PUBLIC_EGRESS_EXCEPT_CIDRS)

    const classifyRule = (rule: (typeof np.spec.egress)[number]): string => {
      const ports = rulePorts(rule).join(',')
      if (
        ports === 'TCP/8081' &&
        targetsSinglePod(rule, 'control-plane', {
          app: 'host-context-controller-api-gateway',
        })
      ) {
        return 'hcc-api'
      }
      if (
        ports === 'TCP/8092' &&
        targetsSinglePod(rule, 'control-plane', {
          app: 'nginx-workflow-approval-gateway',
        })
      ) {
        return 'approval-gateway'
      }
      if (
        ports === 'TCP/53,UDP/53' &&
        targetsSinglePod(rule, 'kube-system', { 'k8s-app': 'kube-dns' })
      ) {
        return 'dns'
      }
      if (isPublicHttpRule(rule, 80)) {
        return 'public-http'
      }
      if (isPublicHttpRule(rule, 443)) {
        return 'public-https'
      }
      return `unexpected:${JSON.stringify(rule)}`
    }

    const classes = np.spec.egress.map(classifyRule).sort()
    expect(classes).toEqual(
      ['approval-gateway', 'dns', 'hcc-api', 'public-http', 'public-https'].sort()
    )
  })

  it('E8.5c — static mcp-host infrastructure policies are explicitly scoped', () => {
    const dnsPolicy = kubectlJson<{
      spec: {
        podSelector: { matchLabels: Record<string, string> }
        policyTypes: string[]
        egress: Array<{
          ports: Array<{ port: number; protocol: string }>
          to: Array<{ namespaceSelector?: { matchLabels: Record<string, string> } }>
        }>
      }
    }>('get networkpolicy allow-dns-egress-mcp-host -n mcp-host')

    expect(dnsPolicy.spec.podSelector.matchLabels['clerum.io/managed-by']).toBe(
      'host-context-controller'
    )
    expect(dnsPolicy.spec.policyTypes).toEqual(['Egress'])
    expect(dnsPolicy.spec.egress).toHaveLength(1)
    expect(dnsPolicy.spec.egress[0].ports.map(p => `${p.protocol}/${p.port}`).sort()).toEqual([
      'TCP/53',
      'UDP/53',
    ])
    expect(dnsPolicy.spec.egress[0].to).toHaveLength(1)
    expect(
      dnsPolicy.spec.egress[0].to[0].namespaceSelector?.matchLabels['kubernetes.io/metadata.name']
    ).toBe('kube-system')

    const k8sPolicy = kubectlJson<{
      spec: {
        podSelector: { matchLabels: Record<string, string> }
        policyTypes: string[]
        egress: Array<{
          ports: Array<{ port: number; protocol: string }>
          to: Array<{ ipBlock?: { cidr: string } }>
        }>
      }
    }>('get networkpolicy allow-k8s-api-egress-mcp-host -n mcp-host')

    expect(k8sPolicy.spec.podSelector.matchLabels['clerum.io/managed-by']).toBe(
      'host-context-controller'
    )
    expect(k8sPolicy.spec.policyTypes).toEqual(['Egress'])
    expect(k8sPolicy.spec.egress).toHaveLength(1)
    expect(k8sPolicy.spec.egress[0].to).toHaveLength(1)
    expect(k8sPolicy.spec.egress[0].to[0].ipBlock?.cidr).toMatch(/^\d+\.\d+\.\d+\.\d+\/32$/)
    expect(k8sPolicy.spec.egress[0].to[0].ipBlock?.cidr).not.toBe('0.0.0.0/0')
    expect(k8sPolicy.spec.egress[0].ports.map(p => `${p.protocol}/${p.port}`).sort()).toEqual([
      'TCP/443',
      'TCP/8443',
    ])
  })
})

// ─── L1: Allow HCC API Ingress ───────────────────────────────────────

describe('L1 — Allow HCC API Ingress', () => {
  it('E8.6 — allow-host-context-controller-api ingress policy exists', () => {
    const np = kubectlJson<{
      metadata: { name: string; labels: Record<string, string> }
      spec: { policyTypes: string[] }
    }>(`get networkpolicy allow-host-context-controller-api -n ${MCP_SERVER_NAMESPACE}`)

    expect(np.metadata.labels['clerum.io/policy-type']).toBe('allow-api')
    expect(np.spec.policyTypes).toEqual(['Ingress'])
  })
})

// ─── L2: Context-Allow Bidirectional ─────────────────────────────────

describe('L2 — Context-Allow Bidirectional', () => {
  it('E8.9 — L2 egress counterpart exists in mcp-host when context has servers', async () => {
    try {
      await installRedisRecipeFixture()
      await waitForResource(`networkpolicy ${REDIS_CONTEXT_EGRESS_POLICY}`, 'mcp-host', {
        timeoutMs: 60_000,
      })

      const policy = kubectlJson<{
        metadata: { name: string; labels: Record<string, string> }
        spec: {
          policyTypes: string[]
          podSelector: { matchLabels: Record<string, string> }
          egress: Array<{
            to: Array<{
              namespaceSelector?: { matchLabels: Record<string, string> }
              podSelector?: { matchLabels: Record<string, string> }
            }>
          }>
        }
      }>(`get networkpolicy ${REDIS_CONTEXT_EGRESS_POLICY} -n mcp-host`)

      expect(policy.metadata.labels['clerum.io/managed-by']).toBe('host-context-controller')
      expect(policy.metadata.labels['clerum.io/context']).toBe(REDIS_RECIPE_CONTEXT_NAME)
      expect(policy.spec.policyTypes).toEqual(['Egress'])
      expect(policy.spec.podSelector.matchLabels['clerum.io/context']).toBe(
        REDIS_RECIPE_CONTEXT_NAME
      )
      expect(policy.spec.egress).toHaveLength(1)
      expect(
        policy.spec.egress[0].to[0].namespaceSelector?.matchLabels['kubernetes.io/metadata.name']
      ).toBe(MCP_SERVER_NAMESPACE)
      expect(policy.spec.egress[0].to[0].podSelector?.matchLabels['clerum.io/mcpserver']).toBe(
        REDIS_MCP_SERVER_NAME
      )
    } finally {
      cleanupRedisRecipeArtifacts()
      await waitForRedisRecipeCleanup()
    }
  }, 120_000)
})

// ─── L3: Binding Policies via McpServer Annotations ──────────────────

describe('L3 — Binding NetworkPolicies (McpServer annotation-driven)', () => {
  it('E8.7 — L3 binding-allow policies exist when recipe has bindings', async () => {
    try {
      await installRedisRecipeFixture()
      await waitForResource(`networkpolicy ${REDIS_BINDING_EGRESS_POLICY}`, MCP_SERVER_NAMESPACE, {
        timeoutMs: 60_000,
      })
      await waitForResource(`networkpolicy ${REDIS_BINDING_INGRESS_POLICY}`, SANDBOX_NAMESPACE, {
        timeoutMs: 60_000,
      })

      const egressPolicy = kubectlJson<{
        metadata: { labels: Record<string, string> }
        spec: {
          podSelector: { matchLabels: Record<string, string> }
          policyTypes: string[]
          egress: Array<{
            to: Array<{
              namespaceSelector?: { matchLabels: Record<string, string> }
              podSelector?: { matchLabels: Record<string, string> }
            }>
            ports: Array<{ port: number; protocol: string }>
          }>
        }
      }>(`get networkpolicy ${REDIS_BINDING_EGRESS_POLICY} -n ${MCP_SERVER_NAMESPACE}`)

      expect(egressPolicy.metadata.labels['clerum.io/managed-by']).toBe('host-context-controller')
      expect(egressPolicy.metadata.labels['clerum.io/recipe']).toBe(REDIS_RECIPE_NAME)
      expect(egressPolicy.spec.policyTypes).toEqual(['Egress'])
      expect(egressPolicy.spec.podSelector.matchLabels['clerum.io/mcpserver']).toBe(
        REDIS_MCP_SERVER_NAME
      )
      expect(
        egressPolicy.spec.egress[0].to[0].namespaceSelector?.matchLabels[
          'kubernetes.io/metadata.name'
        ]
      ).toBe(SANDBOX_NAMESPACE)
      expect(egressPolicy.spec.egress[0].to[0].podSelector?.matchLabels.app).toBe(REDIS_WORKLOAD_ID)
      expect(egressPolicy.spec.egress[0].ports).toEqual([{ port: 6379, protocol: 'TCP' }])

      const ingressPolicy = kubectlJson<{
        metadata: { labels: Record<string, string> }
        spec: {
          podSelector: { matchLabels: Record<string, string> }
          policyTypes: string[]
          ingress: Array<{
            _from?: Array<{
              namespaceSelector?: { matchLabels: Record<string, string> }
              podSelector?: { matchLabels: Record<string, string> }
            }>
            from?: Array<{
              namespaceSelector?: { matchLabels: Record<string, string> }
              podSelector?: { matchLabels: Record<string, string> }
            }>
            ports: Array<{ port: number; protocol: string }>
          }>
        }
      }>(`get networkpolicy ${REDIS_BINDING_INGRESS_POLICY} -n ${SANDBOX_NAMESPACE}`)

      expect(ingressPolicy.metadata.labels['clerum.io/managed-by']).toBe('host-context-controller')
      expect(ingressPolicy.metadata.labels['clerum.io/recipe']).toBe(REDIS_RECIPE_NAME)
      expect(ingressPolicy.spec.policyTypes).toEqual(['Ingress'])
      expect(ingressPolicy.spec.podSelector.matchLabels.app).toBe(REDIS_WORKLOAD_ID)
      const ingressFrom = ingressPolicy.spec.ingress[0]._from ?? ingressPolicy.spec.ingress[0].from
      expect(ingressFrom?.[0].namespaceSelector?.matchLabels['kubernetes.io/metadata.name']).toBe(
        MCP_SERVER_NAMESPACE
      )
      expect(ingressFrom?.[0].podSelector?.matchLabels['clerum.io/mcpserver']).toBe(
        REDIS_MCP_SERVER_NAME
      )
      expect(ingressPolicy.spec.ingress[0].ports).toEqual([{ port: 6379, protocol: 'TCP' }])

      await waitForResource(
        `pod -l clerum.io/mcpserver=${REDIS_MCP_SERVER_NAME}`,
        MCP_SERVER_NAMESPACE,
        { timeoutMs: 60_000 }
      )
      assertNoBroadOrPrivateRecipeMcpEgress()
    } finally {
      cleanupRedisRecipeArtifacts()
      await waitForRedisRecipeCleanup()
    }
  }, 120_000)
})

// ─── L3-Egress: External Egress Policies ─────────────────────────────

describe('L3-Egress — External Egress NetworkPolicies', () => {
  it('E8.10 — WorkflowRecipe egressBindings propagate to McpServer and HCC external egress policy', async () => {
    cleanupEgressRecipeArtifacts()
    await waitForEgressRecipeCleanup()
    try {
      kubectl(`apply -f - <<'EOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${EGRESS_RECIPE_NAME}
  namespace: ${RECIPE_NAMESPACE}
spec:
  contextRef: default
  workloads:
    - id: ${EGRESS_WORKLOAD_ID}
      type: deployment
      image: clerum/mock-mcp-server:test
      port: 3000
      transport:
        type: streamableHttp
        path: /mcp
      egressBindings:
        - dns: "${EGRESS_EXTERNAL_DNS}"
          port: 443
          protocol: TCP
      healthCheck:
        type: tcp
        port: 3001
EOF`)

      await waitForResource(
        `mcpservers.clerum.io ${EGRESS_MCP_SERVER_NAME}`,
        MCP_SERVER_NAMESPACE,
        {
          timeoutMs: 60_000,
        }
      )
      await waitForResource(`networkpolicy ${EGRESS_POLICY_NAME}`, MCP_SERVER_NAMESPACE, {
        timeoutMs: 60_000,
      })

      const mcpServer = kubectlJson<{
        metadata: { labels: Record<string, string> }
        spec: { egressBindings?: Array<{ dns?: string; port: number; protocol?: string }> }
      }>(`get mcpservers.clerum.io ${EGRESS_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE}`)

      expect(mcpServer.metadata.labels['clerum.io/managed-by']).toBe('workflow-recipes')
      expect(mcpServer.metadata.labels['clerum.io/recipe']).toBe(EGRESS_RECIPE_NAME)
      expect(mcpServer.spec.egressBindings).toEqual([
        { dns: EGRESS_EXTERNAL_DNS, port: 443, protocol: 'TCP' },
      ])

      const policies = kubectlJson<{
        items: Array<{
          metadata: { name: string; labels: Record<string, string> }
          spec: {
            policyTypes: string[]
            podSelector: { matchLabels: Record<string, string> }
            egress?: Array<{
              to?: Array<{ ipBlock?: { cidr: string } }>
              ports?: Array<{ port: number; protocol: string }>
            }>
          }
        }>
      }>(
        `get networkpolicy -l clerum.io/policy-type=external-egress,clerum.io/mcpserver=${EGRESS_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE}`
      )
      expect(policies.items.map(item => item.metadata.name)).toEqual([EGRESS_POLICY_NAME])
      const policy = policies.items[0]

      expect(policy.metadata.name).toBe(EGRESS_POLICY_NAME)
      expect(policy.metadata.labels['clerum.io/managed-by']).toBe('host-context-controller')
      expect(policy.metadata.labels['clerum.io/mcpserver']).toBe(EGRESS_MCP_SERVER_NAME)
      expect(policy.spec.policyTypes).toEqual(['Egress'])
      expect(policy.spec.podSelector.matchLabels['clerum.io/mcpserver']).toBe(
        EGRESS_MCP_SERVER_NAME
      )
      expect(policy.spec.egress?.length).toBeGreaterThan(0)
      for (const [index, rule] of (policy.spec.egress ?? []).entries()) {
        expect(
          rule.to,
          `${policy.metadata.name} egress[${index}] must be ipBlock-scoped`
        ).toHaveLength(1)
        const cidr = rule.to?.[0]?.ipBlock?.cidr
        expect(cidr, `${policy.metadata.name} egress[${index}] must resolve DNS to /32`).toMatch(
          /^\d+\.\d+\.\d+\.\d+\/32$/
        )
        expect(
          isBlockedPublicEgressCidr(cidr ?? ''),
          `${policy.metadata.name} must not allow private/special-use CIDR ${cidr}`
        ).toBe(false)
        expect(rule.ports).toEqual([{ port: 443, protocol: 'TCP' }])
      }
    } finally {
      cleanupEgressRecipeArtifacts()
      await waitForEgressRecipeCleanup()
    }
  }, 120_000)

  it('E8.10b — private/special-use egressBindings do not create external egress policies', async () => {
    try {
      kubectl(
        `delete workflowrecipe ${PRIVATE_EGRESS_RECIPE_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found --timeout=20s`
      )
      kubectl(
        `delete mcpservers.clerum.io ${PRIVATE_EGRESS_RECIPE_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --timeout=20s`
      )
      kubectl(
        `delete networkpolicy -l clerum.io/policy-type=external-egress,clerum.io/mcpserver=${PRIVATE_EGRESS_RECIPE_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --timeout=20s`
      )
      kubectl(
        `delete mcpservers.clerum.io ${PRIVATE_EGRESS_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --timeout=20s`
      )
      kubectl(
        `delete networkpolicy -l clerum.io/policy-type=external-egress,clerum.io/mcpserver=${PRIVATE_EGRESS_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --timeout=20s`
      )
    } catch {
      /* best-effort cleanup */
    }
    await waitForResource(`workflowrecipe ${PRIVATE_EGRESS_RECIPE_NAME}`, RECIPE_NAMESPACE, {
      shouldExist: false,
      timeoutMs: 30_000,
    })
    await waitForResource(
      `mcpservers.clerum.io ${PRIVATE_EGRESS_RECIPE_MCP_SERVER_NAME}`,
      MCP_SERVER_NAMESPACE,
      { shouldExist: false, timeoutMs: 30_000 }
    )
    await waitForResource(
      `networkpolicy -l clerum.io/policy-type=external-egress,clerum.io/mcpserver=${PRIVATE_EGRESS_RECIPE_MCP_SERVER_NAME}`,
      MCP_SERVER_NAMESPACE,
      { shouldExist: false, timeoutMs: 30_000 }
    )
    await waitForResource(
      `mcpservers.clerum.io ${PRIVATE_EGRESS_MCP_SERVER_NAME}`,
      MCP_SERVER_NAMESPACE,
      {
        shouldExist: false,
        timeoutMs: 30_000,
      }
    )
    await waitForResource(
      `networkpolicy -l clerum.io/policy-type=external-egress,clerum.io/mcpserver=${PRIVATE_EGRESS_MCP_SERVER_NAME}`,
      MCP_SERVER_NAMESPACE,
      { shouldExist: false, timeoutMs: 30_000 }
    )

    try {
      expect(() =>
        kubectl(`apply -f - <<'EOF'
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${PRIVATE_EGRESS_RECIPE_NAME}
  namespace: ${RECIPE_NAMESPACE}
spec:
  contextRef: default
  workloads:
    - id: ${PRIVATE_EGRESS_WORKLOAD_ID}
      type: deployment
      image: clerum/mock-mcp-server:test
      port: 3000
      transport:
        type: streamableHttp
        path: /mcp
      egressBindings:
        - dns: "kubernetes.default.svc"
          port: 443
          protocol: TCP
EOF`)
      ).toThrow(/internal|service|egressBindings|dns/i)

      expect(() =>
        kubectl(`get workflowrecipe ${PRIVATE_EGRESS_RECIPE_NAME} -n ${RECIPE_NAMESPACE}`)
      ).toThrow()
      expect(() =>
        kubectl(
          `get mcpservers.clerum.io ${PRIVATE_EGRESS_RECIPE_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE}`
        )
      ).toThrow()
      const recipePolicies = kubectlJson<{
        items: Array<{ metadata: { name: string } }>
      }>(
        `get networkpolicy -l clerum.io/policy-type=external-egress,clerum.io/mcpserver=${PRIVATE_EGRESS_RECIPE_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE}`
      )
      expect(recipePolicies.items).toHaveLength(0)

      expect(() =>
        kubectl(`apply -f - <<'EOF'
apiVersion: clerum.io/v1alpha1
kind: McpServer
metadata:
  name: ${PRIVATE_EGRESS_MCP_SERVER_NAME}
  namespace: ${MCP_SERVER_NAMESPACE}
  labels:
    clerum.io/mcpserver: ${PRIVATE_EGRESS_MCP_SERVER_NAME}
spec:
  contextRef: default
  image: test:latest
  managed: false
  transport:
    type: streamableHttp
    url: http://${PRIVATE_EGRESS_MCP_SERVER_NAME}:3000
    port: 3000
  egressBindings:
    - cidr: "10.0.0.0/8"
      port: 443
      protocol: TCP
EOF`)
      ).toThrow(/private|reserved|CIDR/i)

      const policies = kubectlJson<{
        items: Array<{ metadata: { name: string } }>
      }>(
        `get networkpolicy -l clerum.io/policy-type=external-egress,clerum.io/mcpserver=${PRIVATE_EGRESS_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE}`
      )
      expect(policies.items).toHaveLength(0)
      expect(() => {
        kubectl(
          `get mcpservers.clerum.io ${PRIVATE_EGRESS_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE}`
        )
      }).toThrow()
    } finally {
      try {
        kubectl(
          `delete workflowrecipe ${PRIVATE_EGRESS_RECIPE_NAME} -n ${RECIPE_NAMESPACE} --ignore-not-found --timeout=20s`
        )
        kubectl(
          `delete mcpservers.clerum.io ${PRIVATE_EGRESS_RECIPE_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --timeout=20s`
        )
        kubectl(
          `delete networkpolicy -l clerum.io/policy-type=external-egress,clerum.io/mcpserver=${PRIVATE_EGRESS_RECIPE_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --timeout=20s`
        )
        kubectl(
          `delete mcpservers.clerum.io ${PRIVATE_EGRESS_MCP_SERVER_NAME} -n ${MCP_SERVER_NAMESPACE} --ignore-not-found --timeout=20s`
        )
      } catch {
        /* ignore */
      }
      await waitForResource(`workflowrecipe ${PRIVATE_EGRESS_RECIPE_NAME}`, RECIPE_NAMESPACE, {
        shouldExist: false,
        timeoutMs: 30_000,
      })
      await waitForResource(
        `mcpservers.clerum.io ${PRIVATE_EGRESS_RECIPE_MCP_SERVER_NAME}`,
        MCP_SERVER_NAMESPACE,
        { shouldExist: false, timeoutMs: 30_000 }
      )
      await waitForResource(
        `networkpolicy -l clerum.io/policy-type=external-egress,clerum.io/mcpserver=${PRIVATE_EGRESS_RECIPE_MCP_SERVER_NAME}`,
        MCP_SERVER_NAMESPACE,
        { shouldExist: false, timeoutMs: 30_000 }
      )
      await waitForResource(
        `mcpservers.clerum.io ${PRIVATE_EGRESS_MCP_SERVER_NAME}`,
        MCP_SERVER_NAMESPACE,
        {
          shouldExist: false,
          timeoutMs: 30_000,
        }
      )
      await waitForResource(
        `networkpolicy -l clerum.io/policy-type=external-egress,clerum.io/mcpserver=${PRIVATE_EGRESS_MCP_SERVER_NAME}`,
        MCP_SERVER_NAMESPACE,
        { shouldExist: false, timeoutMs: 30_000 }
      )
    }
  }, 60_000)
})

// ─── Policy Count Summary ────────────────────────────────────────────

describe('NetworkPolicy Layer Summary', () => {
  it('E8.8 — All expected policy layers are present in mcp-server namespace', () => {
    const allPolicies = kubectlJson<{
      items: Array<{
        metadata: { name: string; labels?: Record<string, string> }
      }>
    }>(`get networkpolicy -n ${MCP_SERVER_NAMESPACE}`)

    const byType = new Map<string, number>()
    for (const p of allPolicies.items) {
      const policyType = p.metadata.labels?.['clerum.io/policy-type'] ?? 'unknown'
      byType.set(policyType, (byType.get(policyType) ?? 0) + 1)
    }

    // L0: at least 1 deny-all in mcp-server
    expect(byType.get('default-deny')).toBeGreaterThanOrEqual(1)
    // L1: at least 3 infrastructure policies (DNS, HCC, K8s API)
    expect(byType.get('infrastructure')).toBeGreaterThanOrEqual(3)
    // L1: allow-api policy
    expect(byType.get('allow-api')).toBeGreaterThanOrEqual(1)
  })
})
