import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppService } from '../appService.js'
import { getDesktopReleaseAssetName } from '../desktopUpdateArtifacts.js'
import { DesktopUpdateManager } from '../desktopUpdateManager.js'

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

vi.mock('electron', () => ({
  app: {
    whenReady: () => new Promise<void>(() => undefined),
    isReady: () => false,
    getPath: () => '/tmp/evenfire-update-file-race',
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

type ManagerReaders = {
  readPendingPointer(stageRoot: string): Promise<{ operationId: string } | null>
  readOperation(
    operationPath: string,
    operationId: string
  ): Promise<{ environmentBindingId?: string } | null>
  readMarker(filePath: string): Promise<Record<string, unknown> | null>
  readHelperPid(operationPath: string): Promise<number | null>
  writePendingPointer(stageRoot: string, pointer: { operationId: string }): Promise<void>
  writeOperation(filePath: string, value: typeof operation): Promise<void>
  writeJsonFile(filePath: string, value: unknown): Promise<void>
}

const operationId = '123e4567-e89b-42d3-a456-426614174000'
const operation = {
  id: operationId,
  state: 'downloaded',
  version: '0.12.0',
  currentVersion: '0.11.0',
  environmentBindingId: 'production',
  environmentKey: 'legacy-production',
  releaseId: 'release-0.12.0',
  platform: 'linux',
  architecture: 'x64',
  packageType: 'app-zip',
  assetName: getDesktopReleaseAssetName('0.12.0', 'linux', 'x64'),
  assetSha256: 'a'.repeat(64),
  assetSize: 10,
  packagePath: 'payload/application.zip',
  packageSha256: 'b'.repeat(64),
  appPath: 'payload/application/Evenfire.app',
  appVersion: '0.12.0',
  appId: 'ai.evenfire.desktop',
  updaterCapable: true,
  currentAsarSha256: 'c'.repeat(64),
}

describe('Desktop updater metadata file race protection', () => {
  let temporaryRoot = ''

  afterEach(async () => {
    race.path = null
    race.target = null
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = ''
  })

  it.each(['pending pointer', 'operation journal', 'marker', 'helper pid'] as const)(
    'reads the opened updater-owned file if its path is swapped to a symlink during the read (%s)',
    async fileKind => {
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'evenfire-update-file-race-'))
      const stageRoot = path.join(temporaryRoot, 'desktop-update-staging')
      const operationPath = path.join(stageRoot, operationId)
      await mkdir(operationPath, { recursive: true, mode: 0o700 })

      const manager = new DesktopUpdateManager({} as AppService, vi.fn())
      const readers = manager as unknown as ManagerReaders
      let filePath = ''
      let expected: unknown
      let outsideValue: unknown
      const outsideRoot = path.join(temporaryRoot, 'outside')
      await mkdir(outsideRoot, { mode: 0o700 })

      if (fileKind === 'pending pointer') {
        filePath = path.join(stageRoot, 'pending.json')
        expected = { operationId }
        outsideValue = { operationId: '987e6543-e21b-43d3-b654-123456789abc' }
        await readers.writePendingPointer(stageRoot, expected as { operationId: string })
        await readers.writePendingPointer(outsideRoot, outsideValue as { operationId: string })
      } else if (fileKind === 'operation journal') {
        filePath = path.join(operationPath, 'operation.json')
        expected = operation
        outsideValue = {
          ...operation,
          environmentBindingId: 'different-profile',
        }
        await readers.writeOperation(filePath, operation)
        await readers.writeOperation(
          path.join(outsideRoot, 'operation.json'),
          outsideValue as typeof operation
        )
      } else if (fileKind === 'marker') {
        filePath = path.join(operationPath, 'cleanup-safe.json')
        expected = { id: operationId, state: 'installed' }
        outsideValue = { id: 'untrusted-operation', state: 'safe-to-delete' }
        await readers.writeJsonFile(filePath, expected)
        await readers.writeJsonFile(path.join(outsideRoot, 'cleanup-safe.json'), outsideValue)
      } else {
        filePath = path.join(operationPath, 'helper.pid')
        expected = 12345
        outsideValue = 54321
        await writeFile(filePath, String(expected), { mode: 0o600 })
        await writeFile(path.join(outsideRoot, 'helper.pid'), String(outsideValue), { mode: 0o600 })
      }

      const outsidePath =
        fileKind === 'pending pointer'
          ? path.join(outsideRoot, 'pending.json')
          : fileKind === 'operation journal'
            ? path.join(outsideRoot, 'operation.json')
            : fileKind === 'marker'
              ? path.join(outsideRoot, 'cleanup-safe.json')
              : path.join(outsideRoot, 'helper.pid')
      race.path = filePath
      race.target = outsidePath

      let actual: unknown
      if (fileKind === 'pending pointer') {
        actual = await readers.readPendingPointer(stageRoot)
      } else if (fileKind === 'operation journal') {
        actual = await readers.readOperation(operationPath, operationId)
      } else if (fileKind === 'marker') {
        actual = await readers.readMarker(filePath)
      } else {
        actual = await readers.readHelperPid(operationPath)
      }

      expect(actual).toEqual(expected)
    }
  )
})
