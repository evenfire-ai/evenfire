import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DOCUMENT_IPC_RESERVE_BYTES,
  DOCUMENT_VIRTUAL_DRIFT_RESERVE_BYTES,
  childVirtualReserveBytes,
  documentCgroupSampler,
  documentCgroupWorkingSetBytes,
  effectiveDocumentMemoryCaps,
} from '../documentMemory'
import { documentLimits } from './fixtures'

const MIB = 1_048_576
const roots: string[] = []

const defaultStat = (inactiveFileBytes: number) =>
  [
    'anon 134217728',
    'file 138412032',
    'inactive_file ' + String(inactiveFileBytes),
    'active_file 4194304',
    '',
  ].join('\n')

async function fixture(
  membership = '0::/host/reader\n',
  maximum = String(512 * MIB),
  inactiveFileBytes = 128 * MIB
) {
  const root = await mkdtemp(join(tmpdir(), 'document-cgroup-'))
  roots.push(root)
  const membershipFile = join(root, 'membership')
  const cgroupRoot = join(root, 'cgroup')
  const directory = join(cgroupRoot, 'host/reader')
  await mkdir(directory, { recursive: true })
  await writeFile(membershipFile, membership)
  await writeFile(join(directory, 'memory.max'), maximum + '\n')
  await writeFile(join(directory, 'memory.current'), String(256 * MIB) + '\n')
  await writeFile(join(directory, 'memory.stat'), defaultStat(inactiveFileBytes))
  return {
    directory,
    membershipFile,
    sample: documentCgroupSampler('linux', membershipFile, cgroupRoot),
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('document reader cgroup-v2 memory', () => {
  it('reads the Host membership, maximum, current usage and inactive file cache', async () => {
    const { sample, directory } = await fixture()
    expect(await sample()).toEqual({
      maxBytes: 512 * MIB,
      currentBytes: 256 * MIB,
      inactiveFileBytes: 128 * MIB,
    })
    await writeFile(join(directory, 'memory.current'), String(300 * MIB))
    await writeFile(join(directory, 'memory.stat'), defaultStat(200 * MIB))
    expect(await sample()).toEqual({
      maxBytes: 512 * MIB,
      currentBytes: 300 * MIB,
      inactiveFileBytes: 200 * MIB,
    })
  })

  it('uses configured caps for an unlimited controller and macOS', async () => {
    const { sample } = await fixture('0::/host/reader\n', 'max')
    const unlimited = await sample()
    expect(unlimited).toEqual({
      maxBytes: null,
      currentBytes: 256 * MIB,
      inactiveFileBytes: 128 * MIB,
    })
    const configured = { maxResidentBytes: 768 * MIB, maxHeapMb: 512 }
    expect(effectiveDocumentMemoryCaps(documentLimits(), unlimited)).toEqual(configured)
    const macOS = await documentCgroupSampler('darwin')()
    expect(macOS).toBeNull()
    expect(effectiveDocumentMemoryCaps(documentLimits(), macOS)).toEqual(configured)
  })

  it.each(['5:memory:/host/reader\n', '0::/../host/reader\n', 'not a membership'])(
    'rejects unsupported or malformed membership %j and reads a unified control',
    async membership => {
      const { sample, membershipFile } = await fixture(membership)
      await expect(sample()).rejects.toThrow('Document reader cgroup memory unavailable')
      await writeFile(membershipFile, '0::/host/reader\n')
      expect((await sample())?.maxBytes).toBe(512 * MIB)
    }
  )

  it.each(['memory.max', 'memory.current', 'memory.stat'])(
    'rejects a missing %s instead of dropping the cap',
    async name => {
      const { sample, directory } = await fixture()
      await rm(join(directory, name))
      await expect(sample()).rejects.toThrow('Document reader cgroup memory unavailable')
      if (name === 'memory.stat') {
        await writeFile(join(directory, name), defaultStat(128 * MIB))
      } else {
        await writeFile(
          join(directory, name),
          String(name === 'memory.max' ? 512 * MIB : 256 * MIB)
        )
      }
      expect((await sample())?.currentBytes).toBe(256 * MIB)
    }
  )

  it.each(['invalid', '-1', '9007199254740992'])(
    'rejects invalid byte count %j and accepts a measured count',
    async value => {
      const { sample, directory } = await fixture()
      await writeFile(join(directory, 'memory.current'), value)
      await expect(sample()).rejects.toThrow('Document reader cgroup memory unavailable')
      await writeFile(join(directory, 'memory.current'), String(256 * MIB))
      expect((await sample())?.currentBytes).toBe(256 * MIB)
    }
  )

  it('rejects a missing, duplicated or malformed inactive_file and admits a valid one', async () => {
    const { sample, directory } = await fixture()
    for (const stat of [
      'anon 1\nfile 2\nactive_file 3\n',
      'inactive_file 1\ninactive_file 2\n',
      'inactive_file nope\n',
      'inactive_file -1\n',
    ]) {
      await writeFile(join(directory, 'memory.stat'), stat)
      await expect(sample()).rejects.toThrow('Document reader cgroup memory unavailable')
    }
    await writeFile(join(directory, 'memory.stat'), defaultStat(128 * MIB))
    expect((await sample())?.inactiveFileBytes).toBe(128 * MIB)
  })

  it('takes the minimum of configured RSS and headroom, reserving native memory before the heap', () => {
    const cgroup = { maxBytes: 1024 * MIB, currentBytes: 256 * MIB, inactiveFileBytes: 0 }
    // 1024 - 256 working set - 64 margin - 113 IPC - 128 drift = 463 MiB.
    expect(effectiveDocumentMemoryCaps(documentLimits({ maxHeapMb: 1_024 }), cgroup)).toEqual({
      maxResidentBytes: 463 * MIB,
      maxHeapMb: 399,
    })
    expect(effectiveDocumentMemoryCaps(documentLimits({ maxResidentMb: 160 }), cgroup)).toEqual({
      maxResidentBytes: 160 * MIB,
      maxHeapMb: 96,
    })
    expect(effectiveDocumentMemoryCaps(documentLimits({ maxHeapMb: 64 }), cgroup)).toEqual({
      maxResidentBytes: 463 * MIB,
      maxHeapMb: 64,
    })
  })

  it('calibrates the child virtual reserve per architecture and reserves the drift', () => {
    expect(DOCUMENT_IPC_RESERVE_BYTES).toBe(113 * MIB)
    expect(DOCUMENT_VIRTUAL_DRIFT_RESERVE_BYTES).toBe(128 * MIB)
    // Measured idle worker VmData minus resident in the pinned Alpine image:
    // x64 2052 - 89 = 1963 MiB, arm64 1348 - 66 = 1282 MiB; both plus drift.
    expect(childVirtualReserveBytes('x64')).toBe((1_963 + 128) * MIB)
    expect(childVirtualReserveBytes('arm64')).toBe((1_282 + 128) * MIB)
    // Liveness: an architecture without a measurement gets no reserve.
    expect(childVirtualReserveBytes('ia32')).toBeNull()
    expect(childVirtualReserveBytes('riscv64')).toBeNull()
  })

  it('reserves the drift, IPC transients and cgroup margin before the resident cap', () => {
    // 640 - 100 working set - 64 margin - 113 IPC - 128 drift = 235 MiB.
    expect(
      effectiveDocumentMemoryCaps(documentLimits(), {
        maxBytes: 640 * MIB,
        currentBytes: 100 * MIB,
        inactiveFileBytes: 0,
      })
    ).toEqual({ maxResidentBytes: 235 * MIB, maxHeapMb: 171 })
  })

  it('refuses below the admission floor and admits its exact boundary', () => {
    expect(
      effectiveDocumentMemoryCaps(documentLimits(), {
        maxBytes: 512 * MIB,
        currentBytes: 79 * MIB + 1,
        inactiveFileBytes: 0,
      })
    ).toBeNull()
    expect(
      effectiveDocumentMemoryCaps(documentLimits(), {
        maxBytes: 512 * MIB,
        currentBytes: 79 * MIB,
        inactiveFileBytes: 0,
      })
    ).toEqual({ maxResidentBytes: 128 * MIB, maxHeapMb: 64 })
  })

  // R1-H3: a 512 MiB Host whose 468 MiB current is 403 MiB of reclaimable cache
  // has only 65 MiB of working set; the old formula returned null here.
  it('ignores reclaimable inactive file cache when admitting a reader', () => {
    const warm = { maxBytes: 512 * MIB, currentBytes: 468 * MIB, inactiveFileBytes: 403 * MIB }
    expect(effectiveDocumentMemoryCaps(documentLimits(), warm)).toEqual({
      maxResidentBytes: 142 * MIB,
      maxHeapMb: 78,
    })
    // Liveness: the same current with no reclaimable cache must still refuse.
    expect(
      effectiveDocumentMemoryCaps(documentLimits(), { ...warm, inactiveFileBytes: 0 })
    ).toBeNull()
  })

  it('clamps the working set at zero when current and stat race', () => {
    expect(
      documentCgroupWorkingSetBytes({
        maxBytes: 512 * MIB,
        currentBytes: 100 * MIB,
        inactiveFileBytes: 120 * MIB,
      })
    ).toBe(0)
    expect(
      effectiveDocumentMemoryCaps(documentLimits(), {
        maxBytes: 512 * MIB,
        currentBytes: 100 * MIB,
        inactiveFileBytes: 120 * MIB,
      })
    ).toEqual({ maxResidentBytes: 207 * MIB, maxHeapMb: 143 })
  })
})
