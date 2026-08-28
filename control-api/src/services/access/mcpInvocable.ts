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
 *       - `spec.auth.type` is on the allowlist — absent/`"none"`/`"oauth"`
 *         (`bearer`/`basic`/`apiKey` are excluded). U3, mini-spec 04.
 *       - `spec.transport.url` is a non-empty string
 *   - **rpc-proxy rail only** (`resolveInvocableMcpServersForContexts`): an
 *     `oauth` server additionally requires a valid grant for the caller,
 *     computed by flavor (`grantScope`) and passed into the pure filter as data
 *     (`grantPresence`). The catalog rail (`resolveMcpServersForAgents`) skips
 *     this gate — its isolation is the JIT token resolution (U4), not this
 *     filter.
 *   - Session catalog preserves names-only compatibility while enriching each
 *     authorized agent with its canonical directory identity; RPC catalog
 *     additionally returns the transport URL.
 */
import type { DbClient } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import { buildMcpServerGrantKey, resolveServerOAuth } from '../../oauth/mcpServerOAuthSpec.js'
import { oauthGrantExists } from '../../oauth/store.js'
import { rootLogger } from '../../observability/logger.js'
import {
  type AgentDirectoryEntry,
  buildAgentDirectoryEntry,
} from '../directory/accessReconciliation.js'

const log = rootLogger.child({ module: 'mcpInvocable' })

export interface InvocableMcpServer {
  name: string
  url: string
}

export interface AgentWithMcpServers extends AgentDirectoryEntry {
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
    // OAuth coordinates (U1). Read only for the rpc-proxy grant-presence gate;
    // the catalog rail never inspects them. Structurally compatible with
    // `resolveServerOAuth`'s input.
    oauth?: {
      id?: unknown
      grantScope?: unknown
    }
    contextRef?: unknown
  }
}

interface HostCR {
  metadata?: {
    name?: string
    namespace?: string
    deletionTimestamp?: string | null
  }
  spec?: { contextRef?: string; enabled?: boolean; host?: string }
}

/**
 * Recognize the stable Kubernetes "resource does not exist" signal without
 * confusing RBAC, API availability, or transport failures with deletion.
 * The client and gateway wrappers used by Control API expose 404 in several
 * compatible shapes, so classification must inspect the status fields rather
 * than error text.
 */
export function isK8sResourceNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as {
    name?: unknown
    statusCode?: unknown
    code?: unknown
    body?: { code?: unknown }
    response?: { status?: unknown; statusCode?: unknown; body?: { code?: unknown } }
  }
  return (
    candidate.name === 'K8sNotFoundError' ||
    candidate.statusCode === 404 ||
    candidate.code === 404 ||
    candidate.body?.code === 404 ||
    candidate.response?.status === 404 ||
    candidate.response?.statusCode === 404 ||
    candidate.response?.body?.code === 404
  )
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
 *
 * PURE + total — the only I/O is done by the caller, which passes its result in
 * as `grantPresence` (the "identity as data" pattern, mini-spec 04 §2).
 *
 * Auth-type allowlist: admits `none` (or absent) and `oauth`; still EXCLUDES
 * `bearer`/`basic`/`apiKey`. This runs on BOTH rails.
 *
 * Grant-presence gate (rpc-proxy rail ONLY): when `grantPresence` is provided,
 * an `oauth` server is invocable IFF its name is in the set. When `grantPresence`
 * is ABSENT (catalog rail, `resolveMcpServersForAgents`), the gate is skipped and
 * oauth servers pass on the auth-type allowlist alone — that rail's isolation is
 * the JIT token resolution (U4), not this filter.
 */
export function filterInvocable(
  names: ReadonlySet<string>,
  servers: McpServerCR[],
  mcpServersNamespace: string,
  grantPresence?: ReadonlySet<string>
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
    // Allowlist: absent/`none`/`oauth` admitted; `bearer`/`basic`/`apiKey` excluded.
    if (authType && authType !== 'none' && authType !== 'oauth') continue
    // rpc-proxy grant-presence gate: an oauth server needs a valid grant, passed
    // as data by the resolver. Fail-closed — not in the set means not invocable.
    if (grantPresence && authType === 'oauth' && !grantPresence.has(name)) continue
    if (!resolveServerUrl(s, mcpServersNamespace)) continue
    out.add(name)
  }
  return out
}

/**
 * Compute the set of candidate server names that have a valid OAuth grant for
 * this caller, by flavor (mini-spec 04 §2 step 3). Non-oauth servers are never
 * added here (the auth-type allowlist governs them). FAIL-CLOSED throughout: a
 * missing oauth id / contextRef, an unknown grantScope, or a DB error EXCLUDES
 * the server (it is simply not added to the set), so the rpc-proxy gate treats
 * it as un-serviceable rather than propagating a 500 for the whole request.
 *
 * The `user` branch is fully exercised in v1. The `context` (shared-grant)
 * branch is implemented + covered by the pure property test here; its
 * cross-service, end-to-end activation is exercised by U6(api).
 */
async function computeGrantPresence(
  db: DbClient,
  mcpServersNamespace: string,
  callerUserId: string,
  servers: McpServerCR[],
  candidateNames: ReadonlySet<string>
): Promise<Set<string>> {
  const byName = new Map<string, McpServerCR>()
  for (const s of servers) {
    const n = s.metadata?.name
    if (n) byName.set(n, s)
  }

  const present = new Set<string>()
  for (const name of candidateNames) {
    const s = byName.get(name)
    if (!s) continue
    // Only oauth servers are grant-gated; `none` servers pass on the allowlist.
    if (s.spec?.auth?.type !== 'oauth') continue
    const resolved = resolveServerOAuth(s)
    if (!resolved) continue // fail-closed: no usable oauth id
    // Same key derivation (D4) as the mint and the grant-existence sweep. Shared
    // (`context`) identity is keyed by the server's AUTHORITATIVE `contextRef`,
    // decoupled from the caller's userId (mini-spec 04 §2 3b; exercised by
    // U6(api)); a context server without a contextRef yields null → fail-closed.
    const key = buildMcpServerGrantKey(resolved, {
      mcpServerName: name,
      mcpServersNamespace,
      userId: callerUserId,
    })
    if (!key) continue // fail-closed: missing grant coordinate for the flavor

    try {
      if (await oauthGrantExists(db, key)) present.add(name)
    } catch (err) {
      // A grant-check DB error excludes THIS server (fail-closed) rather than
      // failing the whole request — loudly, matching the sibling resolver's
      // observable-degradation posture (`resolveMcpServersForAgents`).
      log.error(
        { err, mcpServerName: name },
        'grant-presence check failed; server excluded from rpc-proxy rail'
      )
    }
  }
  return present
}

/**
 * Flat list of invocable `{name, url}` for the given scoped context ids.
 * Used by `/rpc/access/users/:id/mcp-servers` — the rpc-proxy rail, so it
 * additionally applies the OAuth grant-presence gate (mini-spec 04).
 */
export async function resolveInvocableMcpServersForContexts(
  gateway: K8sGateway,
  mcpServersNamespace: string,
  scopedContextIds: readonly string[],
  callerUserId: string,
  db: DbClient
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
  const grantPresence = await computeGrantPresence(
    db,
    mcpServersNamespace,
    callerUserId,
    serverList,
    union
  )
  const invocable = filterInvocable(union, serverList, mcpServersNamespace, grantPresence)

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
 * Returns valid, active entries in the same order as `agentNames`. Each Host is
 * fetched by its already-authorized name; this resolver never lists or
 * serializes Hosts outside the caller's authorization result.
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

  const resolvedHosts = await Promise.all(
    agentNames.map(async requestedName => {
      try {
        const host = (await gateway.getResource('hosts', requestedName, hostsNamespace)) as HostCR
        const directoryEntry = buildAgentDirectoryEntry(host, hostsNamespace)
        if (!directoryEntry || directoryEntry.name !== requestedName) return null
        return { host, directoryEntry }
      } catch (error) {
        if (isK8sResourceNotFound(error)) return null
        // A non-404 failure says nothing about whether this already-authorized
        // Host still exists. Propagate it so callers can preserve their
        // names-only compatibility field instead of silently revoking access.
        throw error
      }
    })
  )

  let serverList: McpServerCR[] = []
  try {
    serverList = asArray<McpServerCR>(await gateway.listResource('mcpservers', mcpServersNamespace))
  } catch (err) {
    // Directory identity remains useful when optional MCP catalog enrichment
    // is temporarily unavailable — but the degradation must be observable, or
    // a broken mcpservers list path reads as "this agent has no tools".
    console.error(
      '[mcpInvocable] mcpservers list failed; directory served without MCP catalog:',
      err instanceof Error ? err.message : String(err)
    )
  }

  const visibleHosts = resolvedHosts.filter(
    (
      item
    ): item is {
      host: HostCR
      directoryEntry: AgentDirectoryEntry
    } => item !== null
  )

  const scopedContextIds = new Set<string>()
  for (const { host } of visibleHosts) {
    const contextRef = host.spec?.contextRef
    if (contextRef) scopedContextIds.add(contextRef)
  }

  let allowedByContext = new Map<string, Set<string>>()
  if (scopedContextIds.size > 0) {
    try {
      allowedByContext = await loadAllowedNamesByContext(
        gateway,
        mcpServersNamespace,
        scopedContextIds
      )
    } catch (err) {
      // Preserve the authorized directory DTOs with an empty tool catalog —
      // loudly, so a Context-read outage is distinguishable from "no tools".
      console.error(
        '[mcpInvocable] context allowlist load failed; directory served with empty tool catalogs:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  return visibleHosts.map(({ host, directoryEntry }) => {
    const contextRef = host?.spec?.contextRef ?? null
    if (!contextRef) {
      return { ...directoryEntry, contextRef, mcpServers: [] }
    }
    const allowed = allowedByContext.get(contextRef)
    if (!allowed || allowed.size === 0) {
      return { ...directoryEntry, contextRef, mcpServers: [] }
    }
    const invocable = filterInvocable(allowed, serverList, mcpServersNamespace)
    const names = [...invocable].sort((a, b) => a.localeCompare(b))
    return {
      ...directoryEntry,
      contextRef,
      mcpServers: names.map(name => ({ name })),
    }
  })
}
