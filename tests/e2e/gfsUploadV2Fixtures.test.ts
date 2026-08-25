import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createDiskUploadFixture,
  createOversizedDiskUploadFixture,
  removeDiskUploadFixture,
} from './gfsUploadV2Fixtures.js'

const fixturePrefix = 'evenfire-gfs-upload-v2-'

async function fixtureDirectories(): Promise<string[]> {
  return (await readdir(os.tmpdir())).filter(entry => entry.startsWith(fixturePrefix)).sort()
}

describe('GFS Upload v2 disk fixtures', () => {
  const fixtures: Array<Awaited<ReturnType<typeof createDiskUploadFixture>>> = []
  const ownedDirectories: string[] = []

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      if (existsSync(fixture.directory)) await removeDiskUploadFixture(fixture)
    }
    await Promise.all(
      ownedDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
    )
  })

  it('removes an owned fixture after a successful setup', async () => {
    const fixture = await createDiskUploadFixture(1, '.bin', 'cleanup-success')
    expect((await stat(fixture.filePath)).size).toBe(1)
    await removeDiskUploadFixture(fixture)
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

  it('validates before creating a fixture directory', async () => {
    const before = await fixtureDirectories()
    await expect(createOversizedDiskUploadFixture('.bin', 'invalid-product', 0)).rejects.toThrow(
      'invalid GFS v2 product maximum: 0'
    )
    expect(await fixtureDirectories()).toEqual(before)
  })
})
