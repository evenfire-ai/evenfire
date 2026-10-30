import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  getAppArchivePath,
  readPackagedAppManifest,
  verifyAppTree,
} from '../desktopUpdateArtifacts.js'
import { verifyMacInstallerDmg } from '../desktopUpdateMacDmg.js'

const sourceAppPath =
  process.env.EVENFIRE_DESKTOP_SOURCE_APP ?? process.env.EVENFIRE_DESKTOP_UNSIGNED_SOURCE_APP
const unsignedTargetAppPath = process.env.EVENFIRE_DESKTOP_UNSIGNED_SOURCE_APP
let temporaryRoot = ''

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = ''
})

function createUnsignedDmg(sourceApp: string, destination: string): void {
  const result = spawnSync(
    '/usr/bin/hdiutil',
    [
      'create',
      '-volname',
      'Evenfire',
      '-srcfolder',
      sourceApp,
      '-ov',
      '-format',
      'UDZO',
      destination,
    ],
    { encoding: 'utf8', timeout: 60_000 }
  )
  if (result.error || result.status !== 0) {
    throw new Error('Could not create the isolated unsigned macOS DMG fixture.')
  }
}

describe('macOS updater source and release DMG trust roles', () => {
  it.skipIf(!sourceAppPath || process.platform !== 'darwin')(
    'accepts the versioned app bundle as an installed source',
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

  it.skipIf(!unsignedTargetAppPath || process.platform !== 'darwin')(
    'rejects an unsigned locally built app when it is offered as a release DMG',
    async () => {
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-mac-dmg-trust-'))
      const manifest = readPackagedAppManifest(getAppArchivePath(unsignedTargetAppPath!, 'darwin'))
      const bundleRoot = path.join(temporaryRoot, 'bundle')
      const dmgPath = path.join(temporaryRoot, 'unsigned.dmg')
      const mountPath = path.join(temporaryRoot, 'mounted')
      await mkdir(bundleRoot)
      await cp(unsignedTargetAppPath!, path.join(bundleRoot, 'Evenfire.app'), { recursive: true })
      createUnsignedDmg(bundleRoot, dmgPath)

      await expect(
        verifyMacInstallerDmg({
          dmgPath,
          mountPath,
          version: manifest.version,
          architecture: 'arm64',
        })
      ).rejects.toThrow('target failed signature verification')
    }
  )
})
