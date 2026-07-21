import { app, session } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Sandbox-ui partition garbage collection.
 *
 * Runs once at Desktop App launch (before any sandbox-ui view is
 * mounted) so it can safely rm partition data without racing the
 * Electron Session that owns it.
 *
 *   1. Enumerate `userData/Partitions/sandbox-ui-${envKey}-*` directories on
 *      disk (the ACTIVE environment only — spec §5.2).
 *   2. Fetch the user's current sandbox-ui ACL via `GET /apps`.
 *   3. Wipe every on-disk partition (in this env) whose recipe isn't in the ACL.
 *   4. If remaining ACL-aligned partitions sum to > 1 GiB, evict the
 *      oldest by `lastAccessAt` until total is back under cap.
 *
 * The size cap is applied PER ENVIRONMENT since GC is env-scoped; total
 * sandbox-ui storage across N environments can reach up to N × the cap.
 *
 * `lastAccessAt` is tracked per `appRef` in a JSON file under userData
 * and updated by `touchSandboxUiPartition` whenever the driver mounts
 * a view.
 */

export const SANDBOX_UI_PARTITION_PREFIX = 'sandbox-ui-'
export const SANDBOX_UI_MAX_TOTAL_BYTES = 1024 * 1024 * 1024
export const SANDBOX_UI_STATE_FILENAME = 'sandbox-ui-partition-state.json'

/**
 * Marker file (under userData) recording that the one-shot pre-`envKey`
 * partition wipe ran. Mirrors ChatStore's `.env-scoped` marker
 * (`chatStoreBinding.ts`) so the destructive scan happens exactly once.
 */
export const SANDBOX_UI_PRE_ENV_MIGRATION_MARKER = '.sandbox-ui-env-scoped'

/**
 * Leading segment of an env-scoped partition, right after the `sandbox-ui-`
 * prefix. An env partition is `sandbox-ui-<envKey>-<ns>-<name>` where
 * `envKey = <slug>-<12 hex>` (see `resolveEnvKey` in `config.ts`: slug is
 * `[a-z0-9_]+`, hash is 12 hex). So a valid env partition's remainder starts
 * with `<slug>-<12hex>-`; a pre-env partition (`sandbox-ui-<ns>-<name>`) does
 * not. The trailing `-` matters: it rules out a legacy `<name>` that is itself
 * exactly 12 hex from being read as an envKey.
 */
const ENV_KEY_LEADING_SEGMENT_RE = /^[a-z0-9_]+-[0-9a-f]{12}-/

export type SandboxUiPartitionState = {
  lastAccessAt: Record<string, number>
}

export function emptySandboxUiPartitionState(): SandboxUiPartitionState {
  return { lastAccessAt: {} }
}

export function partitionDirNameFor(envKey: string, recipeNs: string, recipeName: string): string {
  return `${SANDBOX_UI_PARTITION_PREFIX}${envKey}-${recipeNs}-${recipeName}`
}

/**
 * True when `dirName` is a sandbox-ui partition of any vintage (env-scoped or
 * the pre-env layout). The base predicate — reused by
 * `isPreEnvSandboxUiPartitionDirName` to gate the one-shot legacy wipe.
 */
export function isSandboxUiPartitionDirName(dirName: string): boolean {
  return (
    dirName.startsWith(SANDBOX_UI_PARTITION_PREFIX) &&
    dirName.length > SANDBOX_UI_PARTITION_PREFIX.length
  )
}

/**
 * True when `dirName` is a sandbox-ui partition created BEFORE env-scoping
 * (`sandbox-ui-<ns>-<name>`, no `<envKey>-` segment). These no longer match any
 * environment's GC scan (`isSandboxUiPartitionDirNameForEnv`, §5.2) — new mounts
 * use `sandbox-ui-<envKey>-…` — so their now-dead KasmVNC cookies would leak on
 * disk forever and never count against the LRU cap. Detected by the ABSENCE of a
 * valid leading envKey segment. Best-effort heuristic (same class as ChatStore's
 * shape check): a legacy `<name>` shaped exactly like `<12hex>-…` is left alone,
 * leaking at most that one dir.
 */
export function isPreEnvSandboxUiPartitionDirName(dirName: string): boolean {
  if (!isSandboxUiPartitionDirName(dirName)) return false
  const rest = dirName.slice(SANDBOX_UI_PARTITION_PREFIX.length)
  return !ENV_KEY_LEADING_SEGMENT_RE.test(rest)
}

/**
 * True when `dirName` is a sandbox-ui partition for `envKey` (spec §5.2). GC is
 * scoped to the CURRENT environment: other environments' partitions must be
 * neither wiped nor counted against this env's LRU cap.
 */
export function isSandboxUiPartitionDirNameForEnv(dirName: string, envKey: string): boolean {
  return dirName.startsWith(`${SANDBOX_UI_PARTITION_PREFIX}${envKey}-`)
}

export type GcPlan = {
  /** Dirs to wipe because their recipe isn't in the ACL. */
  wipe: string[]
  /** Dirs to evict to get under the LRU cap. Includes appRef so the
   *  caller can also clean up that key from `lastAccessAt`. */
  evict: { appRef: string; dirName: string }[]
}

export type GcPlanInput = {
  diskPartitionDirs: string[]
  aclEntries: { appRef: string; dirName: string }[]
  diskUsageByDir: Map<string, number>
  lastAccessAt: Record<string, number>
  maxTotalBytes: number
}

/**
 * Pure planner: given a snapshot of (disk, ACL, sizes, lastAccessAt),
 * decide what to wipe and what to LRU-evict. No I/O so it's testable
 * without Electron.
 */
export function planSandboxUiPartitionGc(input: GcPlanInput): GcPlan {
  const aclByDir = new Map<string, string>() // dirName → appRef
  for (const { appRef, dirName } of input.aclEntries) {
    aclByDir.set(dirName, appRef)
  }

  const wipe: string[] = []
  const aclDirsOnDisk: string[] = []
  for (const dir of input.diskPartitionDirs) {
    if (aclByDir.has(dir)) aclDirsOnDisk.push(dir)
    else wipe.push(dir)
  }

  let total = 0
  const surviving: { dirName: string; appRef: string; bytes: number; lastAccess: number }[] = []
  for (const dir of aclDirsOnDisk) {
    const appRef = aclByDir.get(dir)!
    const bytes = input.diskUsageByDir.get(dir) ?? 0
    const lastAccess = input.lastAccessAt[appRef] ?? 0
    total += bytes
    surviving.push({ dirName: dir, appRef, bytes, lastAccess })
  }

  const evict: { appRef: string; dirName: string }[] = []
  if (total > input.maxTotalBytes) {
    surviving.sort((a, b) => a.lastAccess - b.lastAccess)
    let remaining = total
    for (const entry of surviving) {
      if (remaining <= input.maxTotalBytes) break
      evict.push({ appRef: entry.appRef, dirName: entry.dirName })
      remaining -= entry.bytes
    }
  }

  return { wipe, evict }
}

// ─── State file (lastAccessAt) ────────────────────────────────────

let cachedState: SandboxUiPartitionState | null = null

async function readStateFile(stateFilePath: string): Promise<SandboxUiPartitionState> {
  if (cachedState) return cachedState
  try {
    const raw = await fs.readFile(stateFilePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      'lastAccessAt' in parsed &&
      typeof (parsed as { lastAccessAt: unknown }).lastAccessAt === 'object'
    ) {
      const m = (parsed as { lastAccessAt: Record<string, unknown> }).lastAccessAt
      const cleaned: Record<string, number> = {}
      for (const [k, v] of Object.entries(m)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cleaned[k] = v
      }
      cachedState = { lastAccessAt: cleaned }
      return cachedState
    }
  } catch {
    // missing / unreadable / malformed JSON — start fresh, don't crash
    // launch over a corrupted state file.
  }
  cachedState = emptySandboxUiPartitionState()
  return cachedState
}

async function writeStateFile(
  stateFilePath: string,
  state: SandboxUiPartitionState
): Promise<void> {
  await fs.mkdir(path.dirname(stateFilePath), { recursive: true })
  await fs.writeFile(stateFilePath, JSON.stringify(state, null, 2))
}

/**
 * Update `lastAccessAt[appRef]` to now. Called from the driver each
 * time a view mounts so the LRU has fresh data on the next launch.
 */
export async function touchSandboxUiPartition(appRef: string): Promise<void> {
  const userDataDir = app.getPath('userData')
  const stateFilePath = path.join(userDataDir, SANDBOX_UI_STATE_FILENAME)
  const state = await readStateFile(stateFilePath)
  state.lastAccessAt[appRef] = Date.now()
  cachedState = state
  await writeStateFile(stateFilePath, state)
}

// ─── Disk usage ───────────────────────────────────────────────────

async function diskUsageOfDir(dir: string): Promise<number> {
  let total = 0
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await diskUsageOfDir(full)
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(full)
        total += stat.size
      } catch {
        // file vanished mid-walk — best-effort accounting
      }
    }
  }
  return total
}

async function clearAndRemovePartition(dirName: string, partitionsRoot: string): Promise<void> {
  const partitionId = `persist:${dirName}`
  try {
    const ses = session.fromPartition(partitionId)
    await ses.clearStorageData()
  } catch (err) {
    console.warn(`[SandboxUI] clearStorageData failed for ${partitionId}:`, err)
  }
  try {
    await fs.rm(path.join(partitionsRoot, dirName), { recursive: true, force: true })
  } catch (err) {
    console.warn(`[SandboxUI] rm partition dir failed for ${dirName}:`, err)
  }
}

// ─── One-shot pre-envKey legacy wipe ─────────────────────────────

async function writePreEnvMigrationMarker(markerPath: string): Promise<void> {
  try {
    await fs.mkdir(path.dirname(markerPath), { recursive: true })
    await fs.writeFile(markerPath, new Date().toISOString(), { mode: 0o600 })
  } catch (err) {
    // Non-fatal: worst case the one-shot scan reruns next launch (idempotent).
    console.warn('[SandboxUI] Failed to persist pre-envKey partition marker:', err)
  }
}

/**
 * One-shot wipe of the pre-`envKey` partition layout (spec §5.2). Before this
 * feature partitions were `sandbox-ui-<ns>-<name>`; they are now
 * `sandbox-ui-<envKey>-<ns>-<name>`. The env-scoped GC below only matches the
 * new naming, so old partitions would otherwise leak forever. This scans the
 * partitions root ONCE (marker-guarded, like ChatStore's `.env-scoped` wipe),
 * env-independently, and removes every dir that is a sandbox-ui partition
 * WITHOUT a valid envKey segment. Returns the wiped dir names (for logging).
 */
export async function maybeWipePreEnvSandboxUiPartitions(userDataDir: string): Promise<string[]> {
  const partitionsRoot = path.join(userDataDir, 'Partitions')
  const markerPath = path.join(userDataDir, SANDBOX_UI_PRE_ENV_MIGRATION_MARKER)

  try {
    await fs.access(markerPath)
    return [] // already migrated
  } catch {
    // marker absent → run the one-shot below
  }

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(partitionsRoot, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No Partitions dir yet (fresh install / nothing ever mounted). Nothing
      // legacy to wipe and nowhere stable to drop the marker; the next launch
      // reruns this cheaply once the dir exists.
      return []
    }
    throw err
  }

  const wiped: string[] = []
  for (const entry of entries) {
    // Names come from readdir of partitionsRoot ⇒ single path components (no
    // separators), so `clearAndRemovePartition`'s join can't escape the root.
    if (!entry.isDirectory()) continue
    if (!isPreEnvSandboxUiPartitionDirName(entry.name)) continue
    console.warn(`[SandboxUI] Wiping pre-envKey legacy partition "${entry.name}"`)
    await clearAndRemovePartition(entry.name, partitionsRoot)
    wiped.push(entry.name)
  }

  await writePreEnvMigrationMarker(markerPath)
  return wiped
}

// ─── Orchestrator ────────────────────────────────────────────────

export type RunSandboxUiPartitionGcArgs = {
  userDataDir: string
  /** Namespacing key of the ACTIVE environment (spec §5.2). GC only touches
   *  this env's `sandbox-ui-${envKey}-*` partitions. */
  envKey: string
  /** Returns the user's current sandbox-ui ACL. The orchestrator only
   *  needs `appRef`. Failure here aborts GC for this launch (better to
   *  keep stale data than to wipe a partition the user still has). */
  listAccessibleApps: () => Promise<{ apps: { appRef: string }[] }>
  /** Test seam — defaults to SANDBOX_UI_MAX_TOTAL_BYTES (1 GiB). */
  maxTotalBytes?: number
}

export type RunSandboxUiPartitionGcResult = {
  wiped: string[]
  evicted: string[]
}

export async function runSandboxUiPartitionGc(
  args: RunSandboxUiPartitionGcArgs
): Promise<RunSandboxUiPartitionGcResult> {
  const partitionsRoot = path.join(args.userDataDir, 'Partitions')
  const stateFilePath = path.join(args.userDataDir, SANDBOX_UI_STATE_FILENAME)
  const maxTotalBytes = args.maxTotalBytes ?? SANDBOX_UI_MAX_TOTAL_BYTES

  // One-shot, env-independent cleanup of pre-`envKey` partitions. Runs before
  // the env-scoped scan below (which by design only matches this env's
  // `sandbox-ui-${envKey}-*` dirs) so legacy partitions can't leak forever.
  await maybeWipePreEnvSandboxUiPartitions(args.userDataDir)

  let diskDirs: string[]
  try {
    const entries = await fs.readdir(partitionsRoot, { withFileTypes: true })
    // Scope to the ACTIVE env only — other environments' partitions are left
    // intact (they GC when their env is active). Prevents an env switch from
    // wiping another cluster's KasmVNC storage (spec §5.2).
    diskDirs = entries
      .filter(e => e.isDirectory() && isSandboxUiPartitionDirNameForEnv(e.name, args.envKey))
      .map(e => e.name)
  } catch {
    // userData/Partitions doesn't exist yet — nothing to GC.
    return { wiped: [], evicted: [] }
  }

  if (diskDirs.length === 0) {
    return { wiped: [], evicted: [] }
  }

  let aclEntries: { appRef: string; dirName: string }[]
  try {
    const result = await args.listAccessibleApps()
    aclEntries = []
    for (const a of result.apps) {
      const [ns, name] = a.appRef.split('/', 2)
      if (ns && name) {
        aclEntries.push({ appRef: a.appRef, dirName: partitionDirNameFor(args.envKey, ns, name) })
      }
    }
  } catch (err) {
    console.warn('[SandboxUI] partition GC: failed to fetch ACL, skipping:', err)
    return { wiped: [], evicted: [] }
  }

  const state = await readStateFile(stateFilePath)
  const aclDirSet = new Set(aclEntries.map(e => e.dirName))

  // Only walk size on ACL-aligned partitions; we wipe non-ACL ones
  // unconditionally so their size doesn't matter.
  const diskUsageByDir = new Map<string, number>()
  for (const dir of diskDirs) {
    if (aclDirSet.has(dir)) {
      diskUsageByDir.set(dir, await diskUsageOfDir(path.join(partitionsRoot, dir)))
    }
  }

  const plan = planSandboxUiPartitionGc({
    diskPartitionDirs: diskDirs,
    aclEntries,
    diskUsageByDir,
    lastAccessAt: state.lastAccessAt,
    maxTotalBytes,
  })

  for (const dirName of plan.wipe) {
    await clearAndRemovePartition(dirName, partitionsRoot)
  }
  for (const { dirName, appRef } of plan.evict) {
    await clearAndRemovePartition(dirName, partitionsRoot)
    delete state.lastAccessAt[appRef]
  }

  // Drop lastAccessAt entries for appRefs that lost ACL access AND have no
  // surviving on-disk partition in THIS env. Scoped to the active env so an
  // env switch doesn't discard another cluster's LRU timestamps (self-healing
  // metadata regardless — the next mount re-touches it).
  const envDiskDirSet = new Set(diskDirs)
  for (const appRef of Object.keys(state.lastAccessAt)) {
    const [ns, name] = appRef.split('/', 2)
    if (!ns || !name) {
      delete state.lastAccessAt[appRef]
      continue
    }
    const dirName = partitionDirNameFor(args.envKey, ns, name)
    // Prune only timestamps this pass just invalidated: the recipe had a
    // current-env partition on disk that is NOT in the current ACL (so it was
    // wiped above). An appRef with no current-env dir belongs to another env —
    // leave its timestamp for that env's own GC pass.
    if (envDiskDirSet.has(dirName) && !aclDirSet.has(dirName)) {
      delete state.lastAccessAt[appRef]
    }
  }

  cachedState = state
  await writeStateFile(stateFilePath, state)

  return {
    wiped: plan.wipe,
    evicted: plan.evict.map(e => e.dirName),
  }
}

/** ONLY for tests — drop the in-memory state file cache. */
export function _resetSandboxUiPartitionStateCacheForTests(): void {
  cachedState = null
}
