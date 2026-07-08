import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ChatStore } from './chatStore.js'

/** Current persisted chat schema. Anything older is wiped on bind (§7.1). */
const SCHEMA_VERSION = 2

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
let bindInFlight: { userId: string; promise: Promise<void> } | null = null

/**
 * Reject a `userId` that isn't a single safe path segment. It roots both the
 * store and the destructive bootstrap wipe (`fs.rm` recursive), and it comes
 * from the auth server's `me.id` — an empty/`.`/`..`/separator-bearing value
 * could make the wipe escape the user's subdir or target the whole base dir.
 */
function assertSafeUserId(userId: string): void {
  if (!userId || userId === '.' || userId === '..' || /[/\\\0]/.test(userId)) {
    throw new Error('Invalid userId: unsafe path segment')
  }
}

/**
 * Bind the chat store to a user's directory, wiping any legacy (pre-v2) cache
 * first. The desktop is a cache of the server (post-Hermes spec §7.1): a v1
 * directory has per-message data without `task_id` and a different reconcile
 * model, so the first launch after deploy drops it wholesale and lets the
 * server re-hydrate. Safe because the server is the source of truth.
 */
export async function bindChatStoreForUser(userId: string): Promise<void> {
  assertSafeUserId(userId)
  // Re-binding the same user is a no-op. Team switches and access-catalog
  // refreshes re-call this with an unchanged `me.id`; tearing the store down
  // just to rebuild it opens a window where every concurrent chat IPC fails
  // with "Not authenticated" (seen as an empty "Latest sessions" at boot).
  if (activeChatStore && activeUserId === userId) return
  if (bindInFlight?.userId === userId) return bindInFlight.promise

  const promise = (async () => {
    // bind is async (it awaits a directory wipe); until it completes,
    // requireChatStore must not keep serving the previous user's store.
    activeChatStore = null
    activeUserId = null
    const userDir = join(currentBaseDir(), userId)
    await maybeWipeLegacyCache(userDir)
    activeChatStore = new ChatStore(userDir)
    activeUserId = userId
  })()
  bindInFlight = { userId, promise }
  try {
    await promise
  } finally {
    if (bindInFlight?.promise === promise) bindInFlight = null
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
      isLegacy = parsed.version !== SCHEMA_VERSION
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
}

export function requireChatStore(): ChatStore {
  if (!activeChatStore) throw new Error('Not authenticated')
  return activeChatStore
}

/** Test-only helper. Do not call from production code. */
export function __setChatStoreBaseDirForTests(base: string | null): void {
  baseDirOverride = base
}
