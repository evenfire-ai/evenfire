import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'

/** Paths are relative to this file: control-api/test/ → repo root is ../.. */
const BASE = '../../deploy/base'
const OVERLAYS = '../../deploy/overlays'

const SPECIAL_USE_PUBLIC_EGRESS_EXCEPTS = [
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

function read(relativeFromRepoRoot: string): string {
  return readFileSync(new URL(relativeFromRepoRoot, import.meta.url), 'utf-8')
}

function exists(relativeFromRepoRoot: string): boolean {
  return existsSync(new URL(relativeFromRepoRoot, import.meta.url))
}

/**
 * GKE overlays (deploy/overlays/gcp-*) and the gcp-* detect script are
 * infra-repo concerns: the public single-tenant tree ships deploy/base/** but
 * not the cloud overlays or gcp scripts. When those infra files are absent the
 * GKE-overlay egress-CIDR contract is validated in the infra repo's CI instead,
 * so the corresponding assertion here is skipped rather than failing on ENOENT.
 */
const GKE_INFRA_PRESENT = exists('../../deploy/scripts/gcp-detect-k8s-api-ip.sh')

function readYamlBundle(relativeFromRepoRoot: string): string {
  const url = new URL(relativeFromRepoRoot, import.meta.url)
  if (!statSync(url).isDirectory()) return read(relativeFromRepoRoot)

  const prefix = relativeFromRepoRoot.endsWith('/')
    ? relativeFromRepoRoot
    : `${relativeFromRepoRoot}/`
  return readdirSync(url)
    .filter(name => /\.ya?ml$/.test(name))
    .sort()
    .map(name => read(`${prefix}${name}`))
    .join('\n---\n')
}

function yamlDocs(content: string): string[] {
  return content
    .split(/\n---\n/)
    .map(d => d.trim())
    .filter(Boolean)
}

function docContaining(docs: string[], substring: string): string {
  const hit = docs.find(d => d.includes(substring))
  if (!hit) {
    throw new Error(`No YAML document containing: ${substring}`)
  }
  return hit
}

function locationBlock(config: string, marker: string): string {
  const start = config.indexOf(marker)
  if (start < 0) throw new Error(`No gateway location containing: ${marker}`)
  const next = config.indexOf('\n        location ', start + marker.length)
  return next < 0 ? config.slice(start) : config.slice(start, next)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function expectCanonicalPublicEgressExceptions(): void {
  const exceptions = read(`${BASE}/public-egress-exceptions.yaml`)
  for (const cidr of SPECIAL_USE_PUBLIC_EGRESS_EXCEPTS) {
    expect(exceptions).toContain(`- ${cidr}`)
  }
}

function expectPublicEgressExceptionReplacement(policyName: string): void {
  const kustomization = read(`${BASE}/kustomization.yaml`)
  expect(kustomization).toContain('kind: PublicEgressExceptionSet')
  expect(kustomization).toContain('fieldPath: spec.ranges')
  expect(kustomization).toMatch(
    new RegExp(
      [
        'kind:\\s*NetworkPolicy',
        `name:\\s*${escapeRegExp(policyName)}`,
        'fieldPaths:\\s*\\n\\s*-\\s*spec\\.egress\\.\\*\\.to\\.\\*\\.ipBlock\\.except',
      ].join('[\\s\\S]*?')
    )
  )
}

function ruleBlock(doc: string, resourceLine: string): string {
  const lines = doc.split('\n')
  const start = lines.findIndex(line => line.includes(resourceLine))
  if (start === -1) {
    throw new Error(`No YAML rule containing: ${resourceLine}`)
  }
  return lines.slice(start, start + 2).join('\n')
}

function roleRuleForResource(doc: string, resource: string): string {
  const lines = doc.split('\n')
  const resourceLine = `  - ${resource}`
  const resourceIndex = lines.findIndex(line => line === resourceLine)
  if (resourceIndex === -1) {
    throw new Error(`No RBAC rule containing resource: ${resource}`)
  }

  let start = resourceIndex
  while (start >= 0 && lines[start] !== '- apiGroups:') start -= 1
  if (start < 0) {
    throw new Error(`No RBAC rule boundary for resource: ${resource}`)
  }

  let end = start + 1
  while (end < lines.length && lines[end] !== '- apiGroups:') end += 1
  return lines.slice(start, end).join('\n')
}

function fromPeerBlock(doc: string, marker: string): string {
  const lines = doc.split('\n')
  const markerIndex = lines.findIndex(line => line.includes(marker))
  if (markerIndex === -1) {
    throw new Error(`No NetworkPolicy peer containing: ${marker}`)
  }

  let start = markerIndex
  while (start >= 0 && !/^    - /.test(lines[start])) start -= 1
  if (start < 0) {
    throw new Error(`No NetworkPolicy peer list item for: ${marker}`)
  }

  let end = start + 1
  while (
    end < lines.length &&
    !/^    - /.test(lines[end]) &&
    !/^    ports:/.test(lines[end]) &&
    !/^  - /.test(lines[end])
  ) {
    end += 1
  }
  return lines.slice(start, end).join('\n')
}

// ── Derived control-api-rpc-gateway allowlist guard ──────────────────────────
// The hardcoded check below spot-checks a couple of locations. This derives the
// REQUIRED allowlist from the control-api source instead: any route that attaches
// requireInternalService('rpc-proxy') as route middleware is, by contract, called
// by rpc-proxy — whose only path to control-api is through control-api-rpc-gateway.
// Each such route therefore needs a matching nginx `location`, or it 403s at the
// edge. (Exactly the per-user OAuth regression: oauth/authorize-url, token and
// grant were added without gateway entries.) Scope: per-route middleware only; the
// /rpc/* mount — gated once via api.use('/rpc', requireInternalService(...)) — is
// asserted by the hardcoded test below.
const RPC_PROXY_HTTP_METHODS = 'get|post|put|delete|patch'

interface RouteRef {
  method: string
  path: string
  file: string
}

interface NginxLocation {
  modifier: string
  path: string
  method: string | null
}

function listRouteSourceFiles(relDir: string): string[] {
  const base = relDir.replace(/\/$/, '')
  const out: string[] = []
  for (const entry of readdirSync(new URL(`${base}/`, import.meta.url), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...listRouteSourceFiles(`${base}/${entry.name}`))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(`${base}/${entry.name}`)
    }
  }
  return out
}

function rpcProxyRoutes(): RouteRef[] {
  const routes: RouteRef[] = []
  // Split so each chunk holds exactly one route registration (from its
  // router.<method>( up to the next), then keep only chunks that gate on rpc-proxy.
  const split = new RegExp(`(?=router\\.(?:${RPC_PROXY_HTTP_METHODS})\\s*\\()`)
  const head = new RegExp(`^router\\.(${RPC_PROXY_HTTP_METHODS})\\s*\\(\\s*['"]([^'"]+)['"]`)
  for (const file of listRouteSourceFiles('../src/routes')) {
    for (const chunk of read(file).split(split)) {
      const m = chunk.match(head)
      if (!m) continue
      if (!/requireInternalService\(\s*['"]rpc-proxy['"]\s*\)/.test(chunk)) continue
      routes.push({ method: m[1].toUpperCase(), path: `/api/v1${m[2]}`, file })
    }
  }
  return routes
}

function gatewayAllowlistLocations(gatewayConf: string): NginxLocation[] {
  const locations: NginxLocation[] = []
  // limit_except <M> denies every method except M, i.e. it ALLOWS M. Locations
  // without a limit_except allow all methods (method=null).
  const re = /location\s+(=|~)\s+(\S+)\s*\{\s*(?:limit_except\s+([A-Z]+)\b)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(gatewayConf)) !== null) {
    locations.push({ modifier: m[1], path: m[2], method: m[3] ?? null })
  }
  return locations
}

function routeIsAllowlisted(route: RouteRef, locations: NginxLocation[]): boolean {
  // An exact (=) location can't carry Express :params; substitute a slashless
  // placeholder so :param routes can still be tested against regex (~) locations.
  const concretePath = route.path.replace(/:[^/]+/g, 'placeholder')
  return locations.some(location => {
    if (location.method && location.method !== route.method) return false
    if (location.modifier === '=') return location.path === route.path
    if (location.modifier === '~') {
      try {
        return new RegExp(location.path).test(concretePath)
      } catch {
        return false
      }
    }
    return false
  })
}

// Manifest-level contract tests — assert that the NetworkPolicy + nginx ConfigMap
// invariants in deploy/base/{rpc-proxy,control-plane,mcp-host}/ keep the gateway
// topology locked down (rpc-proxy egress only via control-api-rpc-gateway, HCC
// ingress only via host-context-controller-api-gateway, and nginx allowlist routes).
describe('network/gateway intent (manifest-level)', () => {
  it('ships a GFS namespace default-deny policy while HCC owns gfsc allowlists', () => {
    const gfsKustomization = read(`${BASE}/gfs/kustomization.yaml`)
    const gfsPolicies = read(`${BASE}/gfs/networkpolicies.yaml`)
    const denyAll = docContaining(yamlDocs(gfsPolicies), 'name: deny-all-gfs')

    expect(gfsKustomization).toContain('- networkpolicies.yaml')
    expect(denyAll).toContain('namespace: gfs')
    expect(denyAll).toContain('clerum.io/policy-type: default-deny')
    expect(denyAll).toMatch(/podSelector:\s*\{\}/)
    expect(denyAll).toMatch(/policyTypes:[\s\S]*-\s*Ingress[\s\S]*-\s*Egress/)
    expect(gfsKustomization).toContain('workload-specific allowlist NetworkPolicies')
  })

  it('routes rpc-proxy control-plane egress through control-api-rpc-gateway only', () => {
    const rpcProxyPolicies = read(`${BASE}/rpc-proxy/networkpolicies.yaml`)
    const rpcProxyPolicy = docContaining(yamlDocs(rpcProxyPolicies), 'name: rpc-proxy')
    expect(rpcProxyPolicy).toContain('name: rpc-proxy')
    expect(rpcProxyPolicy).toContain('app: control-api-rpc-gateway')
    // Egress to control-api for JSON-RPC must use the gateway pod, not the API pod directly
    expect(rpcProxyPolicy).toMatch(/port:\s*8090[\s\S]*app:\s*control-api-rpc-gateway/m)
    expect(rpcProxyPolicy).not.toMatch(/port:\s*8090[\s\S]*app:\s*control-api$/m)
  })

  it('does not give rpc-proxy namespace-wide egress to MCP servers', () => {
    const rpcProxyPolicies = read(`${BASE}/rpc-proxy/networkpolicies.yaml`)
    const rpcProxyPolicy = docContaining(yamlDocs(rpcProxyPolicies), 'name: rpc-proxy')
    const mcpServerPolicies = read(`${BASE}/mcp-server/networkpolicies.yaml`)

    expect(rpcProxyPolicy).toContain('rpc-egress-<context>-<server>')
    expect(rpcProxyPolicy).not.toContain('kubernetes.io/metadata.name: mcp-server')
    expect(mcpServerPolicies).not.toContain('allow-rpc-proxy-to-managed-mcp-servers')
  })

  it('keeps rpc-proxy external HTTPS egress from covering private or special-use ranges', () => {
    const rpcProxyPolicies = read(`${BASE}/rpc-proxy/networkpolicies.yaml`)
    const rpcProxyPolicy = docContaining(yamlDocs(rpcProxyPolicies), 'name: rpc-proxy')

    expect(rpcProxyPolicy).toContain('cidr: 0.0.0.0/0')
    expect(rpcProxyPolicy).toContain('except: []')
    expectPublicEgressExceptionReplacement('rpc-proxy')
    expectCanonicalPublicEgressExceptions()
  })

  it('does not give rpc-proxy namespace-wide egress or ingress to all mcp-host pods', () => {
    const rpcProxyPolicies = read(`${BASE}/rpc-proxy/networkpolicies.yaml`)
    const rpcProxyPolicy = docContaining(yamlDocs(rpcProxyPolicies), 'name: rpc-proxy')
    const mcpHostPolicies = read(`${BASE}/mcp-host/networkpolicies.yaml`)
    const mcpHostPolicy = docContaining(yamlDocs(mcpHostPolicies), 'name: mcp-host')

    expect(rpcProxyPolicy).toContain('rpc-proxy-<host>-egress-mcp-host')
    expect(rpcProxyPolicy).not.toContain('kubernetes.io/metadata.name: mcp-host')
    expect(rpcProxyPolicies).not.toContain('name: allow-desktop-egress-rpc-proxy')
    expect(mcpHostPolicy).toContain('mcp-host-<host>-ingress-rpc-proxy')
    expect(mcpHostPolicy).not.toContain('kubernetes.io/metadata.name: rpc-proxy')
  })

  it('locks control-api-rpc-gateway ingress/egress to intended peers', () => {
    const controlPlaneNp = read(`${BASE}/control-plane/networkpolicies.yaml`)
    const gatewayPolicy = docContaining(yamlDocs(controlPlaneNp), 'name: control-api-rpc-gateway')
    expect(gatewayPolicy).toContain('name: control-api-rpc-gateway')
    expect(gatewayPolicy).toContain('kubernetes.io/metadata.name: rpc-proxy')
    expect(gatewayPolicy).toContain('app: rpc-proxy')
    expect(gatewayPolicy).toContain('app: control-api')
    expect(gatewayPolicy).toContain('k8s-app: kube-dns')
    expect(gatewayPolicy).not.toContain('0.0.0.0/0')
  })

  it('whitelists only the intended control-api gateway endpoint and default-denies others', () => {
    const configmaps = read(`${BASE}/control-plane/configmaps.yaml`)
    const gatewayConf = docContaining(yamlDocs(configmaps), 'name: control-api-rpc-gateway')
    expect(gatewayConf).toContain('location ~ ^/api/v1/rpc/access/users/[^/]+/mcp-servers$')
    expect(gatewayConf).toContain('location ~ ^/api/v1/rpc/access/users/[^/]+/mcp-hosts/[^/]+$')
    expect(gatewayConf).toMatch(
      /location ~ \^\/api\/v1\/rpc\/access\/users\/\[\^\/\]\+\/mcp-hosts\/\[\^\/\]\+\$ \{[\s\S]*?limit_except GET POST/
    )
    expect(gatewayConf).not.toContain('/api/v1/internal/tracing/direct-run-bindings')
    expect(gatewayConf).toContain('location ~ ^/api/v1/rpc/hosts/[^/]+/wake$')
    expect(gatewayConf).toContain('limit_except GET')
    expect(gatewayConf).toMatch(
      /location ~ \^\/api\/v1\/rpc\/hosts\/\[\^\/\]\+\/wake\$ \{[\s\S]*?limit_except POST/
    )
    expect(gatewayConf).toContain('location / {')
    expect(gatewayConf).toContain('return 403;')
    expect(gatewayConf).not.toContain('/api/v1/external/')
  })

  it('keeps the Minikube control-api Marketplace on the shared registry', () => {
    const controlApiConfig = read(`${OVERLAYS}/minikube/configmaps/control-api-config.yaml`)

    expect(controlApiConfig).toContain("CLERUM_REGISTRY_URL: 'https://registry.evenfire.ai'")
    expect(controlApiConfig).not.toContain(
      "CLERUM_REGISTRY_URL: 'http://registry-api.registry.svc.cluster.local:8085'"
    )
  })

  it('keeps the stateless heartbeat route POST-only through the mcp-host gateway', () => {
    const configmaps = read(`${BASE}/control-plane/configmaps.yaml`)
    const gatewayConf = docContaining(yamlDocs(configmaps), 'name: nginx-workflow-approval-gateway')

    expect(gatewayConf).toContain('location = /api/v1/mcp-host/hosts/heartbeat')
    expect(gatewayConf).toMatch(
      /location = \/api\/v1\/mcp-host\/hosts\/heartbeat \{[\s\S]*?limit_except POST/
    )
  })

  it('routes promptBridge JIT credential tickets through the mcp-host gateway', () => {
    const configmaps = read(`${BASE}/control-plane/configmaps.yaml`)
    const gatewayConf = docContaining(yamlDocs(configmaps), 'name: nginx-workflow-approval-gateway')
    const route = locationBlock(
      gatewayConf,
      'location = /api/v1/mcp-host/plugin-workload-sdk/prompt-bridge/credential-ticket'
    )

    expect(route).toContain('limit_except POST')
    expect(route).toContain('proxy_pass http://control_api_upstream;')
    expect(route).toContain('proxy_set_header Authorization $http_authorization;')
  })

  it('routes the Plugin Workload SDK capabilities probe through the mcp-host gateway', () => {
    const configmaps = read(`${BASE}/control-plane/configmaps.yaml`)
    const gatewayConf = docContaining(yamlDocs(configmaps), 'name: nginx-workflow-approval-gateway')
    const route = locationBlock(
      gatewayConf,
      'location = /api/v1/mcp-host/plugin-workload-sdk/capabilities'
    )

    expect(route).toContain('limit_except GET')
    expect(route).toContain('proxy_pass http://control_api_upstream;')
    expect(route).toContain('proxy_set_header Authorization $http_authorization;')
  })

  it('routes the target-aware Plugin Workload SDK promptBridge v2 endpoint through the gateway', () => {
    const configmaps = read(`${BASE}/control-plane/configmaps.yaml`)
    const gatewayConf = docContaining(yamlDocs(configmaps), 'name: nginx-workflow-approval-gateway')
    const route = locationBlock(
      gatewayConf,
      'location = /api/v1/mcp-host/plugin-workload-sdk/prompt-bridge/v2'
    )

    expect(route).toContain('limit_except POST')
    expect(route).toContain('proxy_pass http://control_api_upstream;')
    expect(route).toContain('proxy_set_header Authorization $http_authorization;')
  })

  it('routes promptBridge provider-attempt status through the mcp-host gateway', () => {
    const configmaps = read(`${BASE}/control-plane/configmaps.yaml`)
    const gatewayConf = docContaining(yamlDocs(configmaps), 'name: nginx-workflow-approval-gateway')
    const route = locationBlock(
      gatewayConf,
      'location ~ ^/api/v1/mcp-host/plugin-workload-sdk/provider-attempts/[^/]+/status'
    )

    expect(route).toContain('limit_except POST')
    expect(route).toContain('proxy_pass http://control_api_upstream;')
    expect(route).toContain('proxy_set_header Authorization $http_authorization;')
  })

  it('keeps governed agent-run ingest POST-only through the mcp-host gateway', () => {
    const configmaps = read(`${BASE}/control-plane/configmaps.yaml`)
    const gatewayConf = docContaining(yamlDocs(configmaps), 'name: nginx-workflow-approval-gateway')

    expect(gatewayConf).toContain('location = /api/v1/internal/tracing/agent-run-events')
    expect(gatewayConf).toMatch(
      /location = \/api\/v1\/internal\/tracing\/agent-run-events \{[\s\S]*?limit_except POST/
    )
    expect(gatewayConf).toMatch(
      /location = \/api\/v1\/internal\/tracing\/agent-run-events \{[\s\S]*?proxy_set_header Authorization \$http_authorization;/
    )
  })

  it('keeps protected prompt-history capture POST-only through the mcp-host gateway', () => {
    const configmaps = read(`${BASE}/control-plane/configmaps.yaml`)
    const gatewayConf = docContaining(yamlDocs(configmaps), 'name: nginx-workflow-approval-gateway')

    expect(gatewayConf).toContain('location = /api/v1/internal/tracing/approval-prompt-history')
    expect(gatewayConf).toMatch(
      /location = \/api\/v1\/internal\/tracing\/approval-prompt-history \{[\s\S]*?limit_except POST/
    )
    expect(gatewayConf).toMatch(
      /location = \/api\/v1\/internal\/tracing\/approval-prompt-history \{[\s\S]*?proxy_set_header Authorization \$http_authorization;/
    )
  })

  it('forces mcp-host to use host-context-controller API gateway path', () => {
    const mcpHostPolicy = read(`${BASE}/mcp-host/networkpolicies.yaml`)
    expect(mcpHostPolicy).toContain('app: host-context-controller-api-gateway')
    expect(mcpHostPolicy).toContain('port: 8081')
  })

  it('allows 1st-party AuthN, 1st-party MCP-host shared hosts to reach only the workflow approval gateway', () => {
    const mcpHostDocs = yamlDocs(read(`${BASE}/mcp-host/networkpolicies.yaml`))
    const sharedHostPolicy = docContaining(mcpHostDocs, 'name: mcp-host')

    expect(sharedHostPolicy).toContain('clerum.io/managed-by: host-context-controller')
    expect(sharedHostPolicy).toContain('app: nginx-workflow-approval-gateway')
    expect(sharedHostPolicy).toMatch(/port:\s*8092/m)
    expect(sharedHostPolicy).not.toMatch(/port:\s*8090[\s\S]*app:\s*control-api/m)

    const controlPlaneDocs = yamlDocs(read(`${BASE}/control-plane/networkpolicies.yaml`))
    const controlApiIngress = docContaining(controlPlaneDocs, 'name: control-api-ingress')
    const workflowGatewayIngress = docContaining(
      controlPlaneDocs,
      'name: nginx-workflow-approval-gateway'
    )
    const sharedHostGatewayPeer = fromPeerBlock(
      workflowGatewayIngress,
      'kubernetes.io/metadata.name: mcp-host'
    )

    expect(controlApiIngress).not.toContain('kubernetes.io/metadata.name: mcp-host')
    expect(controlApiIngress).not.toContain('app: channel-reader')
    expect(sharedHostGatewayPeer).toContain('namespaceSelector:')
    expect(sharedHostGatewayPeer).toContain('podSelector:')
    expect(sharedHostGatewayPeer).toContain('clerum.io/managed-by: host-context-controller')
    expect(workflowGatewayIngress).toMatch(/port:\s*8092/m)
  })

  it('does not route provider readers through the workflow approval gateway', () => {
    const controlPlaneDocs = yamlDocs(read(`${BASE}/control-plane/networkpolicies.yaml`))
    const controlApiIngress = docContaining(controlPlaneDocs, 'name: control-api-ingress')
    const workflowGatewayIngress = docContaining(
      controlPlaneDocs,
      'name: nginx-workflow-approval-gateway'
    )

    expect(controlApiIngress).not.toContain('app: channel-reader')
    expect(workflowGatewayIngress).not.toContain('app: channel-reader')
    expect(workflowGatewayIngress).not.toContain('workflow-approval-request-reader')
    expect(workflowGatewayIngress).toMatch(/port:\s*8092/m)

    const channelPolicyDocs = yamlDocs(readYamlBundle(`${BASE}/channels/networkpolicies`))
    const readerToMcpHost = docContaining(
      channelPolicyDocs,
      'name: workflow-approval-request-reader-to-mcp-host'
    )
    expect(readerToMcpHost).toContain('app.kubernetes.io/name: workflow-approval-request-reader')
    expect(readerToMcpHost).toContain('kubernetes.io/metadata.name: sandbox-recipes')
    expect(readerToMcpHost).toContain('clerum.io/component: workflow-mcp-host')
    expect(readerToMcpHost).toContain('clerum.io/managed-by: wrc')
    expect(readerToMcpHost).not.toContain('kubernetes.io/metadata.name: mcp-host')
    expect(readerToMcpHost).not.toContain('clerum.io/managed-by: host-context-controller')
    expect(readerToMcpHost).toMatch(/port:\s*8080/m)
    expect(readerToMcpHost).not.toContain('nginx-workflow-approval-gateway')

    const readerToChannelReader = docContaining(
      channelPolicyDocs,
      'name: workflow-approval-request-reader-to-channel-reader'
    )
    expect(readerToChannelReader).toContain(
      'app.kubernetes.io/name: workflow-approval-request-reader'
    )
    expect(readerToChannelReader).toContain('kubernetes.io/metadata.name: channels')
    expect(readerToChannelReader).toContain('app: channel-reader')
    expect(readerToChannelReader).toContain('clerum.io/managed-by: host-context-controller')
    expect(readerToChannelReader).toMatch(/port:\s*8099/m)

    const channelReaderHandoffIngress = docContaining(
      channelPolicyDocs,
      'name: channel-reader-handoff-ingress'
    )
    expect(channelReaderHandoffIngress).toContain('app: channel-reader')
    expect(channelReaderHandoffIngress).toContain(
      'app.kubernetes.io/name: workflow-approval-request-reader'
    )
    expect(channelReaderHandoffIngress).toMatch(/port:\s*8099/m)

    const configmaps = read(`${BASE}/control-plane/configmaps.yaml`)
    const gatewayConf = docContaining(yamlDocs(configmaps), 'name: nginx-workflow-approval-gateway')
    expect(gatewayConf).not.toContain('/api/v1/internal/notifications/deliveries')
    expect(gatewayConf).not.toContain('/api/v1/internal/notifications/workflow-approvals/resolve')
    expect(gatewayConf).not.toContain('/api/v1/internal/workflow-approval-mediums')
    expect(gatewayConf).toContain('location = /api/v1/workflow-approval-notifications/deliveries')
    expect(gatewayConf).toContain(
      'location = /api/v1/workflow-approval-mediums/telegram/challenges/confirm-provider-event'
    )
    expect(gatewayConf).toContain('proxy_set_header Authorization $http_authorization;')
  })

  it('keeps mcp-host public egress from covering private or special-use ranges', () => {
    const mcpHostPolicy = read(`${BASE}/mcp-host/networkpolicies.yaml`)
    const policy = docContaining(yamlDocs(mcpHostPolicy), 'name: mcp-host')

    expect(policy).toContain('cidr: 0.0.0.0/0')
    expect(policy).toContain('except: []')
    expectPublicEgressExceptionReplacement('mcp-host')
    expectCanonicalPublicEgressExceptions()
    expect(policy).not.toContain('kubernetes.io/metadata.name: mcp-server')
    expect(policy).not.toMatch(/port:\s*3000[\s\S]*kubernetes\.io\/metadata\.name:\s*mcp-server/m)
  })

  it('scopes static mcp-host infrastructure egress to HCC-managed mcp-host pods', () => {
    const docs = yamlDocs(read(`${BASE}/mcp-host/networkpolicies.yaml`))
    const dnsPolicy = docContaining(docs, 'name: allow-dns-egress-mcp-host')
    const k8sPolicy = docContaining(docs, 'name: allow-k8s-api-egress-mcp-host')

    expect(dnsPolicy).toContain('clerum.io/managed-by: host-context-controller')
    expect(k8sPolicy).toContain('clerum.io/managed-by: host-context-controller')
  })

  it('does not give every runtime workload access to the HCC API gateway', () => {
    const mcpServerDocs = yamlDocs(read(`${BASE}/mcp-server/networkpolicies.yaml`))
    const sandboxDocs = yamlDocs(read(`${BASE}/sandbox-recipes/networkpolicies.yaml`))
    const rpcProxyDocs = yamlDocs(read(`${BASE}/rpc-proxy/networkpolicies.yaml`))
    const mcpServerHccEgress = docContaining(mcpServerDocs, 'name: allow-hcc-api-egress-mcp-server')
    const sandboxHccEgress = docContaining(
      sandboxDocs,
      'name: allow-hcc-api-egress-sandbox-recipes'
    )
    const rpcProxyHccEgress = docContaining(rpcProxyDocs, 'name: allow-hcc-api-egress-rpc-proxy')

    expect(mcpServerHccEgress).toContain('app: mcp-proxy')
    expect(mcpServerHccEgress).not.toMatch(/podSelector:\s*\{\}/)
    expect(sandboxHccEgress).toContain('clerum.io/component: workflow-mcp-host')
    expect(sandboxHccEgress).not.toMatch(/podSelector:\s*\{\}/)
    expect(rpcProxyHccEgress).toContain('app: rpc-proxy')
    expect(rpcProxyHccEgress).not.toMatch(/podSelector:\s*\{\}/)
  })

  it.skipIf(!GKE_INFRA_PRESENT)(
    'patches the mcp-host Kubernetes API egress CIDR in GKE overlays',
    () => {
      const detectScript = read('../../deploy/scripts/gcp-detect-k8s-api-ip.sh')
      expect(detectScript).toContain("-name 'k8s-api-ip*.yaml'")

      for (const overlay of ['gcp-dev', 'gcp-prod']) {
        const kustomization = read(`${OVERLAYS}/${overlay}/kustomization.yaml`)
        const patch = read(`${OVERLAYS}/${overlay}/patches/k8s-api-ip-mcp-host.yaml`)

        expect(kustomization).toContain('patches/k8s-api-ip-mcp-host.yaml')
        expect(patch).toContain('name: allow-k8s-api-egress-mcp-host')
        expect(patch).toContain('namespace: mcp-host')
        expect(patch).toContain('cidr: 203.0.113.1/32')
        expect(patch).toContain('port: 443')
        expect(patch).toContain('port: 8443')
      }
    }
  )

  it('blocks direct ingress to host-context-controller except from its gateway', () => {
    const controlPlaneNp = read(`${BASE}/control-plane/networkpolicies.yaml`)
    const docs = yamlDocs(controlPlaneNp)
    const gatewayPolicy = docContaining(docs, 'name: host-context-controller-api-gateway')
    const directPolicy = docContaining(docs, 'name: host-context-controller-api-direct')

    expect(gatewayPolicy).toContain('name: host-context-controller-api-gateway')
    expect(gatewayPolicy).toContain('clerum.io/managed-by: host-context-controller')
    expect(gatewayPolicy).toContain('app: rpc-proxy')

    expect(directPolicy).toContain('name: host-context-controller-api-direct')
    expect(directPolicy).toContain('app: host-context-controller-api-gateway')
    expect(directPolicy).not.toContain('kubernetes.io/metadata.name: mcp-host')
  })

  it('whitelists only required host-context-controller gateway endpoints', () => {
    const configmaps = read(`${BASE}/control-plane/configmaps.yaml`)
    const hccGatewayConf = docContaining(
      yamlDocs(configmaps),
      'name: host-context-controller-api-gateway'
    )
    expect(hccGatewayConf).toContain('location = /health')
    expect(hccGatewayConf).toContain('location ~ ^/api/v1/mcpservers/context/[^/]+$')
    expect(hccGatewayConf).toContain('location ~ ^/api/v1/mcpservers/[^/]+/auth$')
    expect(hccGatewayConf).toContain('location / {')
    expect(hccGatewayConf).toContain('return 403;')
  })

  it('routes runtime workflow broker traffic through workflow gateway and not admin routes', () => {
    const configmaps = read(`${BASE}/control-plane/configmaps.yaml`)
    const workflowGatewayConf = docContaining(
      yamlDocs(configmaps),
      'name: nginx-workflow-approval-gateway'
    )

    expect(workflowGatewayConf).toContain('location = /api/v1/workflows')
    expect(workflowGatewayConf).toContain('location ~ ^/api/v1/workflows/[^/]+/[^/]+$')
    expect(workflowGatewayConf).toContain('location ~ ^/api/v1/workflows/[^/]+/[^/]+/health$')
    expect(workflowGatewayConf).toContain('location ~ ^/api/v1/workflows/runs/[^/]+/artifacts$')
    expect(workflowGatewayConf).toContain(
      'location ~ ^/api/v1/workflows/runs/[^/]+/artifacts/[^/]+/download$'
    )
    expect(workflowGatewayConf).toContain(
      'location ~ ^/api/v1/workflows/[^/]+/[^/]+/runs/latest/artifacts$'
    )
    expect(workflowGatewayConf).toContain(
      'location ~ ^/api/v1/workflows/[^/]+/[^/]+/runs/latest/artifacts/[^/]+/content$'
    )
    expect(workflowGatewayConf).toContain(
      'location ~ ^/api/v1/workflows/[^/]+/[^/]+/runs/latest/artifacts/[^/]+/download$'
    )
    expect(workflowGatewayConf).toContain('location ~ ^/api/v1/workflows/[^/]+/[^/]+/trigger$')
    expect(workflowGatewayConf).toContain('location = /api/v1/workflow-approval-mediums/resolve')
    expect(workflowGatewayConf).toContain(
      'location ~ ^/api/v1/workflow-approvals/[^/]+/provider-decision$'
    )
    expect(workflowGatewayConf).toContain('proxy_set_header Idempotency-Key $http_idempotency_key;')
    expect(workflowGatewayConf).not.toContain('/api/v1/admin/workflows')
  })

  it('keeps workflow approval gateway observable without logging authorization material', () => {
    const configmaps = read(`${BASE}/control-plane/configmaps.yaml`)
    const workflowGatewayConf = docContaining(
      yamlDocs(configmaps),
      'name: nginx-workflow-approval-gateway'
    )

    expect(workflowGatewayConf).toContain('log_format workflow_gateway_json')
    expect(workflowGatewayConf).toContain('"request_id":"$request_id"')
    expect(workflowGatewayConf).toContain('"uri":"$uri"')
    expect(workflowGatewayConf).toContain('"status":$status')
    expect(workflowGatewayConf).toContain('"upstream_status":"$upstream_status"')
    expect(workflowGatewayConf).toContain('access_log /dev/stdout workflow_gateway_json;')
    expect(workflowGatewayConf).toContain('proxy_connect_timeout 5s;')
    expect(workflowGatewayConf).toContain('proxy_read_timeout 30s;')
    expect(workflowGatewayConf).toContain('proxy_send_timeout 30s;')
    expect(workflowGatewayConf).not.toContain('$http_authorization"')
    expect(workflowGatewayConf).not.toContain('$http_x_service_token"')
  })

  it('allows 1st-party AuthN, 3rd-party MCP-Host sandbox workflow mcp-hosts to reach only the workflow approval gateway', () => {
    const sandboxDocs = yamlDocs(read(`${BASE}/sandbox-recipes/networkpolicies.yaml`))
    const approvalGatewayEgress = docContaining(
      sandboxDocs,
      'name: allow-workflow-approval-gateway-egress-sandbox-recipes'
    )

    expect(approvalGatewayEgress).toContain('namespace: sandbox-recipes')
    expect(approvalGatewayEgress).toContain('clerum.io/component: workflow-mcp-host')
    expect(approvalGatewayEgress).toContain('kubernetes.io/metadata.name: control-plane')
    expect(approvalGatewayEgress).toContain('app: nginx-workflow-approval-gateway')
    expect(approvalGatewayEgress).toMatch(/port:\s*8092/m)
    expect(approvalGatewayEgress).not.toContain('app: control-api')
    expect(approvalGatewayEgress).not.toMatch(/port:\s*8090/m)

    const sandboxEgressPolicies = sandboxDocs.filter(
      doc =>
        doc.includes('kind: NetworkPolicy') &&
        doc.includes('policyTypes:') &&
        doc.includes('- Egress')
    )
    for (const policy of sandboxEgressPolicies) {
      expect(policy).not.toContain('app: control-api')
      expect(policy).not.toMatch(/port:\s*8090/m)
    }
  })

  it('keeps 1st-party AuthN, 3rd-party MCP-Host sandbox workflow mcp-hosts out of direct control-api ingress', () => {
    const docs = yamlDocs(read(`${BASE}/control-plane/networkpolicies.yaml`))
    const controlApiIngress = docContaining(docs, 'name: control-api-ingress')
    const workflowGatewayIngress = docContaining(docs, 'name: nginx-workflow-approval-gateway')
    const sandboxBrokerIngress = fromPeerBlock(
      controlApiIngress,
      'kubernetes.io/metadata.name: sandbox-recipes'
    )

    expect(controlApiIngress).toContain('app: control-api')
    expect(controlApiIngress).not.toContain('clerum.io/component: workflow-mcp-host')
    expect(sandboxBrokerIngress).toContain('namespaceSelector:')
    expect(sandboxBrokerIngress).toContain('podSelector:')
    expect(sandboxBrokerIngress).toContain('clerum.io/oauth-broker-client: "true"')

    expect(workflowGatewayIngress).toContain('kubernetes.io/metadata.name: sandbox-recipes')
    expect(workflowGatewayIngress).toContain('clerum.io/component: workflow-mcp-host')
    expect(workflowGatewayIngress).toMatch(/port:\s*8092/m)
  })

  it('routes workflow approval reader traffic only to scoped targets', () => {
    const controlPlaneNp = read(`${BASE}/control-plane/networkpolicies.yaml`)
    const docs = yamlDocs(controlPlaneNp)
    const controlApiIngress = docContaining(docs, 'name: control-api-ingress')
    const workflowGatewayIngress = docContaining(docs, 'name: nginx-workflow-approval-gateway')
    const mcpHostNp = read(`${BASE}/mcp-host/networkpolicies.yaml`)
    const mcpHostPolicy = docContaining(yamlDocs(mcpHostNp), 'name: mcp-host')

    expect(controlApiIngress).toContain('name: control-api-ingress')
    // Figure D cross-bot fix (PR1, Opción B-completa): the reader NOW reaches
    // control-api for a READ-ONLY consulta (GET /internal/workflow-approval-reader/
    // approvals/:id/can-approve, spec §10.3 step 6). Authenticated with the
    // workflow-approval-reader internal-service token (same pattern as rpc-proxy).
    // The reader still does NOT transmit decisions to control-api (that goes via
    // the WorkflowRecipe mcp-host) and does NOT reach the nginx workflow-approval
    // gateway.
    expect(controlApiIngress).toContain('app.kubernetes.io/name: workflow-approval-request-reader')

    expect(workflowGatewayIngress).toContain('name: nginx-workflow-approval-gateway')
    expect(workflowGatewayIngress).not.toContain(
      'app.kubernetes.io/name: workflow-approval-request-reader'
    )
    expect(mcpHostPolicy).not.toContain('kubernetes.io/metadata.name: channels')
    expect(mcpHostPolicy).not.toContain('app.kubernetes.io/name: workflow-approval-request-reader')
    expect(mcpHostPolicy).not.toMatch(/port:\s*8080/m)

    const channelPolicies = readYamlBundle(`${BASE}/channels/networkpolicies`)
    const readerEgress = docContaining(
      yamlDocs(channelPolicies),
      'name: workflow-approval-request-reader-to-mcp-host'
    )
    expect(readerEgress).toContain('kubernetes.io/metadata.name: sandbox-recipes')
    expect(readerEgress).toContain('clerum.io/component: workflow-mcp-host')
    expect(readerEgress).toContain('clerum.io/managed-by: wrc')
    expect(readerEgress).not.toContain('kubernetes.io/metadata.name: mcp-host')
    expect(readerEgress).not.toContain('clerum.io/managed-by: host-context-controller')
    expect(readerEgress).toMatch(/port:\s*8080/m)

    const sandboxPolicies = read(`${BASE}/sandbox-recipes/networkpolicies.yaml`)
    const readerIngress = docContaining(
      yamlDocs(sandboxPolicies),
      'name: allow-workflow-approval-reader-to-workflow-mcp-host'
    )
    expect(readerIngress).toContain('kubernetes.io/metadata.name: channels')
    expect(readerIngress).toContain('app.kubernetes.io/name: workflow-approval-request-reader')
    expect(readerIngress).toContain('clerum.io/component: workflow-mcp-host')
    expect(readerIngress).toContain('clerum.io/managed-by: wrc')
    expect(readerIngress).not.toContain('clerum.io/managed-by: host-context-controller')
    expect(readerIngress).toMatch(/port:\s*8080/m)
  })

  it('limits WRC ingress from sandbox-recipes to workflow coordinator pods', () => {
    const controlPlaneNp = read(`${BASE}/control-plane/networkpolicies.yaml`)
    const policy = docContaining(yamlDocs(controlPlaneNp), 'name: allow-coordinator-to-wrc-ingress')

    expect(policy).toContain('kubernetes.io/metadata.name: sandbox-recipes')
    expect(policy).toContain('clerum.io/component: workflow-coordinator')
    expect(policy).toContain('port: 8082')
  })

  it('allows ingress-nginx to reach workflow approval reader webhooks', () => {
    const channelPolicies = readYamlBundle(`${BASE}/channels/networkpolicies`)
    const readerIngress = docContaining(
      yamlDocs(channelPolicies),
      'name: workflow-approval-request-reader-ingress'
    )

    expect(readerIngress).toContain('app.kubernetes.io/name: workflow-approval-request-reader')
    expect(readerIngress).toContain('kubernetes.io/metadata.name: ingress-nginx')
    expect(readerIngress).toMatch(/port:\s*8098/m)
    expect(readerIngress).toContain('- Ingress')
  })

  it('keeps workflow approval reader service exposure in separate manifest files', () => {
    const kustomization = read(`${BASE}/channels/kustomization.yaml`)
    const deployment = read(`${BASE}/channels/workflow-approval-request-reader/deployment.yaml`)
    const service = read(`${BASE}/channels/workflow-approval-request-reader/service.yaml`)
    const serviceAccount = read(
      `${BASE}/channels/workflow-approval-request-reader/serviceaccount.yaml`
    )

    expect(kustomization).toContain('workflow-approval-request-reader/deployment.yaml')
    expect(kustomization).toContain('workflow-approval-request-reader/service.yaml')
    expect(kustomization).toContain('workflow-approval-request-reader/serviceaccount.yaml')
    expect(deployment).toContain('kind: Deployment')
    expect(deployment).not.toContain('kind: Service')
    expect(deployment).not.toContain('kind: ServiceAccount')
    expect(service).toContain('kind: Service')
    expect(service).toContain('type: ClusterIP')
    expect(service).toContain('targetPort: http')
    expect(serviceAccount).toContain('kind: ServiceAccount')
  })

  it('grants WRC only the deletecollection verbs it needs for mcp-server finalizer cleanup', () => {
    const rbac = read(`${BASE}/mcp-server/rbac.yaml`)
    const workflowRecipesRole = docContaining(yamlDocs(rbac), 'name: workflow-recipes')
    const mcpServersRule = ruleBlock(workflowRecipesRole, 'resources: ["mcpservers"]')
    const contextsRule = ruleBlock(workflowRecipesRole, 'resources: ["contexts"]')
    const servicesRule = ruleBlock(workflowRecipesRole, 'resources: ["services"]')
    const configResourcesRule = ruleBlock(
      workflowRecipesRole,
      'resources: ["persistentvolumeclaims", "configmaps"]'
    )
    const networkPoliciesRule = ruleBlock(workflowRecipesRole, 'resources: ["networkpolicies"]')

    expect(mcpServersRule).toContain(
      'verbs: ["get", "list", "create", "update", "delete", "deletecollection"]'
    )
    expect(servicesRule).toContain(
      'verbs: ["get", "list", "create", "update", "delete", "deletecollection"]'
    )
    expect(networkPoliciesRule).toContain(
      'verbs: ["get", "list", "create", "update", "delete", "deletecollection"]'
    )
    expect(contextsRule).toContain('verbs: ["get", "list", "create", "update", "patch", "delete"]')
    expect(contextsRule).not.toContain('deletecollection')
    expect(configResourcesRule).not.toContain('deletecollection')
  })

  it('keeps WorkflowRecipe parent mutation out of mcp-server RBAC', () => {
    const mcpServerRbac = read(`${BASE}/mcp-server/rbac.yaml`)
    const docs = yamlDocs(mcpServerRbac)
    const controlApiRole = docContaining(docs, 'name: control-api')
    const controlApiMcpResourcesRole = docContaining(docs, 'name: control-api-mcp-resources')
    const workflowRecipesRole = docContaining(docs, 'name: workflow-recipes')

    expect(controlApiRole).not.toContain('workflowrecipes')
    expect(controlApiMcpResourcesRole).not.toContain('workflowrecipes')
    expect(workflowRecipesRole).not.toContain('resources: ["workflowrecipes"]')
    expect(workflowRecipesRole).not.toContain('workflowrecipes/status')
  })

  it('grants WorkflowRecipe parent mutation only through sandbox-recipes RBAC', () => {
    const sandboxRbac = read(`${BASE}/sandbox-recipes/rbac.yaml`)
    const sandboxRole = docContaining(yamlDocs(sandboxRbac), 'name: workflow-recipes-sandbox')
    expect(sandboxRole).toContain('resources: ["workflowrecipes"]')
    expect(sandboxRole).toContain(
      'verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]'
    )
    expect(sandboxRole).toContain('resources: ["workflowrecipes/status"]')

    const clusterRoles = read(`${BASE}/cluster-wide/clusterroles.yaml`)
    const clusterDocs = yamlDocs(clusterRoles)
    const controlApiClusterRole = docContaining(clusterDocs, 'name: control-api')
    const wrcMutator = docContaining(clusterDocs, 'name: workflow-recipes-ns-mutator')

    expect(controlApiClusterRole).not.toContain('\n  - workflowrecipes')
    expect(wrcMutator).not.toContain('workflowrecipes')
  })

  it('limits control-api patch to Host CRDs', () => {
    const clusterRoles = read(`${BASE}/cluster-wide/clusterroles.yaml`)
    const controlApiRole = docContaining(yamlDocs(clusterRoles), 'name: control-api')

    expect(roleRuleForResource(controlApiRole, 'hosts')).toContain('  - patch')
    for (const resource of ['contexts', 'communicationchannels', 'mcpservers']) {
      expect(roleRuleForResource(controlApiRole, resource)).not.toContain('  - patch')
    }
  })

  it('routes every rpc-proxy internal-service endpoint through the control-api-rpc-gateway allowlist', () => {
    const configmaps = read(`${BASE}/control-plane/configmaps.yaml`)
    const gatewayConf = docContaining(yamlDocs(configmaps), 'name: control-api-rpc-gateway')
    const locations = gatewayAllowlistLocations(gatewayConf)
    const routes = rpcProxyRoutes()

    // Fail loudly if the extractor matched nothing — a broken regex would otherwise
    // make this guard pass vacuously.
    expect(routes.length).toBeGreaterThanOrEqual(5)

    // Every requireInternalService('rpc-proxy') route needs an allowlist location or
    // rpc-proxy's call is denied at the edge. A failure lists each route missing a
    // `location` in deploy/base/control-plane/configmaps.yaml (control-api-rpc-gateway).
    const missing = routes
      .filter(route => !routeIsAllowlisted(route, locations))
      .map(route => `${route.method} ${route.path}  (${route.file.replace('../', 'control-api/')})`)
    expect(missing).toEqual([])
  })
})
