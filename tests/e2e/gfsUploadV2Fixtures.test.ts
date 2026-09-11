import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import {
  type FileHandle,
  mkdir,
  readdir,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createDiskUploadFixture,
  createOversizedDiskUploadFixture,
  removeDiskUploadFixture,
  setAfterFixtureHandleForTest,
  setFixtureHandleForTest,
  sha256File,
} from './gfsUploadV2Fixtures.js'

const fixturePrefix = 'evenfire-gfs-upload-v2-'

async function fixtureDirectories(): Promise<string[]> {
  return (await readdir(os.tmpdir()))
    .filter(entry => entry.startsWith(fixturePrefix))
    .map(entry => path.join(os.tmpdir(), entry))
    .sort()
}

async function removeKnownFixtureDirectory(directory: string, fileNames: string[]): Promise<void> {
  for (const fileName of fileNames) {
    const filePath = path.join(directory, fileName)
    if (existsSync(filePath)) await unlink(filePath)
  }
  if (existsSync(directory)) await rmdir(directory)
}

function useScriptedFixtureHandle(script: {
  truncate?: (length: number, call: number) => Promise<void> | void
  close?: (call: number, handle: FileHandle) => Promise<void> | void
}): { truncate: number; close: number } {
  const calls = { truncate: 0, close: 0 }
  setFixtureHandleForTest(handle => ({
    async truncate(length: number): Promise<void> {
      calls.truncate += 1
      await script.truncate?.(length, calls.truncate)
      await handle.truncate(length)
    },
    async close(): Promise<void> {
      calls.close += 1
      if (script.close) {
        await script.close(calls.close, handle)
        return
      }
      await handle.close()
    },
  }))
  return calls
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
} {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settledReasons(promises: Array<Promise<void>>): Promise<unknown[]> {
  const results = await Promise.allSettled(promises)
  return results.map(result => {
    expect(result.status).toBe('rejected')
    return (result as PromiseRejectedResult).reason
  })
}

describe('GFS Upload v2 disk fixtures', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createDiskUploadFixture>>> = []

  afterEach(async () => {
    setAfterFixtureHandleForTest?.(undefined)
    setFixtureHandleForTest(undefined)
    for (const fixture of fixtures.splice(0)) {
      await removeDiskUploadFixture(fixture).catch(() => undefined)
      await removeKnownFixtureDirectory(fixture.directory, [fixture.fileName]).catch(
        () => undefined
      )
    }
  })

  it('neutralizes an owned fixture through its retained handle without deleting its pathname', async () => {
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-success')
    fixtures.push(fixture)
    expect((await stat(fixture.filePath)).size).toBe(1)
    expect(await sha256File(fixture.filePath)).toBe(fixture.sha256)

    await removeDiskUploadFixture(fixture)

    expect((await stat(fixture.filePath)).size).toBe(0)
    expect(existsSync(fixture.directory)).toBe(true)
    await expect(removeDiskUploadFixture(fixture)).resolves.toBeUndefined()
  })

  it('neutralizes a tracked fixture after an assertion-failure lifecycle', async () => {
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-assertion-failure')
    fixtures.push(fixture)
    const assertionFailure = new Error('synthetic assertion failure')

    await expect(
      (async () => {
        try {
          throw assertionFailure
        } finally {
          for (const tracked of fixtures.splice(0)) await removeDiskUploadFixture(tracked)
        }
      })()
    ).rejects.toBe(assertionFailure)
    expect((await stat(fixture.filePath)).size).toBe(0)
    await removeKnownFixtureDirectory(fixture.directory, [fixture.fileName])
  })

  it('closes and neutralizes a partial fixture once its handle has been acquired', async () => {
    const before = await fixtureDirectories()
    expect(setAfterFixtureHandleForTest).toBeTypeOf('function')
    setAfterFixtureHandleForTest?.(() => {
      throw new Error('synthetic setup failure after handle acquisition')
    })

    await expect(createDiskUploadFixture(1, '.bin', 'partial-handle')).rejects.toThrow(
      'synthetic setup failure after handle acquisition'
    )

    const created = (await fixtureDirectories()).filter(directory => !before.includes(directory))
    expect(created).toHaveLength(1)
    const partialFile = path.join(created[0]!, 'partial-handle-1.bin')
    expect((await stat(partialFile)).size).toBe(0)
    await removeKnownFixtureDirectory(created[0]!, ['partial-handle-1.bin'])
  })

  it('closes the raw opened handle when wrapper construction fails', async () => {
    const before = await fixtureDirectories()
    const wrapperFailure = new Error('synthetic fixture wrapper failure')
    let rawHandle: FileHandle | undefined
    setFixtureHandleForTest(handle => {
      rawHandle = handle
      throw wrapperFailure
    })

    await expect(createDiskUploadFixture(1, '.bin', 'partial-wrapper')).rejects.toBe(wrapperFailure)

    expect(rawHandle).toBeDefined()
    await expect(rawHandle!.stat()).rejects.toThrow()
    const created = (await fixtureDirectories()).filter(directory => !before.includes(directory))
    expect(created).toHaveLength(1)
    const partialFile = path.join(created[0]!, 'partial-wrapper-1.bin')
    expect((await stat(partialFile)).size).toBe(0)
    await removeKnownFixtureDirectory(created[0]!, ['partial-wrapper-1.bin'])
  })

  it('closes the retained handle when the after-handle setup hook fails', async () => {
    const before = await fixtureDirectories()
    const setupFailure = new Error('synthetic setup hook failure')
    let rawHandle: FileHandle | undefined
    setFixtureHandleForTest(handle => {
      rawHandle = handle
      return {
        async truncate(length: number): Promise<void> {
          await handle.truncate(length)
        },
        async close(): Promise<void> {
          await handle.close()
        },
      }
    })
    setAfterFixtureHandleForTest?.(() => {
      throw setupFailure
    })

    await expect(createDiskUploadFixture(1, '.bin', 'partial-hook')).rejects.toBe(setupFailure)

    expect(rawHandle).toBeDefined()
    await expect(rawHandle!.stat()).rejects.toThrow()
    const created = (await fixtureDirectories()).filter(directory => !before.includes(directory))
    expect(created).toHaveLength(1)
    await removeKnownFixtureDirectory(created[0]!, ['partial-hook-1.bin'])
  })

  it('closes the retained handle when hashing fails after setup', async () => {
    const before = await fixtureDirectories()
    let rawHandle: FileHandle | undefined
    let retainedPath = ''
    setFixtureHandleForTest(handle => {
      rawHandle = handle
      return {
        async truncate(length: number): Promise<void> {
          await handle.truncate(length)
        },
        async close(): Promise<void> {
          await handle.close()
        },
      }
    })
    setAfterFixtureHandleForTest?.(async fixture => {
      retainedPath = `${fixture.filePath}-retained`
      await rename(fixture.filePath, retainedPath)
    })

    await expect(createDiskUploadFixture(1, '.bin', 'partial-hash')).rejects.toMatchObject({
      code: 'ENOENT',
    })

    expect(rawHandle).toBeDefined()
    await expect(rawHandle!.stat()).rejects.toThrow()
    expect((await stat(retainedPath)).size).toBe(0)
    const created = (await fixtureDirectories()).filter(directory => !before.includes(directory))
    expect(created).toHaveLength(1)
    await removeKnownFixtureDirectory(created[0]!, ['partial-hash-1.bin-retained'])
  })

  it('uses exactly one disposal surface after a successful wrapper transition', async () => {
    const calls = useScriptedFixtureHandle({})
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-wrapper-transition')

    try {
      await removeDiskUploadFixture(fixture)
      await expect(removeDiskUploadFixture(fixture)).resolves.toBeUndefined()
      expect(calls).toEqual({ truncate: 2, close: 1 })
    } finally {
      await removeKnownFixtureDirectory(fixture.directory, [fixture.fileName])
    }
  })

  it('rejects a fabricated fixture object with copied pathname data', async () => {
    const fixture = await createDiskUploadFixture(32, '.bin', 'cleanup-fabricated')
    const fabricated = { ...fixture }

    try {
      await expect(removeDiskUploadFixture(fabricated)).rejects.toThrow(
        'refusing to neutralize an unowned GFS v2 fixture'
      )
      expect((await stat(fixture.filePath)).size).toBe(32)
    } finally {
      await removeDiskUploadFixture(fixture)
      await removeKnownFixtureDirectory(fixture.directory, [fixture.fileName])
    }
  })

  it('neutralizes the created file after its visible child pathname is replaced', async () => {
    const fixture = await createDiskUploadFixture(32, '.bin', 'cleanup-child-replacement')
    const retainedOriginal = `${fixture.filePath}-retained`
    await rename(fixture.filePath, retainedOriginal)
    await writeFile(fixture.filePath, 'replacement sentinel')

    try {
      await removeDiskUploadFixture(fixture)
      expect((await stat(retainedOriginal)).size).toBe(0)
      expect((await stat(fixture.filePath)).size).toBe('replacement sentinel'.length)
    } finally {
      await removeKnownFixtureDirectory(fixture.directory, [
        fixture.fileName,
        `${fixture.fileName}-retained`,
      ])
    }
  })

  it('does not redirect cleanup when the fixture directory pathname is replaced', async () => {
    const fixture = await createDiskUploadFixture(32, '.bin', 'cleanup-directory-replacement')
    const retainedDirectory = `${fixture.directory}-retained`
    const replacementSentinel = path.join(fixture.directory, 'sentinel.txt')
    await rename(fixture.directory, retainedDirectory)
    await mkdir(fixture.directory)
    await writeFile(replacementSentinel, 'replacement directory sentinel')

    try {
      await removeDiskUploadFixture(fixture)
      expect((await stat(path.join(retainedDirectory, fixture.fileName))).size).toBe(0)
      expect((await stat(replacementSentinel)).size).toBe('replacement directory sentinel'.length)
    } finally {
      await removeKnownFixtureDirectory(fixture.directory, ['sentinel.txt'])
      await removeKnownFixtureDirectory(retainedDirectory, [fixture.fileName])
    }
  })

  it('cannot redirect cleanup by replacing the pathname immediately before disposal', async () => {
    const fixture = await createDiskUploadFixture(32, '.bin', 'cleanup-last-moment-replacement')
    const retainedOriginal = `${fixture.filePath}-retained`
    await rename(fixture.filePath, retainedOriginal)
    await writeFile(fixture.filePath, 'last moment sentinel')

    try {
      await removeDiskUploadFixture(fixture)
      expect((await stat(retainedOriginal)).size).toBe(0)
      expect((await stat(fixture.filePath)).size).toBe('last moment sentinel'.length)
    } finally {
      await removeKnownFixtureDirectory(fixture.directory, [
        fixture.fileName,
        `${fixture.fileName}-retained`,
      ])
    }
  })

  it('does not mutate a symlink replacement target', async () => {
    const fixture = await createDiskUploadFixture(32, '.bin', 'cleanup-symlink-replacement')
    const retainedOriginal = `${fixture.filePath}-retained`
    const targetPath = `${fixture.filePath}-target`
    await rename(fixture.filePath, retainedOriginal)
    await writeFile(targetPath, 'symlink target sentinel')
    await symlink(targetPath, fixture.filePath)

    try {
      await removeDiskUploadFixture(fixture)
      expect((await stat(retainedOriginal)).size).toBe(0)
      expect((await stat(targetPath)).size).toBe('symlink target sentinel'.length)
    } finally {
      if (existsSync(fixture.filePath)) await unlink(fixture.filePath)
      await removeKnownFixtureDirectory(fixture.directory, [
        `${fixture.fileName}-retained`,
        `${fixture.fileName}-target`,
      ])
    }
  })

  it('keeps a large sparse fixture from retaining its logical size after disposal', async () => {
    const fixture = await createDiskUploadFixture(32 * 1024 * 1024, '.bin', 'cleanup-large-sparse')
    fixtures.push(fixture)
    expect((await stat(fixture.filePath)).size).toBe(32 * 1024 * 1024)

    await removeDiskUploadFixture(fixture)

    expect((await stat(fixture.filePath)).size).toBe(0)
  })

  it('single-flights two concurrent successful disposals', async () => {
    const entered = deferred()
    const release = deferred()
    const calls = useScriptedFixtureHandle({
      truncate: async (_length, call) => {
        if (call === 2) {
          entered.resolve()
          await release.promise
        }
      },
    })
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-concurrent-success')

    try {
      const first = removeDiskUploadFixture(fixture)
      await entered.promise
      const second = removeDiskUploadFixture(fixture)
      release.resolve()
      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
      expect(calls).toEqual({ truncate: 2, close: 1 })
      await expect(removeDiskUploadFixture(fixture)).resolves.toBeUndefined()
      expect(calls).toEqual({ truncate: 2, close: 1 })
    } finally {
      await removeKnownFixtureDirectory(fixture.directory, [fixture.fileName])
    }
  })

  it('single-flights many concurrent successful disposals', async () => {
    const entered = deferred()
    const release = deferred()
    const calls = useScriptedFixtureHandle({
      truncate: async (_length, call) => {
        if (call === 2) {
          entered.resolve()
          await release.promise
        }
      },
    })
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-many-concurrent-success')

    try {
      const first = removeDiskUploadFixture(fixture)
      await entered.promise
      const joined = Array.from({ length: 8 }, () => removeDiskUploadFixture(fixture))
      release.resolve()
      await expect(Promise.all([first, ...joined])).resolves.toEqual(
        Array.from({ length: 9 }, () => undefined)
      )
      expect(calls).toEqual({ truncate: 2, close: 1 })
    } finally {
      await removeKnownFixtureDirectory(fixture.directory, [fixture.fileName])
    }
  })

  it('single-flights concurrent truncate failure and terminal closed recovery', async () => {
    const entered = deferred()
    const release = deferred()
    const truncateFailure = new Error('synthetic concurrent truncate failure')
    const calls = useScriptedFixtureHandle({
      truncate: async (_length, call) => {
        if (call === 2) {
          entered.resolve()
          await release.promise
          throw truncateFailure
        }
      },
    })
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-concurrent-truncate-failure')

    try {
      const first = removeDiskUploadFixture(fixture)
      await entered.promise
      const second = removeDiskUploadFixture(fixture)
      release.resolve()
      const reasons = await settledReasons([first, second])
      expect(reasons).toEqual([truncateFailure, truncateFailure])
      expect(calls).toEqual({ truncate: 2, close: 1 })

      await expect(removeDiskUploadFixture(fixture)).rejects.toBe(truncateFailure)
      expect(calls).toEqual({ truncate: 2, close: 1 })
    } finally {
      await removeKnownFixtureDirectory(fixture.directory, [fixture.fileName])
    }
  })

  it('single-flights concurrent close failure after successful neutralization', async () => {
    const entered = deferred()
    const release = deferred()
    const closeFailure = new Error('synthetic concurrent close failure')
    const calls = useScriptedFixtureHandle({
      close: async (call, handle) => {
        if (call === 1) {
          entered.resolve()
          await release.promise
          throw closeFailure
        }
        await handle.close()
      },
    })
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-concurrent-close-failure')

    try {
      const first = removeDiskUploadFixture(fixture)
      await entered.promise
      const second = removeDiskUploadFixture(fixture)
      release.resolve()
      const reasons = await settledReasons([first, second])
      expect(reasons).toEqual([closeFailure, closeFailure])
      expect(calls).toEqual({ truncate: 2, close: 1 })

      await expect(removeDiskUploadFixture(fixture)).resolves.toBeUndefined()
      expect(calls).toEqual({ truncate: 2, close: 2 })
      await expect(removeDiskUploadFixture(fixture)).resolves.toBeUndefined()
      expect(calls).toEqual({ truncate: 2, close: 2 })
    } finally {
      await removeKnownFixtureDirectory(fixture.directory, [fixture.fileName])
    }
  })

  it('single-flights concurrent truncate and recovery-close failure', async () => {
    const entered = deferred()
    const release = deferred()
    const truncateFailure = new Error('synthetic concurrent truncate failure')
    const closeFailure = new Error('synthetic concurrent close failure')
    const calls = useScriptedFixtureHandle({
      truncate: async (_length, call) => {
        if (call === 2) {
          entered.resolve()
          await release.promise
          throw truncateFailure
        }
      },
      close: async (call, handle) => {
        if (call === 1) throw closeFailure
        await handle.close()
      },
    })
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-concurrent-truncate-close')

    try {
      const first = removeDiskUploadFixture(fixture)
      await entered.promise
      const second = removeDiskUploadFixture(fixture)
      release.resolve()
      const reasons = await settledReasons([first, second])
      expect(reasons[0]).toBeInstanceOf(AggregateError)
      expect(reasons[1]).toBe(reasons[0])
      expect((reasons[0] as AggregateError).errors).toEqual([truncateFailure, closeFailure])
      expect(calls).toEqual({ truncate: 2, close: 1 })

      await expect(removeDiskUploadFixture(fixture)).rejects.toBe(truncateFailure)
      expect(calls).toEqual({ truncate: 2, close: 2 })
      await expect(removeDiskUploadFixture(fixture)).rejects.toBe(truncateFailure)
      expect(calls).toEqual({ truncate: 2, close: 2 })
    } finally {
      await removeKnownFixtureDirectory(fixture.directory, [fixture.fileName])
    }
  })

  it('keeps a truncate-failure disposal terminal after recovery close succeeds', async () => {
    const truncateFailure = new Error('synthetic cleanup truncate failure')
    const calls = useScriptedFixtureHandle({
      truncate: (_length, call) => {
        if (call === 2) throw truncateFailure
      },
    })
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-truncate-failure')

    try {
      await expect(removeDiskUploadFixture(fixture)).rejects.toBe(truncateFailure)
      expect(calls).toEqual({ truncate: 2, close: 1 })

      await expect(removeDiskUploadFixture(fixture)).rejects.toBe(truncateFailure)
      expect(calls).toEqual({ truncate: 2, close: 1 })
    } finally {
      await removeKnownFixtureDirectory(fixture.directory, [fixture.fileName])
    }
  })

  it('preserves close context when truncate failure recovery cannot close the handle', async () => {
    const truncateFailure = new Error('synthetic cleanup truncate failure')
    const closeFailure = new Error('synthetic cleanup close failure')
    const calls = useScriptedFixtureHandle({
      truncate: (_length, call) => {
        if (call === 2) throw truncateFailure
      },
      close: async (call, handle) => {
        if (call === 1) throw closeFailure
        if (call === 2) {
          await handle.close()
          return
        }
        throw new Error('dispose retried a terminally failed handle')
      },
    })
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-truncate-close-failure')

    try {
      const firstError = await removeDiskUploadFixture(fixture).catch((error: unknown) => error)
      expect(firstError).toBeInstanceOf(AggregateError)
      expect((firstError as AggregateError).errors).toEqual([truncateFailure, closeFailure])
      expect(calls).toEqual({ truncate: 2, close: 1 })

      await expect(removeDiskUploadFixture(fixture)).rejects.toBe(truncateFailure)
      expect(calls).toEqual({ truncate: 2, close: 2 })

      await expect(removeDiskUploadFixture(fixture)).rejects.toBe(truncateFailure)
      expect(calls).toEqual({ truncate: 2, close: 2 })
    } finally {
      await removeKnownFixtureDirectory(fixture.directory, [fixture.fileName])
    }
  })

  it('marks a neutralized fixture disposed after close recovery succeeds', async () => {
    const closeFailure = new Error('synthetic cleanup close failure')
    const calls = useScriptedFixtureHandle({
      close: async (call, handle) => {
        if (call === 1) throw closeFailure
        await handle.close()
      },
    })
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-close-failure')

    try {
      await expect(removeDiskUploadFixture(fixture)).rejects.toBe(closeFailure)
      expect((await stat(fixture.filePath)).size).toBe(0)
      expect(calls).toEqual({ truncate: 2, close: 1 })

      await expect(removeDiskUploadFixture(fixture)).resolves.toBeUndefined()
      expect(calls).toEqual({ truncate: 2, close: 2 })
    } finally {
      await removeKnownFixtureDirectory(fixture.directory, [fixture.fileName])
    }
  })

  it('validates before creating a fixture directory', async () => {
    const before = await fixtureDirectories()
    await expect(createOversizedDiskUploadFixture('.bin', 'invalid-product', 0)).rejects.toThrow(
      'invalid GFS v2 product maximum: 0'
    )
    expect(await fixtureDirectories()).toEqual(before)
  })
})
