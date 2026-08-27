/**
 * MCP Manager - manages connections to multiple MCP servers.
 *
 * Live connections are keyed by ClientKey = (serverName, principal) where
 * principal ∈ { SHARED, userId }. Static/oauth-context servers use a single
 * SHARED partition; oauth-user servers keep one token-less SHARED representative
 * (populates the catalog) plus N lazily-admitted per-user partitions. Desired
 * state / catalog / fencing still reason by serverName — see `byServer`.
 */
import { McpServerInfo, McpTool, ToolCallResult } from '../types'
import {
  McpAuthError,
  McpClient,
  McpTokenProvider,
  type McpToolCallOptions,
  staticTokenProvider,
} from './client'
import { ServerStatusTracker } from './serverStatus'

export interface McpStatusRefreshSummary {
  serverCount: number
  succeeded: number
  failed: number
  toolCount: number
  outputSchemaCount: number
  aborted: boolean
}

export type McpAdmissionOutcome = 'applied' | 'stale'
export interface McpAdmissionControl {
  isCurrent?: () => boolean
  onCommit?: () => void
  scheduleCleanup?: (cleanup: McpDetachedServerCleanup) => void
}
export type McpDetachedServerCleanup = () => Promise<void>

interface PendingAdmission {
  attempt: symbol
  client: McpClient
  serverName: string
}

interface ClientRetirement {
  cleanup: McpDetachedServerCleanup
  claimed: boolean
}

// ─── ClientKey / principal ──────────────────────────────────────────────────
//
// SHARED is a STRUCTURAL sentinel (a tagged tuple), never a bare literal a real
// userId could collide with. Serialization tags the shared/user discriminator as
// the first tuple element, so no userId string can serialize to a SHARED key
// (property-tested in managerPartition.test.ts, T2).

export type McpPrincipal =
  | { readonly kind: 'shared' }
  | { readonly kind: 'user'; readonly userId: string }

export const SHARED_PRINCIPAL: McpPrincipal = { kind: 'shared' }

export function userPrincipal(userId: string): McpPrincipal {
  return { kind: 'user', userId }
}

/** Serialize a (serverName, principal) pair into a stable Map key string. */
export function serializeClientKey(serverName: string, principal: McpPrincipal): string {
  return principal.kind === 'shared'
    ? JSON.stringify(['s', serverName])
    : JSON.stringify(['u', serverName, principal.userId])
}

/** Recover the serverName from a serialized ClientKey. */
export function serverNameFromClientKey(key: string): string {
  return (JSON.parse(key) as [string, string, string?])[1]
}

/** Factory that builds a per-connection token provider for an oauth server. */
export type McpTokenProviderFactory = (
  server: McpServerInfo,
  principal: McpPrincipal
) => McpTokenProvider

export class McpManager {
  // Live connections, keyed by serialized ClientKey.
  private clients: Map<string, McpClient> = new Map()
  // Desired-state projection is per-serverName (identical across partitions).
  private serverInfos: Map<string, McpServerInfo> = new Map()
  private toolToServerMap: Map<string, string> = new Map()
  // In-flight admissions, keyed by serialized ClientKey.
  private pendingAdmissions: Map<string, PendingAdmission> = new Map()
  // serverName → set of live ClientKeys. Restores serverName-level reasoning
  // (catalog dedup, connected-servers projection, server-wide purge).
  private byServer: Map<string, Set<string>> = new Map()
  // Coalesces concurrent lazy admissions for the same per-user partition.
  private ensureInFlight: Map<string, Promise<void>> = new Map()
  // Last-used timestamp for per-user partitions (LRU + TTL eviction).
  private partitionLastUsed: Map<string, number> = new Map()
  // In-flight tool-call tokens per per-user partition. A UNIQUE token per call
  // (not a bare counter): each call removes only its own token, so a completing
  // call can never zero a *re-admitted* partition's in-flight state after a
  // force-eviction (the H1 re-admission race). A partition with a live call is
  // NEVER evicted by the idle sweep (mini-spec §6 — respect in-flight).
  private partitionInFlight: Map<string, Set<symbol>> = new Map()
  private clientRetirements = new WeakMap<McpClient, ClientRetirement>()
  private lifecycleEpoch = 0
  private closed = false
  private proxyUrl?: string
  private statusTracker: ServerStatusTracker
  private tokenProviderFactory?: McpTokenProviderFactory

  constructor(
    proxyUrl?: string,
    statusTracker?: ServerStatusTracker,
    tokenProviderFactory?: McpTokenProviderFactory
  ) {
    this.proxyUrl = proxyUrl
    this.statusTracker = statusTracker ?? new ServerStatusTracker()
    this.tokenProviderFactory = tokenProviderFactory
    if (proxyUrl) {
      console.log(`[McpManager] Proxy mode enabled: ${proxyUrl}`)
    }
  }

  /**
   * The shared status tracker. Exposed so higher layers (status endpoint,
   * background heartbeat) can read snapshots and touch entries.
   */
  get status(): ServerStatusTracker {
    return this.statusTracker
  }

  private sharedKey(serverName: string): string {
    return serializeClientKey(serverName, SHARED_PRINCIPAL)
  }

  private userKey(serverName: string, userId: string): string {
    return serializeClientKey(serverName, userPrincipal(userId))
  }

  /**
   * The representative connection for a serverName: prefer the SHARED partition
   * (token-less for oauth-user, the sole connection for static/oauth-context),
   * else any live per-user partition. Powers catalog dedup by serverName.
   */
  private representativeClient(serverName: string): McpClient | undefined {
    const shared = this.clients.get(this.sharedKey(serverName))
    if (shared) return shared
    const keys = this.byServer.get(serverName)
    if (keys) {
      for (const key of keys) {
        const client = this.clients.get(key)
        if (client) return client
      }
    }
    return undefined
  }

  private buildTokenProvider(
    serverConfig: McpServerInfo,
    principal: McpPrincipal,
    eagerToken: string | undefined
  ): McpTokenProvider | undefined {
    if (serverConfig.authKind === 'oauth-user' || serverConfig.authKind === 'oauth-context') {
      // oauth: JIT resolution via the injected factory (broker per-user /
      // per-context, or token-less representative). No factory (dev/tests) →
      // token-less, which fails closed on a server that requires auth.
      //
      // PRECONDITION (v1 class-a, spec §10.1 VERIFIED / mini-spec 03 §5): catalog
      // population relies on the SHARED representative connecting WITHOUT auth —
      // i.e. the server must serve initialize/tools/list unauthenticated and only
      // 401 on tools/call (own-image, static catalog). A class-b upstream that
      // auth-gates discovery is OUT of v1 scope and needs the deferred
      // CRD-declared-schema path (mini-spec 03 §5/§8 "fuente de schema declarado").
      return this.tokenProviderFactory
        ? this.tokenProviderFactory(serverConfig, principal)
        : staticTokenProvider(undefined)
    }
    // static/none/bearer/basic/apiKey: preserve today's frozen-token behavior.
    return staticTokenProvider(eagerToken)
  }

  private clearToolMappings(serverName: string): void {
    for (const [toolName, server] of this.toolToServerMap.entries()) {
      if (server === serverName) {
        this.toolToServerMap.delete(toolName)
      }
    }
  }

  private installConnectedClient(
    key: string,
    serverConfig: McpServerInfo,
    client: McpClient
  ): void {
    this.clearToolMappings(serverConfig.name)
    this.clients.set(key, client)
    this.serverInfos.set(serverConfig.name, serverConfig)

    let keys = this.byServer.get(serverConfig.name)
    if (!keys) {
      keys = new Set()
      this.byServer.set(serverConfig.name, keys)
    }
    keys.add(key)

    for (const tool of client.availableTools) {
      const fullToolName = `${serverConfig.name}__${tool.name}`
      this.toolToServerMap.set(fullToolName, serverConfig.name)
    }

    this.statusTracker.markConnected(serverConfig.name, client.availableTools.length)
  }

  private claimClientCleanup(client: McpClient): McpDetachedServerCleanup | undefined {
    let retirement = this.clientRetirements.get(client)
    if (!retirement) {
      const cleanupClient = client.retire()
      let cleanupPromise: Promise<void> | undefined
      retirement = {
        claimed: false,
        cleanup: () => {
          if (!cleanupPromise) {
            try {
              cleanupPromise = Promise.resolve(cleanupClient())
            } catch (error) {
              cleanupPromise = Promise.reject(error)
            }
          }
          return cleanupPromise
        },
      }
      this.clientRetirements.set(client, retirement)
    }
    if (retirement.claimed) return undefined
    retirement.claimed = true
    return retirement.cleanup
  }

  private scheduleClientCleanup(client: McpClient, control: McpAdmissionControl): Promise<void> {
    const cleanup = this.claimClientCleanup(client)
    if (!cleanup) return Promise.resolve()
    if (control.scheduleCleanup) {
      control.scheduleCleanup(cleanup)
      return Promise.resolve()
    }
    return cleanup().catch(() => undefined)
  }

  /**
   * Retain an admission failure for inventory/status reporting when failure
   * occurs before McpClient.connect (for example, auth-token discovery).
   */
  recordAdmissionFailure(serverConfig: McpServerInfo, error: unknown): void {
    if (this.closed) return
    this.serverInfos.set(serverConfig.name, serverConfig)
    this.statusTracker.markFailed(serverConfig.name, error)
  }

  /**
   * Add and connect to an MCP server (SHARED partition — the eager coordinator
   * path). oauth-user servers admit only the token-less representative here;
   * per-user partitions are lazily admitted on demand via callTool.
   */
  async addServer(
    serverConfig: McpServerInfo,
    authToken?: string,
    control: McpAdmissionControl = {}
  ): Promise<McpAdmissionOutcome> {
    const admissionLifecycleEpoch = this.lifecycleEpoch
    const externalIsCurrent = control.isCurrent ?? (() => true)
    const isCurrent = (): boolean =>
      !this.closed && this.lifecycleEpoch === admissionLifecycleEpoch && externalIsCurrent()
    if (!isCurrent()) return 'stale'

    // Skip disabled servers — operator intent, not infra failure.
    if (!serverConfig.enabled) {
      console.log(`[McpManager] Skipping disabled server: ${serverConfig.name}`)
      this.serverInfos.set(serverConfig.name, serverConfig)
      this.statusTracker.markDisabled(serverConfig.name)
      control.onCommit?.()
      return 'applied'
    }

    // Explicitly non-authoritative readiness is a fail-closed admission
    // signal, not permission to open a new connection.
    if (serverConfig.status?.authoritative === false) {
      console.log(
        `[McpManager] Skipping server with non-authoritative readiness: ${serverConfig.name}`
      )
      this.serverInfos.set(serverConfig.name, serverConfig)
      this.statusTracker.markNotReady(serverConfig.name, serverConfig.status?.message)
      control.onCommit?.()
      return 'applied'
    }

    // Skip servers that aren't ready yet — transient infra, surfaced as not_ready.
    if (!serverConfig.status?.ready) {
      console.log(
        `[McpManager] Skipping server not ready: ${serverConfig.name} (${serverConfig.status?.message || 'unknown'})`
      )
      this.serverInfos.set(serverConfig.name, serverConfig)
      this.statusTracker.markNotReady(serverConfig.name, serverConfig.status?.message)
      control.onCommit?.()
      return 'applied'
    }

    const key = this.sharedKey(serverConfig.name)

    // Check if already connected (SHARED partition)
    if (this.clients.has(key)) {
      const installed = this.serverInfos.get(serverConfig.name)
      if (installed && JSON.stringify(installed) === JSON.stringify(serverConfig)) {
        console.log(`[McpManager] Server already connected: ${serverConfig.name}`)
        control.onCommit?.()
        return 'applied'
      }
      return this.replaceServer(serverConfig, authToken, control)
    }

    const tokenProvider = this.buildTokenProvider(serverConfig, SHARED_PRINCIPAL, authToken)
    return this.connectAndInstall(key, serverConfig, tokenProvider, control, true)
  }

  /**
   * Shared connect+install core reused by the eager SHARED path (addServer) and
   * the lazy per-user path (ensureClient) — one fencing machine (D4), keyed by
   * ClientKey. `ownsServerStatus` gates the per-serverName status writes so a
   * per-user admission failure never flips a healthy representative to failed.
   */
  private async connectAndInstall(
    key: string,
    serverConfig: McpServerInfo,
    tokenProvider: McpTokenProvider | undefined,
    control: McpAdmissionControl,
    ownsServerStatus: boolean
  ): Promise<McpAdmissionOutcome> {
    const admissionLifecycleEpoch = this.lifecycleEpoch
    const externalIsCurrent = control.isCurrent ?? (() => true)
    const isCurrent = (): boolean =>
      !this.closed && this.lifecycleEpoch === admissionLifecycleEpoch && externalIsCurrent()
    if (!isCurrent()) return 'stale'

    const client = new McpClient(serverConfig, tokenProvider, this.proxyUrl)
    const attempt = Symbol(key)
    this.pendingAdmissions.set(key, { attempt, client, serverName: serverConfig.name })
    if (ownsServerStatus) this.statusTracker.markConnecting(serverConfig.name)

    try {
      await client.connect()
      if (!isCurrent() || this.pendingAdmissions.get(key)?.attempt !== attempt) {
        await this.scheduleClientCleanup(client, control)
        this.discardPendingAdmission(key, attempt, serverConfig.name)
        return 'stale'
      }
      this.pendingAdmissions.delete(key)
      this.installConnectedClient(key, serverConfig, client)
      control.onCommit?.()
      console.log(`[McpManager] Installed client: ${key}`)
      return 'applied'
    } catch (error) {
      if (!isCurrent() || this.pendingAdmissions.get(key)?.attempt !== attempt) {
        await this.scheduleClientCleanup(client, control)
        this.discardPendingAdmission(key, attempt, serverConfig.name)
        return 'stale'
      }
      this.pendingAdmissions.delete(key)
      console.error(`[McpManager] Failed to install client ${key}:`, error)
      // Only the SHARED/eager path owns the per-serverName status transition. A
      // per-user admission failure must leave the representative's status intact.
      if (ownsServerStatus) this.recordAdmissionFailure(serverConfig, error)
      throw error
    }
  }

  /**
   * Connect a ready desired revision before committing it over the current
   * SHARED connection. A candidate failure leaves the previous client, tools,
   * serverInfo, and connected status untouched. On commit, per-user partitions
   * of the same server are evicted (the desired config changed for everyone;
   * they rebuild lazily with the new revision).
   */
  async replaceServer(
    serverConfig: McpServerInfo,
    authToken?: string,
    control: McpAdmissionControl = {}
  ): Promise<McpAdmissionOutcome> {
    const admissionLifecycleEpoch = this.lifecycleEpoch
    const externalIsCurrent = control.isCurrent ?? (() => true)
    const isCurrent = (): boolean =>
      !this.closed && this.lifecycleEpoch === admissionLifecycleEpoch && externalIsCurrent()
    if (!isCurrent()) return 'stale'

    const key = this.sharedKey(serverConfig.name)
    const previousClient = this.clients.get(key)
    if (!previousClient) {
      return this.addServer(serverConfig, authToken, control)
    }

    const tokenProvider = this.buildTokenProvider(serverConfig, SHARED_PRINCIPAL, authToken)
    const candidate = new McpClient(serverConfig, tokenProvider, this.proxyUrl)
    const attempt = Symbol(key)
    this.pendingAdmissions.set(key, { attempt, client: candidate, serverName: serverConfig.name })
    try {
      await candidate.connect()
    } catch (error) {
      await this.scheduleClientCleanup(candidate, control)
      if (!isCurrent() || this.pendingAdmissions.get(key)?.attempt !== attempt) {
        this.discardPendingAdmission(key, attempt, serverConfig.name)
        return 'stale'
      }
      this.pendingAdmissions.delete(key)
      throw error
    }

    if (!isCurrent() || this.pendingAdmissions.get(key)?.attempt !== attempt) {
      await this.scheduleClientCleanup(candidate, control)
      this.discardPendingAdmission(key, attempt, serverConfig.name)
      return 'stale'
    }
    this.pendingAdmissions.delete(key)

    // Commit is synchronous: readers see either the complete previous
    // revision or the complete connected candidate, never a missing server.
    this.installConnectedClient(key, serverConfig, candidate)
    control.onCommit?.()

    // The desired config changed for the whole server → per-user partitions are
    // stale. Evict them (and any in-flight lazy admission) so they rebuild lazily.
    this.evictPartitionsExcept(serverConfig.name, key, control)

    await this.scheduleClientCleanup(previousClient, control)
    console.log(`[McpManager] Replaced server: ${serverConfig.name}`)
    return 'applied'
  }

  /**
   * Lazily admit a per-user partition for an oauth-user server, reusing the same
   * connect+install fencing as the eager path. Concurrent callers for the same
   * partition coalesce onto one admission.
   */
  private async ensureClient(serverName: string, userId: string): Promise<void> {
    const key = this.userKey(serverName, userId)
    if (this.clients.has(key)) return
    const existing = this.ensureInFlight.get(key)
    if (existing) return existing

    const info = this.serverInfos.get(serverName)
    if (!info) {
      throw new Error(`MCP server not connected: ${serverName}`)
    }
    const tokenProvider = this.buildTokenProvider(info, userPrincipal(userId), undefined)
    const admission = this.connectAndInstall(key, info, tokenProvider, {}, false).then(
      () => undefined
    )
    const tracked = admission.finally(() => {
      if (this.ensureInFlight.get(key) === tracked) this.ensureInFlight.delete(key)
    })
    this.ensureInFlight.set(key, tracked)
    return tracked
  }

  /**
   * Evict every per-user partition of a server (and any in-flight lazy
   * admission), except an optional key to keep (the SHARED representative).
   */
  private evictPartitionsExcept(
    serverName: string,
    keepKey: string,
    control: McpAdmissionControl
  ): void {
    const keys = this.byServer.get(serverName)
    if (keys) {
      for (const key of [...keys]) {
        if (key === keepKey) continue
        const client = this.clients.get(key)
        this.clients.delete(key)
        keys.delete(key)
        this.partitionLastUsed.delete(key)
        this.partitionInFlight.delete(key)
        if (client) void this.scheduleClientCleanup(client, control)
      }
      if (keys.size === 0) this.byServer.delete(serverName)
    }
    for (const [key, pending] of [...this.pendingAdmissions]) {
      if (pending.serverName === serverName && key !== keepKey) {
        this.pendingAdmissions.delete(key)
        void this.scheduleClientCleanup(pending.client, control)
      }
    }
    for (const key of [...this.ensureInFlight.keys()]) {
      if (key !== keepKey && serverNameFromClientKey(key) === serverName) {
        this.ensureInFlight.delete(key)
      }
    }
  }

  /**
   * Evict a single per-user partition (terminal auth failure). SHARED/static
   * partitions and per-serverName status/serverInfo are left untouched — a later
   * call re-admits the partition lazily.
   */
  private evictPartition(key: string): void {
    const client = this.clients.get(key)
    const serverName = serverNameFromClientKey(key)
    this.clients.delete(key)
    this.partitionLastUsed.delete(key)
    this.partitionInFlight.delete(key)
    this.ensureInFlight.delete(key)
    const keys = this.byServer.get(serverName)
    if (keys) {
      keys.delete(key)
      if (keys.size === 0) this.byServer.delete(serverName)
    }
    if (client) {
      const cleanup = this.claimClientCleanup(client)
      if (cleanup) void cleanup().catch(() => undefined)
    }
  }

  /**
   * Evict idle per-user partitions (LRU + TTL). SHARED/static/representative
   * partitions are exempt (snapshot-driven, never evicted here). Bounds
   * revocation latency for oauth-user grants and caps memory. Returns the count
   * evicted.
   */
  evictIdleUserPartitions(maxIdleMs: number, maxUserPartitions?: number): number {
    const now = Date.now()
    let evicted = 0
    const inFlight = (key: string): boolean => (this.partitionInFlight.get(key)?.size ?? 0) > 0
    // TTL pass — never evict a partition with a live tool call.
    for (const [key, lastUsed] of [...this.partitionLastUsed]) {
      if (inFlight(key)) continue
      if (now - lastUsed >= maxIdleMs) {
        this.evictPartition(key)
        evicted += 1
      }
    }
    // LRU-cap pass — same in-flight exemption; only idle partitions are candidates.
    if (maxUserPartitions !== undefined && this.partitionLastUsed.size > maxUserPartitions) {
      const ordered = [...this.partitionLastUsed.entries()]
        .filter(([key]) => !inFlight(key))
        .sort((a, b) => a[1] - b[1])
      const overflow = this.partitionLastUsed.size - maxUserPartitions
      for (let i = 0; i < overflow && i < ordered.length; i++) {
        this.evictPartition(ordered[i][0])
        evicted += 1
      }
    }
    return evicted
  }

  private releaseInFlight(key: string, token: symbol): void {
    // Remove only THIS call's token. If the partition was force-evicted and
    // re-admitted under a fresh Set, this no-ops on the new Set instead of
    // clearing another live call's in-flight state.
    const set = this.partitionInFlight.get(key)
    if (!set) return
    set.delete(token)
    if (set.size === 0) this.partitionInFlight.delete(key)
  }

  /**
   * Revoke an MCP server synchronously, returning bounded async cleanup.
   *
   * Purges EVERY ClientKey that shares this serverName (SHARED representative +
   * all per-user partitions) — a config change / delete affects everyone. This
   * is the revocation path. Callers can detach every server in an authoritative
   * revocation snapshot before awaiting any potentially slow disconnect.
   */
  detachServer(serverName: string): McpDetachedServerCleanup {
    const clients = new Set<McpClient>()
    const liveKeys = this.byServer.get(serverName)
    if (liveKeys) {
      for (const key of liveKeys) {
        const client = this.clients.get(key)
        if (client) clients.add(client)
        this.clients.delete(key)
        this.partitionLastUsed.delete(key)
        this.partitionInFlight.delete(key)
      }
    }
    for (const [key, pending] of [...this.pendingAdmissions]) {
      if (pending.serverName === serverName) {
        clients.add(pending.client)
        this.pendingAdmissions.delete(key)
      }
    }
    for (const key of [...this.ensureInFlight.keys()]) {
      if (serverNameFromClientKey(key) === serverName) this.ensureInFlight.delete(key)
    }

    const cleanups = [...clients]
      .map(client => this.claimClientCleanup(client))
      .filter((cleanup): cleanup is McpDetachedServerCleanup => cleanup !== undefined)

    this.clearToolMappings(serverName)
    this.byServer.delete(serverName)
    this.serverInfos.delete(serverName)
    this.statusTracker.remove(serverName)

    return async () => {
      await this.runDetachedCleanups(cleanups)
      console.log(`[McpManager] Removed server: ${serverName}`)
    }
  }

  /**
   * Remove and disconnect from an MCP server.
   */
  async removeServer(serverName: string): Promise<void> {
    await this.detachServer(serverName)()
  }

  /**
   * Disconnect from all MCP servers. Subsystem reset — per spec §4.5 this is
   * the one path that allows `connecting` to reappear afterwards.
   */
  async disconnectAll(): Promise<void> {
    await this.runDetachedCleanups(this.detachAllServers())
  }

  /**
   * Permanently close this manager. Unlike disconnectAll(), a closed manager
   * cannot be authorized again by a delayed poll or direct admission.
   */
  async close(scheduleCleanup?: (cleanup: McpDetachedServerCleanup) => void): Promise<void> {
    if (this.closed) return
    this.closed = true
    const cleanups = this.detachAllServers()
    if (scheduleCleanup) {
      for (const cleanup of cleanups) {
        scheduleCleanup(cleanup)
      }
      return
    }
    await this.runDetachedCleanups(cleanups)
  }

  private detachAllServers(): McpDetachedServerCleanup[] {
    this.lifecycleEpoch += 1
    const serverNames = [
      ...new Set([
        ...this.byServer.keys(),
        ...[...this.pendingAdmissions.values()].map(p => p.serverName),
      ]),
    ]
    const cleanups = serverNames.map(name => this.detachServer(name))
    this.toolToServerMap.clear()
    this.serverInfos.clear()
    this.pendingAdmissions.clear()
    this.byServer.clear()
    this.ensureInFlight.clear()
    this.partitionLastUsed.clear()
    this.partitionInFlight.clear()
    this.statusTracker.reset()
    return cleanups
  }

  private async runDetachedCleanups(cleanups: McpDetachedServerCleanup[]): Promise<void> {
    let firstError: unknown
    let cleanupFailed = false
    for (const cleanup of cleanups) {
      try {
        await cleanup()
      } catch (error) {
        if (!cleanupFailed) firstError = error
        cleanupFailed = true
      }
    }
    if (cleanupFailed) {
      throw firstError
    }
  }

  /**
   * Get all available tools from all connected servers.
   *
   * Deduplicated by serverName via the representative connection: N per-user
   * partitions of one oauth server contribute the tool exactly once.
   * Tool names are prefixed with server name to avoid conflicts.
   */
  getAllTools(): McpTool[] {
    const allTools: McpTool[] = []

    for (const serverName of this.byServer.keys()) {
      const client = this.representativeClient(serverName)
      if (!client) continue
      for (const tool of client.availableTools) {
        // Prefix tool name with server name for uniqueness
        allTools.push({
          ...tool,
          name: `${serverName}__${tool.name}`,
        })
      }
    }

    return allTools
  }

  /**
   * Build a description of all connected MCP servers and their tools.
   * Used to give the LLM full context about its available capabilities.
   * Deduplicated by serverName (representative connection).
   */
  describeCapabilities(): string {
    if (this.byServer.size === 0) {
      return 'No MCP servers are currently connected. You cannot use any tools.'
    }

    const sections: string[] = []

    for (const serverName of this.byServer.keys()) {
      const client = this.representativeClient(serverName)
      if (!client) continue
      const info = this.serverInfos.get(serverName)
      const description = info?.description || 'No description available.'
      const tools = client.availableTools

      let section = `### ${serverName}\n${description}`

      if (tools.length > 0) {
        section += `\n\nTools (${tools.length}):`
        for (const tool of tools) {
          const toolDesc = tool.description ? ` — ${tool.description}` : ''
          section += `\n- ${serverName}__${tool.name}${toolDesc}`
        }
      } else {
        section += '\n\nNo tools available from this server.'
      }

      sections.push(section)
    }

    return `## Available MCP Servers\n\nYou have access to ${this.byServer.size} MCP server(s) with ${this.getAllTools().length} tool(s) total.\nAlways use the full tool name (serverName__toolName) when calling tools.\n\n${sections.join('\n\n')}`
  }

  /**
   * Call a tool by its full name (serverName__toolName).
   *
   * Dispatch by the server's flavor: static & oauth grantScope='context' route
   * to the SHARED partition; oauth grantScope='user' routes to the caller's
   * per-user partition (lazily admitted). oauth-user with no/anonymous userId is
   * rejected fail-closed BEFORE any token is resolved.
   */
  async callTool(
    fullToolName: string,
    args: Record<string, unknown>,
    options: McpToolCallOptions = {}
  ): Promise<ToolCallResult> {
    // Parse server name and tool name
    const parts = fullToolName.split('__')
    if (parts.length !== 2) {
      return {
        toolName: fullToolName,
        result: { error: `Invalid tool name format: ${fullToolName}` },
        isError: true,
      }
    }

    const [serverName, toolName] = parts
    const info = this.serverInfos.get(serverName)
    // Only the per-user oauth sabor gets per-user partitions. oauth-context and
    // static both resolve on the SHARED representative (the else branch below).
    const isOauthUser = info?.authKind === 'oauth-user'

    let key: string
    if (isOauthUser) {
      // options.userId originates from the authenticated session (`sender`,
      // rpc-proxy's auth.sub). It is forwarded verbatim as the broker grant
      // subject: mcp-host asserts the identity, and control-api is the
      // authorization authority that resolves the grant against it (spec §U4
      // must-fix). Fail-closed in practice — a non-sub principal matches no grant
      // → 404/no_grant → no token. No authz is enforced here by design.
      const userId = options.userId
      // Fail-closed: never resolve a token (nor forward the call) without a
      // concrete user identity on a per-user oauth server.
      if (!userId || userId === 'anonymous') {
        return {
          toolName: fullToolName,
          result: {
            error: `Authentication required: ${serverName} needs a per-user connection, but no user identity was provided`,
          },
          isError: true,
        }
      }
      key = this.userKey(serverName, userId)
      try {
        await this.ensureClient(serverName, userId)
      } catch (error) {
        return {
          toolName: fullToolName,
          result: {
            error: `Authentication required for ${serverName}: ${error instanceof Error ? error.message : 'connection failed'}`,
          },
          isError: true,
        }
      }
    } else {
      key = this.sharedKey(serverName)
    }

    const client = this.clients.get(key)
    if (!client) {
      return {
        toolName: fullToolName,
        result: { error: `MCP server not found: ${serverName}` },
        isError: true,
      }
    }

    // Unique token identifying THIS call's in-flight claim on the partition.
    const callToken = Symbol('mcp-call')
    if (isOauthUser) {
      // Stamp usage only once the partition is confirmed live (a 'stale'
      // admission installs no client) so no phantom entry counts toward the cap.
      this.partitionLastUsed.set(key, Date.now())
      // Pin the partition against idle eviction for the duration of this call.
      let set = this.partitionInFlight.get(key)
      if (!set) {
        set = new Set()
        this.partitionInFlight.set(key, set)
      }
      set.add(callToken)
    }

    try {
      const result = await client.callTool(toolName, args, options)
      if (isOauthUser) this.partitionLastUsed.set(key, Date.now())
      return {
        toolName: fullToolName,
        result,
        isError: false,
      }
    } catch (error) {
      if (error instanceof McpAuthError) {
        // Terminal auth failure — evict the per-user partition so a later call
        // (e.g. after the user reconnects) re-admits fresh. Static/shared exempt.
        if (isOauthUser) this.evictPartition(key)
        // U5 reactive-consent marker: a live 401 on an oauth server (surfaced
        // only AFTER the client's single forced-refresh retry, so already
        // terminal-after-retry — no loop) means the user must (re)connect. Gate
        // strictly on `authKind ∈ {oauth-user, oauth-context}` (covers BOTH
        // per-user and shared grantScope='context' — the shared flavor bootstraps
        // on its first user) AND `status===401`. A 403 (insufficient scope) is
        // TERMINAL: no marker, no connect flow. static (secretRef) has no consent
        // flow → excluded by the authKind check. The marker is attached as a typed
        // field so the caller sees it (NOT flattened into the opaque error).
        //
        // NOTE: this gate reads `authKind` (the HCC v2 inventory field), NOT the
        // pre-mini-spec-10 `auth.type` — `decodeMcpServer` populates `authKind`
        // and never `auth`, so `info.auth?.type` is always undefined here and the
        // old check silently disabled reactive consent for every oauth server.
        if (
          (info?.authKind === 'oauth-user' || info?.authKind === 'oauth-context') &&
          error.status === 401
        ) {
          return {
            toolName: fullToolName,
            result: { error: error.message },
            isError: true,
            connectRequired: { mcpServerName: serverName, provider: info.oauth?.provider },
          }
        }
        return {
          toolName: fullToolName,
          result: { error: error.message },
          isError: true,
        }
      }
      return {
        toolName: fullToolName,
        result: { error: error instanceof Error ? error.message : 'Unknown error' },
        isError: true,
      }
    } finally {
      if (isOauthUser) this.releaseInFlight(key, callToken)
    }
  }

  /**
   * Probe every connected server's tool list and update the status tracker.
   * Called by the background heartbeat to keep `observedAt` fresh and to
   * classify refresh failures (spec §4.5 — stay connected, attach reason).
   * Probes the representative connection per serverName.
   *
   * Probes a stable client snapshot. State is written only after every probe
   * settles; an aborted round never mutates the last known server status.
   */
  async refreshAllServerStatus(options: McpToolCallOptions = {}): Promise<McpStatusRefreshSummary> {
    // One representative client per server. The ClientKey index partitions an
    // oauth grantScope='user' server into per-user clients, but a status round
    // probes each server once via its representative; iterating raw clients would
    // double-count those partitions in the summary tally.
    const entries = [...this.byServer.keys()]
      .map(name => [name, this.representativeClient(name)] as const)
      .filter((entry): entry is readonly [string, McpClient] => entry[1] !== undefined)
    if (options.signal?.aborted) {
      return {
        serverCount: entries.length,
        succeeded: 0,
        failed: 0,
        toolCount: 0,
        outputSchemaCount: 0,
        aborted: true,
      }
    }

    const results = await Promise.all(
      entries.map(async ([name, client]) => {
        try {
          return {
            name,
            client,
            // Probes share the round's abort signal directly: the heartbeat owns
            // round-level cancellation and no per-probe cancellation capability
            // exists, so wrapping the signal would only fake a seam.
            result: await client.probeTools({
              timeoutMs: options.timeoutMs,
              signal: options.signal,
            }),
          }
        } catch (error) {
          return { name, client, result: { ok: false as const, error, stale: false } }
        }
      })
    )
    // A probe only counts toward the round's tally when its result is
    // authoritative for the currently-installed client: never a client swapped
    // out mid-round, never a stale-error probe that raced a reconnect. This is
    // the same predicate the status commit below uses, so summary.succeeded /
    // summary.failed match what was written — a benign mid-round swap can't
    // inflate `failed` and flip the run's outcome on the series #148 watches.
    const committed = results.filter(
      ({ name, client, result }) =>
        this.representativeClient(name) === client && !(!result.ok && result.stale)
    )
    const succeeded = committed.filter(({ result }) => result.ok).length
    const summary: McpStatusRefreshSummary = {
      serverCount: entries.length,
      succeeded,
      failed: committed.length - succeeded,
      toolCount: committed.reduce(
        (total, { result }) => total + (result.ok ? result.toolCount : 0),
        0
      ),
      outputSchemaCount: committed.reduce(
        (total, { result }) => total + (result.ok ? result.outputSchemaCount : 0),
        0
      ),
      aborted: options.signal?.aborted === true,
    }
    if (summary.aborted) return summary

    for (const { name, result } of committed) {
      if (result.ok) {
        this.statusTracker.updateToolCount(name, result.toolCount)
      } else {
        this.statusTracker.updateToolCount(name, 0, { refreshError: result.error })
      }
    }
    return summary
  }

  /**
   * Get connected server names (projected from the ClientKey index).
   */
  getConnectedServers(): string[] {
    return [...this.byServer.keys()]
  }

  /**
   * Get every server represented in manager inventory, including disabled,
   * not-ready, and failed-admission entries that have no connected client.
   */
  getKnownServers(): string[] {
    return [
      ...new Set([
        ...this.serverInfos.keys(),
        ...[...this.pendingAdmissions.values()].map(p => p.serverName),
      ]),
    ]
  }

  private discardPendingAdmission(key: string, attempt: symbol, serverName: string): void {
    if (this.pendingAdmissions.get(key)?.attempt !== attempt) return
    this.pendingAdmissions.delete(key)
    const hasLiveClient = (this.byServer.get(serverName)?.size ?? 0) > 0
    if (!hasLiveClient && !this.serverInfos.has(serverName)) {
      this.statusTracker.remove(serverName)
    }
  }

  /**
   * Check if any servers are connected.
   */
  hasConnectedServers(): boolean {
    return this.byServer.size > 0
  }
}
