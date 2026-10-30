import { BrowserWindow, app } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { AppService } from './appService.js'
import { getActiveRuntimeConfigOptionId } from './config.js'
import {
  type DesktopReleaseArchitecture,
  type DesktopReleasePackageType,
  type DesktopReleasePlatform,
  type GitHubReleaseAsset,
  type VerifiedDesktopPayload,
  compareDesktopVersions,
  downloadVerifiedReleaseAsset,
  getAppArchivePath,
  getDesktopReleaseAssetName,
  prepareVerifiedDesktopPayload,
  readFileSha256,
  resolveGitHubReleaseAsset,
  verifyAppTree,
  verifyRecordedOperationDirectory,
} from './desktopUpdateArtifacts.js'
import { readRegularFileNoFollow, updaterFileSystem } from './desktopUpdateFileSystem.js'
import {
  type DesktopInstallLocation,
  type DesktopInstallPlan,
  detectDesktopInstall,
  launchDesktopInstallHelper,
  stopMacDesktopInstallJob,
} from './desktopUpdateInstaller.js'
import type { DesktopReleaseStatus, DesktopUpdateProgress, PendingDesktopUpdate } from './types.js'

const { lstat, mkdir, readdir, rename, rm, unlink, writeFile } = updaterFileSystem.promises

const MINIMUM_UPDATE_VERSION = '0.8.0'
const STAGING_DIRECTORY = 'desktop-update-staging'
const PENDING_UPDATE_FILE = 'pending.json'
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const MAX_ENVIRONMENT_BINDING_ID_LENGTH = 256

export type UpdateEvent =
  | { type: 'progress'; progress: DesktopUpdateProgress }
  | { type: 'downloaded'; version: string; updaterCapable: boolean }
  | { type: 'error'; message: string }

type UpdateOperation = {
  id: string
  state: 'downloading' | 'downloaded' | 'installing'
  version: string
  currentVersion: string
  environmentBindingId: string
  platform: DesktopReleasePlatform
  architecture: DesktopReleaseArchitecture
  packageType: DesktopReleasePackageType
  assetName: string
  assetSha256: string
  assetSize: number
  packagePath: string
  packageSha256: string
  appPath: string
  appVersion: string
  appId: string
  updaterCapable: boolean
  rollbackPackagePath?: string
  rollbackPackageSha256?: string
  currentAsarSha256: string
}

type PendingUpdatePointer = { operationId: string }
type DownloadResult = {
  downloaded: true
  version: string
  updaterCapable: boolean
}

export type DesktopUpdateManagerDependencies = {
  fetchImpl?: typeof fetch
  platform?: string
  architecture?: string
  executablePath?: string
  getEnvironmentBindingId?: () => string | null
  resolveAsset?: typeof resolveGitHubReleaseAsset
  downloadAsset?: typeof downloadVerifiedReleaseAsset
  preparePayload?: typeof prepareVerifiedDesktopPayload
  detectInstall?: typeof detectDesktopInstall
  verifyApp?: typeof verifyAppTree
  hashFile?: typeof readFileSha256
  launchInstallHelper?: (plan: DesktopInstallPlan) => Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isUpdateOperation(value: unknown, operationId: string): value is UpdateOperation {
  if (!isRecord(value)) return false
  const platform = value.platform
  const architecture = value.architecture
  const packageType = value.packageType
  if (
    !['darwin', 'win32', 'linux'].includes(String(platform)) ||
    !['x64', 'arm64'].includes(String(architecture)) ||
    !['app-zip', 'squirrel', 'deb', 'rpm'].includes(String(packageType))
  )
    return false
  const releaseTagValid =
    typeof value.version === 'string' &&
    typeof value.assetName === 'string' &&
    value.assetName ===
      getDesktopReleaseAssetName(
        value.version,
        platform as DesktopReleasePlatform,
        architecture as DesktopReleaseArchitecture
      )
  const rollbackFieldsValid =
    (value.rollbackPackagePath === undefined && value.rollbackPackageSha256 === undefined) ||
    (typeof value.rollbackPackagePath === 'string' &&
      typeof value.rollbackPackageSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(value.rollbackPackageSha256))
  return (
    value.id === operationId &&
    ['downloading', 'downloaded', 'installing'].includes(String(value.state)) &&
    typeof value.version === 'string' &&
    VERSION_PATTERN.test(value.version) &&
    compareDesktopVersions(value.version, MINIMUM_UPDATE_VERSION) >= 0 &&
    typeof value.environmentBindingId === 'string' &&
    value.environmentBindingId.length <= MAX_ENVIRONMENT_BINDING_ID_LENGTH &&
    releaseTagValid &&
    ((platform === 'win32' && packageType === 'squirrel') ||
      (platform === 'linux' && ['deb', 'rpm'].includes(String(packageType))) ||
      packageType === 'app-zip') &&
    typeof value.currentVersion === 'string' &&
    VERSION_PATTERN.test(value.currentVersion) &&
    typeof value.packagePath === 'string' &&
    typeof value.appPath === 'string' &&
    typeof value.packageSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.packageSha256) &&
    typeof value.assetSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.assetSha256) &&
    Number.isSafeInteger(value.assetSize) &&
    (value.state === 'downloading' ? Number(value.assetSize) >= 0 : Number(value.assetSize) > 0) &&
    Number(value.assetSize) <= 512 * 1024 * 1024 &&
    value.appVersion === value.version &&
    value.appId === 'ai.evenfire.desktop' &&
    rollbackFieldsValid &&
    typeof value.updaterCapable === 'boolean' &&
    typeof value.currentAsarSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.currentAsarSha256)
  )
}

function safeRelativePath(operationPath: string, relativePath: string): string {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    /^[a-z]:/i.test(relativePath) ||
    relativePath.split(/[\\/]/).some(segment => segment === '..' || segment === '.')
  ) {
    throw new Error('The staged Desktop update contains an unsafe path.')
  }
  const result = path.resolve(operationPath, relativePath)
  const prefix = path.resolve(operationPath) + path.sep
  if (!result.startsWith(prefix)) {
    throw new Error('The staged Desktop update path escaped its operation directory.')
  }
  return result
}

function packageTypeForInstall(location: DesktopInstallLocation): DesktopReleasePackageType {
  return location.packageType
}

export class DesktopUpdateManager {
  private activeDownload: {
    version: string
    controller: AbortController
    promise: Promise<DownloadResult>
  } | null = null
  private activeInstall: {
    version: string
    promise: Promise<{ installed: true }>
  } | null = null

  private readonly fetchImpl: typeof fetch
  private readonly platform: string
  private readonly architecture: string
  private readonly executablePath: string
  private readonly getEnvironmentBindingId: () => string | null
  private readonly resolveAsset: typeof resolveGitHubReleaseAsset
  private readonly downloadAsset: typeof downloadVerifiedReleaseAsset
  private readonly preparePayload: typeof prepareVerifiedDesktopPayload
  private readonly detectInstall: typeof detectDesktopInstall
  private readonly verifyApp: typeof verifyAppTree
  private readonly hashFile: typeof readFileSha256
  private readonly launchInstallHelper: (plan: DesktopInstallPlan) => Promise<void>

  constructor(
    private readonly service: AppService,
    private readonly sendEvent: (event: UpdateEvent) => void,
    dependencies: DesktopUpdateManagerDependencies = {}
  ) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch
    this.platform = dependencies.platform ?? process.platform
    this.architecture = dependencies.architecture ?? process.arch
    this.executablePath = dependencies.executablePath ?? process.execPath
    this.getEnvironmentBindingId =
      dependencies.getEnvironmentBindingId ?? getActiveRuntimeConfigOptionId
    this.resolveAsset = dependencies.resolveAsset ?? resolveGitHubReleaseAsset
    this.downloadAsset = dependencies.downloadAsset ?? downloadVerifiedReleaseAsset
    this.preparePayload = dependencies.preparePayload ?? prepareVerifiedDesktopPayload
    this.detectInstall = dependencies.detectInstall ?? detectDesktopInstall
    this.verifyApp = dependencies.verifyApp ?? verifyAppTree
    this.hashFile = dependencies.hashFile ?? readFileSha256
    this.launchInstallHelper = dependencies.launchInstallHelper ?? launchDesktopInstallHelper

    void app
      .whenReady()
      .then(async () => {
        await this.confirmStartupUpdate()
        await this.cleanInterruptedOperations()
      })
      .catch(error => this.sendEvent({ type: 'error', message: errorMessage(error) }))
  }

  async getPendingDesktopUpdate(): Promise<PendingDesktopUpdate | null> {
    const pending = await this.readPendingOperation()
    if (!pending) return null
    const { operationPath, operation } = pending
    if (operation.state === 'installing') return null

    const initialEnvironmentBindingId = this.getEnvironmentBindingId()
    if (
      !initialEnvironmentBindingId ||
      initialEnvironmentBindingId.length > MAX_ENVIRONMENT_BINDING_ID_LENGTH
    ) {
      await this.discardOperation(operationPath, operation.id)
      return null
    }
    let status: DesktopReleaseStatus
    try {
      status = await this.service.getDesktopReleaseStatus()
    } catch {
      return null
    }
    if (
      this.getEnvironmentBindingId() !== initialEnvironmentBindingId ||
      operation.environmentBindingId !== initialEnvironmentBindingId
    ) {
      await this.discardOperation(operationPath, operation.id)
      return null
    }
    if (this.statusRecommends(status, operation.version)) {
      return { version: operation.version, updaterCapable: operation.updaterCapable }
    }
    await this.discardOperation(operationPath, operation.id)
    return null
  }

  async downloadDesktopUpdate(
    expectedVersion: string,
    restartAfterDownload = false
  ): Promise<DownloadResult> {
    this.assertPackagedBuild()
    this.assertValidTargetVersion(expectedVersion)

    if (this.activeDownload) {
      if (this.activeDownload.version !== expectedVersion) {
        throw new Error('A different Desktop update is already being downloaded.')
      }
      const result = await this.activeDownload.promise
      if (restartAfterDownload && result.updaterCapable) {
        await this.installDownloadedUpdate(expectedVersion)
      }
      return result
    }

    const controller = new AbortController()
    const operation = this.downloadAndStageUpdate(expectedVersion, controller.signal)
    const activeDownload = { version: expectedVersion, controller, promise: operation }
    this.activeDownload = activeDownload
    try {
      const result = await operation
      if (restartAfterDownload && result.updaterCapable) {
        await this.installDownloadedUpdate(expectedVersion)
      }
      return result
    } finally {
      if (this.activeDownload === activeDownload) this.activeDownload = null
    }
  }

  async cancelDesktopUpdate(): Promise<void> {
    const active = this.activeDownload
    if (!active) return
    active.controller.abort()
    await active.promise.catch(() => undefined)
  }

  async installDownloadedUpdate(expectedVersion: string): Promise<{ installed: true }> {
    this.assertPackagedBuild()
    this.assertValidTargetVersion(expectedVersion)

    if (this.activeDownload) {
      if (this.activeDownload.version !== expectedVersion) {
        throw new Error('A different Desktop update is still being downloaded.')
      }
      await this.activeDownload.promise
    }
    if (this.activeInstall) {
      if (this.activeInstall.version !== expectedVersion) {
        throw new Error('A different Desktop update is already being installed.')
      }
      return this.activeInstall.promise
    }

    const operation = this.installDownloadedUpdateOnce(expectedVersion)
    const activeInstall = { version: expectedVersion, promise: operation }
    this.activeInstall = activeInstall
    try {
      return await operation
    } finally {
      if (this.activeInstall === activeInstall) this.activeInstall = null
    }
  }

  private async downloadAndStageUpdate(
    expectedVersion: string,
    signal: AbortSignal
  ): Promise<DownloadResult> {
    const environmentBindingId = this.requireEnvironmentBindingId()
    const status = await this.service.getDesktopReleaseStatus()
    this.assertEnvironmentUnchanged(environmentBindingId)
    this.assertTargetIsCurrent(status, expectedVersion)
    const currentVersion = app.getVersion()
    if (!VERSION_PATTERN.test(currentVersion) || currentVersion === expectedVersion) {
      throw new Error('The selected Desktop update does not differ from the installed version.')
    }
    if (compareDesktopVersions(currentVersion, MINIMUM_UPDATE_VERSION) < 0) {
      throw new Error(
        `Automatic updates support installed versions from ${MINIMUM_UPDATE_VERSION}.`
      )
    }

    const platform = this.platform as DesktopReleasePlatform
    const architecture = this.architecture as DesktopReleaseArchitecture
    const location = await this.detectInstall({
      platform: this.platform,
      architecture: this.architecture,
      executablePath: this.executablePath,
      currentVersion,
    })
    const currentTree = await this.verifyApp(
      location.appPath,
      currentVersion,
      location.platform,
      location.architecture
    )
    if (currentTree.appId !== 'ai.evenfire.desktop') {
      throw new Error('The installed application identity could not be verified for updating.')
    }
    const currentAsarSha256 = await this.hashFile(
      path.join(
        location.appPath,
        location.platform === 'darwin' ? 'Contents/Resources/app.asar' : 'resources/app.asar'
      )
    )

    const operationId = randomUUID()
    const stageRoot = this.stagingRoot()
    await this.ensureStagingRoot(stageRoot)
    const operationPath = path.join(stageRoot, operationId)
    await mkdir(operationPath, { mode: 0o700 })
    const journalPath = path.join(operationPath, 'operation.json')
    const archivePath = path.join(operationPath, 'release.zip')
    const payloadRoot = path.join(operationPath, 'payload')

    let operation: UpdateOperation | null = null
    try {
      const assetName = getDesktopReleaseAssetName(expectedVersion, platform, architecture)
      operation = {
        id: operationId,
        state: 'downloading',
        version: expectedVersion,
        currentVersion,
        environmentBindingId,
        platform,
        architecture,
        packageType: packageTypeForInstall(location),
        assetName,
        assetSha256: '0'.repeat(64),
        assetSize: 0,
        packagePath: 'payload/release.zip',
        packageSha256: '0'.repeat(64),
        appPath: 'payload/application',
        appVersion: expectedVersion,
        appId: 'ai.evenfire.desktop',
        updaterCapable: false,
        currentAsarSha256,
      }
      await this.writeOperation(journalPath, operation)

      const asset = await this.resolveAsset(expectedVersion, platform, architecture, {
        fetchImpl: this.fetchImpl,
        signal,
      })
      if (asset.name !== assetName) {
        throw new Error('GitHub selected a Desktop asset outside the backend recommendation.')
      }
      await this.downloadAsset(asset, archivePath, {
        fetchImpl: this.fetchImpl,
        signal,
        onProgress: progress => {
          this.sendEvent({
            type: 'progress',
            progress: {
              percent: progress.percent,
              transferred: progress.transferred,
              total: progress.total,
            },
          })
        },
      })
      if (signal.aborted) throw new Error('Desktop update download canceled.')

      await mkdir(payloadRoot, { mode: 0o700 })
      const payload = await this.preparePayload({
        archivePath,
        destination: payloadRoot,
        version: expectedVersion,
        platform,
        architecture,
        packageType: location.packageType,
      })
      if (signal.aborted) throw new Error('Desktop update download canceled.')
      await unlink(archivePath)

      let rollbackPackagePath: string | undefined
      let rollbackPackageSha256: string | undefined
      if (location.packageType === 'deb' || location.packageType === 'rpm') {
        const rollbackRoot = path.join(operationPath, 'rollback')
        await mkdir(rollbackRoot, { mode: 0o700 })
        const rollbackAsset = await this.resolveAsset(currentVersion, platform, architecture, {
          fetchImpl: this.fetchImpl,
          signal,
        })
        const rollbackArchive = path.join(rollbackRoot, 'release.zip')
        await this.downloadAsset(rollbackAsset, rollbackArchive, {
          fetchImpl: this.fetchImpl,
          signal,
        })
        const rollbackPayloadRoot = path.join(rollbackRoot, 'payload')
        await mkdir(rollbackPayloadRoot, { mode: 0o700 })
        const rollbackPayload = await this.preparePayload({
          archivePath: rollbackArchive,
          destination: rollbackPayloadRoot,
          version: currentVersion,
          platform,
          architecture,
          packageType: location.packageType,
        })
        rollbackPackagePath = path.relative(operationPath, rollbackPayload.packagePath)
        rollbackPackageSha256 = await this.hashFile(rollbackPayload.packagePath)
        await unlink(rollbackArchive)
      }

      const finalStatus = await this.service.getDesktopReleaseStatus()
      if (signal.aborted) throw new Error('Desktop update download canceled.')
      this.assertEnvironmentUnchanged(environmentBindingId)
      this.assertTargetIsCurrent(finalStatus, expectedVersion)

      const packagePath = path.relative(operationPath, payload.packagePath)
      const appPath = path.relative(operationPath, payload.appPath)
      operation = {
        ...operation,
        state: 'downloaded',
        packageType: payload.packageType,
        assetSha256: payload.assetSha256,
        assetSize: payload.assetSize,
        packagePath,
        packageSha256: await this.hashFile(payload.packagePath),
        appPath,
        appVersion: payload.appVersion,
        appId: payload.appId,
        updaterCapable: payload.updaterCapable,
        ...(rollbackPackagePath ? { rollbackPackagePath } : {}),
        ...(rollbackPackageSha256 ? { rollbackPackageSha256 } : {}),
      }
      await this.writeOperation(journalPath, operation)
      await this.writePendingPointer(stageRoot, { operationId })
      this.sendEvent({
        type: 'downloaded',
        version: expectedVersion,
        updaterCapable: operation.updaterCapable,
      })
      return {
        downloaded: true,
        version: expectedVersion,
        updaterCapable: operation.updaterCapable,
      }
    } catch (error) {
      if (operation && (await this.readPendingPointer(stageRoot))?.operationId === operationId) {
        await this.removePendingPointer(stageRoot).catch(() => undefined)
      }
      await this.discardOperation(operationPath, operationId).catch(() => undefined)
      if (
        operation &&
        (await verifyRecordedOperationDirectory(stageRoot, operationPath, operationId)) &&
        !(await this.isRegularFile(path.join(operationPath, 'operation.json')))
      ) {
        await rm(operationPath, { recursive: true, force: false }).catch(() => undefined)
      }
      if (signal.aborted) throw new Error('Desktop update download canceled.')
      this.sendEvent({ type: 'error', message: errorMessage(error) })
      throw error
    }
  }

  private async installDownloadedUpdateOnce(expectedVersion: string): Promise<{ installed: true }> {
    const pending = await this.readPendingOperation()
    if (!pending || pending.operation.version !== expectedVersion) {
      throw new Error('The selected Desktop update is not staged. Download it again to continue.')
    }
    const { operationPath, operation } = pending
    if (operation.state !== 'downloaded') {
      throw new Error('The selected Desktop update is already being installed.')
    }

    const environmentBindingId = this.requireEnvironmentBindingId()
    const status = await this.service.getDesktopReleaseStatus()
    this.assertEnvironmentUnchanged(environmentBindingId)
    if (operation.environmentBindingId !== environmentBindingId) {
      await this.discardOperation(operationPath, operation.id)
      throw new Error('The selected backend changed. Check for updates again before installing.')
    }
    this.assertTargetIsCurrent(status, expectedVersion)

    const location = await this.detectInstall({
      platform: this.platform,
      architecture: this.architecture,
      executablePath: this.executablePath,
      currentVersion: app.getVersion(),
    })
    if (
      location.platform !== operation.platform ||
      location.architecture !== operation.architecture ||
      location.packageType !== operation.packageType ||
      app.getVersion() !== operation.currentVersion
    ) {
      throw new Error('The installed Desktop environment changed since this update was downloaded.')
    }
    const currentTree = await this.verifyApp(
      location.appPath,
      operation.currentVersion,
      location.platform,
      location.architecture
    )
    const currentAsarSha256 = await this.hashFile(
      path.join(
        location.appPath,
        location.platform === 'darwin' ? 'Contents/Resources/app.asar' : 'resources/app.asar'
      )
    )
    if (
      currentTree.appId !== operation.appId ||
      currentAsarSha256 !== operation.currentAsarSha256
    ) {
      throw new Error('The installed application changed after the update was staged.')
    }

    const packagePath = safeRelativePath(operationPath, operation.packagePath)
    const appPath = safeRelativePath(operationPath, operation.appPath)
    if ((await this.hashFile(packagePath)) !== operation.packageSha256) {
      throw new Error('The staged Desktop installer changed after download verification.')
    }
    const targetTree = await this.verifyApp(
      appPath,
      expectedVersion,
      operation.platform,
      operation.architecture
    )
    if (
      targetTree.appId !== operation.appId ||
      targetTree.updaterCapable !== operation.updaterCapable
    ) {
      throw new Error('The staged Desktop application changed after archive verification.')
    }
    const payload: VerifiedDesktopPayload = {
      packageType: operation.packageType,
      packagePath,
      appPath,
      appVersion: operation.appVersion,
      appId: operation.appId,
      architecture: operation.architecture,
      updaterCapable: operation.updaterCapable,
      assetName: operation.assetName,
      assetSha256: operation.assetSha256,
      assetSize: operation.assetSize,
    }
    const rollbackPackagePath = operation.rollbackPackagePath
      ? safeRelativePath(operationPath, operation.rollbackPackagePath)
      : undefined
    if (rollbackPackagePath) {
      if (
        !operation.rollbackPackageSha256 ||
        (await this.hashFile(rollbackPackagePath)) !== operation.rollbackPackageSha256
      ) {
        throw new Error('The rollback package changed after download verification.')
      }
    }
    const plan: DesktopInstallPlan = {
      operationId: operation.id,
      operationPath,
      stageRoot: this.stagingRoot(),
      pendingPath: path.join(this.stagingRoot(), PENDING_UPDATE_FILE),
      location,
      payload,
      currentVersion: operation.currentVersion,
      currentAsarSha256: operation.currentAsarSha256,
      targetPackageSha256: operation.packageSha256,
      ...(rollbackPackagePath ? { rollbackPackagePath } : {}),
      ...(operation.rollbackPackageSha256
        ? { rollbackPackageSha256: operation.rollbackPackageSha256 }
        : {}),
    }

    const finalStatus = await this.service.getDesktopReleaseStatus()
    this.assertEnvironmentUnchanged(environmentBindingId)
    this.assertTargetIsCurrent(finalStatus, expectedVersion)
    await this.writeOperation(path.join(operationPath, 'operation.json'), {
      ...operation,
      state: 'installing',
    })
    try {
      await this.launchInstallHelper(plan)
      const handoffStatus = await this.service.getDesktopReleaseStatus()
      this.assertEnvironmentUnchanged(environmentBindingId)
      this.assertTargetIsCurrent(handoffStatus, expectedVersion)
      if (app.getVersion() !== operation.currentVersion) {
        throw new Error('The selected backend or installed build changed before installation.')
      }
    } catch (error) {
      try {
        await this.cancelStartedHelper(operationPath, operation.id)
      } catch {
        throw new Error(
          'The update helper could not be safely stopped; recovery files were preserved.'
        )
      }
      await this.writeOperation(path.join(operationPath, 'operation.json'), {
        ...operation,
        state: 'downloaded',
      }).catch(() => undefined)
      if (this.platform === 'darwin') await this.discardOperation(operationPath, operation.id)
      throw error
    }
    app.quit()
    return { installed: true }
  }

  private async confirmStartupUpdate(): Promise<void> {
    const argument = process.argv.find(value => value.startsWith('--evenfire-update-operation='))
    const operationId = argument?.slice('--evenfire-update-operation='.length)
    if (!operationId || !/^[0-9a-f-]{36}$/i.test(operationId)) return
    const pending = await this.readPendingOperation()
    if (!pending || pending.operation.id !== operationId) return
    const { operation, operationPath } = pending
    if (operation.state !== 'installing' || app.getVersion() !== operation.version) return
    if (!app.isPackaged || !operation.updaterCapable) return
    await this.writeJsonFile(path.join(operationPath, 'startup-ok.json'), {
      id: operationId,
      version: app.getVersion(),
    })
  }

  private async cleanInterruptedOperations(): Promise<void> {
    const stageRoot = this.stagingRoot()
    await this.ensureStagingRoot(stageRoot)
    await this.cleanRecordedCleanup(stageRoot)
    const pending = await this.readPendingPointer(stageRoot)
    const entries = await readdir(stageRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue
      const operationPath = path.join(stageRoot, entry.name)
      const operation = await this.readOperation(operationPath, entry.name)
      if (!operation) continue
      const safeCleanupMarker = await this.readMarker(path.join(operationPath, 'cleanup-safe.json'))
      const startupMarker = await this.readMarker(path.join(operationPath, 'startup-ok.json'))
      const helperPid = await this.readHelperPid(operationPath)
      const helperStillRunning = helperPid !== null && this.isProcessAlive(helperPid)
      const safeCleanupComplete =
        safeCleanupMarker?.id === entry.name &&
        ['installed', 'rollback-complete'].includes(String(safeCleanupMarker.state))
      const startupComplete =
        startupMarker?.id === entry.name &&
        startupMarker.version === operation.version &&
        app.getVersion() === operation.version

      if (pending?.operationId === entry.name) {
        if (!helperStillRunning && safeCleanupComplete) {
          await this.discardOperation(operationPath, entry.name)
          continue
        }
        if (!helperStillRunning && startupComplete) {
          await this.finalizeInterruptedInstall(operationPath, operation)
          await this.discardOperation(operationPath, entry.name)
          continue
        }
        if (!helperStillRunning && operation.state === 'downloading') {
          await this.discardOperation(operationPath, entry.name)
          continue
        }
        if (
          !helperStillRunning &&
          operation.state === 'installing' &&
          app.getVersion() === operation.currentVersion
        ) {
          try {
            const currentInstall = await this.detectInstall({
              platform: this.platform,
              architecture: this.architecture,
              executablePath: this.executablePath,
              currentVersion: operation.currentVersion,
            })
            const currentAsarPath = path.join(
              currentInstall.appPath,
              currentInstall.platform === 'darwin'
                ? 'Contents/Resources/app.asar'
                : 'resources/app.asar'
            )
            const currentHash = await this.hashFile(currentAsarPath)
            const status = await this.service.getDesktopReleaseStatus()
            if (
              currentHash === operation.currentAsarSha256 &&
              operation.environmentBindingId === this.getEnvironmentBindingId() &&
              this.statusRecommends(status, operation.version)
            ) {
              await this.writeOperation(path.join(operationPath, 'operation.json'), {
                ...operation,
                state: 'downloaded',
              })
              continue
            }
            if (currentHash === operation.currentAsarSha256) {
              await this.discardOperation(operationPath, entry.name)
              continue
            }
          } catch {
            // Keep the staged payload and recovery record if startup cannot prove the installed app.
          }
        }
        continue
      }
      if (
        operation.state !== 'installing' ||
        (!helperStillRunning && (safeCleanupComplete || startupComplete))
      ) {
        await this.discardOperation(operationPath, entry.name)
      }
    }
  }

  private async cleanRecordedCleanup(stageRoot: string): Promise<void> {
    const cleanupPath = path.join(stageRoot, 'cleanup.json')
    const cleanup = await this.readMarker(cleanupPath)
    if (
      !cleanup ||
      cleanup.state !== 'safe-to-delete' ||
      typeof cleanup.id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(cleanup.id)
    ) {
      return
    }
    const operationPath = path.join(stageRoot, cleanup.id)
    try {
      const operationInfo = await lstat(operationPath)
      if (
        !operationInfo.isDirectory() ||
        operationInfo.isSymbolicLink() ||
        (typeof process.getuid === 'function' && operationInfo.uid !== process.getuid()) ||
        (process.platform !== 'win32' && (operationInfo.mode & 0o077) !== 0)
      ) {
        throw new Error('The interrupted Desktop cleanup path is not safe.')
      }
      await rm(operationPath, { recursive: true, force: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const pointer = await this.readPendingPointer(stageRoot)
    if (pointer?.operationId === cleanup.id) await this.removePendingPointer(stageRoot)
    await this.removeOwnedFile(cleanupPath)
  }

  private async finalizeInterruptedInstall(
    operationPath: string,
    operation: UpdateOperation
  ): Promise<void> {
    const location = await this.detectInstall({
      platform: operation.platform,
      architecture: operation.architecture,
      executablePath: this.executablePath,
      currentVersion: operation.version,
    })
    if (
      location.platform !== operation.platform ||
      location.architecture !== operation.architecture ||
      location.packageType !== operation.packageType
    ) {
      throw new Error('The installed Desktop update location changed before cleanup.')
    }

    const installed = await this.verifyApp(
      location.appPath,
      operation.version,
      location.platform,
      location.architecture
    )
    const stagedAppPath = safeRelativePath(operationPath, operation.appPath)
    const staged = await this.verifyApp(
      stagedAppPath,
      operation.version,
      operation.platform,
      operation.architecture
    )
    const installedDigest = await this.hashFile(
      getAppArchivePath(location.appPath, location.platform)
    )
    const stagedDigest = await this.hashFile(getAppArchivePath(stagedAppPath, operation.platform))
    if (
      app.getVersion() !== operation.version ||
      installed.appId !== operation.appId ||
      staged.appId !== operation.appId ||
      installedDigest !== stagedDigest
    ) {
      throw new Error('The restarted Desktop version could not be verified for cleanup.')
    }

    if (operation.packageType === 'deb' || operation.packageType === 'rpm') return
    const rollbackRoot = `${location.installRoot}.evenfire-rollback-${operation.id}`
    let rollbackInfo
    try {
      rollbackInfo = await lstat(rollbackRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!rollbackInfo.isDirectory() || rollbackInfo.isSymbolicLink()) {
      throw new Error('The interrupted Desktop update has an unsafe rollback path.')
    }

    const rollbackAppPath =
      operation.platform === 'win32'
        ? path.join(rollbackRoot, `app-${operation.currentVersion}`)
        : rollbackRoot
    const rollback = await this.verifyApp(
      rollbackAppPath,
      operation.currentVersion,
      operation.platform,
      operation.architecture
    )
    const rollbackDigest = await this.hashFile(
      getAppArchivePath(rollbackAppPath, operation.platform)
    )
    if (rollback.appId !== operation.appId || rollbackDigest !== operation.currentAsarSha256) {
      throw new Error('The previous Desktop app could not be verified before rollback cleanup.')
    }
    await rm(rollbackRoot, { recursive: true, force: false })
  }

  private assertPackagedBuild(): void {
    if (!app.isPackaged) throw new Error('Desktop updates are available only in packaged builds.')
  }

  private assertValidTargetVersion(version: string): void {
    if (!VERSION_PATTERN.test(version)) throw new Error('Invalid Desktop update version.')
    if (compareDesktopVersions(version, MINIMUM_UPDATE_VERSION) < 0) {
      throw new Error(
        `Desktop update releases before v${MINIMUM_UPDATE_VERSION} are not supported.`
      )
    }
  }

  private requireEnvironmentBindingId(): string {
    const environmentBindingId = this.getEnvironmentBindingId()
    if (!environmentBindingId || environmentBindingId.length > MAX_ENVIRONMENT_BINDING_ID_LENGTH) {
      throw new Error('Select a saved backend profile before downloading a Desktop update.')
    }
    return environmentBindingId
  }

  private assertEnvironmentUnchanged(expectedEnvironmentBindingId: string): void {
    if (this.getEnvironmentBindingId() !== expectedEnvironmentBindingId) {
      throw new Error(
        'The selected backend changed during the update. Check again before continuing.'
      )
    }
  }

  private statusRecommends(status: DesktopReleaseStatus, version: string): boolean {
    return (
      status.checked &&
      status.updateAvailable &&
      status.latestVersion === version &&
      status.releaseTag === `v${version}` &&
      Array.isArray(status.compatibleVersions) &&
      status.compatibleVersions.includes(version)
    )
  }

  private assertTargetIsCurrent(status: DesktopReleaseStatus, expectedVersion: string): void {
    if (!this.statusRecommends(status, expectedVersion)) {
      throw new Error('The selected backend no longer recommends this Desktop update.')
    }
    if (compareDesktopVersions(expectedVersion, MINIMUM_UPDATE_VERSION) < 0) {
      throw new Error(
        `Desktop update releases before v${MINIMUM_UPDATE_VERSION} are not supported.`
      )
    }
  }

  private stagingRoot(): string {
    return path.join(app.getPath('userData'), STAGING_DIRECTORY)
  }

  private async ensureStagingRoot(stageRoot: string): Promise<void> {
    try {
      await mkdir(stageRoot, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const info = await lstat(stageRoot)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    ) {
      throw new Error('The Desktop update staging directory is not safe.')
    }
  }

  private async readPendingPointer(
    stageRoot = this.stagingRoot()
  ): Promise<PendingUpdatePointer | null> {
    const filePath = path.join(stageRoot, PENDING_UPDATE_FILE)
    try {
      const bytes = await readRegularFileNoFollow(filePath, 1024)
      const parsed: unknown = JSON.parse(bytes.toString('utf8'))
      if (
        !isRecord(parsed) ||
        typeof parsed.operationId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(parsed.operationId)
      ) {
        return null
      }
      return { operationId: parsed.operationId }
    } catch {
      return null
    }
  }

  private async readPendingOperation(): Promise<{
    operationPath: string
    operation: UpdateOperation
  } | null> {
    const stageRoot = this.stagingRoot()
    const pointer = await this.readPendingPointer(stageRoot)
    if (!pointer) return null
    const operationPath = path.join(stageRoot, pointer.operationId)
    if (!(await verifyRecordedOperationDirectory(stageRoot, operationPath, pointer.operationId))) {
      return null
    }
    const operation = await this.readOperation(operationPath, pointer.operationId)
    if (this.platform === 'darwin') {
      try {
        await lstat(path.join(operationPath, 'cancel-install.json'))
        return null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return operation ? { operationPath, operation } : null
  }

  private async readOperation(
    operationPath: string,
    operationId: string
  ): Promise<UpdateOperation | null> {
    try {
      const journalPath = path.join(operationPath, 'operation.json')
      const bytes = await readRegularFileNoFollow(journalPath, 64 * 1024)
      const parsed: unknown = JSON.parse(bytes.toString('utf8'))
      return isUpdateOperation(parsed, operationId) ? parsed : null
    } catch {
      return null
    }
  }

  private async writePendingPointer(
    stageRoot: string,
    pointer: PendingUpdatePointer
  ): Promise<void> {
    await this.writeJsonFile(path.join(stageRoot, PENDING_UPDATE_FILE), pointer)
  }

  private async removePendingPointer(stageRoot: string): Promise<void> {
    const filePath = path.join(stageRoot, PENDING_UPDATE_FILE)
    try {
      const info = await lstat(filePath)
      if (info.isFile() && !info.isSymbolicLink()) await unlink(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async writeOperation(filePath: string, operation: UpdateOperation): Promise<void> {
    await this.writeJsonFile(filePath, operation)
  }

  private async writeJsonFile(filePath: string, value: unknown): Promise<void> {
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, JSON.stringify(value) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      })
      await rename(temporaryPath, filePath)
    } catch (error) {
      await this.removeOwnedFile(temporaryPath).catch(() => undefined)
      throw error
    }
  }

  private async discardOperation(operationPath: string, operationId: string): Promise<void> {
    const stageRoot = this.stagingRoot()
    if (!(await verifyRecordedOperationDirectory(stageRoot, operationPath, operationId))) return
    const operation = await this.readOperation(operationPath, operationId)
    if (!operation) return
    await this.writeJsonFile(path.join(stageRoot, 'cleanup.json'), {
      id: operationId,
      state: 'safe-to-delete',
    })
    await rm(operationPath, { recursive: true, force: false })
    const pointer = await this.readPendingPointer(stageRoot)
    if (pointer?.operationId === operationId) await this.removePendingPointer(stageRoot)
    await this.removeOwnedFile(path.join(stageRoot, 'cleanup.json'))
  }

  private async isRegularFile(filePath: string): Promise<boolean> {
    try {
      const info = await lstat(filePath)
      return info.isFile() && !info.isSymbolicLink()
    } catch {
      return false
    }
  }

  private async readMarker(filePath: string): Promise<Record<string, unknown> | null> {
    try {
      const bytes = await readRegularFileNoFollow(filePath, 16 * 1024)
      const parsed: unknown = JSON.parse(bytes.toString('utf8'))
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private async removeOwnedFile(filePath: string): Promise<void> {
    try {
      const info = await lstat(filePath)
      if (info.isFile() && !info.isSymbolicLink()) await unlink(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async readHelperPid(operationPath: string): Promise<number | null> {
    try {
      const filePath = path.join(operationPath, 'helper.pid')
      const bytes = await readRegularFileNoFollow(filePath, 64)
      const pid = Number(bytes.toString('utf8').trim())
      return Number.isSafeInteger(pid) && pid > 1 ? pid : null
    } catch {
      return null
    }
  }

  private async cancelStartedHelper(operationPath: string, operationId: string): Promise<void> {
    await this.writeJsonFile(path.join(operationPath, 'cancel-install.json'), { id: operationId })
    if (this.platform === 'darwin') await stopMacDesktopInstallJob(operationId)
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const pid = await this.readHelperPid(operationPath)
      if (pid === null || !this.isProcessAlive(pid)) {
        // Keep Mac cancellation durable: a queued authorization must never run later.
        if (this.platform !== 'darwin') {
          await this.removeOwnedFile(path.join(operationPath, 'cancel-install.json'))
        }
        return
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('The update helper did not stop after cancellation was requested.')
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
}

export function sendDesktopUpdateEvent(event: UpdateEvent): void {
  const channel = {
    progress: 'desktopUpdate:progress',
    downloaded: 'desktopUpdate:downloaded',
    error: 'desktopUpdate:error',
  }[event.type]
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, event)
  }
}
