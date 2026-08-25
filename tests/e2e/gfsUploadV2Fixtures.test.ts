import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
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
  setAfterFixtureQuarantineForTest,
} from './gfsUploadV2Fixtures.js'

const fixturePrefix = 'evenfire-gfs-upload-v2-'

async function fixtureDirectories(): Promise<string[]> {
  return (await readdir(os.tmpdir())).filter(entry => entry.startsWith(fixturePrefix)).sort()
}

async function removeKnownFixtureDirectory(directory: string, fileName: string): Promise<void> {
  const filePath = path.join(directory, fileName)
  if (existsSync(filePath)) await unlink(filePath)
  if (existsSync(directory)) await rmdir(directory)
}

describe('GFS Upload v2 disk fixtures', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createDiskUploadFixture>>> = []
  const ownedDirectories: string[] = []

  afterEach(async () => {
    setAfterFixtureQuarantineForTest(undefined)
    for (const fixture of fixtures.splice(0)) {
      if (existsSync(fixture.directory)) await removeDiskUploadFixture(fixture)
    }
    for (const directory of ownedDirectories.splice(0)) {
      if (existsSync(directory)) await rmdir(directory)
    }
  })

  it('removes an owned fixture after a successful setup', async () => {
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-success')
    fixtures.push(fixture)
    expect((await stat(fixture.filePath)).size).toBe(1)
    await removeDiskUploadFixture(fixture)
    expect(existsSync(fixture.directory)).toBe(false)
    expect(existsSync(fixture.filePath)).toBe(false)
  })

  it('removes a tracked owned fixture after an assertion-failure lifecycle', async () => {
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
    expect(existsSync(fixture.directory)).toBe(false)
  })

  it('cleans an owned directory when fixture setup fails part-way through', async () => {
    const before = await fixtureDirectories()
    await expect(createDiskUploadFixture(1, '.bin', 'nested/partial')).rejects.toThrow()
    expect(await fixtureDirectories()).toEqual(before)
  })

  it('refuses to delete a directory the fixture did not create', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'unowned-gfs-upload-v2-'))
    ownedDirectories.push(directory)
    await expect(
      removeDiskUploadFixture({
        directory,
        filePath: path.join(directory, 'payload.bin'),
        fileName: 'payload.bin',
        byteLength: 0,
        sha256: '',
      })
    ).rejects.toThrow('refusing to remove an unowned GFS v2 fixture directory')
    expect(existsSync(directory)).toBe(true)
  })

  it('rejects a replaced owned pathname and preserves its sentinel', async () => {
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-replacement')
    const movedDirectory = `${fixture.directory}-original`
    const sentinel = path.join(fixture.directory, 'sentinel.txt')
    await rename(fixture.directory, movedDirectory)
    await mkdir(fixture.directory)
    await writeFile(sentinel, 'replacement must survive')

    try {
      await expect(removeDiskUploadFixture(fixture)).rejects.toThrow(
        'refusing to quarantine a replaced GFS v2 fixture directory'
      )
      await expect(stat(sentinel)).resolves.toBeDefined()
    } finally {
      await unlink(sentinel)
      await rmdir(fixture.directory)
      await removeKnownFixtureDirectory(movedDirectory, fixture.fileName)
    }
  })

  it('does not treat a missing active fixture directory as already disposed', async () => {
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-missing')
    const movedDirectory = `${fixture.directory}-original`
    await rename(fixture.directory, movedDirectory)

    try {
      await expect(removeDiskUploadFixture(fixture)).rejects.toThrow(
        'cannot quarantine active GFS v2 fixture directory'
      )
      expect(existsSync(movedDirectory)).toBe(true)
    } finally {
      await removeKnownFixtureDirectory(movedDirectory, fixture.fileName)
    }
  })

  it('leaves a recreated original pathname untouched after quarantining the real fixture', async () => {
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-recreated-original')
    const sentinel = path.join(fixture.directory, 'sentinel.txt')
    setAfterFixtureQuarantineForTest(async directory => {
      await mkdir(directory)
      await writeFile(sentinel, 'replacement after quarantine')
    })

    try {
      await removeDiskUploadFixture(fixture)
      await expect(stat(sentinel)).resolves.toBeDefined()
    } finally {
      setAfterFixtureQuarantineForTest(undefined)
      await unlink(sentinel)
      await rmdir(fixture.directory)
    }
  })

  it('rejects unexpected contents in a verified owned fixture directory', async () => {
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-unexpected')
    const unexpected = path.join(fixture.directory, 'unexpected.txt')
    let quarantineDirectory: string | undefined
    setAfterFixtureQuarantineForTest((_directory, quarantined) => {
      quarantineDirectory = quarantined
    })
    await writeFile(unexpected, 'preserve unexpected content')

    try {
      await expect(removeDiskUploadFixture(fixture)).rejects.toThrow(
        'refusing to remove unexpected GFS v2 fixture contents'
      )
      expect(quarantineDirectory).toBeDefined()
      await expect(stat(path.join(quarantineDirectory!, 'unexpected.txt'))).resolves.toBeDefined()
      await unlink(path.join(quarantineDirectory!, 'unexpected.txt'))
      await removeKnownFixtureDirectory(quarantineDirectory!, fixture.fileName)
    } finally {
      setAfterFixtureQuarantineForTest(undefined)
    }
  })

  it('rejects a symlink replacement without deleting its target', async () => {
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-symlink')
    const movedDirectory = `${fixture.directory}-original`
    const targetDirectory = await mkdtemp(path.join(os.tmpdir(), 'unowned-gfs-upload-v2-target-'))
    const targetSentinel = path.join(targetDirectory, 'sentinel.txt')
    await rename(fixture.directory, movedDirectory)
    await writeFile(targetSentinel, 'symlink target must survive')
    await symlink(targetDirectory, fixture.directory)

    try {
      await expect(removeDiskUploadFixture(fixture)).rejects.toThrow(
        'cannot quarantine active GFS v2 fixture directory'
      )
      await expect(stat(targetSentinel)).resolves.toBeDefined()
      expect((await lstat(fixture.directory)).isSymbolicLink()).toBe(true)
    } finally {
      await unlink(fixture.directory)
      await unlink(targetSentinel)
      await rmdir(targetDirectory)
      await removeKnownFixtureDirectory(movedDirectory, fixture.fileName)
    }
  })

  it('makes repeated cleanup of a successfully disposed fixture a no-op', async () => {
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-repeated')
    fixtures.push(fixture)
    await removeDiskUploadFixture(fixture)
    await expect(removeDiskUploadFixture(fixture)).resolves.toBeUndefined()
    expect(existsSync(fixture.directory)).toBe(false)
  })

  it('rejects a replacement that appears after the original directory is quarantined', async () => {
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-quarantine-replacement')
    let quarantinedOriginal: string | undefined
    let quarantineReplacement: string | undefined
    setAfterFixtureQuarantineForTest(async (_directory, quarantineDirectory) => {
      quarantinedOriginal = `${quarantineDirectory}-original`
      quarantineReplacement = quarantineDirectory
      await rename(quarantineDirectory, quarantinedOriginal)
      await mkdir(quarantineDirectory)
      await writeFile(path.join(quarantineDirectory, 'sentinel.txt'), 'quarantine replacement')
    })

    try {
      await expect(removeDiskUploadFixture(fixture)).rejects.toThrow(
        'refusing to remove a replaced GFS v2 fixture directory'
      )
      await expect(stat(path.join(quarantineReplacement!, 'sentinel.txt'))).resolves.toBeDefined()
    } finally {
      setAfterFixtureQuarantineForTest(undefined)
      await unlink(path.join(quarantineReplacement!, 'sentinel.txt'))
      await rmdir(quarantineReplacement!)
      await removeKnownFixtureDirectory(quarantinedOriginal!, fixture.fileName)
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
