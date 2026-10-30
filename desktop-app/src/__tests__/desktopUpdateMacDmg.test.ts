import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { updaterFileSystem } from '../desktopUpdateFileSystem.js'
import { saveVerifiedMacInstaller } from '../desktopUpdateMacDmg.js'

let temporaryRoot = ''

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = ''
})

async function createFixture() {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-manual-dmg-'))
  const downloadsDirectory = path.join(temporaryRoot, 'Downloads')
  const sourcePath = path.join(temporaryRoot, 'original.dmg')
  const contents = Buffer.from('original-published-dmg')
  const expectedSha256 = createHash('sha256').update(contents).digest('hex')
  await mkdir(downloadsDirectory)
  await writeFile(sourcePath, contents)
  return { downloadsDirectory, sourcePath, contents, expectedSha256 }
}

describe('verified macOS installer saving', () => {
  it('uses the architecture-free versioned filename and preserves the exact DMG bytes', async () => {
    const fixture = await createFixture()
    const saved = await saveVerifiedMacInstaller({
      ...fixture,
      version: '0.12.0',
    })

    expect(path.basename(saved.filePath)).toBe('Evenfire-v0.12.0.dmg')
    expect(saved.sha256).toBe(fixture.expectedSha256)
    expect(await readFile(saved.filePath)).toEqual(fixture.contents)
  })

  it('reuses an identical existing verified installer without replacing its inode', async () => {
    const fixture = await createFixture()
    const existingPath = path.join(fixture.downloadsDirectory, 'Evenfire-v0.12.0.dmg')
    await writeFile(existingPath, fixture.contents)
    const existingInode = (await lstat(existingPath)).ino

    const saved = await saveVerifiedMacInstaller({ ...fixture, version: '0.12.0' })

    expect(saved.filePath).toBe(
      path.join(await realpath(fixture.downloadsDirectory), 'Evenfire-v0.12.0.dmg')
    )
    expect((await lstat(existingPath)).ino).toBe(existingInode)
  })

  it('uses numeric suffixes for different-content and symlink filename collisions', async () => {
    const fixture = await createFixture()
    const occupiedPath = path.join(fixture.downloadsDirectory, 'Evenfire-v0.12.0.dmg')
    await writeFile(occupiedPath, 'a different installer')

    const saved = await saveVerifiedMacInstaller({ ...fixture, version: '0.12.0' })

    expect(saved.filePath).toBe(
      path.join(await realpath(fixture.downloadsDirectory), 'Evenfire-v0.12.0 (1).dmg')
    )
    const outsidePath = path.join(temporaryRoot, 'outside.dmg')
    const symlinkPath = path.join(fixture.downloadsDirectory, 'Evenfire-v0.13.0.dmg')
    await writeFile(outsidePath, 'do not follow')
    await symlink(outsidePath, symlinkPath)
    const symlinkCollision = await saveVerifiedMacInstaller({ ...fixture, version: '0.13.0' })

    expect(path.basename(symlinkCollision.filePath)).toBe('Evenfire-v0.13.0 (1).dmg')
    expect((await lstat(occupiedPath)).isSymbolicLink()).toBe(false)
    expect((await lstat(symlinkPath)).isSymbolicLink()).toBe(true)
    expect(await readFile(outsidePath, 'utf8')).toBe('do not follow')
    expect(await readFile(saved.filePath)).toEqual(fixture.contents)
  })

  it('rejects an unsafe Downloads symlink without writing outside it', async () => {
    const fixture = await createFixture()
    const unsafeDirectory = path.join(temporaryRoot, 'linked-downloads')
    await rm(fixture.downloadsDirectory, { recursive: true })
    await symlink(temporaryRoot, unsafeDirectory)

    await expect(
      saveVerifiedMacInstaller({
        ...fixture,
        downloadsDirectory: unsafeDirectory,
        version: '0.12.0',
      })
    ).rejects.toThrow('Downloads folder is not a safe directory')
    await expect(lstat(path.join(temporaryRoot, 'Evenfire-v0.12.0.dmg'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('removes only its partial file when extraction is canceled', async () => {
    const fixture = await createFixture()
    const controller = new AbortController()
    controller.abort()

    await expect(
      saveVerifiedMacInstaller({ ...fixture, version: '0.12.0', signal: controller.signal })
    ).rejects.toThrow()
    expect(await readdir(fixture.downloadsDirectory)).toEqual([])
    expect(await readFile(fixture.sourcePath)).toEqual(fixture.contents)
  })

  it('removes its just-created destination if cancellation lands during the atomic commit', async () => {
    const fixture = await createFixture()
    const controller = new AbortController()
    const originalLink = updaterFileSystem.promises.link

    await expect(
      saveVerifiedMacInstaller({
        ...fixture,
        version: '0.12.0',
        signal: controller.signal,
        linkFile: async (...args) => {
          controller.abort()
          await originalLink(...args)
        },
      })
    ).rejects.toThrow('download canceled')
    expect(await readdir(fixture.downloadsDirectory)).toEqual([])
    expect(await readFile(fixture.sourcePath)).toEqual(fixture.contents)
  })
})
