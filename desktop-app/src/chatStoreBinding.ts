import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ChatStore } from './chatStore.js'
import { assertSafeFilesystemSegment } from './pathSafety.js'

/**
 * Keep the shared catalog at v2 so pre-paging desktop builds can read the
 * bounded compatibility snapshots. Paged transcripts version their own files.
 */
const SCHEMA_VERSION = 2
const PREVIOUS_PAGED_INDEX_VERSION = 3
const LEGACY_INDEX_VERSIONS = new Set([1])
const CORRUPT_QUARANTINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

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
let bindingGeneration = 0

/** Marker file (per base dir) that records the pre-`envKey` legacy wipe ran. */
const PRE_ENV_MIGRATION_MARKER = '.env-scoped'

/**
 * Reject a segment that isn't a single safe path component. It roots both the
 * store and the destructive bootstrap wipe (`fs.rm` recursive): `userId` comes
 * from the auth server's `me.id` and `envKey` from the runtime config — an
 * empty/`.`/`..`/separator-bearing value could make the wipe escape its subdir
 * or target the whole base dir.
 */
/**
 * Bind the chat store to a `(envKey, user)` directory (spec §5.2). The path is
 * namespaced by environment — `<base>/<envKey>/<userId>/…` — so switching
 * clusters never surfaces or reconciles another environment's chats (the
 * cross-cluster 404-eviction bug). Wipes any legacy (pre-v2) per-agent cache
 * first; the desktop is a cache of the server (spec §3.5, §7.1), so a stale
 * directory is dropped and re-hydrated from the source of truth.
 */
export async function bindChatStoreForUser(
  userId: string,
  envKey: string,
  options: { legacyEnvKeys?: readonly string[] } = {}
): Promise<void> {
  assertSafeFilesystemSegment('userId', userId)
  assertSafeFilesystemSegment('envKey', envKey)
  for (const legacyEnvKey of options.legacyEnvKeys ?? []) {
    assertSafeFilesystemSegment('legacyEnvKey', legacyEnvKey)
  }
  // Re-binding the same (env, user) is a no-op. Team switches and access-catalog
  // refreshes re-call this with an unchanged `me.id`; tearing the store down
  // just to rebuild it opens a window where every concurrent chat IPC fails
  // with "Not authenticated" (seen as an empty "Latest sessions" at boot).
  if (activeChatStore && activeUserId === userId && activeEnvKey === envKey) return
  const bindKey = `${envKey}::${userId}`
  if (bindInFlight?.key === bindKey) return bindInFlight.promise
  const generation = ++bindingGeneration

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
    await maybeMigrateEnvScopedCache(baseDir, userId, envKey, options.legacyEnvKeys ?? [])
    const userDir = join(baseDir, envKey, userId)
    await ensurePrivateDirectory(baseDir)
    await ensurePrivateDirectory(join(baseDir, envKey))
    await ensurePrivateDirectory(userDir)
    await maybeWipeLegacyCache(userDir)
    await sweepExpiredCorruptQuarantines(userDir)
    if (generation !== bindingGeneration) return
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

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 })
  // mkdir's mode does not update an existing directory. Tighten legacy
  // permissions at the three ancestry boundaries that protect the full cache.
  await fs.chmod(directoryPath, 0o700)
}

/**
 * One-shot rename from older env-key namespaces into the current env-key
 * namespace. This preserves local chat pages when only the env-key derivation
 * changed, e.g. REST-only key → REST+RPC key.
 */
async function maybeMigrateEnvScopedCache(
  baseDir: string,
  userId: string,
  envKey: string,
  legacyEnvKeys: readonly string[]
): Promise<void> {
  const candidates = Array.from(
    new Set(legacyEnvKeys.map(key => String(key || '').trim()).filter(key => key && key !== envKey))
  )
  if (!candidates.length) return

  const targetDir = join(baseDir, envKey, userId)
  try {
    await fs.access(targetDir)
    return
  } catch {
    // target absent → a legacy env-scoped cache may be migrated below
  }

  for (const legacyEnvKey of candidates) {
    const sourceDir = join(baseDir, legacyEnvKey, userId)
    try {
      await fs.access(sourceDir)
    } catch {
      continue
    }
    await fs.mkdir(join(baseDir, envKey), { recursive: true, mode: 0o700 })
    try {
      await fs.rename(sourceDir, targetDir)
      console.info(`[chatStore] Migrated chat cache from legacy env key "${legacyEnvKey}"`)
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return
      throw err
    }
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
      await fs.mkdir(baseDir, { recursive: true, mode: 0o700 })
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
 * Scan a user's per-agent chat directories and remove only caches whose parsed
 * catalog declares a known legacy schema. Missing, torn, or future-version
 * catalogs are not evidence that their paged transcripts are disposable.
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
      if (parsed.version === PREVIOUS_PAGED_INDEX_VERSION) {
        // A parsed v3 catalog is valid. Leave it in place during binding so the
        // next ordinary ChatStore RMW normalizes it through the same crash-durable
        // temp-write, file-fsync, rename, and directory-fsync path as every other
        // index update.
        isLegacy = false
      } else if (LEGACY_INDEX_VERSIONS.has(parsed.version ?? Number.NaN)) {
        isLegacy = true
      } else if (parsed.version !== SCHEMA_VERSION) {
        console.warn(`[chatStore] Preserving cache for "${entry.name}" with unknown index schema`)
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code !== undefined && code !== 'ENOENT') {
        // A transient permission/I/O failure is not evidence of an old schema.
        // Propagate it instead of recursively deleting a live agent cache.
        throw error
      }
      // Missing or unparseable catalogs can be a torn atomic write. Preserve
      // paged transcripts so server reconciliation or manual recovery can use them.
      console.warn(`[chatStore] Preserving cache for "${entry.name}" with unreadable index`)
    }
    if (isLegacy) {
      console.warn(
        `[chatStore] Wiping legacy cache for "${entry.name}" (expected v${SCHEMA_VERSION})`
      )
      await fs.rm(agentDir, { recursive: true, force: true })
    }
  }
}

/**
 * Corrupt snapshots preserve recoverable local work, but they also retain full
 * transcript content. Keep recent quarantines for downgrade/crash recovery and
 * remove abandoned copies after a bounded retention window on each bind.
 */
async function sweepExpiredCorruptQuarantines(userDir: string, nowMs = Date.now()): Promise<void> {
  const agentEntries = await fs.readdir(userDir, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    agentEntries
      .filter(entry => entry.isDirectory())
      .map(async entry => {
        const agentDir = join(userDir, entry.name)
        await removeExpiredQuarantineEntries(join(agentDir, '.corrupt'), () => true, nowMs)

        const snapshotRoot = join(agentDir, 'chats', '.snapshots')
        if (!(await isRealDirectory(snapshotRoot))) return
        const chatEntries = await fs.readdir(snapshotRoot, { withFileTypes: true }).catch(() => [])
        await Promise.all(
          chatEntries
            .filter(chatEntry => chatEntry.isDirectory())
            .map(chatEntry =>
              removeExpiredQuarantineEntries(
                join(snapshotRoot, chatEntry.name),
                name => name.startsWith('corrupt-'),
                nowMs
              )
            )
        )
      })
  )
}

async function isRealDirectory(directory: string): Promise<boolean> {
  const stat = await fs.lstat(directory).catch(() => null)
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink())
}

async function removeExpiredQuarantineEntries(
  directory: string,
  shouldRemove: (name: string) => boolean,
  nowMs: number
): Promise<void> {
  if (!(await isRealDirectory(directory))) return
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter(entry => shouldRemove(entry.name))
      .map(async entry => {
        const target = join(directory, entry.name)
        const stat = await fs.lstat(target).catch(() => null)
        if (!stat || nowMs - stat.mtimeMs < CORRUPT_QUARANTINE_RETENTION_MS) return
        await fs.rm(target, { recursive: entry.isDirectory(), force: true }).catch(() => undefined)
      })
  )
}

export function unbindChatStore(): void {
  bindingGeneration += 1
  bindInFlight = null
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
