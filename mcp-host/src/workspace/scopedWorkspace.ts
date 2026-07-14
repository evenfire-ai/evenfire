/**
 * Per-user scoped view over the workspace (FS isolation, plan F1).
 *
 * `mcp-host` is a collective agent (one Pod, many humans) with a single flat
 * workspace. `ScopedWorkspace` is a per-task view that routes each operation to
 * one of two backing {@link WorkspaceService} instances:
 *
 *   - **collective** (root = `<workspacePath>`): agent identity
 *     (`IDENTITY/SOUL/AGENTS/USER.md`), collective `MEMORY.md`, `memories/`.
 *   - **user** (root = `<workspacePath>/users/<userKey>`): everything else the
 *     agent writes on behalf of a human — `daily/`, spillover, output, private
 *     memory.
 *
 * Routing is by path class ({@link isCollectivePath}). Because the per-user
 * instance is rooted at the user's subtree, a path naming another user
 * (`users/<other>/...`) is NOT collective-class → routed to the caller's own
 * root → resolves to a non-existent nested path → no cross-user access. The
 * only path that reaches the collective root is an explicit collective-class
 * path, and `list`/`search` only surface the collective whitelist (never
 * `users/`, `state.db`, spillover, or outputs).
 *
 * Instances are produced by {@link ScopedWorkspaceProvider}, which caches the
 * per-user `WorkspaceService` by `userKey` so concurrent tasks of the same user
 * share one mutex map (the `append` read-modify-write stays serialized).
 */
import * as fs from 'fs'
import * as path from 'path'
import type { IncomingMessage } from '../server/types'
import type { Workspace } from './service'
import { WorkspaceService } from './service'
import type { SearchResult, WorkspaceEntry } from './types'
import { deriveUserKeyFromSessionKey, deriveUserKeyFromSource } from './userKey'

const USERS_DIR = 'users'

/** Root-level files that belong to the agent/team, not to one human. */
const COLLECTIVE_FILES: ReadonlySet<string> = new Set([
  'MEMORY.md',
  'memories', // directory
  'IDENTITY.md',
  'SOUL.md',
  'AGENTS.md',
  'USER.md',
  'HEARTBEAT.md',
])

/**
 * Subset of collective paths that `list`/`search` may surface (browse) to the
 * agent. Deliberately narrower than COLLECTIVE_FILES: identity/HEARTBEAT files
 * are read-by-path and injected via the system prompt, not browsed — so they
 * are routable (`isCollectivePath`) but intentionally NOT listed/searched here.
 */
function isSurfacedCollective(relativePath: string): boolean {
  const n = normalizeRel(relativePath)
  return n === 'MEMORY.md' || n === 'memories' || n.startsWith('memories/')
}

function normalizeRel(relativePath: string): string {
  let n = path.posix.normalize(relativePath || '')
  if (n.startsWith('./')) n = n.slice(2)
  if (n.startsWith('/')) n = n.slice(1)
  if (n.endsWith('/')) n = n.slice(0, -1)
  return n
}

/**
 * True if a relative path addresses collective (Pod-shared) state. Everything
 * else (daily, spillover, output, arbitrary paths, and any `users/...` path)
 * is per-user.
 */
export function isCollectivePath(relativePath: string): boolean {
  const n = normalizeRel(relativePath)
  if (COLLECTIVE_FILES.has(n)) return true
  if (n.startsWith('memories/')) return true
  return false
}

/**
 * Thrown when a scoped view is asked to address the `users/` namespace directly
 * (e.g. `users/<other>/...`). A per-user view addresses its own files relative
 * to its root and collective files by their root names — it never needs to name
 * `users/`, so any such path is an explicit cross-user access attempt.
 */
export class CrossUserAccessError extends Error {
  constructor(relativePath: string) {
    super(`Access denied: '${relativePath}' addresses another user's namespace.`)
    this.name = 'CrossUserAccessError'
  }
}

export class ScopedWorkspace implements Workspace {
  constructor(
    private readonly collective: WorkspaceService,
    private readonly user: WorkspaceService
  ) {}

  private route(relativePath: string): WorkspaceService {
    const n = normalizeRel(relativePath)
    // Case-sensitive by design (matches LOCKED_IDENTITY_FILES): a mixed-case
    // variant like `Users/x` is NOT denied here but is still contained — it
    // routes to the caller's own per-user root, never another user's.
    if (n === USERS_DIR || n.startsWith(`${USERS_DIR}/`)) {
      throw new CrossUserAccessError(relativePath)
    }
    return isCollectivePath(relativePath) ? this.collective : this.user
  }

  /**
   * Absolute per-user root, used to scope the raw file tools (`file_read`/
   * `file_write`) which operate on a path string rather than this interface.
   * Not on the `Workspace` interface — it is ScopedWorkspace-specific.
   */
  get userRootPath(): string {
    return this.user.rootPath
  }

  // ── Primitive ops (routed by path class) ───────────────────────────────────
  // `async` so the route() guard surfaces as a rejected promise (not a sync
  // throw) regardless of how the caller consumes it (await or .catch).
  async read(relativePath: string): Promise<string | null> {
    return this.route(relativePath).read(relativePath)
  }
  async write(relativePath: string, content: string): Promise<void> {
    return this.route(relativePath).write(relativePath, content)
  }
  async append(relativePath: string, content: string): Promise<void> {
    return this.route(relativePath).append(relativePath, content)
  }
  async delete(relativePath: string): Promise<void> {
    return this.route(relativePath).delete(relativePath)
  }
  async exists(relativePath: string): Promise<boolean> {
    return this.route(relativePath).exists(relativePath)
  }

  // ── Convenience (single-class → delegate to the right instance) ─────────────
  readMemory(): Promise<string> {
    return this.collective.readMemory()
  }
  appendMemory(entry: string): Promise<void> {
    return this.collective.appendMemory(entry)
  }
  // Private memory (F5) → the per-user instance's MEMORY.md. Bypasses route()
  // on purpose: 'MEMORY.md' routes to the collective, and 'users/...' is denied.
  // Scanned + 8KB-capped automatically (the user instance sees relative
  // 'MEMORY.md' → isMemoryClassPath). Recalled via memory_search (the per-user
  // tree is searched) — NOT injected into the system prompt.
  readPrivateMemory(): Promise<string> {
    return this.user.readMemory()
  }
  appendPrivateMemory(entry: string): Promise<void> {
    return this.user.appendMemory(entry)
  }
  writePrivateMemory(content: string): Promise<void> {
    return this.user.write('MEMORY.md', content)
  }
  readHeartbeatChecklist(): Promise<string | null> {
    return this.collective.readHeartbeatChecklist()
  }
  readIdentityFiles(): ReturnType<WorkspaceService['readIdentityFiles']> {
    return this.collective.readIdentityFiles()
  }
  readTodayLog(): Promise<string> {
    return this.user.readTodayLog()
  }
  appendDailyLog(entry: string): Promise<void> {
    return this.user.appendDailyLog(entry)
  }
  snapshotDailyLogs(days = 2): Promise<string> {
    return this.user.snapshotDailyLogs(days)
  }

  /**
   * Compose the legacy system prompt from collective identity + this user's
   * daily logs. Mirrors `WorkspaceService.assembleSystemPrompt` but reads each
   * section from the correct backing instance.
   */
  async assembleSystemPrompt(): Promise<string> {
    const parts: string[] = []
    const identityFiles: [string, string][] = [
      ['AGENTS.md', '## Agent Instructions'],
      ['SOUL.md', '## Core Values'],
      ['USER.md', '## User Context'],
      ['IDENTITY.md', '## Identity'],
    ]
    for (const [filePath, header] of identityFiles) {
      const content = await this.collective.read(filePath)
      if (content && content.trim().length > 0) {
        parts.push(`${header}\n\n${content.trim()}`)
      }
    }
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    for (const [date, label] of [
      [today, "Today's Notes"],
      [yesterday, "Yesterday's Notes"],
    ] as const) {
      const content = await this.user.read(`daily/${date}.md`)
      if (content && content.trim().length > 0) {
        parts.push(`## ${label}\n\n${content.trim()}`)
      }
    }
    return parts.join('\n\n---\n\n')
  }

  // ── Listing / search (user tree ∪ collective whitelist) ─────────────────────
  async list(directory = ''): Promise<WorkspaceEntry[]> {
    if (directory === '') {
      const userEntries = await this.user.list('')
      const collectiveEntries = (await this.collective.list('')).filter(e =>
        isSurfacedCollective(e.name)
      )
      return [...collectiveEntries, ...userEntries]
    }
    return this.route(directory).list(directory)
  }

  async search(query: string, limit = 10): Promise<SearchResult[]> {
    // The collective instance is constructed with `excludeDirs: ['users']`
    // (F2), so its scan never descends into other users' subtrees. The
    // isSurfacedCollective filter below is the second, defense-in-depth layer:
    // it narrows the (already user-free) collective results to the browseable
    // whitelist (MEMORY.md + memories/), dropping identity/HEARTBEAT files.
    const [userResults, collectiveAll] = await Promise.all([
      this.user.search(query, limit),
      this.collective.search(query, limit),
    ])
    const collectiveResults = collectiveAll.filter(r => isSurfacedCollective(r.path))
    return [...userResults, ...collectiveResults].sort((a, b) => b.score - a.score).slice(0, limit)
  }
}

/**
 * Owns the single collective {@link WorkspaceService} and a per-user cache, and
 * hands out {@link ScopedWorkspace} views. The cache is keyed by `userKey` (NOT
 * per-task) so concurrent tasks of the same user share one mutex map.
 */
export class ScopedWorkspaceProvider {
  private readonly collective: WorkspaceService
  private readonly userCache = new Map<string, WorkspaceService>()

  constructor(private readonly baseRoot: string) {
    // Collective instance never enumerates/scans `users/` (per-user subtrees).
    this.collective = new WorkspaceService(baseRoot, { excludeDirs: [USERS_DIR] })
  }

  /** The collective (Pod-shared) workspace — used for admin identity reconcile. */
  get collectiveWorkspace(): WorkspaceService {
    return this.collective
  }

  private userWorkspace(userKey: string): WorkspaceService {
    let ws = this.userCache.get(userKey)
    if (!ws) {
      // Synchronous get-or-create (no construction race). Create the per-user
      // root eagerly: the raw file tools resolve via realpathSync, which throws
      // if the root does not exist yet (WorkspaceService writes create dirs
      // lazily, but file tools don't go through it).
      const userRoot = path.join(this.baseRoot, USERS_DIR, userKey)
      fs.mkdirSync(userRoot, { recursive: true })
      ws = new WorkspaceService(userRoot)
      this.userCache.set(userKey, ws)
    }
    return ws
  }

  forUser(userKey: string): ScopedWorkspace {
    return new ScopedWorkspace(this.collective, this.userWorkspace(userKey))
  }

  forSessionKey(sessionKey: string): ScopedWorkspace {
    return this.forUser(deriveUserKeyFromSessionKey(sessionKey))
  }

  forSource(
    sourceMessage?: Pick<IncomingMessage, 'sender' | 'channelType'> | null
  ): ScopedWorkspace {
    return this.forUser(deriveUserKeyFromSource(sourceMessage))
  }
}
