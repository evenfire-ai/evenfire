import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { documentCgroupSampler, effectiveDocumentMemoryCaps } from '../documentMemory'
import { documentLimits } from './fixtures'

const MIB = 1_048_576
const roots: string[] = []

async function fixture(membership = '0::/host/reader\n', maximum = String(512 * MIB)) {
  const root = await mkdtemp(join(tmpdir(), 'document-cgroup-'))
  roots.push(root)
  const membershipFile = join(root, 'membership')
  const cgroupRoot = join(root, 'cgroup')
  const directory = join(cgroupRoot, 'host/reader')
  await mkdir(directory, { recursive: true })
  await writeFile(membershipFile, membership)
  await writeFile(join(directory, 'memory.max'), maximum + '\n')
  await writeFile(join(directory, 'memory.current'), String(256 * MIB) + '\n')
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
  it('reads the Host membership, maximum and fresh current usage from fixture files', async () => {
    const { sample, directory } = await fixture()
    expect(await sample()).toEqual({ maxBytes: 512 * MIB, currentBytes: 256 * MIB })
    await writeFile(join(directory, 'memory.current'), String(300 * MIB))
    expect(await sample()).toEqual({ maxBytes: 512 * MIB, currentBytes: 300 * MIB })
  })

  it('uses configured caps for an unlimited controller and macOS', async () => {
    const { sample } = await fixture('0::/host/reader\n', 'max')
    const unlimited = await sample()
    expect(unlimited).toEqual({ maxBytes: null, currentBytes: 256 * MIB })
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

  it.each(['memory.max', 'memory.current'])(
    'rejects a missing %s instead of dropping the cap',
    async name => {
      const { sample, directory } = await fixture()
      await rm(join(directory, name))
      await expect(sample()).rejects.toThrow('Document reader cgroup memory unavailable')
      await writeFile(join(directory, name), String(name === 'memory.max' ? 512 * MIB : 256 * MIB))
      expect(await sample()).toEqual({ maxBytes: 512 * MIB, currentBytes: 256 * MIB })
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

  it('takes the minimum of configured RSS and headroom, reserving native memory before the heap', () => {
    const cgroup = { maxBytes: 512 * MIB, currentBytes: 256 * MIB }
    expect(effectiveDocumentMemoryCaps(documentLimits(), cgroup)).toEqual({
      maxResidentBytes: 192 * MIB,
      maxHeapMb: 128,
    })
    expect(effectiveDocumentMemoryCaps(documentLimits({ maxResidentMb: 160 }), cgroup)).toEqual({
      maxResidentBytes: 160 * MIB,
      maxHeapMb: 96,
    })
    expect(effectiveDocumentMemoryCaps(documentLimits({ maxHeapMb: 64 }), cgroup)).toEqual({
      maxResidentBytes: 192 * MIB,
      maxHeapMb: 64,
    })
  })

  it('refuses below the admission floor and admits its exact boundary', () => {
    expect(
      effectiveDocumentMemoryCaps(documentLimits(), {
        maxBytes: 512 * MIB,
        currentBytes: 320 * MIB + 1,
      })
    ).toBeNull()
    expect(
      effectiveDocumentMemoryCaps(documentLimits(), {
        maxBytes: 512 * MIB,
        currentBytes: 320 * MIB,
      })
    ).toEqual({ maxResidentBytes: 128 * MIB, maxHeapMb: 64 })
  })
})
