import { describe, expect, it } from 'vitest'
import {
  type GcPlanInput,
  isSandboxUiPartitionDirName,
  partitionDirNameFor,
  planSandboxUiPartitionGc,
} from '../sandboxUiPartitionGc.js'

describe('partitionDirNameFor', () => {
  it('matches the persist:sandbox-ui-<ns>-<name> partition encoding (minus the `persist:` prefix)', () => {
    // The driver stamps `persist:sandbox-ui-${ns}-${name}` as the
    // Electron partition; on disk, Chromium drops the `persist:`
    // prefix, so the directory name is `sandbox-ui-${ns}-${name}`.
    expect(partitionDirNameFor('sandbox-recipes', 'r1')).toBe('sandbox-ui-sandbox-recipes-r1')
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
