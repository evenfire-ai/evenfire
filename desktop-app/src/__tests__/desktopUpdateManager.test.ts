import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDesktopReleasePolicy } from '../../../external-rest-api/src/desktopReleasePolicy.js'
import { releaseManifest } from '../../../external-rest-api/src/releaseManifest.js'
import type { AppService } from '../appService.js'
import { AppService as DesktopAppService } from '../appService.js'
import {
  type VerifiedDesktopPayload,
  getDesktopReleaseAssetName,
} from '../desktopUpdateArtifacts.js'
import type { DesktopInstallLocation, DesktopInstallPlan } from '../desktopUpdateInstaller.js'
import {
  DesktopUpdateManager,
  type DesktopUpdateManagerDependencies,
  type UpdateEvent,
} from '../desktopUpdateManager.js'

const { mockApp } = vi.hoisted(() => ({
  mockApp: {
    isPackaged: true,
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
    isReady: vi.fn(() => false),
    getPath: vi.fn(),
    getVersion: vi.fn(() => '0.11.0'),
    quit: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

const UPDATE_VERSION = '0.12.0'
const EXPECTED_DIGEST = 'a'.repeat(64)
const environment = { key: 'prod' }

function createReleasePolicy(version = UPDATE_VERSION) {
  return buildDesktopReleasePolicy(
    {
      ...releaseManifest,
      releaseId: `release-${version}`,
      desktopVersion: version,
      compatibleDesktopVersions: [version],
      minimumDesktopVersion: '0.8.0',
    },
    'https://github.com/evenfire-ai/evenfire/releases'
  )
}

function createPolicyBackedService(version = UPDATE_VERSION) {
  const getDesktopReleasePolicy = vi.fn().mockResolvedValue(createReleasePolicy(version))
  const service = new DesktopAppService() as unknown as {
    authClient: { getDesktopReleasePolicy: typeof getDesktopReleasePolicy }
    getDesktopReleaseStatus: AppService['getDesktopReleaseStatus']
  }
  service.authClient = { getDesktopReleasePolicy }
  return { service: service as unknown as AppService, getDesktopReleasePolicy }
}

function createDependencies(
  options: {
    updaterCapable?: boolean
    downloadAsset?: DesktopUpdateManagerDependencies['downloadAsset']
    preparePayload?: DesktopUpdateManagerDependencies['preparePayload']
    launchInstallHelper?: DesktopUpdateManagerDependencies['launchInstallHelper']
    bindingId?: () => string | null
  } = {}
): DesktopUpdateManagerDependencies {
  const appRoot = '/Applications/Evenfire.app'
  const location: DesktopInstallLocation = {
    platform: 'darwin',
    architecture: 'arm64',
    packageType: 'app-zip',
    installRoot: appRoot,
    appPath: appRoot,
    executablePath: `${appRoot}/Contents/MacOS/Evenfire`,
  }
  const resolveAsset: NonNullable<DesktopUpdateManagerDependencies['resolveAsset']> = vi.fn(
    async (version, platform, architecture) => ({
      name: getDesktopReleaseAssetName(version, platform, architecture),
      size: 8,
      digest: EXPECTED_DIGEST,
      browserDownloadUrl: `https://github.com/evenfire-ai/evenfire/releases/download/v${version}/${getDesktopReleaseAssetName(version, platform, architecture)}`,
    })
  )
  const downloadAsset: NonNullable<DesktopUpdateManagerDependencies['downloadAsset']> =
    options.downloadAsset ??
    vi.fn(async (_asset, destination, downloadOptions) => {
      await fs.writeFile(destination, 'zip-data')
      downloadOptions?.onProgress?.({ percent: 100, transferred: 8, total: 8 })
    })
  const preparePayload =
    options.preparePayload ??
    (vi.fn(async ({ destination, version, platform, architecture, packageType }) => {
      const appPath = path.join(destination, 'Evenfire.app')
      const packagePath = path.join(destination, 'application.zip')
      await fs.mkdir(appPath, { recursive: true })
      await fs.writeFile(packagePath, 'verified-payload')
      return {
        packageType,
        packagePath,
        appPath,
        appVersion: version,
        appId: 'ai.evenfire.desktop',
        architecture,
        updaterCapable: options.updaterCapable ?? false,
        assetName: getDesktopReleaseAssetName(version, platform, architecture),
        assetSha256: EXPECTED_DIGEST,
        assetSize: 8,
      } satisfies VerifiedDesktopPayload
    }) as NonNullable<DesktopUpdateManagerDependencies['preparePayload']>)
  const verifyApp: NonNullable<DesktopUpdateManagerDependencies['verifyApp']> = vi.fn(
    async (_appPath, version) => ({
      appVersion: version,
      appId: 'ai.evenfire.desktop',
      updaterCapable: version === UPDATE_VERSION ? (options.updaterCapable ?? false) : false,
    })
  )
  const detectInstall: NonNullable<DesktopUpdateManagerDependencies['detectInstall']> = vi.fn(
    async () => location
  )
  const hashFile: NonNullable<DesktopUpdateManagerDependencies['hashFile']> = vi.fn(
    async () => EXPECTED_DIGEST
  )
  const launchInstallHelper =
    options.launchInstallHelper ?? vi.fn(async (_plan: DesktopInstallPlan) => undefined)
  return {
    platform: 'darwin',
    architecture: 'arm64',
    executablePath: location.executablePath,
    getEnvironmentBindingId: options.bindingId ?? (() => environment.key),
    resolveAsset,
    downloadAsset,
    preparePayload,
    detectInstall,
    verifyApp,
    hashFile,
    launchInstallHelper,
  }
}

describe('DesktopUpdateManager', () => {
  let userDataPath: string
  let service: AppService
  let getDesktopReleasePolicy: ReturnType<typeof vi.fn>
  let manager: DesktopUpdateManager
  let events: UpdateEvent[]
  let dependencies: DesktopUpdateManagerDependencies

  beforeEach(async () => {
    vi.clearAllMocks()
    mockApp.whenReady.mockImplementation(() => new Promise<void>(() => undefined))
    userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-desktop-update-'))
    environment.key = 'prod'
    mockApp.isPackaged = true
    mockApp.getVersion.mockReturnValue('0.11.0')
    mockApp.getPath.mockReturnValue(userDataPath)
    events = []
    const created = createPolicyBackedService()
    service = created.service
    getDesktopReleasePolicy = created.getDesktopReleasePolicy
    dependencies = createDependencies()
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
  })

  afterEach(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true })
  })

  it('downloads the exact backend-recommended release ZIP and stages it for a deferred restart', async () => {
    await expect(manager.downloadDesktopUpdate(UPDATE_VERSION)).resolves.toEqual({
      downloaded: true,
      version: UPDATE_VERSION,
      updaterCapable: false,
    })

    expect(dependencies.resolveAsset).toHaveBeenCalledWith(
      UPDATE_VERSION,
      'darwin',
      'arm64',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(dependencies.downloadAsset).toHaveBeenCalledOnce()
    expect(events).toContainEqual({
      type: 'downloaded',
      version: UPDATE_VERSION,
      updaterCapable: false,
    })
    const pending = await manager.getPendingDesktopUpdate()
    expect(pending).toEqual({ version: UPDATE_VERSION, updaterCapable: false })
  })

  it('does not persist the backend release identity in the operation journal', async () => {
    await manager.downloadDesktopUpdate(UPDATE_VERSION)

    const stageRoot = path.join(userDataPath, 'desktop-update-staging')
    const operationId = (await fs.readdir(stageRoot)).find(name => name !== 'pending.json')!
    const operation = JSON.parse(
      await fs.readFile(path.join(stageRoot, operationId, 'operation.json'), 'utf8')
    ) as Record<string, unknown>

    expect(operation.releaseId).toBeUndefined()
    expect(operation.releaseIdentitySha256).toBeUndefined()
    expect(JSON.stringify(operation)).not.toContain('release-0.12.0')
  })

  it('keeps a staged target when release metadata changes but remains recommended', async () => {
    await manager.downloadDesktopUpdate(UPDATE_VERSION)
    getDesktopReleasePolicy.mockResolvedValue({
      ...createReleasePolicy(),
      releaseId: 'new-release-metadata',
    })

    await expect(manager.getPendingDesktopUpdate()).resolves.toEqual({
      version: UPDATE_VERSION,
      updaterCapable: false,
    })
  })

  it('rejects stale backend recommendations before resolving an artifact', async () => {
    await expect(manager.downloadDesktopUpdate('0.11.0')).rejects.toThrow(
      'no longer recommends this Desktop update'
    )
    expect(dependencies.resolveAsset).not.toHaveBeenCalled()
    expect(dependencies.downloadAsset).not.toHaveBeenCalled()
  })

  it('does not stage an update when no stable backend profile is selected', async () => {
    dependencies = createDependencies({ bindingId: () => null })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)

    await expect(manager.downloadDesktopUpdate(UPDATE_VERSION)).rejects.toThrow(
      'Select a saved backend profile'
    )
    expect(dependencies.resolveAsset).not.toHaveBeenCalled()
    expect(dependencies.downloadAsset).not.toHaveBeenCalled()
  })

  it('coalesces same-version downloads and rejects a different version in flight', async () => {
    let finishDownload!: () => void
    const blockedDownload: NonNullable<DesktopUpdateManagerDependencies['downloadAsset']> = vi.fn(
      async (_asset, destination) => {
        await new Promise<void>(resolve => {
          finishDownload = resolve
        })
        await fs.writeFile(destination, 'zip-data')
      }
    )
    dependencies = createDependencies({ downloadAsset: blockedDownload })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)

    const first = manager.downloadDesktopUpdate(UPDATE_VERSION)
    await vi.waitFor(() => expect(blockedDownload).toHaveBeenCalledOnce())
    const second = manager.downloadDesktopUpdate(UPDATE_VERSION)
    await expect(manager.downloadDesktopUpdate('0.13.0')).rejects.toThrow(
      'A different Desktop update is already being downloaded'
    )
    finishDownload()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { downloaded: true, version: UPDATE_VERSION, updaterCapable: false },
      { downloaded: true, version: UPDATE_VERSION, updaterCapable: false },
    ])
    expect(blockedDownload).toHaveBeenCalledOnce()
  })

  it('permanently removes staging after a failed download and permits a retry', async () => {
    const failingDownload: NonNullable<DesktopUpdateManagerDependencies['downloadAsset']> = vi
      .fn()
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockImplementation(async (_asset, destination) => {
        await fs.writeFile(destination, 'zip-data')
      })
    dependencies = createDependencies({ downloadAsset: failingDownload })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)

    await expect(manager.downloadDesktopUpdate(UPDATE_VERSION)).rejects.toThrow(
      'network unavailable'
    )
    const stageRoot = path.join(userDataPath, 'desktop-update-staging')
    await expect(fs.readdir(stageRoot)).resolves.toEqual([])
    await expect(manager.downloadDesktopUpdate(UPDATE_VERSION)).resolves.toMatchObject({
      downloaded: true,
    })
    expect(failingDownload).toHaveBeenCalledTimes(2)
  })

  it('permanently removes staging when archive extraction or app verification fails', async () => {
    const rejectedPayload: NonNullable<DesktopUpdateManagerDependencies['preparePayload']> = vi
      .fn()
      .mockRejectedValue(new Error('The downloaded Desktop app has an unexpected version.'))
    dependencies = createDependencies({ preparePayload: rejectedPayload })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)

    await expect(manager.downloadDesktopUpdate(UPDATE_VERSION)).rejects.toThrow(
      'unexpected version'
    )
    expect(rejectedPayload).toHaveBeenCalledOnce()
    await expect(fs.readdir(path.join(userDataPath, 'desktop-update-staging'))).resolves.toEqual([])
  })

  it('aborts an active transfer and permanently removes the staged download', async () => {
    const blockedDownload: NonNullable<DesktopUpdateManagerDependencies['downloadAsset']> = vi.fn(
      async (_asset, destination, options) => {
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        })
        await fs.writeFile(destination, 'unreachable')
      }
    )
    dependencies = createDependencies({ downloadAsset: blockedDownload })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    const pending = manager.downloadDesktopUpdate(UPDATE_VERSION)
    await vi.waitFor(() => expect(blockedDownload).toHaveBeenCalledOnce())

    await manager.cancelDesktopUpdate()
    await expect(pending).rejects.toThrow('canceled')
    await expect(fs.readdir(path.join(userDataPath, 'desktop-update-staging'))).resolves.toEqual([])
  })

  it('invalidates the staged artifact when the backend environment changes during download', async () => {
    let finishDownload!: () => void
    const blockedDownload: NonNullable<DesktopUpdateManagerDependencies['downloadAsset']> = vi.fn(
      async (_asset, destination) => {
        await new Promise<void>(resolve => {
          finishDownload = resolve
        })
        await fs.writeFile(destination, 'zip-data')
      }
    )
    dependencies = createDependencies({ downloadAsset: blockedDownload })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    const pending = manager.downloadDesktopUpdate(UPDATE_VERSION)
    await vi.waitFor(() => expect(blockedDownload).toHaveBeenCalledOnce())
    environment.key = 'dev'
    finishDownload()

    await expect(pending).rejects.toThrow('backend changed during the update')
    await expect(fs.readdir(path.join(userDataPath, 'desktop-update-staging'))).resolves.toEqual([])
  })

  it('rechecks the backend before install and leaves deferred staging intact when policy changes', async () => {
    await manager.downloadDesktopUpdate(UPDATE_VERSION)
    getDesktopReleasePolicy.mockResolvedValue(createReleasePolicy('0.13.0'))

    await expect(manager.installDownloadedUpdate(UPDATE_VERSION)).rejects.toThrow(
      'no longer recommends this Desktop update'
    )
    expect(dependencies.launchInstallHelper).not.toHaveBeenCalled()
  })

  it('rejects a staged update after switching the selected backend', async () => {
    await manager.downloadDesktopUpdate(UPDATE_VERSION)
    environment.key = 'dev'

    await expect(manager.installDownloadedUpdate(UPDATE_VERSION)).rejects.toThrow(
      'selected backend changed'
    )
    expect(dependencies.launchInstallHelper).not.toHaveBeenCalled()
  })

  it('recovers a pending install after startup when the old app is still intact', async () => {
    await manager.downloadDesktopUpdate(UPDATE_VERSION)
    const stageRoot = path.join(userDataPath, 'desktop-update-staging')
    const operationId = (await fs.readdir(stageRoot)).find(name => name !== 'pending.json')!
    const operationPath = path.join(stageRoot, operationId)
    const operation = JSON.parse(
      await fs.readFile(path.join(operationPath, 'operation.json'), 'utf8')
    ) as { state: string }
    await fs.writeFile(
      path.join(operationPath, 'operation.json'),
      JSON.stringify({ ...operation, state: 'installing' })
    )

    mockApp.whenReady.mockResolvedValue()
    const restartedManager = new DesktopUpdateManager(
      service,
      event => events.push(event),
      dependencies
    )
    await vi.waitFor(async () => {
      await expect(restartedManager.getPendingDesktopUpdate()).resolves.toEqual({
        version: UPDATE_VERSION,
        updaterCapable: false,
      })
    })
  })

  it('finalizes an interrupted successful install before deleting its staged rollback copy', async () => {
    const installRoot = path.join(userDataPath, 'install', 'Evenfire.app')
    const location: DesktopInstallLocation = {
      platform: 'darwin',
      architecture: 'arm64',
      packageType: 'app-zip',
      installRoot,
      appPath: installRoot,
      executablePath: path.join(installRoot, 'Contents/MacOS/Evenfire'),
    }
    dependencies = createDependencies({ updaterCapable: true })
    dependencies.detectInstall = vi.fn(async () => location)
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await manager.downloadDesktopUpdate(UPDATE_VERSION)

    const stageRoot = path.join(userDataPath, 'desktop-update-staging')
    const operationId = (await fs.readdir(stageRoot)).find(name => name !== 'pending.json')!
    const operationPath = path.join(stageRoot, operationId)
    const operation = JSON.parse(
      await fs.readFile(path.join(operationPath, 'operation.json'), 'utf8')
    ) as { state: string }
    await fs.writeFile(
      path.join(operationPath, 'operation.json'),
      JSON.stringify({ ...operation, state: 'installing' })
    )
    const rollbackRoot = `${installRoot}.evenfire-rollback-${operationId}`
    await fs.mkdir(rollbackRoot, { recursive: true })
    await fs.writeFile(path.join(userDataPath, 'user-data-sentinel.txt'), 'preserve me')

    mockApp.getVersion.mockReturnValue(UPDATE_VERSION)
    mockApp.whenReady.mockResolvedValue()
    const originalArgv = process.argv
    process.argv = [...originalArgv, `--evenfire-update-operation=${operationId}`]
    try {
      new DesktopUpdateManager(service, event => events.push(event), dependencies)

      await vi.waitFor(async () => {
        await expect(fs.readdir(stageRoot)).resolves.toEqual([])
        await expect(fs.stat(rollbackRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      })
    } finally {
      process.argv = originalArgv
    }
    await expect(
      fs.readFile(path.join(userDataPath, 'user-data-sentinel.txt'), 'utf8')
    ).resolves.toBe('preserve me')
  })

  it('deletes an interrupted download on the next safe startup', async () => {
    await manager.downloadDesktopUpdate(UPDATE_VERSION)
    const stageRoot = path.join(userDataPath, 'desktop-update-staging')
    const operationId = (await fs.readdir(stageRoot)).find(name => name !== 'pending.json')!
    const operationPath = path.join(stageRoot, operationId)
    const operation = JSON.parse(
      await fs.readFile(path.join(operationPath, 'operation.json'), 'utf8')
    ) as { state: string }
    await fs.writeFile(
      path.join(operationPath, 'operation.json'),
      JSON.stringify({ ...operation, state: 'downloading' })
    )

    mockApp.whenReady.mockResolvedValue()
    new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await vi.waitFor(async () => {
      await expect(fs.readdir(stageRoot)).resolves.toEqual([])
    })
  })

  it('finishes deleting a recorded staging operation interrupted during cleanup', async () => {
    const stageRoot = path.join(userDataPath, 'desktop-update-staging')
    const operationId = '39e7fa87-d6a3-45d6-bd9d-47ecfdc1fd4b'
    const operationPath = path.join(stageRoot, operationId)
    await fs.mkdir(operationPath, { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(operationPath, 'partial-payload.zip'), 'temporary')
    await fs.writeFile(path.join(stageRoot, 'pending.json'), JSON.stringify({ operationId }))
    await fs.writeFile(
      path.join(stageRoot, 'cleanup.json'),
      JSON.stringify({ id: operationId, state: 'safe-to-delete' })
    )

    mockApp.whenReady.mockResolvedValue()
    new DesktopUpdateManager(service, event => events.push(event), dependencies)

    await vi.waitFor(async () => {
      await expect(fs.readdir(stageRoot)).resolves.toEqual([])
    })
  })

  it('keeps the app running and requires a fresh Mac attempt after authorization is refused', async () => {
    const launchInstallHelper = vi
      .fn()
      .mockRejectedValueOnce(new Error('authorization was canceled'))
      .mockResolvedValue(undefined)
    dependencies = createDependencies({ launchInstallHelper })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await manager.downloadDesktopUpdate(UPDATE_VERSION)

    await expect(manager.installDownloadedUpdate(UPDATE_VERSION)).rejects.toThrow(
      'authorization was canceled'
    )
    expect(mockApp.quit).not.toHaveBeenCalled()
    await expect(manager.getPendingDesktopUpdate()).resolves.toBeNull()
    await expect(manager.installDownloadedUpdate(UPDATE_VERSION)).rejects.toThrow('not staged')
    await manager.downloadDesktopUpdate(UPDATE_VERSION)
    await expect(manager.installDownloadedUpdate(UPDATE_VERSION)).resolves.toEqual({
      installed: true,
    })
    expect(launchInstallHelper).toHaveBeenCalledTimes(2)
  })

  it('never advertises a canceled Mac attempt when interrupted cleanup leaves its journal', async () => {
    dependencies = createDependencies({
      launchInstallHelper: vi.fn().mockRejectedValue(new Error('authorization failed')),
    })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await manager.downloadDesktopUpdate(UPDATE_VERSION)
    vi.spyOn(
      manager as unknown as { discardOperation: () => Promise<void> },
      'discardOperation'
    ).mockRejectedValueOnce(new Error('cleanup interrupted'))
    await expect(manager.installDownloadedUpdate(UPDATE_VERSION)).rejects.toThrow(
      'cleanup interrupted'
    )
    await expect(manager.getPendingDesktopUpdate()).resolves.toBeNull()
    await expect(manager.installDownloadedUpdate(UPDATE_VERSION)).rejects.toThrow('not staged')
    expect(mockApp.quit).not.toHaveBeenCalled()
  })

  it('cancels the helper handoff if the backend recommendation changes during authorization', async () => {
    const launchInstallHelper = vi.fn(async () => {
      getDesktopReleasePolicy.mockResolvedValue(createReleasePolicy('0.13.0'))
    })
    dependencies = createDependencies({ launchInstallHelper })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await manager.downloadDesktopUpdate(UPDATE_VERSION)

    await expect(manager.installDownloadedUpdate(UPDATE_VERSION)).rejects.toThrow(
      'no longer recommends this Desktop update'
    )
    expect(mockApp.quit).not.toHaveBeenCalled()
    await expect(manager.getPendingDesktopUpdate()).resolves.toBeNull()
    await expect(fs.readdir(path.join(userDataPath, 'desktop-update-staging'))).resolves.toEqual([])
  })

  it('coalesces installs and restarts only after an explicit install request', async () => {
    let resolveStatus!: (policy: ReturnType<typeof createReleasePolicy>) => void
    // Stage first; the download is a manual check and must not start installation.
    const policyService = createPolicyBackedService()
    service = policyService.service
    getDesktopReleasePolicy = policyService.getDesktopReleasePolicy
    dependencies = createDependencies({ updaterCapable: true })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await manager.downloadDesktopUpdate(UPDATE_VERSION)
    expect(dependencies.launchInstallHelper).not.toHaveBeenCalled()

    getDesktopReleasePolicy.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveStatus = resolve
        })
    )
    const first = manager.installDownloadedUpdate(UPDATE_VERSION)
    await vi.waitFor(() => expect(getDesktopReleasePolicy).toHaveBeenCalledTimes(3))
    const duplicate = manager.installDownloadedUpdate(UPDATE_VERSION)
    await expect(manager.installDownloadedUpdate('0.13.0')).rejects.toThrow(
      'A different Desktop update is already being installed'
    )
    resolveStatus(createReleasePolicy())
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { installed: true },
      { installed: true },
    ])
    expect(dependencies.launchInstallHelper).toHaveBeenCalledOnce()
    expect(mockApp.quit).toHaveBeenCalledOnce()
  })

  it('installs immediately only for an explicitly requested startup flow', async () => {
    dependencies = createDependencies({ updaterCapable: true })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)

    await expect(manager.downloadDesktopUpdate(UPDATE_VERSION, true)).resolves.toMatchObject({
      downloaded: true,
      updaterCapable: true,
    })
    expect(dependencies.launchInstallHelper).toHaveBeenCalledOnce()
    expect(mockApp.quit).toHaveBeenCalledOnce()
  })

  it('rejects legacy installed versions below the supported updater floor', async () => {
    mockApp.getVersion.mockReturnValue('0.7.9')
    await expect(manager.downloadDesktopUpdate(UPDATE_VERSION)).rejects.toThrow(
      'installed versions from 0.8.0'
    )
    expect(dependencies.resolveAsset).not.toHaveBeenCalled()
  })
})
