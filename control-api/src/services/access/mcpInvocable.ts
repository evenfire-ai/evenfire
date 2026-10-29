/**
 * Shared MCP-invocability resolver.
 *
 * Both the RPC catalog (`GET /rpc/access/users/:id/mcp-servers`) and the
 * session catalog (`GET /external/users/:userId/agents`, …/teams/…) resolve
 * "which MCP servers is this principal allowed to invoke" from the same
 * rules, so they MUST call into this module. Spec §6.
 *
 * Rules:
 *   - A server is **allowed** if any live Context CR whose `metadata.name` is in
 *     the scoped context ids lists it, exactly, in `spec.mcpServers`.
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
import {
  type GrantScope,
  buildMcpServerGrantKey,
  resolveServerOAuth,
} from '../../oauth/mcpServerOAuthSpec.js'
import { oauthGrantExists } from '../../oauth/store.js'
import { rootLogger } from '../../observability/logger.js'
import {
  type AgentDirectoryEntry,
  buildAgentDirectoryEntry,
} from '../directory/accessReconciliation.js'
import { getUserAgents } from '../directory/agentAccess.js'
import { getUserContexts } from '../directory/contextAccess.js'
import { isCanonicalUuid, isLive, isValidK8sName } from './brokerHostBinding.js'

const log = rootLogger.child({ module: 'mcpInvocable' })
const connectorsLog = rootLogger.child({ module: 'mcp-connectors' })

export interface InvocableMcpServer {
  name: string
  url: string
}

export interface AgentWithMcpServers extends AgentDirectoryEntry {
  contextRef: string | null
  mcpServers: Array<{ name: string }>
}

/**
 * Tri-state authorization status of one connector for the proactive panel
 * (spec 11 U1). Derived, never invented:
 *   - `no_oauth`       — the server is not governed by this OAuth rail
 *                        (`resolveServerOAuth` = null, i.e. static/none/no id).
 *   - `authorized`     — an OAuth server WITH a valid grant by its flavor.
 *   - `requires_setup` — an OAuth server WITHOUT a grant (the "needs-connect").
 * The `authorized`/`requires_setup` split comes SOLELY from `oauthGrantExists`
 * over `oauth_grants` (the same authoritative source the LLM rail reads for
 * `no_grant`, D4) — there is no parallel "connected" computation.
 */
export type ConnectorStatus = 'authorized' | 'requires_setup' | 'no_oauth'

/**
 * One connector row: a READ-MODEL projection that classifies instead of
 * filtering, so a `requires_setup` server NEVER disappears from the list.
 * Carries only NON-SECRET policy (`authKind`, `provider`, `grantScope`) — never
 * `auth`/`secretRef`/tokens (spec §1.4).
 */
export interface ConnectorEntry {
  name: string
  provider?: string
  authKind?: 'static' | 'oauth-user' | 'oauth-context'
  grantScope?: GrantScope
  status: ConnectorStatus
}

export interface AgentWithConnectors extends AgentDirectoryEntry {
  contextRef: string | null
  connectors: ConnectorEntry[]
}

interface ContextCR {
  metadata?: { name?: unknown; deletionTimestamp?: unknown }
  spec?: { mcpServers?: unknown }
}

interface McpServerCR {
  metadata?: { name?: string; uid?: string }
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
      // Non-secret provider label (e.g. 'google'). Surfaced verbatim to the
      // panel; never gates oauth-ness (that is `id` via `resolveServerOAuth`).
      provider?: unknown
    }
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

interface VisibleAgentHost {
  host: HostCR
  directoryEntry: AgentDirectoryEntry
}

/**
 * The Hosts behind already-authorized agent names that the agent directory
 * would show (same order as `agentNames`): disabled, deleting, foreign-namespace
 * and sentinel Hosts, and Hosts whose directory name differs from the requested
 * one, are dropped. A 404 drops the agent; any other read failure propagates,
 * because it says nothing about whether the Host still exists.
 *
 * Shared by the per-agent catalogs and the per-user consent gate so that every
 * Host a catalog shows is a Host the gate counts.
 */
async function loadVisibleAgentHosts(
  gateway: Pick<K8sGateway, 'getResource'>,
  hostsNamespace: string,
  agentNames: readonly string[]
): Promise<VisibleAgentHost[]> {
  const resolved = await Promise.all(
    agentNames.map(async (requestedName): Promise<VisibleAgentHost | null> => {
      try {
        const host = (await gateway.getResource('hosts', requestedName, hostsNamespace)) as HostCR
        const directoryEntry = buildAgentDirectoryEntry(host, hostsNamespace)
        if (!directoryEntry || directoryEntry.name !== requestedName) return null
        return { host, directoryEntry }
      } catch (error) {
        if (isK8sResourceNotFound(error)) return null
        throw error
      }
    })
  )
  return resolved.filter((item): item is VisibleAgentHost => item !== null)
}

/**
 * The allowlist a Context grants, compared exactly as the broker and
 * host-context-controller compare it: an entry that only matches after trimming
 * names no server.
 */
function contextAllowlist(ctx: ContextCR): Set<string> {
  const raw = ctx.spec?.mcpServers
  const set = new Set<string>()
  if (!Array.isArray(raw)) return set
  for (const name of raw) {
    if (typeof name === 'string' && name.length > 0) set.add(name)
  }
  return set
}

/**
 * Resolve the set of allowed server names per Context, keyed by the Context's
 * `metadata.name` (the identifier memberships, Hosts and shared grants use).
 * Contexts being deleted are skipped, as the broker skips them. When
 * `scopedContextNames` is provided, Contexts not in scope are dropped.
 */
async function loadAllowedNamesByContext(
  gateway: Pick<K8sGateway, 'listResource'>,
  contextsNamespace: string,
  scopedContextNames?: ReadonlySet<string>
): Promise<Map<string, Set<string>>> {
  const contexts = asArray<ContextCR>(await gateway.listResource('contexts', contextsNamespace))
  const byContext = new Map<string, Set<string>>()
  for (const ctx of contexts) {
    const name = ctx.metadata?.name
    if (typeof name !== 'string' || name.length === 0) continue
    if (!isLive(ctx.metadata)) continue
    if (scopedContextNames && !scopedContextNames.has(name)) continue
    byContext.set(name, contextAllowlist(ctx))
  }
  return byContext
}

/**
 * Union of the allowlists of the given Contexts (by `metadata.name`). Used by
 * the user-scope consent gate, which only needs "does any Context enable it".
 * An empty `contextNames` resolves without listing Contexts.
 */
export async function allowedMcpServerNamesForContexts(
  gateway: Pick<K8sGateway, 'listResource'>,
  contextsNamespace: string,
  contextNames: readonly string[]
): Promise<Set<string>> {
  const union = new Set<string>()
  if (contextNames.length === 0) return union
  const allowedByContext = await loadAllowedNamesByContext(
    gateway,
    contextsNamespace,
    new Set(contextNames)
  )
  for (const names of allowedByContext.values()) {
    for (const name of names) union.add(name)
  }
  return union
}

/**
 * Whether some Context the user reaches still enables `mcpServerName` through
 * its `spec.mcpServers` allowlist. This is the access rule for consenting to
 * (and completing consent for) a per-user OAuth server: the grant is keyed by
 * (user, server) and serves every Context that enables the server, so access
 * follows the allowlists.
 *
 * A Context is reached directly (`getUserContexts`, active users) or through
 * an agent assigned to the user (`getUserAgents` → a Host the agent directory
 * shows → its `spec.contextRef`). Those are the two sources the flat
 * `/mcp-servers` catalog and the per-agent connectors panel resolve from, so
 * anything either offers the user can be connected. Team membership
 * (`team_contexts`, `team_agents`) does not count: neither catalog reads it
 * for a user, and this path has no trusted team id.
 *
 * Agents are read only when the direct Contexts do not enable the server, so
 * a Host read failure cannot break consent that direct membership already
 * allows; when it is needed, a failure propagates rather than answering
 * false. Deliberately ignores grant presence: the consent flow exists
 * precisely for servers that have no grant yet.
 */
export async function userHasContextEnablingMcpServer(opts: {
  gateway: Pick<K8sGateway, 'listResource' | 'getResource'>
  contextsNamespace: string
  hostsNamespace: string
  userId: string
  mcpServerName: string
}): Promise<boolean> {
  const { contextIds } = await getUserContexts(opts.userId)
  const direct = await allowedMcpServerNamesForContexts(
    opts.gateway,
    opts.contextsNamespace,
    contextIds
  )
  if (direct.has(opts.mcpServerName)) return true

  const { agentNames } = await getUserAgents(opts.userId)
  const hosts = await loadVisibleAgentHosts(opts.gateway, opts.hostsNamespace, agentNames)
  const agentContextNames: string[] = []
  for (const { host } of hosts) {
    const contextRef = host.spec?.contextRef
    if (contextRef) agentContextNames.push(contextRef)
  }
  if (agentContextNames.length === 0) return false
  const reached = await allowedMcpServerNamesForContexts(opts.gateway, opts.contextsNamespace, [
    ...new Set([...contextIds, ...agentContextNames]),
  ])
  return reached.has(opts.mcpServerName)
}

/**
 * Whether `userId` may act on the shared grant of Context `contextName`: the
 * access rule for consenting to, completing consent for and revoking a
 * context-scope OAuth server, whose grant belongs to one named Context.
 *
 * The Context must exist by name in `contextsNamespace` and not be being
 * deleted, and the user must reach it from the same sources the connectors
 * panel shows them: directly (`user_contexts`) or through an assigned agent
 * whose visible Host's `spec.contextRef` is that name. With `requireAllowlist`
 * the Context must also allowlist `mcpServerName` exactly. Revocation does not
 * require it, so a member can still remove a grant the Context no longer
 * enables.
 *
 * A malformed name or a userId that is not a canonical UUID is a plain denial,
 * decided before any read: the membership columns are UUIDs and would turn it
 * into a database error. A not-found Context is a denial; any other read
 * failure propagates, so callers fail closed with a 500.
 */
export async function userReachesContext(opts: {
  gateway: Pick<K8sGateway, 'getResource'>
  contextsNamespace: string
  hostsNamespace: string
  userId: string
  contextName: string
  mcpServerName: string
  requireAllowlist: boolean
}): Promise<boolean> {
  if (!isValidK8sName(opts.contextName) || !isCanonicalUuid(opts.userId)) return false

  let ctx: ContextCR
  try {
    ctx = (await opts.gateway.getResource(
      'contexts',
      opts.contextName,
      opts.contextsNamespace
    )) as ContextCR
  } catch (error) {
    if (isK8sResourceNotFound(error)) return false
    throw error
  }
  if (!ctx || ctx.metadata?.name !== opts.contextName || !isLive(ctx.metadata)) return false
  if (opts.requireAllowlist && !contextAllowlist(ctx).has(opts.mcpServerName)) return false

  const { contextIds } = await getUserContexts(opts.userId)
  if (contextIds.includes(opts.contextName)) return true

  const { agentNames } = await getUserAgents(opts.userId)
  const hosts = await loadVisibleAgentHosts(opts.gateway, opts.hostsNamespace, agentNames)
  return hosts.some(({ host }) => host.spec?.contextRef === opts.contextName)
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

/** Grant presence by flavor: shared grants per Context, per-user grants per server. */
interface GrantPresence {
  shared: Map<string, Set<string>>
  user: Set<string>
}

/**
 * Which (Context, server) pairs have a valid OAuth grant for this caller, by
 * flavor. A `context` server is checked once per distinct Context that enables
 * it among `pairs` (its grant belongs to that Context); a `user` server once,
 * keyed by the caller. Non-oauth servers are never added (the auth-type
 * allowlist governs them). FAIL-CLOSED throughout: a missing oauth id or a DB
 * error EXCLUDES the pair rather than failing the whole request.
 */
async function computeGrantPresenceByContext(
  db: DbClient,
  mcpServersNamespace: string,
  callerUserId: string,
  servers: McpServerCR[],
  pairs: Iterable<{ contextName: string; mcpServerName: string }>
): Promise<GrantPresence> {
  const byName = new Map<string, McpServerCR>()
  for (const s of servers) {
    const n = s.metadata?.name
    if (n) byName.set(n, s)
  }

  const presence: GrantPresence = { shared: new Map(), user: new Set() }
  const checkedUser = new Set<string>()
  const checkedShared = new Set<string>()
  for (const { contextName, mcpServerName: name } of pairs) {
    const s = byName.get(name)
    if (!s) continue
    // Only oauth servers are grant-gated; `none` servers pass on the allowlist.
    if (s.spec?.auth?.type !== 'oauth') continue
    const resolved = resolveServerOAuth(s)
    if (!resolved) continue // fail-closed: no usable oauth id
    const isShared = resolved.grantScope === 'context'
    const memo = isShared ? `${contextName}\u0000${name}` : name
    const checked = isShared ? checkedShared : checkedUser
    if (checked.has(memo)) continue
    checked.add(memo)

    // Same key derivation (D4) as the mint, the callback and the broker.
    const key = buildMcpServerGrantKey(resolved, {
      mcpServerName: name,
      mcpServersNamespace,
      userId: callerUserId,
      contextId: contextName,
    })
    if (!key) continue // fail-closed: missing grant coordinate for the flavor

    try {
      if (!(await oauthGrantExists(db, key))) continue
      if (!isShared) {
        presence.user.add(name)
        continue
      }
      const forContext = presence.shared.get(contextName) ?? new Set<string>()
      forContext.add(name)
      presence.shared.set(contextName, forContext)
    } catch (err) {
      // A grant-check DB error excludes THIS pair (fail-closed) rather than
      // failing the whole request — loudly, matching the sibling resolver's
      // observable-degradation posture (`resolveMcpServersForAgents`).
      log.error(
        { err, mcpServerName: name, contextName: isShared ? contextName : undefined },
        'grant-presence check failed; server excluded'
      )
    }
  }
  return presence
}

/** The servers with a grant usable from Context `contextName`. */
function presentFromContext(presence: GrantPresence, contextName: string): Set<string> {
  return new Set([...presence.user, ...(presence.shared.get(contextName) ?? [])])
}

/** Every (Context, server) pair the allowlists name. */
function allowlistedPairs(
  allowedByContext: ReadonlyMap<string, ReadonlySet<string>>
): Array<{ contextName: string; mcpServerName: string }> {
  const pairs: Array<{ contextName: string; mcpServerName: string }> = []
  for (const [contextName, names] of allowedByContext) {
    for (const mcpServerName of names) pairs.push({ contextName, mcpServerName })
  }
  return pairs
}

/**
 * Flat list of invocable `{name, url}` for the given Contexts (the user's
 * direct `user_contexts`). Used by `/rpc/access/users/:id/mcp-servers` — the
 * rpc-proxy rail, so it additionally applies the OAuth grant-presence gate: an
 * oauth server is invocable when SOME of these Contexts both enables it and
 * holds a grant usable there (the caller's own grant for a `user` server, that
 * Context's shared grant for a `context` server).
 */
export async function resolveInvocableMcpServersForContexts(
  gateway: K8sGateway,
  mcpServersNamespace: string,
  scopedContextIds: readonly string[],
  callerUserId: string,
  db: DbClient,
  contextsNamespace: string
): Promise<InvocableMcpServer[]> {
  if (scopedContextIds.length === 0) return []

  const [allowedByContext, mcpServers] = await Promise.all([
    loadAllowedNamesByContext(gateway, contextsNamespace, new Set(scopedContextIds)),
    gateway.listResource('mcpservers', mcpServersNamespace),
  ])
  const serverList = asArray<McpServerCR>(mcpServers)

  const presence = await computeGrantPresenceByContext(
    db,
    mcpServersNamespace,
    callerUserId,
    serverList,
    allowlistedPairs(allowedByContext)
  )
  const invocable = new Set<string>()
  for (const [contextName, names] of allowedByContext) {
    const fromHere = filterInvocable(
      names,
      serverList,
      mcpServersNamespace,
      presentFromContext(presence, contextName)
    )
    for (const name of fromHere) invocable.add(name)
  }

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
    contextsNamespace: string
    hostsNamespace: string
    agentNames: readonly string[]
  }
): Promise<AgentWithMcpServers[]> {
  const { mcpServersNamespace, contextsNamespace, hostsNamespace, agentNames } = opts
  if (agentNames.length === 0) return []

  // A non-404 Host read failure propagates so callers can preserve their
  // names-only compatibility field instead of silently revoking access.
  const visibleHosts = await loadVisibleAgentHosts(gateway, hostsNamespace, agentNames)

  let serverList: McpServerCR[] = []
  try {
    serverList = asArray<McpServerCR>(await gateway.listResource('mcpservers', mcpServersNamespace))
  } catch (err) {
    // Directory identity remains useful when optional MCP catalog enrichment
    // is temporarily unavailable — but the degradation must be observable, or
    // a broken mcpservers list path reads as "this agent has no tools".
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'mcpservers list failed; directory served without MCP catalog'
    )
  }

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
        contextsNamespace,
        scopedContextIds
      )
    } catch (err) {
      // Preserve the authorized directory DTOs with an empty tool catalog —
      // loudly, so a Context-read outage is distinguishable from "no tools".
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'context allowlist load failed; directory served with empty tool catalogs'
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

/**
 * The non-OAuth `authKind` label. Mirrors host-context-controller's
 * `deriveAuthKind` for the non-oauth branch (mini-spec 10): a static auth type
 * (`bearer`/`basic`/`apiKey`) maps to `static`; absent/`none` (implicit no-auth)
 * carries no label. Cosmetic for the panel — all of these classify `no_oauth`.
 */
function deriveNonOauthAuthKind(server: McpServerCR): 'static' | undefined {
  const authType = server.spec?.auth?.type
  return authType === 'bearer' || authType === 'basic' || authType === 'apiKey'
    ? 'static'
    : undefined
}

/**
 * Classify ONE server into the tri-state, given the authoritative grant-presence
 * set of the agent's Context (`grantPresent`, from `computeGrantPresenceByContext`
 * — the SAME flavored key construction the rpc-proxy gate uses, D4). FAIL-CLOSED: a server that is
 * not an OAuth connector (not `auth.type==='oauth'`, or no usable oauth id) is
 * `no_oauth`, never `authorized`; an OAuth server absent from `grantPresent`
 * (no grant OR a grant-read error, both swallowed fail-closed upstream) is
 * `requires_setup`, never `authorized`.
 *
 * SCOPE OF THE TRI-STATE (review R1-SM1/SM2, owner decision): the answer is
 * "does this connector have a grant?", NOT "can it run right now?". By design
 * this classifier does NOT apply the viability gates `filterInvocable` uses on
 * the invocation rail — `spec.enabled === false`, the auth-type allowlist, and
 * a resolvable transport URL. A disabled or static-auth server stays in the
 * admin-curated `Context.spec.mcpServers` allowlist (disabling does not prune
 * it — only deleting does), so it is classified and returned with its real
 * authorization state rather than dropped. Consequence, accepted here: the
 * classified set is a strict SUPERSET of `/rpc/servers` (the invocable set), so
 * the shared `mcp:servers:list` scope now spans two result-sets. This is not a
 * privilege escalation — it is the caller's own fleet, carrying only non-secret
 * policy — and the panel exists precisely to show the full fleet with its state
 * before the user runs anything. A green connector may still be non-invocable;
 * the panel reports grant state, not runnability.
 */
function classifyConnector(server: McpServerCR, grantPresent: ReadonlySet<string>): ConnectorEntry {
  const name = String(server.metadata?.name)
  // Gate on `auth.type==='oauth'` to stay aligned with `computeGrantPresenceByContext`,
  // which only ever considers (and thus admits into `grantPresent`) oauth
  // servers. A server carrying `spec.oauth` but a non-oauth auth type is NOT an
  // oauth connector on this rail.
  const resolved = server.spec?.auth?.type === 'oauth' ? resolveServerOAuth(server) : null
  if (!resolved) {
    return { name, status: 'no_oauth', authKind: deriveNonOauthAuthKind(server) }
  }
  // Provider is the non-secret panel label. Derive it directly from
  // `spec.oauth.provider`, consistent with the oauth-ness gate above — NOT via
  // `resolveServerOAuthSubject`, whose baked lane still requires clientIdRef/
  // clientSecretRef (and whose remote lane sets `provider:'remote'`, not the panel
  // label). This gate only needs the grant coordinate (`resolveServerOAuth`).
  const providerRaw = server.spec?.oauth?.provider
  const provider =
    typeof providerRaw === 'string' && providerRaw.length > 0 ? providerRaw : undefined
  return {
    name,
    ...(provider ? { provider } : {}),
    authKind: resolved.grantScope === 'context' ? 'oauth-context' : 'oauth-user',
    grantScope: resolved.grantScope,
    status: grantPresent.has(name) ? 'authorized' : 'requires_setup',
  }
}

/**
 * For each agent (Host), return its Host's contextRef and the CLASSIFIED
 * connector fleet of its Context (spec 11 U1). This is the panel read-model: it
 * CLASSIFIES the whole allowlist into `{authorized | requires_setup | no_oauth}`
 * rather than FILTERING the un-granted ones out (which is what the rpc-proxy
 * rail's `resolveInvocableMcpServersForContexts` does, and precisely what a
 * panel must NOT do). `filterInvocable` is left untouched.
 *
 * Authorization model is identical to `resolveMcpServersForAgents`: agent access
 * IS the gate. The caller MUST only pass `agentNames` the principal is
 * authorized to use (e.g. from `getUserAgents`). `userId` is the authenticated
 * session subject — it flows ONLY into the grant-presence key, never from a body.
 *
 * Returns valid, active entries in the same order as `agentNames`.
 */
export async function resolveConnectorsForAgents(
  gateway: K8sGateway,
  opts: {
    mcpServersNamespace: string
    contextsNamespace: string
    hostsNamespace: string
    agentNames: readonly string[]
    userId: string
  },
  db: DbClient
): Promise<AgentWithConnectors[]> {
  const { mcpServersNamespace, contextsNamespace, hostsNamespace, agentNames, userId } = opts
  if (agentNames.length === 0) return []

  const visibleHosts = await loadVisibleAgentHosts(gateway, hostsNamespace, agentNames)

  let serverList: McpServerCR[] = []
  try {
    serverList = asArray<McpServerCR>(await gateway.listResource('mcpservers', mcpServersNamespace))
  } catch (err) {
    // Degrade loudly: an mcpservers-list outage yields empty connector lists,
    // distinguishable in logs from "this agent genuinely exposes no tools".
    connectorsLog.error(
      { err },
      'mcpservers list failed; connectors served without catalog classification'
    )
  }

  const byName = new Map<string, McpServerCR>()
  for (const s of serverList) {
    const n = s.metadata?.name
    if (n) byName.set(n, s)
  }

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
        contextsNamespace,
        scopedContextIds
      )
    } catch (err) {
      // Preserve the authorized directory DTOs with empty connector lists —
      // loudly, so a Context-read outage is distinguishable from "no tools".
      connectorsLog.error(
        { err },
        'context allowlist load failed; connectors served with empty lists'
      )
    }
  }

  // One presence check per distinct (Context, shared server) and per user
  // server; each agent is then classified with its own Context's grants, so a
  // grant in one Context never marks an agent of another Context authorized.
  const presence = await computeGrantPresenceByContext(
    db,
    mcpServersNamespace,
    userId,
    serverList,
    allowlistedPairs(allowedByContext)
  )

  return visibleHosts.map(({ host, directoryEntry }) => {
    const contextRef = host?.spec?.contextRef ?? null
    if (!contextRef) {
      return { ...directoryEntry, contextRef, connectors: [] }
    }
    const allowed = allowedByContext.get(contextRef)
    if (!allowed || allowed.size === 0) {
      return { ...directoryEntry, contextRef, connectors: [] }
    }
    const grantPresent = presentFromContext(presence, contextRef)
    const connectors: ConnectorEntry[] = []
    for (const name of [...allowed].sort((a, b) => a.localeCompare(b))) {
      const server = byName.get(name)
      if (!server) continue // allowlisted name with no live McpServer CR
      connectors.push(classifyConnector(server, grantPresent))
    }
    return { ...directoryEntry, contextRef, connectors }
  })
}
