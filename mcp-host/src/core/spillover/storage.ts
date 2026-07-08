/**
 * T1.5 — Filesystem-backed spillover storage.
 *
 * Persists oversized tool outputs out-of-band so the inline `tool` message
 * carries only a rich summary (head/tail/fingerprint/structure_hint) +
 * a `spillover_ref` URI on the lateral field (Opción D, P.3).
 *
 * Storage layout: `${workspacePath}/spillover/<task_id>/<tool_call_id>.json`.
 * Each blob is a `SpilloverBlob` JSON object — wrapping the raw output in
 * JSON guarantees a deterministic fingerprint, makes the file self-describing
 * for ops, and reserves room for a future `version` bump (chunking, etc).
 *
 * Path safety: `taskId`/`toolCallId` are validated against `[A-Za-z0-9_-]+`
 * AND the resolved absolute path must stay within the spillover root prefix.
 * Tests cover both `..` traversal and null bytes.
 *
 * Atomic writes: temp file + rename, mirroring `WorkspaceService._atomicWrite`.
 * GC: lazy sweep at boot + optional periodic sweep via `startGc()`.
 */
import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import { Counter, Gauge, Histogram } from 'prom-client'
import { buildSpilloverRef, parseSpilloverRef } from './refResolver'
import { generateStructureHint, inferContentType } from './structureHints'
import type {
  MaybePersistArgs,
  SpilloverBlob,
  SpilloverStorageOptions,
  SpilloverSummary,
  SweepResult,
} from './types'

// ── Prometheus instruments (co-located, plan §9) ───────────────────────────
//
// Cardinality budget: `tool` label is closed-set (file_read, http_request,
// shell_exec, …) plus an open tail of `clerum__*` and `<server>__<tool>` from
// MCP. Worst case ~50 series, well within limits.

// Each metric is constructed inside a try/catch so a duplicate-registration
// error (typically when vitest reuses module state across suites) leaves the
// export as `undefined` instead of crashing module evaluation. Call-sites use
// optional chaining (`metric?.inc(...)`) accordingly.

export const clerumSpilloverBytesTotal = (() => {
  try {
    return new Gauge({
      name: 'clerum_spillover_bytes_total',
      help: 'Total bytes currently held in the spillover store (refreshed on sweep).',
    })
  } catch {
    return undefined
  }
})()

export const clerumToolOutputBytes = (() => {
  try {
    return new Histogram({
      name: 'clerum_tool_output_bytes',
      help: 'Distribution of post-sanitization tool output sizes in bytes.',
      labelNames: ['tool'] as const,
      buckets: [
        1 * 1024,
        4 * 1024,
        8 * 1024,
        16 * 1024,
        64 * 1024,
        256 * 1024,
        1 * 1024 * 1024,
        4 * 1024 * 1024,
        16 * 1024 * 1024,
      ],
    })
  } catch {
    return undefined
  }
})()

export const clerumSpilloverPersistedTotal = (() => {
  try {
    return new Counter({
      name: 'clerum_spillover_persisted_total',
      help: 'Count of tool outputs spilled to disk.',
      labelNames: ['tool'] as const,
    })
  } catch {
    return undefined
  }
})()

export const clerumSpilloverReadsTotal = (() => {
  try {
    return new Counter({
      name: 'clerum_spillover_reads_total',
      help: 'Count of clerum__spillover_read invocations.',
      labelNames: ['with_range'] as const,
    })
  } catch {
    return undefined
  }
})()

export const clerumSpilloverGcFilesDeleted = (() => {
  try {
    return new Counter({
      name: 'clerum_spillover_gc_files_deleted_total',
      help: 'Total spillover blobs removed by GC sweeps.',
    })
  } catch {
    return undefined
  }
})()

export const clerumSpilloverGcBytesFreed = (() => {
  try {
    return new Counter({
      name: 'clerum_spillover_gc_bytes_freed_total',
      help: 'Total bytes reclaimed by spillover GC sweeps.',
    })
  } catch {
    return undefined
  }
})()

export const clerumApprovalExpiredTotal = (() => {
  try {
    return new Counter({
      name: 'clerum_approval_expired_total',
      help: 'Approvals that failed because a referenced spillover ref expired.',
      labelNames: ['reason'] as const,
    })
  } catch {
    return undefined
  }
})()

const HEAD_TAIL_CHARS = 400

const SPILLOVER_ROOT = 'spillover'

export class SpilloverStorage {
  private readonly opts: SpilloverStorageOptions
  private gcTimer: NodeJS.Timeout | null = null
  /** Resolved absolute root for safety prefix checks. Trailing separator stripped. */
  private readonly rootAbs: string

  constructor(opts: SpilloverStorageOptions) {
    if (!opts.workspacePath) throw new Error('SpilloverStorage: workspacePath is required')
    if (opts.thresholdBytes < 0) throw new Error('SpilloverStorage: thresholdBytes must be >= 0')
    if (opts.ttlMs < 0) throw new Error('SpilloverStorage: ttlMs must be >= 0')
    if (opts.gcIntervalMs < 0) throw new Error('SpilloverStorage: gcIntervalMs must be >= 0')
    this.opts = opts
    this.rootAbs = path.resolve(opts.workspacePath, SPILLOVER_ROOT)
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Persist `content` if it exceeds `thresholdBytes` (and isn't an exception).
   * Returns the summary to embed in the `tool` message, or null when the
   * caller should inline `content` as-is.
   *
   * Excludes (plan §4.1):
   *   - `isError === true` → never spill (errors are tiny and worth inlining).
   *   - `toolName === 'clerum__spillover_read'` → never spill (the user asked
   *     for the data; persisting it again is recursion bait).
   */
  async maybePersist(args: MaybePersistArgs): Promise<SpilloverSummary | null> {
    const byteSize = Buffer.byteLength(args.content, 'utf8')
    clerumToolOutputBytes?.observe({ tool: args.toolName }, byteSize)

    if (args.isError) return null
    if (args.toolName === 'clerum__spillover_read') return null
    if (byteSize < this.opts.thresholdBytes) return null

    const ref = buildSpilloverRef(args.taskId, args.toolCallId)
    const resolved = this.resolvePath(args.taskId, args.toolCallId)
    const fingerprint = sha256(args.content)
    const lineCount = countLines(args.content)
    const contentType = inferContentType(args.toolName, args.content)

    const blob: SpilloverBlob = {
      version: 1,
      tool_call_id: args.toolCallId,
      tool_name: args.toolName,
      task_id: args.taskId,
      created_at_ms: Date.now(),
      byte_size: byteSize,
      line_count: lineCount,
      content_type: contentType,
      fingerprint_sha256: fingerprint,
      content: args.content,
    }

    await this.atomicWrite(resolved, JSON.stringify(blob))
    clerumSpilloverPersistedTotal?.inc({ tool: args.toolName })

    const head =
      args.content.length > HEAD_TAIL_CHARS ? args.content.slice(0, HEAD_TAIL_CHARS) : args.content
    const tail = args.content.length > HEAD_TAIL_CHARS ? args.content.slice(-HEAD_TAIL_CHARS) : ''
    const structureHint = generateStructureHint(args.toolName, args.content, contentType)

    return {
      spillover_ref: ref,
      byte_size: byteSize,
      line_count: lineCount,
      content_type: contentType,
      fingerprint_sha256: fingerprint,
      head,
      tail,
      structure_hint: structureHint,
    }
  }

  /**
   * Resolve a ref to its persisted blob. Returns null if the ref is malformed
   * or the file is missing/expired. The caller decides whether to surface
   * the miss as `approval_expired` or just an inline error.
   */
  async load(ref: string): Promise<SpilloverBlob | null> {
    const parsed = parseSpilloverRef(ref)
    if (!parsed) return null
    const resolved = this.tryResolve(parsed.taskId, parsed.toolCallId)
    if (!resolved) return null
    try {
      const raw = await fs.readFile(resolved, 'utf-8')
      const blob = JSON.parse(raw) as SpilloverBlob
      if (!blob || blob.version !== 1) return null
      // Defensive: if TTL has elapsed, treat as expired even if GC hasn't run.
      if (this.opts.ttlMs > 0 && Date.now() - blob.created_at_ms > this.opts.ttlMs) {
        return null
      }
      return blob
    } catch {
      return null
    }
  }

  /**
   * Cheap existence probe — used by the resume path to decide
   * `approval_expired` BEFORE reading the blob content.
   */
  async exists(ref: string): Promise<boolean> {
    const parsed = parseSpilloverRef(ref)
    if (!parsed) return false
    const resolved = this.tryResolve(parsed.taskId, parsed.toolCallId)
    if (!resolved) return false
    try {
      const stat = await fs.stat(resolved)
      if (!stat.isFile()) return false
      if (this.opts.ttlMs > 0) {
        // Use mtime as a conservative liveness signal; the load path
        // double-checks against `created_at_ms`.
        if (Date.now() - stat.mtimeMs > this.opts.ttlMs) return false
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * Walk the spillover root, delete files older than TTL, and rmdir empty
   * task directories. Returns the totals it freed.
   *
   * Defensive: never throws — sweep is best-effort observability. Errors
   * are logged once and the next sweep retries.
   */
  async sweep(): Promise<SweepResult> {
    let bytesFreed = 0
    let filesDeleted = 0
    let bytesAlive = 0
    const cutoff = this.opts.ttlMs > 0 ? Date.now() - this.opts.ttlMs : Number.NEGATIVE_INFINITY

    let taskDirs: string[]
    try {
      taskDirs = await fs.readdir(this.rootAbs)
    } catch {
      // Root not created yet (no spillover ever written). Nothing to do.
      clerumSpilloverBytesTotal?.set(0)
      return { bytesFreed: 0, filesDeleted: 0 }
    }

    for (const dir of taskDirs) {
      // Defensive: only walk well-formed task dirs.
      if (!/^[A-Za-z0-9_-]+$/.test(dir)) continue
      const taskDirAbs = path.join(this.rootAbs, dir)
      let entries: string[]
      try {
        entries = await fs.readdir(taskDirAbs)
      } catch {
        continue
      }

      for (const entry of entries) {
        const entryAbs = path.join(taskDirAbs, entry)
        try {
          const stat = await fs.stat(entryAbs)
          if (!stat.isFile()) continue
          if (stat.mtimeMs <= cutoff) {
            bytesFreed += stat.size
            filesDeleted += 1
            await fs.rm(entryAbs, { force: true })
          } else {
            bytesAlive += stat.size
          }
        } catch {
          // skip on race
        }
      }

      // Rmdir the directory if it's empty.
      try {
        const remaining = await fs.readdir(taskDirAbs)
        if (remaining.length === 0) await fs.rmdir(taskDirAbs)
      } catch {
        // skip
      }
    }

    if (filesDeleted > 0) clerumSpilloverGcFilesDeleted?.inc(filesDeleted)
    if (bytesFreed > 0) clerumSpilloverGcBytesFreed?.inc(bytesFreed)
    clerumSpilloverBytesTotal?.set(bytesAlive)
    return { bytesFreed, filesDeleted }
  }

  /**
   * Compute current on-disk bytes without deleting anything. Mostly used by
   * tests and ops debugging. The Prometheus gauge is refreshed every sweep().
   */
  async currentBytesOnDisk(): Promise<number> {
    let total = 0
    let dirs: string[]
    try {
      dirs = await fs.readdir(this.rootAbs)
    } catch {
      return 0
    }
    for (const dir of dirs) {
      if (!/^[A-Za-z0-9_-]+$/.test(dir)) continue
      const taskDirAbs = path.join(this.rootAbs, dir)
      let entries: string[]
      try {
        entries = await fs.readdir(taskDirAbs)
      } catch {
        continue
      }
      for (const entry of entries) {
        try {
          const stat = await fs.stat(path.join(taskDirAbs, entry))
          if (stat.isFile()) total += stat.size
        } catch {
          // skip
        }
      }
    }
    return total
  }

  /** Start the periodic GC sweep. No-op if `gcIntervalMs === 0`. */
  startGc(): void {
    if (this.opts.gcIntervalMs === 0) return
    if (this.gcTimer) return
    this.gcTimer = setInterval(() => {
      this.sweep().catch(err => {
        console.error('[SpilloverStorage] GC sweep failed:', err)
      })
    }, this.opts.gcIntervalMs)
    // Don't keep the process alive just for the sweep.
    if (typeof this.gcTimer.unref === 'function') this.gcTimer.unref()
  }

  /** Stop the periodic GC sweep. Idempotent. */
  stopGc(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer)
      this.gcTimer = null
    }
  }

  /** Test-only helper to forcibly drop a blob (simulates TTL expiration). */
  async _testOnlyDelete(taskId: string, toolCallId: string): Promise<void> {
    const resolved = this.tryResolve(taskId, toolCallId)
    if (!resolved) return
    await fs.rm(resolved, { force: true })
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private resolvePath(taskId: string, toolCallId: string): string {
    const resolved = this.tryResolve(taskId, toolCallId)
    if (!resolved) {
      throw new Error(
        `Invalid spillover path components: taskId=${JSON.stringify(taskId)} toolCallId=${JSON.stringify(toolCallId)}`
      )
    }
    return resolved
  }

  private tryResolve(taskId: string, toolCallId: string): string | null {
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(taskId)) return null
    if (typeof toolCallId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(toolCallId)) return null
    const resolved = path.resolve(this.rootAbs, taskId, `${toolCallId}.json`)
    if (!resolved.startsWith(this.rootAbs + path.sep) && resolved !== this.rootAbs) {
      return null
    }
    return resolved
  }

  private async atomicWrite(resolved: string, content: string): Promise<void> {
    const dir = path.dirname(resolved)
    const base = path.basename(resolved)
    const tempPath = path.join(
      dir,
      `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    )
    await fs.mkdir(dir, { recursive: true })
    try {
      await fs.writeFile(tempPath, content, 'utf-8')
      await fs.rename(tempPath, resolved)
    } catch (err) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
      throw err
    }
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function countLines(content: string): number {
  if (content.length === 0) return 0
  let count = 1
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) count += 1
  }
  // If the content ends with a trailing newline we counted an empty line — normalize.
  if (content.charCodeAt(content.length - 1) === 10) count -= 1
  return Math.max(count, 1)
}
