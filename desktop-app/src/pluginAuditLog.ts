/**
 * Append-only audit trail for plugin SDK activity (spec §10.3).
 *
 * Records the SHAPE of what a plugin received, never the content: field names
 * for objects, counts for lists, byte sizes for blobs. An audit log that
 * reproduces the data it is auditing is a liability, not a control — the whole
 * point is that a user can read this file to see that LeadForge got their email
 * without the file itself becoming a second copy of their email.
 *
 * One JSONL file per environment, mode 0600, rotated at 5 MB / 90 days with a
 * single `.1` generation kept.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

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
  constructor(
    private readonly baseDir: string,
    private readonly now: () => number = () => Date.now()
  ) {}

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
      await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 })
      await this.rotateIfNeeded(file)
      await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (err) {
      console.warn('[PluginSDK] audit append failed:', err)
    }
  }

  private async rotateIfNeeded(file: string): Promise<void> {
    let stat
    try {
      stat = await fs.stat(file)
    } catch {
      return
    }
    const tooBig = stat.size >= AUDIT_MAX_BYTES
    const tooOld = this.now() - stat.birthtimeMs >= AUDIT_MAX_AGE_MS
    if (!tooBig && !tooOld) return
    await fs.rm(`${file}.1`, { force: true })
    await fs.rename(file, `${file}.1`)
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
      raw = await fs.readFile(this.fileFor(envKey), 'utf8')
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
    await fs.rm(file, { force: true })
    await fs.rm(`${file}.1`, { force: true })
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
