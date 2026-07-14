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
 *   1. Enumerate `userData/Partitions/sandbox-ui-*` directories on disk.
 *   2. Fetch the user's current sandbox-ui ACL via `GET /apps`.
 *   3. Wipe every on-disk partition whose recipe isn't in the ACL.
 *   4. If remaining ACL-aligned partitions sum to > 1 GiB, evict the
 *      oldest by `lastAccessAt` until total is back under cap.
 *
 * `lastAccessAt` is tracked per `appRef` in a JSON file under userData
 * and updated by `touchSandboxUiPartition` whenever the driver mounts
 * a view.
 */

export const SANDBOX_UI_PARTITION_PREFIX = 'sandbox-ui-'
export const SANDBOX_UI_MAX_TOTAL_BYTES = 1024 * 1024 * 1024
export const SANDBOX_UI_STATE_FILENAME = 'sandbox-ui-partition-state.json'

export type SandboxUiPartitionState = {
  lastAccessAt: Record<string, number>
}

export function emptySandboxUiPartitionState(): SandboxUiPartitionState {
  return { lastAccessAt: {} }
}

export function partitionDirNameFor(recipeNs: string, recipeName: string): string {
  return `${SANDBOX_UI_PARTITION_PREFIX}${recipeNs}-${recipeName}`
}

export function isSandboxUiPartitionDirName(dirName: string): boolean {
  return (
    dirName.startsWith(SANDBOX_UI_PARTITION_PREFIX) &&
    dirName.length > SANDBOX_UI_PARTITION_PREFIX.length
  )
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

// ─── Orchestrator ────────────────────────────────────────────────

export type RunSandboxUiPartitionGcArgs = {
  userDataDir: string
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

  let diskDirs: string[]
  try {
    const entries = await fs.readdir(partitionsRoot, { withFileTypes: true })
    diskDirs = entries
      .filter(e => e.isDirectory() && isSandboxUiPartitionDirName(e.name))
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
      if (ns && name) aclEntries.push({ appRef: a.appRef, dirName: partitionDirNameFor(ns, name) })
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

  // Drop lastAccessAt entries for appRefs that no longer have an ACL
  // mapping — we'd never use them again.
  for (const appRef of Object.keys(state.lastAccessAt)) {
    const [ns, name] = appRef.split('/', 2)
    if (!ns || !name) {
      delete state.lastAccessAt[appRef]
      continue
    }
    if (!aclDirSet.has(partitionDirNameFor(ns, name))) {
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
