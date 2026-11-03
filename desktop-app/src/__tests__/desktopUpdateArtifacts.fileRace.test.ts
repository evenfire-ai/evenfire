import { afterEach, describe, expect, it, vi } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { prepareVerifiedDesktopPayload, verifyAppTree } from '../desktopUpdateArtifacts.js'

const race = vi.hoisted(() => ({ path: null as string | null, target: null as string | null }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const info = await actual.lstat(...args)
      const requestedPath = String(args[0])
      if (race.path === requestedPath && race.target) {
        const target = race.target
        race.path = null
        race.target = null
        await actual.rename(requestedPath, `${requestedPath}.before-race`)
        await actual.symlink(target, requestedPath)
      }
      return info
    },
  }
})

describe('Desktop updater executable verification race protection', () => {
  let temporaryRoot = ''

  afterEach(async () => {
    race.path = null
    race.target = null
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = ''
  })

  it.skipIf(!process.env.EVENFIRE_DESKTOP_RELEASE_FIXTURE_DIR)(
    'does not verify an external executable substituted after the staged file check',
    async () => {
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-executable-race-'))
      const archivePath = path.join(
        process.env.EVENFIRE_DESKTOP_RELEASE_FIXTURE_DIR!,
        'linux-v0.12.0.zip'
      )
      const destination = path.join(temporaryRoot, 'payload')
      await mkdir(destination)
      const payload = await prepareVerifiedDesktopPayload({
        archivePath,
        destination,
        version: '0.12.0',
        platform: 'linux',
        architecture: 'x64',
        packageType: 'app-zip',
      })

      const executablePath = path.join(payload.appPath, 'Evenfire')
      const publisherExecutable = path.join(temporaryRoot, 'publisher-evenfire')
      await writeFile(publisherExecutable, await readFile(executablePath))
      await writeFile(executablePath, 'not an ELF executable')
      race.path = executablePath
      race.target = publisherExecutable

      await expect(verifyAppTree(payload.appPath, '0.12.0', 'linux', 'x64')).rejects.toThrow(
        'not an ELF executable'
      )
      expect((await lstat(executablePath)).isSymbolicLink()).toBe(true)
    }
  )
})
