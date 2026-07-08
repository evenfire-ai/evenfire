/**
 * WorkspaceService — filesystem-backed document store.
 *
 * All operations are scoped to the workspace root directory.
 * Path safety: rejects absolute paths, ".." traversal, and null bytes.
 */
import { Mutex } from 'async-mutex'
import * as fs from 'fs/promises'
import * as path from 'path'
import type { PersonalizationConfig } from '../types'
import { scanWriteContent } from './scanner'
import { searchWorkspace } from './search'
import { SearchConfig, SearchResult, WorkspaceEntry } from './types'

function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

// Case-sensitive by design: these are the exact root-level filenames mcp-host
// reconciles from Host.spec.personalization. Lowercase variants are not
// friendly-blocked here; filesystem permissions still provide the OS backstop.
export const LOCKED_IDENTITY_FILES: ReadonlySet<string> = new Set([
  'IDENTITY.md',
  'SOUL.md',
  'AGENTS.md',
  'USER.md',
])

export function adminManagedIdentityFileMessage(filename: string): string {
  return `${filename} is admin-managed and cannot be modified by the agent. Contact your admin to update it.`
}

export class LockedFileError extends Error {
  constructor(filename: string) {
    super(adminManagedIdentityFileMessage(filename))
    this.name = 'LockedFileError'
  }
}

/**
 * Normalize a relative path to its canonical root-level form so we can compare
 * against LOCKED_IDENTITY_FILES exactly. Rejects anything that — after
 * normalization — is the bare basename of a locked file at workspace root.
 *
 * Returns true for: "IDENTITY.md", "./IDENTITY.md", "/IDENTITY.md", "IDENTITY.md/", etc.
 * Returns false for: "agents.md" (case), "daily/AGENTS.md" (sub-path), "AGENTS.md.bak".
 */
export function isLockedPath(relativePath: string): boolean {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false
  // path.posix.normalize handles "./", "//", "/.", trailing-".".
  // Then strip leading "/" and "./", and trailing "/".
  let normalized = path.posix.normalize(relativePath)
  if (normalized.startsWith('./')) normalized = normalized.slice(2)
  if (normalized.startsWith('/')) normalized = normalized.slice(1)
  if (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return LOCKED_IDENTITY_FILES.has(normalized)
}

/**
 * Agent-facing workspace surface, implemented by both {@link WorkspaceService}
 * (the flat Pod-wide store) and `ScopedWorkspace` (the per-user routing view).
 * Consumers that receive an injected workspace (memory tools, context manager,
 * prompt assembly) depend on this interface so a scoped view is a drop-in.
 * Collective-only operations (`applyAdminIdentityFiles`, `listAll`) are NOT on
 * the interface — they live on `WorkspaceService` and run on the collective root.
 */
export interface Workspace {
  read(relativePath: string): Promise<string | null>
  write(relativePath: string, content: string): Promise<void>
  append(relativePath: string, content: string): Promise<void>
  delete(relativePath: string): Promise<void>
  exists(relativePath: string): Promise<boolean>
  list(directory?: string): Promise<WorkspaceEntry[]>
  search(query: string, limit?: number): Promise<SearchResult[]>
  readMemory(): Promise<string>
  appendMemory(entry: string): Promise<void>
  readPrivateMemory(): Promise<string>
  appendPrivateMemory(entry: string): Promise<void>
  writePrivateMemory(content: string): Promise<void>
  readTodayLog(): Promise<string>
  appendDailyLog(entry: string): Promise<void>
  readHeartbeatChecklist(): Promise<string | null>
  readIdentityFiles(): Promise<{ identity: string; soul: string; agents: string; user: string }>
  snapshotDailyLogs(days?: number): Promise<string>
  assembleSystemPrompt(): Promise<string>
}

export class WorkspaceService implements Workspace {
  // Per-file mutex keyed by absolute resolved path. Ensures concurrent
  // writes/appends from different sessions don't interleave and that the
  // read-modify-write inside append() is transactional.
  private readonly fileMutexes = new Map<string, Mutex>()

  constructor(
    private readonly workspacePath: string,
    // Top-level dir names skipped by `list('')`/`listAll`/`search` — used so the
    // collective instance never enumerates or scans `users/` (per-user subtrees).
    private readonly options?: { excludeDirs?: readonly string[] }
  ) {}

  /** Absolute root this service is confined to (used to scope raw file tools). */
  get rootPath(): string {
    return this.workspacePath
  }

  // ── Path safety ────────────────────────────────────────────────────────────

  private resolvePath(relativePath: string): string {
    if (relativePath.includes('\0')) {
      throw new Error('Path contains null bytes')
    }
    if (path.isAbsolute(relativePath)) {
      throw new Error('Absolute paths not allowed')
    }
    if (relativePath.includes('..')) {
      throw new Error('Directory traversal (..) not allowed')
    }
    // Normalize: strip leading slash, collapse duplicate slashes
    const normalized = relativePath.replace(/\/+/g, '/').replace(/^\//, '')
    const resolved = path.resolve(this.workspacePath, normalized)
    // Containment via path.relative (not startsWith, which has a prefix-collision
    // bug: "/a/ws" would match a sibling "/a/ws-evil"). This matters once the
    // service is rooted at a per-user subtree. A symlink inside the root can
    // still redirect out — that residual is bundled with shell sandboxing.
    const rel = path.relative(this.workspacePath, resolved)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Path resolves outside workspace')
    }
    return resolved
  }

  private mutexFor(absolutePath: string): Mutex {
    let m = this.fileMutexes.get(absolutePath)
    if (!m) {
      m = new Mutex()
      this.fileMutexes.set(absolutePath, m)
    }
    return m
  }

  // ── Document CRUD ──────────────────────────────────────────────────────────

  async read(relativePath: string): Promise<string | null> {
    const resolved = this.resolvePath(relativePath) // throws on invalid paths
    try {
      return await fs.readFile(resolved, 'utf-8')
    } catch {
      return null
    }
  }

  async write(relativePath: string, content: string): Promise<void> {
    if (isLockedPath(relativePath)) {
      throw new LockedFileError(relativePath)
    }
    const resolved = this.resolvePath(relativePath)
    scanWriteContent(relativePath, content, Buffer.byteLength(content, 'utf-8'))
    await this.mutexFor(resolved).runExclusive(async () => {
      await this._atomicWrite(resolved, content)
    })
  }

  /**
   * `opts.scan === false` skips the prompt-feeding injection scan. Used ONLY by
   * `appendDailyLog` for the compaction archive (F3): that content is raw
   * conversation that already passed through the model, not a fresh injection
   * vector, and legitimate conversation (security discussions, pastes, quoted
   * prompts) trips the patterns — scanning it would silently drop legitimate
   * archives. Deliberate agent writes to `daily/*` (memory_write) use the
   * default-scanned path.
   */
  async append(relativePath: string, content: string, opts?: { scan?: boolean }): Promise<void> {
    if (isLockedPath(relativePath)) {
      throw new LockedFileError(relativePath)
    }
    const resolved = this.resolvePath(relativePath)
    await this.mutexFor(resolved).runExclusive(async () => {
      let existing: string | null
      try {
        existing = await fs.readFile(resolved, 'utf-8')
      } catch {
        existing = null
      }
      const separator = existing ? '\n' : ''
      const next = (existing ?? '') + separator + content
      if (opts?.scan !== false) {
        scanWriteContent(relativePath, next, Buffer.byteLength(next, 'utf-8'))
      }
      await this._atomicWrite(resolved, next)
    })
  }

  async delete(relativePath: string): Promise<void> {
    if (isLockedPath(relativePath)) {
      throw new LockedFileError(relativePath)
    }
    await fs.unlink(this.resolvePath(relativePath))
  }

  /**
   * Atomic write via temp file + rename. Crash- and race-safe: readers always
   * see either the previous content or the new content, never a partial one.
   * On any I/O failure, the temp file is best-effort cleaned up.
   */
  private async _atomicWrite(
    resolved: string,
    content: string,
    opts?: { chmod?: number }
  ): Promise<void> {
    const dir = path.dirname(resolved)
    const base = path.basename(resolved)
    const tempPath = path.join(
      dir,
      `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    )
    try {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(tempPath, content, 'utf-8')
      if (opts?.chmod !== undefined) {
        await fs.chmod(tempPath, opts.chmod)
      }
      await fs.rename(tempPath, resolved)
    } catch (err) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
      throw err
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolvePath(relativePath))
      return true
    } catch {
      return false
    }
  }

  // ── Directory listing ──────────────────────────────────────────────────────

  async list(directory: string = ''): Promise<WorkspaceEntry[]> {
    const resolved = directory ? this.resolvePath(directory) : this.workspacePath
    let entries: { name: string; isDirectory(): boolean }[]
    try {
      entries = await fs.readdir(resolved, { withFileTypes: true })
    } catch {
      return []
    }

    const results: WorkspaceEntry[] = []
    for (const entry of entries) {
      // At the root, skip excluded top-level dirs (e.g. `users/` on collective).
      if (!directory && this.options?.excludeDirs?.includes(entry.name)) continue
      const entryPath = path.join(directory, entry.name).replace(/^\//, '')
      const absPath = path.join(resolved, entry.name)
      let size: number | undefined
      let modifiedAt: string | undefined
      try {
        const stat = await fs.stat(absPath)
        size = stat.size
        modifiedAt = stat.mtime.toISOString()
      } catch {
        // ignore stat errors
      }
      results.push({
        name: entry.name,
        path: entryPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size,
        modifiedAt,
      })
    }
    return results
  }

  async listAll(): Promise<string[]> {
    const { searchWorkspace: collect } = await import('./search')
    // Reuse the internal file collector by doing a dummy search with empty result
    const files: string[] = []
    const entries = await this.list()
    const recurse = async (dir: string) => {
      const children = await this.list(dir)
      for (const child of children) {
        if (child.type === 'directory') {
          await recurse(child.path)
        } else {
          files.push(child.path)
        }
      }
    }
    for (const entry of entries) {
      if (entry.type === 'directory') {
        await recurse(entry.path)
      } else {
        files.push(entry.path)
      }
    }
    return files
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async search(query: string, limit: number = 10): Promise<SearchResult[]> {
    return searchWorkspace(this.workspacePath, query, { limit }, this.options?.excludeDirs)
  }

  // ── Convenience methods ────────────────────────────────────────────────────

  async readMemory(): Promise<string> {
    return (await this.read('MEMORY.md')) ?? ''
  }

  async appendMemory(entry: string): Promise<void> {
    await this.append('MEMORY.md', entry)
  }

  // ── Private (per-user) memory (F5) ──────────────────────────────────────────
  // A flat WorkspaceService has no per-user dimension, so private memory
  // degenerates to its single MEMORY.md. In production the injected workspace is
  // a ScopedWorkspace, which routes these to the per-user root
  // (`users/<userKey>/MEMORY.md`). MEMORY.md content is NOT injected into the
  // system prompt — the agent recalls it via memory_search / memory_read.
  async readPrivateMemory(): Promise<string> {
    return this.readMemory()
  }

  async appendPrivateMemory(entry: string): Promise<void> {
    await this.appendMemory(entry)
  }

  async writePrivateMemory(content: string): Promise<void> {
    await this.write('MEMORY.md', content)
  }

  async readTodayLog(): Promise<string> {
    return (await this.read(`daily/${todayDate()}.md`)) ?? ''
  }

  async appendDailyLog(entry: string): Promise<void> {
    const now = new Date().toISOString().slice(11, 19) // HH:MM:SS
    // scan:false — this is the compaction-archive path (raw conversation that
    // already passed through the model). Deliberate agent writes to daily use
    // `append('daily/...')` directly (memory_write) and ARE scanned. See F3.
    await this.append(`daily/${todayDate()}.md`, `[${now}] ${entry}`, { scan: false })
  }

  async readHeartbeatChecklist(): Promise<string | null> {
    const content = await this.read('HEARTBEAT.md')
    if (!content) return null

    // Empty detection: only whitespace, HTML comments, headers, or empty checkboxes
    const stripped = content
      .replace(/<!--[\s\S]*?-->/g, '') // strip HTML comments
      .replace(/^#+\s.*$/gm, '') // strip markdown headers
      .replace(/^\s*-\s*\[\s*\]\s*.*$/gm, '') // strip empty checkboxes
      .trim()

    return stripped.length > 0 ? content : null
  }

  // ── T2.2 — Tiered system prompt helpers ────────────────────────────────────

  /**
   * Read the four locked identity files as separate strings (instead of the
   * pre-concatenated form `assembleSystemPrompt()` returns). T2.2 needs them
   * individually so the `stable` tier can format each section with a header
   * and skip the empty ones cleanly. Returns the empty string for any file
   * that does not exist or is unreadable — identical semantics to the legacy
   * loader.
   */
  async readIdentityFiles(): Promise<{
    identity: string
    soul: string
    agents: string
    user: string
  }> {
    const [identity, soul, agents, user] = await Promise.all([
      this.read('IDENTITY.md').then(c => c ?? ''),
      this.read('SOUL.md').then(c => c ?? ''),
      this.read('AGENTS.md').then(c => c ?? ''),
      this.read('USER.md').then(c => c ?? ''),
    ])
    return { identity, soul, agents, user }
  }

  /**
   * Read the last `days` daily logs (today first) and concatenate them with
   * absolute date headers. Empty or missing days are omitted. T2.2 freezes
   * the resulting string at session start so mid-session writes to
   * `daily/<today>.md` do NOT re-flow into the cached `stable` tier.
   *
   * Labels are absolute (`## 2026-05-22 Notes`) rather than relative
   * (`Today`/`Yesterday`) because the snapshot survives the session lifetime
   * and may outlive midnight — a frozen "Today's Notes" header would lie
   * about the date of the underlying file once the calendar day rolls.
   */
  async snapshotDailyLogs(days: number = 2): Promise<string> {
    const parts: string[] = []
    const today = new Date()
    for (let i = 0; i < days; i++) {
      const d = new Date(today.getTime() - i * 86400000)
      const date = d.toISOString().slice(0, 10)
      const content = await this.read(`daily/${date}.md`)
      if (content && content.trim().length > 0) {
        parts.push(`## ${date} Notes\n\n${content.trim()}`)
      }
    }
    return parts.join('\n\n---\n\n')
  }

  // ── System prompt assembly ─────────────────────────────────────────────────

  async assembleSystemPrompt(): Promise<string> {
    const parts: string[] = []

    const identityFiles: [string, string][] = [
      ['AGENTS.md', '## Agent Instructions'],
      ['SOUL.md', '## Core Values'],
      ['USER.md', '## User Context'],
      ['IDENTITY.md', '## Identity'],
    ]

    for (const [filePath, header] of identityFiles) {
      const content = await this.read(filePath)
      if (content && content.trim().length > 0) {
        parts.push(`${header}\n\n${content.trim()}`)
      }
    }

    // Include last 2 days of daily logs
    const today = todayDate()
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)

    for (const [date, label] of [
      [today, "Today's Notes"],
      [yesterday, "Yesterday's Notes"],
    ] as const) {
      const content = await this.read(`daily/${date}.md`)
      if (content && content.trim().length > 0) {
        parts.push(`## ${label}\n\n${content.trim()}`)
      }
    }

    return parts.join('\n\n---\n\n')
  }

  // ── Identity file reconciliation (admin-managed) ───────────────────────────

  /**
   * Reconcile the four locked identity files from a PersonalizationConfig.
   *
   * For each file:
   *   - Non-empty field → overwrite the file with that content.
   *   - Empty / undefined / null field → truncate the file to empty.
   *
   * Each file is left chmod 0o444 after writing, so any non-privileged caller
   * that bypasses the workspace lock check gets EACCES from the OS.
   *
   * Idempotent. No-op when config is null/undefined.
   */
  async applyAdminIdentityFiles(config: PersonalizationConfig | null | undefined): Promise<void> {
    if (!config) return
    await fs.mkdir(this.workspacePath, { recursive: true })
    const files: Array<[string, string | undefined]> = [
      ['IDENTITY.md', config.identity],
      ['SOUL.md', config.soul],
      ['AGENTS.md', config.agents],
      ['USER.md', config.user],
    ]
    for (const [filename, content] of files) {
      const resolved = this.resolvePath(filename)
      await this.mutexFor(resolved).runExclusive(async () => {
        await this._atomicWrite(resolved, content ?? '', { chmod: 0o444 })
      })
    }
  }
}
