import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createDiskUploadFixture,
  createOversizedDiskUploadFixture,
  removeDiskUploadFixture,
  setAfterFixtureHandleForTest,
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

describe('GFS Upload v2 disk fixtures', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createDiskUploadFixture>>> = []

  afterEach(async () => {
    setAfterFixtureHandleForTest?.(undefined)
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

  it('validates before creating a fixture directory', async () => {
    const before = await fixtureDirectories()
    await expect(createOversizedDiskUploadFixture('.bin', 'invalid-product', 0)).rejects.toThrow(
      'invalid GFS v2 product maximum: 0'
    )
    expect(await fixtureDirectories()).toEqual(before)
  })
})
