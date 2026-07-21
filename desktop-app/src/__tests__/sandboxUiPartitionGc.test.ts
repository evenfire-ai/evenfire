import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  type GcPlanInput,
  SANDBOX_UI_PRE_ENV_MIGRATION_MARKER,
  isPreEnvSandboxUiPartitionDirName,
  isSandboxUiPartitionDirName,
  isSandboxUiPartitionDirNameForEnv,
  maybeWipePreEnvSandboxUiPartitions,
  partitionDirNameFor,
  planSandboxUiPartitionGc,
} from '../sandboxUiPartitionGc.js'

const clearStorageData = vi.fn(async () => {})
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/clerum-desktop-test') },
  session: { fromPartition: vi.fn(() => ({ clearStorageData })) },
}))

describe('partitionDirNameFor', () => {
  it('matches the persist:sandbox-ui-<env>-<ns>-<name> partition encoding (minus the `persist:` prefix)', () => {
    // The driver stamps `persist:sandbox-ui-${env}-${ns}-${name}` as the
    // Electron partition; on disk, Chromium drops the `persist:`
    // prefix, so the directory name is `sandbox-ui-${env}-${ns}-${name}`.
    expect(partitionDirNameFor('env1', 'sandbox-recipes', 'r1')).toBe(
      'sandbox-ui-env1-sandbox-recipes-r1'
    )
  })
})

describe('isSandboxUiPartitionDirNameForEnv', () => {
  it('matches only the given environment prefix (spec §5.2)', () => {
    expect(isSandboxUiPartitionDirNameForEnv('sandbox-ui-envA-sandbox-recipes-r1', 'envA')).toBe(
      true
    )
    expect(isSandboxUiPartitionDirNameForEnv('sandbox-ui-envB-sandbox-recipes-r1', 'envA')).toBe(
      false
    )
  })
})

describe('isSandboxUiPartitionDirName', () => {
  it('matches dirs that start with the sandbox-ui- prefix', () => {
    expect(isSandboxUiPartitionDirName('sandbox-ui-sandbox-recipes-r1')).toBe(true)
    expect(isSandboxUiPartitionDirName('sandbox-ui-x')).toBe(true)
  })

  it('rejects unrelated dirs and the bare prefix', () => {
    expect(isSandboxUiPartitionDirName('sandbox-ui-')).toBe(false)
    expect(isSandboxUiPartitionDirName('default')).toBe(false)
    expect(isSandboxUiPartitionDirName('persist%3Achatllm-rpc')).toBe(false)
    expect(isSandboxUiPartitionDirName('')).toBe(false)
  })
})

describe('isPreEnvSandboxUiPartitionDirName', () => {
  it('flags pre-env partitions (no envKey segment)', () => {
    expect(isPreEnvSandboxUiPartitionDirName('sandbox-ui-sandbox-recipes-r1')).toBe(true)
    expect(isPreEnvSandboxUiPartitionDirName('sandbox-ui-mcp-server-r1')).toBe(true)
  })

  it('does NOT flag env-scoped partitions (valid <slug>-<12hex> envKey)', () => {
    expect(
      isPreEnvSandboxUiPartitionDirName('sandbox-ui-localhost_8091-ab12cd34ef56-sandbox-recipes-r1')
    ).toBe(false)
    expect(isPreEnvSandboxUiPartitionDirName('sandbox-ui-env-0123456789ab-mcp-server-r1')).toBe(
      false
    )
  })

  it('ignores non-sandbox-ui dirs and the bare prefix', () => {
    expect(isPreEnvSandboxUiPartitionDirName('default')).toBe(false)
    expect(isPreEnvSandboxUiPartitionDirName('sandbox-ui-')).toBe(false)
  })
})

describe('maybeWipePreEnvSandboxUiPartitions', () => {
  let userDataDir: string
  let partitionsRoot: string
  const legacyDir = 'sandbox-ui-sandbox-recipes-r1'
  const envDir = 'sandbox-ui-localhost_8091-ab12cd34ef56-sandbox-recipes-r1'

  beforeEach(async () => {
    clearStorageData.mockClear()
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-ui-gc-'))
    partitionsRoot = path.join(userDataDir, 'Partitions')
    await fs.mkdir(path.join(partitionsRoot, legacyDir), { recursive: true })
    await fs.writeFile(path.join(partitionsRoot, legacyDir, 'Cookies'), 'x')
    await fs.mkdir(path.join(partitionsRoot, envDir), { recursive: true })
    await fs.writeFile(path.join(partitionsRoot, envDir, 'Cookies'), 'y')
    await fs.mkdir(path.join(partitionsRoot, 'default'), { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true })
  })

  const exists = async (p: string) =>
    fs
      .access(p)
      .then(() => true)
      .catch(() => false)

  it('(a) wipes the pre-env legacy partition', async () => {
    const wiped = await maybeWipePreEnvSandboxUiPartitions(userDataDir)
    expect(wiped).toEqual([legacyDir])
    expect(await exists(path.join(partitionsRoot, legacyDir))).toBe(false)
    expect(clearStorageData).toHaveBeenCalledTimes(1)
  })

  it('(b) leaves valid env-scoped partitions and unrelated dirs intact', async () => {
    await maybeWipePreEnvSandboxUiPartitions(userDataDir)
    expect(await exists(path.join(partitionsRoot, envDir))).toBe(true)
    expect(await exists(path.join(partitionsRoot, 'default'))).toBe(true)
  })

  it('(c) marker prevents a second run from re-scanning/wiping', async () => {
    await maybeWipePreEnvSandboxUiPartitions(userDataDir)
    expect(await exists(path.join(userDataDir, SANDBOX_UI_PRE_ENV_MIGRATION_MARKER))).toBe(true)

    // Re-create a legacy dir; the marker must keep the second pass a no-op.
    await fs.mkdir(path.join(partitionsRoot, legacyDir), { recursive: true })
    clearStorageData.mockClear()
    const wiped = await maybeWipePreEnvSandboxUiPartitions(userDataDir)
    expect(wiped).toEqual([])
    expect(await exists(path.join(partitionsRoot, legacyDir))).toBe(true)
    expect(clearStorageData).not.toHaveBeenCalled()
  })

  it('returns [] with no marker when the Partitions dir does not exist', async () => {
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-ui-gc-fresh-'))
    try {
      const wiped = await maybeWipePreEnvSandboxUiPartitions(fresh)
      expect(wiped).toEqual([])
      expect(await exists(path.join(fresh, SANDBOX_UI_PRE_ENV_MIGRATION_MARKER))).toBe(false)
    } finally {
      await fs.rm(fresh, { recursive: true, force: true })
    }
  })
})

describe('planSandboxUiPartitionGc', () => {
  function input(overrides: Partial<GcPlanInput>): GcPlanInput {
    return {
      diskPartitionDirs: [],
      aclEntries: [],
      diskUsageByDir: new Map(),
      lastAccessAt: {},
      maxTotalBytes: 1024 * 1024 * 1024,
      ...overrides,
    }
  }

  it('wipes partitions whose recipe is not in the ACL', () => {
    const plan = planSandboxUiPartitionGc(
      input({
        diskPartitionDirs: ['sandbox-ui-ns-r1', 'sandbox-ui-ns-r2', 'sandbox-ui-ns-r3-stale'],
        aclEntries: [
          { appRef: 'ns/r1', dirName: 'sandbox-ui-ns-r1' },
          { appRef: 'ns/r2', dirName: 'sandbox-ui-ns-r2' },
        ],
      })
    )
    expect(plan.wipe).toEqual(['sandbox-ui-ns-r3-stale'])
    expect(plan.evict).toEqual([])
  })

  it('keeps every disk partition when total usage is under the cap', () => {
    const plan = planSandboxUiPartitionGc(
      input({
        diskPartitionDirs: ['sandbox-ui-ns-r1', 'sandbox-ui-ns-r2'],
        aclEntries: [
          { appRef: 'ns/r1', dirName: 'sandbox-ui-ns-r1' },
          { appRef: 'ns/r2', dirName: 'sandbox-ui-ns-r2' },
        ],
        diskUsageByDir: new Map([
          ['sandbox-ui-ns-r1', 100_000_000],
          ['sandbox-ui-ns-r2', 200_000_000],
        ]),
        maxTotalBytes: 1024 * 1024 * 1024,
      })
    )
    expect(plan.wipe).toEqual([])
    expect(plan.evict).toEqual([])
  })

  it('LRU-evicts oldest partitions first until total drops below cap', () => {
    const plan = planSandboxUiPartitionGc(
      input({
        diskPartitionDirs: ['sandbox-ui-ns-a', 'sandbox-ui-ns-b', 'sandbox-ui-ns-c'],
        aclEntries: [
          { appRef: 'ns/a', dirName: 'sandbox-ui-ns-a' },
          { appRef: 'ns/b', dirName: 'sandbox-ui-ns-b' },
          { appRef: 'ns/c', dirName: 'sandbox-ui-ns-c' },
        ],
        diskUsageByDir: new Map([
          ['sandbox-ui-ns-a', 600_000_000],
          ['sandbox-ui-ns-b', 600_000_000],
          ['sandbox-ui-ns-c', 600_000_000],
        ]),
        // a oldest, then b, then c most recent
        lastAccessAt: { 'ns/a': 100, 'ns/b': 200, 'ns/c': 300 },
        maxTotalBytes: 1024 * 1024 * 1024, // 1 GiB
      })
    )
    // Total = 1.8 GiB; cap = 1 GiB. After evicting a (oldest), total =
    // 1.2 GiB still over cap. After evicting b, total = 0.6 GiB under cap.
    // c is the freshest and is preserved.
    expect(plan.evict.map(e => e.appRef)).toEqual(['ns/a', 'ns/b'])
    expect(plan.wipe).toEqual([])
  })

  it('treats absent lastAccessAt as the oldest possible (epoch 0) for LRU tie-break', () => {
    const plan = planSandboxUiPartitionGc(
      input({
        diskPartitionDirs: ['sandbox-ui-ns-a', 'sandbox-ui-ns-b'],
        aclEntries: [
          { appRef: 'ns/a', dirName: 'sandbox-ui-ns-a' },
          { appRef: 'ns/b', dirName: 'sandbox-ui-ns-b' },
        ],
        diskUsageByDir: new Map([
          ['sandbox-ui-ns-a', 800_000_000],
          ['sandbox-ui-ns-b', 800_000_000],
        ]),
        // a was touched recently; b was never touched (not in lastAccessAt)
        lastAccessAt: { 'ns/a': 1_000_000 },
        maxTotalBytes: 1024 * 1024 * 1024,
      })
    )
    // b is treated as last-access=0, so evicted first.
    expect(plan.evict.map(e => e.appRef)).toEqual(['ns/b'])
  })

  it('runs wipe (ACL diff) and evict (LRU) independently', () => {
    const plan = planSandboxUiPartitionGc(
      input({
        diskPartitionDirs: ['sandbox-ui-ns-stale', 'sandbox-ui-ns-a', 'sandbox-ui-ns-b'],
        aclEntries: [
          { appRef: 'ns/a', dirName: 'sandbox-ui-ns-a' },
          { appRef: 'ns/b', dirName: 'sandbox-ui-ns-b' },
        ],
        diskUsageByDir: new Map([
          // stale is wiped regardless of size
          ['sandbox-ui-ns-stale', 9_999_999_999],
          ['sandbox-ui-ns-a', 600_000_000],
          ['sandbox-ui-ns-b', 600_000_000],
        ]),
        lastAccessAt: { 'ns/a': 100, 'ns/b': 200 },
        maxTotalBytes: 1024 * 1024 * 1024,
      })
    )
    // Stale is wiped; surviving (a, b) total 1.2 GiB > cap, so a (oldest) is
    // evicted. Stale's giant size does NOT count toward the cap because it's
    // already wiped.
    expect(plan.wipe).toEqual(['sandbox-ui-ns-stale'])
    expect(plan.evict.map(e => e.appRef)).toEqual(['ns/a'])
  })

  it('does not evict when ACL is empty (everything is wiped via the diff phase)', () => {
    const plan = planSandboxUiPartitionGc(
      input({
        diskPartitionDirs: ['sandbox-ui-ns-r1', 'sandbox-ui-ns-r2'],
        aclEntries: [],
        diskUsageByDir: new Map([
          ['sandbox-ui-ns-r1', 1_000_000_000],
          ['sandbox-ui-ns-r2', 1_000_000_000],
        ]),
      })
    )
    expect(plan.wipe.sort()).toEqual(['sandbox-ui-ns-r1', 'sandbox-ui-ns-r2'])
    expect(plan.evict).toEqual([])
  })
})
