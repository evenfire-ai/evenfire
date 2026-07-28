import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ChatStore } from './chatStore.js'

/** Current persisted chat schema. Anything older is wiped on bind (§7.1). */
const SCHEMA_VERSION = 3
const PAGED_V2_SCHEMA_VERSION = 2

// Default base dir derived from Electron's userData path. Tests override via
// __setChatStoreBaseDirForTests to point at a tmpdir, which means the
// app.getPath call below is only reached in production.
let baseDirOverride: string | null = null
function currentBaseDir(): string {
  if (baseDirOverride !== null) return baseDirOverride
  return join(app.getPath('home'), '.clerum', 'chats')
}

let activeChatStore: ChatStore | null = null
let activeUserId: string | null = null
let activeEnvKey: string | null = null
let bindInFlight: { key: string; promise: Promise<void> } | null = null

/** Marker file (per base dir) that records the pre-`envKey` legacy wipe ran. */
const PRE_ENV_MIGRATION_MARKER = '.env-scoped'

/**
 * Reject a segment that isn't a single safe path component. It roots both the
 * store and the destructive bootstrap wipe (`fs.rm` recursive): `userId` comes
 * from the auth server's `me.id` and `envKey` from the runtime config — an
 * empty/`.`/`..`/separator-bearing value could make the wipe escape its subdir
 * or target the whole base dir.
 */
function assertSafeSegment(label: string, value: string): void {
  if (!value || value === '.' || value === '..' || /[/\\\0]/.test(value)) {
    throw new Error(`Invalid ${label}: unsafe path segment`)
  }
}

/**
 * Bind the chat store to a `(envKey, user)` directory (spec §5.2). The path is
 * namespaced by environment — `<base>/<envKey>/<userId>/…` — so switching
 * clusters never surfaces or reconciles another environment's chats (the
 * cross-cluster 404-eviction bug). Wipes any legacy (pre-v2) per-agent cache
 * first; the desktop is a cache of the server (spec §3.5, §7.1), so a stale
 * directory is dropped and re-hydrated from the source of truth.
 */
export async function bindChatStoreForUser(userId: string, envKey: string): Promise<void> {
  assertSafeSegment('userId', userId)
  assertSafeSegment('envKey', envKey)
  // Re-binding the same (env, user) is a no-op. Team switches and access-catalog
  // refreshes re-call this with an unchanged `me.id`; tearing the store down
  // just to rebuild it opens a window where every concurrent chat IPC fails
  // with "Not authenticated" (seen as an empty "Latest sessions" at boot).
  if (activeChatStore && activeUserId === userId && activeEnvKey === envKey) return
  const bindKey = `${envKey}::${userId}`
  if (bindInFlight?.key === bindKey) return bindInFlight.promise

  const promise = (async () => {
    // bind is async (it awaits a directory wipe); until it completes,
    // requireChatStore must not keep serving the previous user's store.
    activeChatStore = null
    activeUserId = null
    activeEnvKey = null
    const baseDir = currentBaseDir()
    // One-shot: drop the pre-`envKey` cache tree (no env level) before rooting
    // the env-scoped store. Safe to discard — the server rebuilds it (spec §5.5).
    await maybeWipePreEnvLegacyCache(baseDir)
    const userDir = join(baseDir, envKey, userId)
    await maybeWipeLegacyCache(userDir)
    activeChatStore = new ChatStore(userDir)
    activeUserId = userId
    activeEnvKey = envKey
  })()
  bindInFlight = { key: bindKey, promise }
  try {
    await promise
  } finally {
    if (bindInFlight?.promise === promise) bindInFlight = null
  }
}

/**
 * One-shot wipe of the pre-`envKey` cache layout (spec §5.5, D3). Before this
 * feature the tree was `<base>/<userId>/<agentRef>/index.json`; it is now
 * `<base>/<envKey>/<userId>/<agentRef>/index.json`. Legacy user dirs are
 * indistinguishable from env dirs by name, but not by SHAPE: a legacy `<userId>`
 * dir has `index.json` at depth 2 (`<userId>/<agentRef>/index.json`), whereas an
 * env dir only ever has it at depth 3 (`<envKey>/<userId>/<agentRef>/index.json`).
 * So any top-level dir with an `index.json` in one of its children is legacy and
 * is dropped.
 * Guarded by a marker file so it runs exactly once (the first launch after the
 * update, before any env dir exists); it never touches env-scoped subtrees.
 */
async function maybeWipePreEnvLegacyCache(baseDir: string): Promise<void> {
  const markerPath = join(baseDir, PRE_ENV_MIGRATION_MARKER)
  try {
    await fs.access(markerPath)
    return // already migrated
  } catch {
    // marker absent → run the one-shot below
  }

  let entries
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Fresh install — nothing legacy to wipe. Create the base + marker so the
      // scan never runs again.
      await fs.mkdir(baseDir, { recursive: true })
      await writeMigrationMarker(markerPath)
      return
    }
    throw err
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const topDir = join(baseDir, entry.name)
    if (await looksLikeLegacyUserDir(topDir)) {
      console.warn(`[chatStore] Wiping pre-envKey legacy cache dir "${entry.name}"`)
      await fs.rm(topDir, { recursive: true, force: true })
    }
  }

  await writeMigrationMarker(markerPath)
}

/** A top-level dir is a legacy user dir iff any child holds `index.json`. */
async function looksLikeLegacyUserDir(topDir: string): Promise<boolean> {
  let children
  try {
    children = await fs.readdir(topDir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const child of children) {
    if (!child.isDirectory()) continue
    try {
      await fs.access(join(topDir, child.name, 'index.json'))
      return true
    } catch {
      // no index.json under this child — keep scanning siblings
    }
  }
  return false
}

async function writeMigrationMarker(markerPath: string): Promise<void> {
  try {
    await fs.writeFile(markerPath, new Date().toISOString(), { mode: 0o600 })
  } catch (err) {
    // Non-fatal: worst case the one-shot scan reruns next launch (idempotent).
    console.warn('[chatStore] Failed to persist pre-envKey migration marker:', err)
  }
}

/**
 * Scan a user's per-agent chat directories and remove any whose `index.json`
 * is missing or not at the current schema version. Idempotent and best-effort
 * per agent dir — a parse failure is treated as legacy and wiped.
 */
async function maybeWipeLegacyCache(userDir: string): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(userDir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return // nothing cached yet
    throw err
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const agentDir = join(userDir, entry.name)
    const indexPath = join(agentDir, 'index.json')
    let isLegacy = false
    try {
      const raw = await fs.readFile(indexPath, 'utf-8')
      const parsed = JSON.parse(raw) as { version?: number }
      if (parsed.version === PAGED_V2_SCHEMA_VERSION) {
        const migratedIndexPath = `${indexPath}.v3.tmp`
        await fs.writeFile(
          migratedIndexPath,
          JSON.stringify({ ...parsed, version: SCHEMA_VERSION }, null, 2),
          { mode: 0o600 }
        )
        await fs.rename(migratedIndexPath, indexPath)
        isLegacy = false
      } else {
        isLegacy = parsed.version !== SCHEMA_VERSION
      }
    } catch {
      // index.json missing or unparseable → treat as legacy
      isLegacy = true
    }
    if (isLegacy) {
      console.warn(
        `[chatStore] Wiping legacy cache for "${entry.name}" (expected v${SCHEMA_VERSION})`
      )
      await fs.rm(agentDir, { recursive: true, force: true })
    }
  }
}

export function unbindChatStore(): void {
  activeChatStore = null
  activeUserId = null
  activeEnvKey = null
}

export function requireChatStore(): ChatStore {
  if (!activeChatStore) throw new Error('Not authenticated')
  return activeChatStore
}

/** Test-only helper. Do not call from production code. */
export function __setChatStoreBaseDirForTests(base: string | null): void {
  baseDirOverride = base
}
