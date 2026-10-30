/**
 * Append-only audit trail for plugin SDK activity (spec §10.3).
 *
 * Records the SHAPE of what a plugin received, never the content: field names
 * for objects, counts for lists, byte sizes for blobs. An audit log that
 * reproduces the data it is auditing is a liability, not a control — the whole
 * point is that a user can read this file to see that LeadForge got their email
 * without the file itself becoming a second copy of their email.
 *
 * One JSONL file per environment, POSIX mode 0600 where mode bits are
 * supported, rotated at 5 MB / 90 days with a single `.1` generation kept.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { PluginStoragePrivacyGuard } from './pluginStorageWindowsAcl.js'

/** Same shape guard tokenStore.ts applies before interpolating into a path. */
const ENV_KEY_SHAPE = /^[a-z0-9_]+-[0-9a-f]{12}$/

export const AUDIT_MAX_BYTES = 5 * 1024 * 1024
export const AUDIT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

export type AuditOutcome =
  | 'allowed'
  | 'denied'
  | 'granted'
  | 'revoked'
  | 'revoked_mid_flight'
  | 'rate_limited'
  | 'error'

export type AuditConsentSource =
  | 'existing_grant'
  | 'prompt_allowed'
  | 'prompt_denied'
  | 'not_required'
  | 'user_revoked'

/** Shape summary — the only description of the payload that is ever written. */
export type AuditShape = {
  fields?: string[]
  count?: number
  bytes?: number
}

export type AuditEntry = {
  ts: string
  userId: string
  pluginId: string
  capability: string
  outcome: AuditOutcome
  consent?: AuditConsentSource
  surface?: string
  shape?: AuditShape
  /** Error code for `outcome: error`. Never an upstream message. */
  code?: string
}

export class PluginAuditLog {
  private readonly privacy: PluginStoragePrivacyGuard

  constructor(
    private readonly baseDir: string,
    private readonly now: () => number = () => Date.now()
  ) {
    this.privacy = new PluginStoragePrivacyGuard(baseDir)
  }

  private fileFor(envKey: string): string {
    if (!ENV_KEY_SHAPE.test(envKey)) throw new Error('Invalid envKey: unexpected shape')
    return path.join(this.baseDir, `${envKey}.jsonl`)
  }

  /**
   * Append one line. Never throws into the request path: an audit write failure
   * must not turn a legitimate capability call into an error for the plugin,
   * so failures are logged and swallowed. (A silently unwritable audit log is a
   * real gap; it surfaces as a console warning rather than user-facing noise.)
   */
  async append(envKey: string, entry: AuditEntry): Promise<void> {
    try {
      const file = this.fileFor(envKey)
      await this.privacy.ensureDirectory()
      await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 })
      await this.rotateIfNeeded(file)
      await this.ensureFile(file)
      await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // Audit is best effort, but do not print filesystem paths or native ACL details.
      console.warn('[PluginSDK] audit append failed')
    }
  }

  private async ensureFile(file: string): Promise<void> {
    try {
      await fs.lstat(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        const handle = await fs.open(file, 'wx', 0o600)
        await handle.close()
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError
      }
    }
    await this.privacy.verifyFile(file)
  }

  private async rotateIfNeeded(file: string): Promise<void> {
    let stat
    try {
      await fs.lstat(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await this.privacy.verifyFile(file)
    stat = await fs.stat(file)
    const tooBig = stat.size >= AUDIT_MAX_BYTES
    const tooOld = this.now() - stat.birthtimeMs >= AUDIT_MAX_AGE_MS
    if (!tooBig && !tooOld) return
    const rotated = `${file}.1`
    try {
      await fs.lstat(rotated)
      await this.privacy.verifyFile(rotated)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await fs.rm(rotated, { force: true })
    this.privacy.forget(rotated)
    await fs.rename(file, rotated)
    await this.privacy.recordRename(file, rotated)
  }

  /**
   * Newest-first read for the Settings activity tab. `ambient` capability lines
   * are on disk but the caller filters them out by default (spec §10.3) — a
   * `theme.read` per second would drown the entries a user cares about.
   */
  async read(envKey: string, options?: { limit?: number; userId?: string }): Promise<AuditEntry[]> {
    const limit = options?.limit ?? 200
    let raw: string
    try {
      const file = this.fileFor(envKey)
      await fs.lstat(file)
      await this.privacy.verifyFile(file)
      raw = await fs.readFile(file, 'utf8')
    } catch {
      return []
    }
    const entries: AuditEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as AuditEntry
        if (options?.userId && parsed.userId !== options.userId) continue
        entries.push(parsed)
      } catch {
        // A torn final line (crash mid-append) must not poison the whole read.
      }
    }
    return entries.reverse().slice(0, limit)
  }

  async clear(envKey: string): Promise<void> {
    const file = this.fileFor(envKey)
    for (const target of [file, `${file}.1`]) {
      try {
        await fs.lstat(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      await this.privacy.verifyFile(target)
    }
    await fs.rm(file, { force: true })
    await fs.rm(`${file}.1`, { force: true })
    this.privacy.forget(file)
    this.privacy.forget(`${file}.1`)
  }
}

/** Describe a payload without copying it. */
export function shapeOf(value: unknown): AuditShape {
  if (value === null || value === undefined) return {}
  if (Array.isArray(value)) return { count: value.length }
  if (typeof value === 'string') return { bytes: Buffer.byteLength(value, 'utf8') }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const fields = Object.keys(record).sort()
    // A single-key wrapper around a list ({ agents: [...] }) is much more
    // useful reported as a count than as the field name alone.
    const only = fields.length === 1 ? record[fields[0] as string] : undefined
    if (Array.isArray(only)) return { fields, count: only.length }
    return { fields }
  }
  return {}
}
