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
    platform?: 'darwin' | 'win32' | 'linux'
    architecture?: 'x64' | 'arm64'
    updaterCapable?: boolean
    downloadAsset?: DesktopUpdateManagerDependencies['downloadAsset']
    preparePayload?: DesktopUpdateManagerDependencies['preparePayload']
    launchInstallHelper?: DesktopUpdateManagerDependencies['launchInstallHelper']
    extractMacDmg?: DesktopUpdateManagerDependencies['extractMacDmg']
    verifyMacDmg?: DesktopUpdateManagerDependencies['verifyMacDmg']
    saveMacInstaller?: DesktopUpdateManagerDependencies['saveMacInstaller']
    promoteMacInstaller?: DesktopUpdateManagerDependencies['promoteMacInstaller']
    discardMacInstaller?: DesktopUpdateManagerDependencies['discardMacInstaller']
    openMacInstaller?: DesktopUpdateManagerDependencies['openMacInstaller']
    hashFile?: DesktopUpdateManagerDependencies['hashFile']
    bindingId?: () => string | null
  } = {}
): DesktopUpdateManagerDependencies {
  const platform = options.platform ?? 'linux'
  const architecture = options.architecture ?? 'x64'
  const appRoot =
    platform === 'darwin'
      ? '/Applications/Evenfire.app'
      : platform === 'win32'
        ? 'C:/Users/alice/AppData/Local/Programs/Evenfire/app-0.11.0'
        : '/opt/evenfire/Evenfire-linux-x64'
  const location: DesktopInstallLocation = {
    platform,
    architecture,
    packageType: platform === 'win32' ? 'squirrel' : 'app-zip',
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
  const hashFile: NonNullable<DesktopUpdateManagerDependencies['hashFile']> =
    options.hashFile ?? vi.fn(async () => EXPECTED_DIGEST)
  const launchInstallHelper =
    options.launchInstallHelper ?? vi.fn(async (_plan: DesktopInstallPlan) => undefined)
  const extractMacDmg =
    options.extractMacDmg ??
    vi.fn(async ({ destination }) => {
      await fs.writeFile(destination, 'published-dmg')
    })
  const verifyMacDmg = options.verifyMacDmg ?? vi.fn(async () => undefined)
  const saveMacInstaller =
    options.saveMacInstaller ??
    vi.fn(
      async ({
        version,
        cacheDirectory,
        operationId,
        architecture,
        environmentBindingId,
      }: {
        sourcePath: string
        cacheDirectory: string
        operationId: string
        version: string
        architecture: 'x64' | 'arm64'
        environmentBindingId: string
      }) => {
        await fs.mkdir(cacheDirectory, { recursive: true, mode: 0o700 })
        const resolvedCacheDirectory = await fs.realpath(cacheDirectory)
        const filePath = path.join(resolvedCacheDirectory, `Evenfire-v${version}.dmg`)
        await fs.writeFile(filePath, 'published-dmg')
        return { filePath, sha256: EXPECTED_DIGEST }
      }
    )
  const promoteMacInstaller =
    options.promoteMacInstaller ??
    vi.fn(async ({ cacheDirectory, expected }) => {
      await fs.writeFile(
        path.join(cacheDirectory, 'current.json'),
        JSON.stringify({ ...expected, retiredInstallers: [] })
      )
    })
  return {
    platform,
    architecture,
    executablePath: location.executablePath,
    getEnvironmentBindingId: options.bindingId ?? (() => environment.key),
    resolveAsset,
    downloadAsset,
    preparePayload,
    detectInstall,
    verifyApp,
    hashFile,
    launchInstallHelper,
    extractMacDmg,
    verifyMacDmg,
    saveMacInstaller,
    promoteMacInstaller,
    discardMacInstaller:
      options.discardMacInstaller ??
      vi.fn(async ({ cacheDirectory, expected }) => {
        await fs.rm(path.join(cacheDirectory, expected.fileName), { force: true })
      }),
    openMacInstaller: options.openMacInstaller ?? vi.fn(async () => ''),
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
    mockApp.getPath.mockImplementation(() => userDataPath)
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
      manualInstall: false,
    })

    expect(dependencies.resolveAsset).toHaveBeenCalledWith(
      UPDATE_VERSION,
      'linux',
      'x64',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(dependencies.downloadAsset).toHaveBeenCalledOnce()
    expect(events).toContainEqual({
      type: 'downloaded',
      version: UPDATE_VERSION,
      updaterCapable: false,
      manualInstall: false,
    })
    const pending = await manager.getPendingDesktopUpdate()
    expect(pending).toEqual({
      version: UPDATE_VERSION,
      updaterCapable: false,
      manualInstall: false,
    })
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
      manualInstall: false,
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
      { downloaded: true, version: UPDATE_VERSION, updaterCapable: false, manualInstall: false },
      { downloaded: true, version: UPDATE_VERSION, updaterCapable: false, manualInstall: false },
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

  it('cleans macOS staging after DMG extraction fails', async () => {
    dependencies = createDependencies({
      platform: 'darwin',
      architecture: 'arm64',
      extractMacDmg: vi.fn().mockRejectedValue(new Error('the release ZIP has no safe DMG entry')),
    })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)

    await expect(manager.downloadDesktopUpdate(UPDATE_VERSION)).rejects.toThrow('no safe DMG entry')
    await expect(fs.readdir(path.join(userDataPath, 'desktop-update-staging'))).resolves.toEqual([])
    await expect(fs.readdir(path.join(userDataPath, 'update-installers'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('promotes the verified macOS candidate only after policy and pending journal checks', async () => {
    const promoteMacInstaller: NonNullable<
      DesktopUpdateManagerDependencies['promoteMacInstaller']
    > = vi.fn(async ({ cacheDirectory, expected }) => {
      const stageRoot = path.join(userDataPath, 'desktop-update-staging')
      const pointer = JSON.parse(
        await fs.readFile(path.join(stageRoot, 'pending.json'), 'utf8')
      ) as { operationId: string }
      const operation = JSON.parse(
        await fs.readFile(path.join(stageRoot, pointer.operationId, 'operation.json'), 'utf8')
      ) as { state: string; manualInstallerPath?: string }
      expect(operation.state).toBe('downloaded')
      expect(operation.manualInstallerPath).toContain('update-installers')
      await fs.writeFile(
        path.join(cacheDirectory, 'current.json'),
        JSON.stringify({ ...expected, retiredInstallers: [] })
      )
    })
    dependencies = createDependencies({
      platform: 'darwin',
      architecture: 'arm64',
      promoteMacInstaller,
    })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)

    await expect(manager.downloadDesktopUpdate(UPDATE_VERSION)).resolves.toMatchObject({
      manualInstall: true,
    })

    expect(getDesktopReleasePolicy).toHaveBeenCalledTimes(2)
    expect(promoteMacInstaller).toHaveBeenCalledOnce()
    expect(events.at(-1)).toMatchObject({ type: 'downloaded', manualInstall: true })
  })

  it('invalidates a prepared macOS installer when the backend changes before handoff', async () => {
    let finishExtraction!: () => void
    const extractMacDmg: NonNullable<DesktopUpdateManagerDependencies['extractMacDmg']> = vi.fn(
      async ({ destination }) => {
        await new Promise<void>(resolve => {
          finishExtraction = resolve
        })
        await fs.writeFile(destination, 'published-dmg')
      }
    )
    dependencies = createDependencies({ platform: 'darwin', architecture: 'arm64', extractMacDmg })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    const pending = manager.downloadDesktopUpdate(UPDATE_VERSION)
    await vi.waitFor(() => expect(extractMacDmg).toHaveBeenCalledOnce())
    environment.key = 'dev'
    finishExtraction()

    await expect(pending).rejects.toThrow('backend changed during the update')
    await expect(fs.readdir(path.join(userDataPath, 'desktop-update-staging'))).resolves.toEqual([])
    await expect(fs.readdir(path.join(userDataPath, 'update-installers'))).resolves.toEqual([])
    expect(dependencies.promoteMacInstaller).not.toHaveBeenCalled()
    environment.key = 'prod'
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
        manualInstall: false,
      })
    })
  })

  it('finalizes an interrupted successful install before deleting its staged rollback copy', async () => {
    const installRoot = path.join(userDataPath, 'install', 'Evenfire.app')
    const location: DesktopInstallLocation = {
      platform: 'linux',
      architecture: 'x64',
      packageType: 'app-zip',
      installRoot,
      appPath: installRoot,
      executablePath: path.join(installRoot, 'Evenfire'),
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

  it('opens the exact saved DMG before quitting and preserves the installer', async () => {
    const openMacInstaller = vi.fn(async (_filePath: string) => '')
    dependencies = createDependencies({
      platform: 'darwin',
      architecture: 'arm64',
      openMacInstaller,
    })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await expect(manager.downloadDesktopUpdate(UPDATE_VERSION, true)).resolves.toMatchObject({
      manualInstall: true,
    })
    expect(events).toContainEqual({ type: 'preparing', version: UPDATE_VERSION })
    expect(await fs.readdir(path.join(userDataPath, 'update-installers'))).toEqual(
      expect.arrayContaining(['Evenfire-v0.12.0.dmg', 'current.json'])
    )
    const stageRoot = path.join(userDataPath, 'desktop-update-staging')
    const operationId = (await fs.readdir(stageRoot)).find(name => name !== 'pending.json')!
    const operation = JSON.parse(
      await fs.readFile(path.join(stageRoot, operationId, 'operation.json'), 'utf8')
    ) as { manualInstallerPath: string; manualInstallerSha256: string }
    expect(operation.manualInstallerPath).toBe(
      path.join(
        await fs.realpath(path.join(userDataPath, 'update-installers')),
        'Evenfire-v0.12.0.dmg'
      )
    )
    expect(operation.manualInstallerSha256).toBe(EXPECTED_DIGEST)
    await expect(manager.getPendingDesktopUpdate()).resolves.toMatchObject({ manualInstall: true })

    await expect(manager.openDownloadedMacInstaller(UPDATE_VERSION)).resolves.toEqual({
      opened: true,
    })
    await expect(manager.openDownloadedMacInstaller(UPDATE_VERSION)).resolves.toEqual({
      opened: true,
    })
    expect(openMacInstaller).toHaveBeenCalledOnce()
    expect(mockApp.quit).toHaveBeenCalledOnce()
    expect(openMacInstaller).toHaveBeenCalledWith(
      path.join(
        await fs.realpath(path.join(userDataPath, 'update-installers')),
        'Evenfire-v0.12.0.dmg'
      )
    )
    expect(dependencies.launchInstallHelper).not.toHaveBeenCalled()
    expect(mockApp.quit).toHaveBeenCalledOnce()
    await expect(
      fs.readFile(path.join(userDataPath, 'update-installers', 'Evenfire-v0.12.0.dmg'), 'utf8')
    ).resolves.toBe('published-dmg')
  })

  it('keeps Evenfire running with an actionable error when macOS cannot open the DMG', async () => {
    const openMacInstaller = vi.fn(async (_filePath: string) => 'Launch Services refused')
    dependencies = createDependencies({
      platform: 'darwin',
      architecture: 'arm64',
      openMacInstaller,
    })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await manager.downloadDesktopUpdate(UPDATE_VERSION)

    await expect(manager.openDownloadedMacInstaller(UPDATE_VERSION)).rejects.toThrow(
      'verified installer remains in Evenfire’s update cache'
    )
    expect(mockApp.quit).not.toHaveBeenCalled()
    await expect(
      fs.readFile(path.join(userDataPath, 'update-installers', 'Evenfire-v0.12.0.dmg'), 'utf8')
    ).resolves.toBe('published-dmg')
  })

  it('rejects pending installer reuse when the current architecture differs', async () => {
    dependencies = createDependencies({ platform: 'darwin', architecture: 'x64' })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await manager.downloadDesktopUpdate(UPDATE_VERSION)

    dependencies = createDependencies({ platform: 'darwin', architecture: 'arm64' })
    const restartedManager = new DesktopUpdateManager(
      service,
      event => events.push(event),
      dependencies
    )

    await expect(restartedManager.getPendingDesktopUpdate()).resolves.toBeNull()
    await expect(
      fs.readFile(path.join(userDataPath, 'update-installers', 'Evenfire-v0.12.0.dmg'), 'utf8')
    ).resolves.toBe('published-dmg')
  })

  it('rechecks architecture at the final macOS open authorization', async () => {
    const openMacInstaller = vi.fn(async () => '')
    dependencies = createDependencies({ platform: 'darwin', architecture: 'x64' })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await manager.downloadDesktopUpdate(UPDATE_VERSION)

    dependencies = createDependencies({
      platform: 'darwin',
      architecture: 'arm64',
      openMacInstaller,
    })
    const restartedManager = new DesktopUpdateManager(
      service,
      event => events.push(event),
      dependencies
    )

    await expect(restartedManager.openDownloadedMacInstaller(UPDATE_VERSION)).rejects.toThrow(
      'selected backend or installed build changed'
    )
    expect(openMacInstaller).not.toHaveBeenCalled()
    expect(mockApp.quit).not.toHaveBeenCalled()
    await expect(
      fs.readFile(path.join(userDataPath, 'update-installers', 'Evenfire-v0.12.0.dmg'), 'utf8')
    ).resolves.toBe('published-dmg')
  })

  it('refuses to open a saved DMG after the installed app reaches its target version', async () => {
    const openMacInstaller = vi.fn(async (_filePath: string) => '')
    const currentStatus = await service.getDesktopReleaseStatus()
    vi.spyOn(service, 'getDesktopReleaseStatus').mockResolvedValue(currentStatus)
    dependencies = createDependencies({
      platform: 'darwin',
      architecture: 'arm64',
      openMacInstaller,
    })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await manager.downloadDesktopUpdate(UPDATE_VERSION)
    mockApp.getVersion.mockReturnValue(UPDATE_VERSION)

    await expect(manager.openDownloadedMacInstaller(UPDATE_VERSION)).rejects.toThrow(
      'selected backend or installed build changed'
    )
    expect(openMacInstaller).not.toHaveBeenCalled()
    expect(mockApp.quit).not.toHaveBeenCalled()
    await expect(
      fs.readFile(path.join(userDataPath, 'update-installers', 'Evenfire-v0.12.0.dmg'), 'utf8')
    ).resolves.toBe('published-dmg')
  })

  it('does not present a pending DMG after the installed app version changes', async () => {
    dependencies = createDependencies({ platform: 'darwin', architecture: 'arm64' })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await manager.downloadDesktopUpdate(UPDATE_VERSION)
    mockApp.getVersion.mockReturnValue('0.11.1')

    await expect(manager.getPendingDesktopUpdate()).resolves.toBeNull()
    await expect(manager.getPendingDesktopUpdate()).resolves.toBeNull()
    await expect(
      fs.readFile(path.join(userDataPath, 'update-installers', 'Evenfire-v0.12.0.dmg'), 'utf8')
    ).resolves.toBe('published-dmg')
  })

  it('invalidates a saved DMG when the backend changes during handoff integrity verification', async () => {
    let releaseHash!: () => void
    let markHashStarted!: () => void
    const hashStarted = new Promise<void>(resolve => {
      markHashStarted = resolve
    })
    const hashGate = new Promise<void>(resolve => {
      releaseHash = resolve
    })
    let holdInstallerHash = false
    const hashFile = vi.fn(async (filePath: string) => {
      if (holdInstallerHash && path.basename(filePath) === 'Evenfire-v0.12.0.dmg') {
        holdInstallerHash = false
        markHashStarted()
        await hashGate
      }
      return EXPECTED_DIGEST
    })
    const openMacInstaller = vi.fn(async () => '')
    dependencies = createDependencies({
      platform: 'darwin',
      architecture: 'arm64',
      hashFile,
      openMacInstaller,
    })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await manager.downloadDesktopUpdate(UPDATE_VERSION)

    holdInstallerHash = true
    const openPromise = manager.openDownloadedMacInstaller(UPDATE_VERSION)
    await hashStarted
    environment.key = 'staging'
    releaseHash()

    await expect(openPromise).rejects.toThrow('selected backend or installed build changed')
    expect(openMacInstaller).not.toHaveBeenCalled()
    expect(mockApp.quit).not.toHaveBeenCalled()
    await expect(manager.getPendingDesktopUpdate()).resolves.toBeNull()
    await expect(
      fs.readFile(path.join(userDataPath, 'update-installers', 'Evenfire-v0.12.0.dmg'), 'utf8')
    ).resolves.toBe('published-dmg')
  })

  it('does not return a ready macOS update when the backend changes during integrity verification', async () => {
    let releaseHash!: () => void
    let markHashStarted!: () => void
    const hashStarted = new Promise<void>(resolve => {
      markHashStarted = resolve
    })
    const hashGate = new Promise<void>(resolve => {
      releaseHash = resolve
    })
    let holdInstallerHash = false
    const hashFile = vi.fn(async (filePath: string) => {
      if (holdInstallerHash && path.basename(filePath) === 'Evenfire-v0.12.0.dmg') {
        holdInstallerHash = false
        markHashStarted()
        await hashGate
      }
      return EXPECTED_DIGEST
    })
    dependencies = createDependencies({ platform: 'darwin', architecture: 'arm64', hashFile })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await manager.downloadDesktopUpdate(UPDATE_VERSION)

    holdInstallerHash = true
    const pendingPromise = manager.getPendingDesktopUpdate()
    await hashStarted
    environment.key = 'staging'
    releaseHash()

    await expect(pendingPromise).resolves.toBeNull()
    await expect(manager.getPendingDesktopUpdate()).resolves.toBeNull()
    await expect(
      fs.readFile(path.join(userDataPath, 'update-installers', 'Evenfire-v0.12.0.dmg'), 'utf8')
    ).resolves.toBe('published-dmg')
  })

  it('invalidates the macOS action when the saved DMG changes but preserves the file', async () => {
    const hashFile = vi.fn(async (filePath: string) =>
      (await fs.readFile(filePath, 'utf8')) === 'published-dmg' ? EXPECTED_DIGEST : 'b'.repeat(64)
    )
    dependencies = createDependencies({
      platform: 'darwin',
      architecture: 'arm64',
      hashFile,
    })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await manager.downloadDesktopUpdate(UPDATE_VERSION)
    const installerPath = path.join(userDataPath, 'update-installers', 'Evenfire-v0.12.0.dmg')
    await fs.writeFile(installerPath, 'tampered-dmg')

    await expect(manager.openDownloadedMacInstaller(UPDATE_VERSION)).rejects.toThrow(
      'saved macOS installer is missing or has changed'
    )
    expect(mockApp.quit).not.toHaveBeenCalled()
    await expect(fs.readFile(installerPath, 'utf8')).resolves.toBe('tampered-dmg')
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

  it('retains the Windows Squirrel automatic installer dispatch', async () => {
    dependencies = createDependencies({ platform: 'win32', architecture: 'x64' })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    await manager.downloadDesktopUpdate(UPDATE_VERSION)

    expect(dependencies.resolveAsset).toHaveBeenCalledWith(
      UPDATE_VERSION,
      'win32',
      'x64',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(dependencies.preparePayload).toHaveBeenCalledWith(
      expect.objectContaining({ packageType: 'squirrel', platform: 'win32' })
    )
    await expect(manager.installDownloadedUpdate(UPDATE_VERSION)).resolves.toEqual({
      installed: true,
    })
    expect(dependencies.launchInstallHelper).toHaveBeenCalledOnce()
    expect(mockApp.quit).toHaveBeenCalledOnce()
  })

  it.each([true, false])(
    'installs a capability=%s target after explicit startup consent',
    async updaterCapable => {
      dependencies = createDependencies({ updaterCapable })
      manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)

      await expect(manager.downloadDesktopUpdate(UPDATE_VERSION, true)).resolves.toMatchObject({
        downloaded: true,
        updaterCapable,
      })
      expect(dependencies.launchInstallHelper).toHaveBeenCalledOnce()
      expect(mockApp.quit).toHaveBeenCalledOnce()
    }
  )

  it('honors startup consent when joining an active manual download of a pre-updater target', async () => {
    let finishDownload!: () => void
    const downloadAsset: NonNullable<DesktopUpdateManagerDependencies['downloadAsset']> = vi.fn(
      async (_asset, destination) => {
        await new Promise<void>(resolve => {
          finishDownload = resolve
        })
        await fs.writeFile(destination, 'zip-data')
      }
    )
    dependencies = createDependencies({ updaterCapable: false, downloadAsset })
    manager = new DesktopUpdateManager(service, event => events.push(event), dependencies)
    const manual = manager.downloadDesktopUpdate(UPDATE_VERSION)
    await vi.waitFor(() => expect(downloadAsset).toHaveBeenCalledOnce())
    const startup = manager.downloadDesktopUpdate(UPDATE_VERSION, true)
    finishDownload()
    await Promise.all([manual, startup])
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
