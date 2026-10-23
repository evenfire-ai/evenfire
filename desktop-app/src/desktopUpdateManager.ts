import { BrowserWindow, app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AppService } from './appService.js'
import type { DesktopReleaseStatus, DesktopUpdateProgress, PendingDesktopUpdate } from './types.js'

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const PENDING_UPDATE_FILE = 'desktop-update-pending.json'
const RELEASES_BASE_URL = new URL('https://github.com/evenfire-ai/evenfire/releases')

export type UpdateEvent =
  | { type: 'progress'; progress: DesktopUpdateProgress }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }

type PendingUpdateRecord = {
  version: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateReleaseFeed(status: DesktopReleaseStatus): string {
  if (!status.releaseTag || status.releaseTag !== 'v' + status.latestVersion) {
    throw new Error('The selected backend returned an invalid Desktop release tag.')
  }
  if (!status.releaseUrl || !status.updateFeedUrl) {
    throw new Error('The selected backend did not provide a Desktop update feed.')
  }

  const releaseUrl = new URL(status.releaseUrl)
  const feedUrl = new URL(status.updateFeedUrl)
  const expectedReleasePath =
    RELEASES_BASE_URL.pathname + '/tag/' + encodeURIComponent(status.releaseTag)
  const expectedFeedPath =
    RELEASES_BASE_URL.pathname + '/download/' + encodeURIComponent(status.releaseTag)
  if (
    releaseUrl.protocol !== 'https:' ||
    feedUrl.protocol !== 'https:' ||
    releaseUrl.username ||
    releaseUrl.password ||
    releaseUrl.search ||
    releaseUrl.hash ||
    feedUrl.username ||
    feedUrl.password ||
    feedUrl.search ||
    feedUrl.hash ||
    releaseUrl.origin !== RELEASES_BASE_URL.origin ||
    feedUrl.origin !== RELEASES_BASE_URL.origin ||
    releaseUrl.pathname !== expectedReleasePath ||
    feedUrl.pathname.replace(/\/+$/, '') !== expectedFeedPath
  ) {
    throw new Error('The selected backend returned an untrusted Desktop update feed.')
  }
  return feedUrl.toString().replace(/\/+$/, '') + '/'
}

export class DesktopUpdateManager {
  private downloadedVersion: string | null = null
  private updateInProgress = false
  private activeDownload: {
    version: string
    promise: Promise<{ downloaded: true; version: string }>
  } | null = null
  private activeInstall: {
    version: string
    promise: Promise<{ installed: true }>
  } | null = null

  constructor(
    private readonly service: AppService,
    private readonly sendEvent: (event: UpdateEvent) => void
  ) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowDowngrade = true
    autoUpdater.disableDifferentialDownload = true
    autoUpdater.on('download-progress', progress => {
      this.sendEvent({
        type: 'progress',
        progress: {
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
        },
      })
    })
    autoUpdater.on('update-downloaded', event => {
      this.downloadedVersion = event.version
      this.sendEvent({ type: 'downloaded', version: event.version })
    })
    autoUpdater.on('error', error => {
      if (this.updateInProgress) {
        this.sendEvent({ type: 'error', message: errorMessage(error) })
      }
    })
  }

  async getPendingDesktopUpdate(): Promise<PendingDesktopUpdate | null> {
    const record = await this.readPendingUpdate()
    if (!record) return null
    let status: DesktopReleaseStatus
    try {
      status = await this.service.getDesktopReleaseStatus()
    } catch {
      // Keep the staged build for the next successful backend verification.
      return null
    }
    if (
      status.updateAvailable &&
      status.latestVersion === record.version &&
      status.compatibleVersions.includes(record.version)
    ) {
      return { version: record.version }
    }
    await this.clearPendingUpdate()
    return null
  }

  async downloadDesktopUpdate(
    expectedVersion: string,
    restartAfterDownload = false
  ): Promise<{ downloaded: true; version: string }> {
    if (!app.isPackaged) {
      throw new Error('Desktop updates are available only in packaged builds.')
    }
    if (!VERSION_PATTERN.test(expectedVersion)) {
      throw new Error('Invalid Desktop update version.')
    }

    if (this.activeDownload) {
      if (this.activeDownload.version !== expectedVersion) {
        throw new Error('A different Desktop update is already in progress.')
      }
      const result = await this.activeDownload.promise
      if (restartAfterDownload) await this.installDownloadedUpdate(expectedVersion)
      return result
    }

    const operation = this.downloadAndStageUpdate(expectedVersion)
    this.activeDownload = { version: expectedVersion, promise: operation }
    this.updateInProgress = true
    try {
      const result = await operation
      if (restartAfterDownload) await this.installDownloadedUpdate(expectedVersion)
      return result
    } finally {
      this.updateInProgress = false
      if (this.activeDownload?.promise === operation) this.activeDownload = null
    }
  }

  async installDownloadedUpdate(expectedVersion: string): Promise<{ installed: true }> {
    if (!VERSION_PATTERN.test(expectedVersion)) {
      throw new Error('Invalid Desktop update version.')
    }
    if (!app.isPackaged) {
      throw new Error('Desktop updates are available only in packaged builds.')
    }

    if (this.activeDownload) {
      if (this.activeDownload.version !== expectedVersion) {
        throw new Error('A different Desktop update is already being downloaded.')
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
    this.activeInstall = { version: expectedVersion, promise: operation }
    try {
      return await operation
    } finally {
      if (this.activeInstall?.promise === operation) this.activeInstall = null
    }
  }

  private async downloadAndStageUpdate(
    expectedVersion: string
  ): Promise<{ downloaded: true; version: string }> {
    const status = await this.service.getDesktopReleaseStatus()
    this.assertTargetIsCurrent(status, expectedVersion)
    await this.prepareUpdate(status, expectedVersion)
    return { downloaded: true, version: expectedVersion }
  }

  private async installDownloadedUpdateOnce(expectedVersion: string): Promise<{ installed: true }> {
    this.updateInProgress = true
    try {
      const status = await this.service.getDesktopReleaseStatus()
      this.assertTargetIsCurrent(status, expectedVersion)
      if (this.downloadedVersion !== expectedVersion) {
        await this.prepareUpdate(status, expectedVersion)
      }

      // Re-read the selected backend immediately before installation. A backend
      // switch or rollout during a deferred restart invalidates a stale target.
      const currentStatus = await this.service.getDesktopReleaseStatus()
      this.assertTargetIsCurrent(currentStatus, expectedVersion)
      await this.clearPendingUpdate()
      autoUpdater.quitAndInstall(false, true)
      return { installed: true }
    } finally {
      this.updateInProgress = false
    }
  }

  private async prepareUpdate(
    status: DesktopReleaseStatus,
    expectedVersion: string
  ): Promise<void> {
    this.assertTargetIsCurrent(status, expectedVersion)
    const feedUrl = validateReleaseFeed(status)
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
    const result = await autoUpdater.checkForUpdates()
    if (!result || !result.isUpdateAvailable || result.updateInfo.version !== expectedVersion) {
      throw new Error(
        'The selected backend release ' + expectedVersion + ' is not available for this device.'
      )
    }

    await autoUpdater.downloadUpdate()
    this.downloadedVersion = expectedVersion
    await this.savePendingUpdate(expectedVersion)
  }

  private assertTargetIsCurrent(status: DesktopReleaseStatus, expectedVersion: string): void {
    if (
      !status.updateAvailable ||
      status.latestVersion !== expectedVersion ||
      !status.compatibleVersions.includes(expectedVersion)
    ) {
      throw new Error('The selected backend no longer recommends this Desktop update.')
    }
  }

  private pendingUpdatePath(): string {
    return path.join(app.getPath('userData'), PENDING_UPDATE_FILE)
  }

  private async readPendingUpdate(): Promise<PendingUpdateRecord | null> {
    try {
      const raw = await fs.readFile(this.pendingUpdatePath(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<PendingUpdateRecord>
      return typeof parsed.version === 'string' && VERSION_PATTERN.test(parsed.version)
        ? { version: parsed.version }
        : null
    } catch {
      return null
    }
  }

  private async savePendingUpdate(version: string): Promise<void> {
    const pendingPath = this.pendingUpdatePath()
    const temporaryPath = pendingPath + '.' + process.pid + '.tmp'
    await fs.mkdir(path.dirname(pendingPath), { recursive: true })
    await fs.writeFile(temporaryPath, JSON.stringify({ version }) + '\n', { mode: 0o600 })
    await fs.rename(temporaryPath, pendingPath)
  }

  private async clearPendingUpdate(): Promise<void> {
    await fs.rm(this.pendingUpdatePath(), { force: true })
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
