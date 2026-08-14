/**
 * Consent grant persistence (spec §10).
 *
 * The interface is the v1 obligation; the local implementation is v1's answer.
 * A server-backed store (spec §10.6) implements the same interface, which is
 * the test of whether the layering is right: syncing grants across devices
 * should touch this file and nothing the plugin can observe.
 *
 * Storage: one JSON file per environment under `<userData>/plugin-consent/`,
 * mode 0600, written atomically. Scoped by `envKey` exactly like `tokenStore`
 * and the sandbox-ui partitions, so cluster A's grants never leak into
 * cluster B's. Keyed by `userId` inside the file, so a shared machine keeps two
 * humans' decisions apart.
 *
 * NOT encrypted, deliberately: grants are not secrets ("plugin X may read Y"),
 * and an attacker who can read this file can already read the audit log or
 * patch the app bundle. safeStorage would add a platform-dependent failure mode
 * for no real gain. 0600 is the protection.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const ENV_KEY_SHAPE = /^[a-z0-9_]+-[0-9a-f]{12}$/
const SCHEMA_VERSION = 1

export type ConsentGrant = {
  envKey: string
  userId: string
  /** `<recipeNs>/<recipeName>` */
  pluginId: string
  capability: string
  grantedAt: string
  lastUsedAt: string | null
  /** Bumped when a capability's payload widens; older grants stop covering it (§9.6). */
  descriptorVersion: number
  /** Monotonic per grant, for the v2 sync merge. */
  revision: number
}

export type GrantKey = {
  envKey: string
  userId: string
  pluginId: string
  capability: string
}

export interface ConsentStore {
  list(envKey: string, userId: string): Promise<ConsentGrant[]>
  get(key: GrantKey): Promise<ConsentGrant | null>
  put(grant: ConsentGrant): Promise<void>
  touch(key: GrantKey): Promise<void>
  revoke(key: GrantKey): Promise<void>
  revokeAllForPlugin(envKey: string, userId: string, pluginId: string): Promise<void>
  /** v2 hook; the local implementation does not define it. */
  sync?(envKey: string, userId: string): Promise<void>
}

type ConsentFile = {
  version: number
  users: Record<string, ConsentGrant[]>
}

function emptyFile(): ConsentFile {
  return { version: SCHEMA_VERSION, users: {} }
}

function sameGrant(grant: ConsentGrant, key: GrantKey): boolean {
  return grant.pluginId === key.pluginId && grant.capability === key.capability
}

export class LocalConsentStore implements ConsentStore {
  /** envKey → parsed file. Invalidated on every write. */
  private cache = new Map<string, ConsentFile>()
  /** Serializes read-modify-write so two concurrent puts cannot drop one. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly baseDir: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  private fileFor(envKey: string): string {
    if (!ENV_KEY_SHAPE.test(envKey)) throw new Error('Invalid envKey: unexpected shape')
    return path.join(this.baseDir, `${envKey}.json`)
  }

  private async load(envKey: string): Promise<ConsentFile> {
    const cached = this.cache.get(envKey)
    if (cached) return cached
    const file = this.fileFor(envKey)
    let parsed: ConsentFile
    try {
      const raw = await fs.readFile(file, 'utf8')
      const candidate = JSON.parse(raw) as ConsentFile
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        candidate.version !== SCHEMA_VERSION ||
        typeof candidate.users !== 'object'
      ) {
        throw new Error(`unsupported consent file version: ${candidate?.version}`)
      }
      parsed = candidate
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code && code !== 'ENOENT') {
        // Fail CLOSED: an unreadable or future-version file means every
        // capability re-prompts. Never partially parse a consent file — a
        // half-understood grant list is worse than no grant list.
        console.warn('[PluginSDK] consent file unreadable, starting empty:', err)
        await fs.rename(file, `${file}.corrupt-${this.now()}`).catch(() => undefined)
      } else if (!code) {
        console.warn('[PluginSDK] consent file invalid, starting empty:', err)
        await fs.rename(file, `${file}.corrupt-${this.now()}`).catch(() => undefined)
      }
      parsed = emptyFile()
    }
    this.cache.set(envKey, parsed)
    return parsed
  }

  private async save(envKey: string, data: ConsentFile): Promise<void> {
    const file = this.fileFor(envKey)
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 })
    // Atomic: a crash mid-write leaves the previous file intact rather than a
    // truncated one that would fail closed and silently drop every grant.
    const tmp = `${file}.tmp-${this.now()}`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, file)
    this.cache.set(envKey, data)
  }

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  async list(envKey: string, userId: string): Promise<ConsentGrant[]> {
    const data = await this.load(envKey)
    return [...(data.users[userId] ?? [])]
  }

  async get(key: GrantKey): Promise<ConsentGrant | null> {
    const rows = await this.list(key.envKey, key.userId)
    return rows.find(row => sameGrant(row, key)) ?? null
  }

  async put(grant: ConsentGrant): Promise<void> {
    await this.mutate(async () => {
      const data = await this.load(grant.envKey)
      const rows = data.users[grant.userId] ?? []
      const existing = rows.find(row => sameGrant(row, grant))
      const next = rows.filter(row => !sameGrant(row, grant))
      next.push({ ...grant, revision: (existing?.revision ?? 0) + 1 })
      data.users[grant.userId] = next
      await this.save(grant.envKey, data)
    })
  }

  async touch(key: GrantKey): Promise<void> {
    await this.mutate(async () => {
      const data = await this.load(key.envKey)
      const rows = data.users[key.userId] ?? []
      const row = rows.find(entry => sameGrant(entry, key))
      if (!row) return
      row.lastUsedAt = new Date(this.now()).toISOString()
      await this.save(key.envKey, data)
    })
  }

  async revoke(key: GrantKey): Promise<void> {
    await this.mutate(async () => {
      const data = await this.load(key.envKey)
      const rows = data.users[key.userId] ?? []
      data.users[key.userId] = rows.filter(row => !sameGrant(row, key))
      await this.save(key.envKey, data)
    })
  }

  async revokeAllForPlugin(envKey: string, userId: string, pluginId: string): Promise<void> {
    await this.mutate(async () => {
      const data = await this.load(envKey)
      const rows = data.users[userId] ?? []
      data.users[userId] = rows.filter(row => row.pluginId !== pluginId)
      await this.save(envKey, data)
    })
  }

  /**
   * Drop grants for plugins the user can no longer reach. Called from the
   * launch-time partition GC pass, which already computes that set (§10.5).
   */
  async pruneToPlugins(envKey: string, userId: string, allowed: Set<string>): Promise<void> {
    await this.mutate(async () => {
      const data = await this.load(envKey)
      const rows = data.users[userId] ?? []
      const kept = rows.filter(row => allowed.has(row.pluginId))
      if (kept.length === rows.length) return
      data.users[userId] = kept
      await this.save(envKey, data)
    })
  }

  /** ONLY for tests. */
  _invalidateCacheForTests(): void {
    this.cache.clear()
  }
}
