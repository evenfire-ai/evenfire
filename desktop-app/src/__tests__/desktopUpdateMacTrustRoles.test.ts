import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  getAppArchivePath,
  getNestedApplicationZipPath,
  prepareVerifiedDesktopPayload,
  readPackagedAppManifest,
  verifyAppTree,
} from '../desktopUpdateArtifacts.js'

const sourceAppPath = process.env.EVENFIRE_DESKTOP_UNSIGNED_SOURCE_APP
let temporaryRoot = ''

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = ''
})

function createDittoArchive(args: string[]): void {
  const result = spawnSync('/usr/bin/ditto', args, { encoding: 'utf8', timeout: 60_000 })
  if (result.error || result.status !== 0) {
    throw new Error('Could not create the isolated Forge-layout ZIP fixture with ditto.')
  }
}

describe('macOS updater source and target verification roles', () => {
  it.skipIf(!sourceAppPath || process.platform !== 'darwin')(
    'accepts the actual locally built unsigned app as an installed source',
    async () => {
      const manifest = readPackagedAppManifest(getAppArchivePath(sourceAppPath!, 'darwin'))
      await expect(
        verifyAppTree(sourceAppPath!, manifest.version, 'darwin', 'arm64')
      ).resolves.toMatchObject({
        appId: 'ai.evenfire.desktop',
        appVersion: manifest.version,
      })
    }
  )

  it.skipIf(!sourceAppPath || process.platform !== 'darwin')(
    'attributes an unsigned locally built app as an invalid release target',
    async () => {
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-mac-target-'))
      const manifest = readPackagedAppManifest(getAppArchivePath(sourceAppPath!, 'darwin'))
      const bundleRoot = path.join(temporaryRoot, 'outer')
      const nestedZipPath = path.join(
        bundleRoot,
        getNestedApplicationZipPath(manifest.version, 'darwin', 'arm64')
      )
      await mkdir(path.dirname(nestedZipPath), { recursive: true })
      createDittoArchive(['-c', '-k', '--keepParent', sourceAppPath!, nestedZipPath])

      const archivePath = path.join(temporaryRoot, 'release.zip')
      createDittoArchive(['-c', '-k', bundleRoot, archivePath])
      const destination = path.join(temporaryRoot, 'payload')
      await mkdir(destination)

      await expect(
        prepareVerifiedDesktopPayload({
          archivePath,
          destination,
          version: manifest.version,
          platform: 'darwin',
          architecture: 'arm64',
          packageType: 'app-zip',
        })
      ).rejects.toThrow('The downloaded macOS target failed signature verification.')
    }
  )
})
