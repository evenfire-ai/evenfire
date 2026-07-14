/**
 * Shared MCP-invocability resolver.
 *
 * Both the RPC catalog (`GET /rpc/access/users/:id/mcp-servers`) and the
 * session catalog (`GET /external/users/:userId/agents`, …/teams/…) resolve
 * "which MCP servers is this principal allowed to invoke" from the same
 * rules, so they MUST call into this module. Spec §6.
 *
 * Rules:
 *   - A server is **allowed** if any Context CR whose `spec.contextId` is in
 *     the scoped context-ids lists it in `spec.mcpServers`.
 *   - A server is **invocable** if it's allowed AND:
 *       - `spec.enabled !== false`
 *       - `spec.auth.type` is absent or equals `"none"`
 *       - `spec.transport.url` is a non-empty string
 *   - Session catalog returns **names only**; RPC catalog additionally returns
 *     the transport URL.
 */
import type { K8sGateway } from '../../k8s.js'

export interface InvocableMcpServer {
  name: string
  url: string
}

export interface AgentWithMcpServers {
  name: string
  contextRef: string | null
  mcpServers: Array<{ name: string }>
}

interface ContextCR {
  spec?: { contextId?: string; mcpServers?: unknown[] }
}

interface McpServerCR {
  metadata?: { name?: string }
  spec?: {
    enabled?: boolean
    auth?: { type?: string }
    transport?: { type?: string; url?: string }
  }
}

interface HostCR {
  metadata?: { name?: string }
  spec?: { contextRef?: string }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/**
 * Resolve the set of allowed server names per context.
 * When `scopedContextIds` is provided, contexts NOT in scope are dropped.
 * When omitted, every context in the namespace is indexed — appropriate when
 * the caller authorizes by agent rather than by context.
 */
async function loadAllowedNamesByContext(
  gateway: K8sGateway,
  mcpServersNamespace: string,
  scopedContextIds?: ReadonlySet<string>
): Promise<Map<string, Set<string>>> {
  const contexts = asArray<ContextCR>(await gateway.listResource('contexts', mcpServersNamespace))
  const byContext = new Map<string, Set<string>>()
  for (const ctx of contexts) {
    const ctxId = ctx.spec?.contextId
    if (!ctxId) continue
    if (scopedContextIds && !scopedContextIds.has(ctxId)) continue
    const set = new Set<string>()
    for (const name of ctx.spec?.mcpServers || []) {
      if (typeof name === 'string' && name.trim()) set.add(name.trim())
    }
    byContext.set(ctxId, set)
  }
  return byContext
}

/**
 * Derive the invocation URL for an MCP server. stdio-transport servers are
 * proxied by an in-namespace stdio-bridge sidecar on a well-known path, so
 * the CR's `transport.url` is blank by design — mcp-host applies the same
 * default. HTTP-transport servers MUST carry a URL on the CR.
 */
function resolveServerUrl(s: McpServerCR, mcpServersNamespace: string): string | null {
  const transportType = s.spec?.transport?.type
  const rawUrl = s.spec?.transport?.url
  if (typeof rawUrl === 'string' && rawUrl.trim()) return rawUrl.trim()
  if (transportType === 'stdio' && s.metadata?.name) {
    return `http://${s.metadata.name}.${mcpServersNamespace}.svc.cluster.local:3000/mcp`
  }
  return null
}

/**
 * Intersect a name set with the "invocable" filter on McpServer CRs.
 * Returns a new Set of just the invocable names.
 */
function filterInvocable(
  names: ReadonlySet<string>,
  servers: McpServerCR[],
  mcpServersNamespace: string
): Set<string> {
  const byName = new Map<string, McpServerCR>()
  for (const s of servers) {
    const n = s.metadata?.name
    if (n) byName.set(n, s)
  }
  const out = new Set<string>()
  for (const name of names) {
    const s = byName.get(name)
    if (!s) continue
    if (s.spec?.enabled === false) continue
    const authType = s.spec?.auth?.type
    if (authType && authType !== 'none') continue
    if (!resolveServerUrl(s, mcpServersNamespace)) continue
    out.add(name)
  }
  return out
}

/**
 * Flat list of invocable `{name, url}` for the given scoped context ids.
 * Used by `/rpc/access/users/:id/mcp-servers`.
 */
export async function resolveInvocableMcpServersForContexts(
  gateway: K8sGateway,
  mcpServersNamespace: string,
  scopedContextIds: readonly string[]
): Promise<InvocableMcpServer[]> {
  const scoped = new Set(scopedContextIds)
  if (scoped.size === 0) return []

  const [allowedByContext, mcpServers] = await Promise.all([
    loadAllowedNamesByContext(gateway, mcpServersNamespace, scoped),
    gateway.listResource('mcpservers', mcpServersNamespace),
  ])
  const serverList = asArray<McpServerCR>(mcpServers)

  const union = new Set<string>()
  for (const names of allowedByContext.values()) {
    for (const name of names) union.add(name)
  }
  const invocable = filterInvocable(union, serverList, mcpServersNamespace)

  const byName = new Map<string, McpServerCR>()
  for (const s of serverList) {
    const n = s.metadata?.name
    if (n) byName.set(n, s)
  }

  const out: InvocableMcpServer[] = []
  for (const name of invocable) {
    const server = byName.get(name)
    if (!server) continue
    const url = resolveServerUrl(server, mcpServersNamespace)
    if (url) out.push({ name, url })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * For each agent name, return its Host's contextRef and the invocable MCP
 * server names exposed by that context.
 *
 * Authorization model: agent access IS the gate. The caller MUST only pass
 * `agentNames` the principal is authorized to use (e.g. from getUserAgents /
 * getTeamAgents). If the principal can invoke the agent, they can see the
 * catalog of tools the agent exposes — no separate context authorization
 * is required. Passing an unauthorized agentName leaks that agent's MCP
 * server names.
 *
 * Returns one entry per input `agentNames` in the same order.
 */
export async function resolveMcpServersForAgents(
  gateway: K8sGateway,
  opts: {
    mcpServersNamespace: string
    hostsNamespace: string
    agentNames: readonly string[]
  }
): Promise<AgentWithMcpServers[]> {
  const { mcpServersNamespace, hostsNamespace, agentNames } = opts
  if (agentNames.length === 0) return []

  const [hosts, mcpServers] = await Promise.all([
    gateway.listResource('hosts', hostsNamespace),
    gateway.listResource('mcpservers', mcpServersNamespace),
  ])
  const hostList = asArray<HostCR>(hosts)
  const serverList = asArray<McpServerCR>(mcpServers)

  const hostByName = new Map<string, HostCR>()
  for (const h of hostList) {
    const n = h.metadata?.name
    if (n) hostByName.set(n, h)
  }

  const scopedContextIds = new Set<string>()
  for (const agentName of agentNames) {
    const contextRef = hostByName.get(agentName)?.spec?.contextRef
    if (contextRef) scopedContextIds.add(contextRef)
  }

  const allowedByContext =
    scopedContextIds.size === 0
      ? new Map<string, Set<string>>()
      : await loadAllowedNamesByContext(gateway, mcpServersNamespace, scopedContextIds)

  return agentNames.map(agentName => {
    const host = hostByName.get(agentName)
    const contextRef = host?.spec?.contextRef ?? null
    if (!contextRef) {
      return { name: agentName, contextRef, mcpServers: [] }
    }
    const allowed = allowedByContext.get(contextRef)
    if (!allowed || allowed.size === 0) {
      return { name: agentName, contextRef, mcpServers: [] }
    }
    const invocable = filterInvocable(allowed, serverList, mcpServersNamespace)
    const names = [...invocable].sort((a, b) => a.localeCompare(b))
    return {
      name: agentName,
      contextRef,
      mcpServers: names.map(name => ({ name })),
    }
  })
}
