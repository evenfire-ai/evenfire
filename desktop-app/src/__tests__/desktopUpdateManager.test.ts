import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDesktopReleasePolicy } from '../../../external-rest-api/src/desktopReleasePolicy.js'
import { releaseManifest } from '../../../external-rest-api/src/releaseManifest.js'
import type { AppService } from '../appService.js'
import { AppService as DesktopAppService } from '../appService.js'
import { DesktopUpdateManager } from '../desktopUpdateManager.js'

const { mockApp, mockAutoUpdater } = vi.hoisted(() => ({
  mockApp: {
    isPackaged: true,
    isReady: vi.fn(() => false),
    getPath: vi.fn(),
    getVersion: vi.fn(() => '0.11.0'),
  },
  mockAutoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: false,
    disableDifferentialDownload: false,
    on: vi.fn(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

vi.mock('electron-updater', () => ({ autoUpdater: mockAutoUpdater }))

const UPDATE_VERSION = '0.12.0'

function createReleasePolicy(
  releaseBaseUrl = 'https://github.com/evenfire-ai/evenfire/releases'
): ReturnType<typeof buildDesktopReleasePolicy> {
  return buildDesktopReleasePolicy(
    {
      ...releaseManifest,
      desktopVersion: UPDATE_VERSION,
      compatibleDesktopVersions: [UPDATE_VERSION],
    },
    releaseBaseUrl
  )
}

function createPolicyBackedService(policy: ReturnType<typeof createReleasePolicy>) {
  const getDesktopReleasePolicy = vi.fn().mockResolvedValue(policy)
  const service = new DesktopAppService() as unknown as {
    authClient: { getDesktopReleasePolicy: typeof getDesktopReleasePolicy }
  }
  service.authClient = { getDesktopReleasePolicy }
  return { service: service as unknown as AppService, getDesktopReleasePolicy }
}

describe('DesktopUpdateManager', () => {
  let userDataPath: string
  let service: AppService
  let getDesktopReleasePolicy: ReturnType<typeof vi.fn>
  let manager: DesktopUpdateManager

  beforeEach(async () => {
    vi.clearAllMocks()
    userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-desktop-update-'))
    mockApp.isPackaged = true
    mockApp.getPath.mockReturnValue(userDataPath)
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: true,
      updateInfo: { version: UPDATE_VERSION },
    })
    mockAutoUpdater.downloadUpdate.mockResolvedValue([])
    const created = createPolicyBackedService(createReleasePolicy())
    service = created.service
    getDesktopReleasePolicy = created.getDesktopReleasePolicy
    manager = new DesktopUpdateManager(service, vi.fn())
  })

  afterEach(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true })
  })

  it('downloads only the selected backend tag and persists a deferred update', async () => {
    await expect(manager.downloadDesktopUpdate(UPDATE_VERSION)).resolves.toEqual({
      downloaded: true,
      version: '0.12.0',
    })

    expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://github.com/evenfire-ai/evenfire/releases/download/v0.12.0/',
    })
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledOnce()
    await expect(
      fs.readFile(path.join(userDataPath, 'desktop-update-pending.json'), 'utf8')
    ).resolves.toContain('"version":"0.12.0"')
  })

  it('rejects a stale target before contacting the updater', async () => {
    await expect(manager.downloadDesktopUpdate('0.11.0')).rejects.toThrow(
      'no longer recommends this Desktop update'
    )

    expect(mockAutoUpdater.setFeedURL).not.toHaveBeenCalled()
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('rejects a feed outside the Evenfire GitHub releases before contacting the updater', async () => {
    const untrustedService = createPolicyBackedService(
      createReleasePolicy('https://github.com/another-owner/evenfire/releases')
    )
    const untrustedManager = new DesktopUpdateManager(untrustedService.service, vi.fn())

    await expect(untrustedManager.downloadDesktopUpdate(UPDATE_VERSION)).rejects.toThrow(
      'untrusted Desktop update feed'
    )

    expect(mockAutoUpdater.setFeedURL).not.toHaveBeenCalled()
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('coalesces concurrent requests for the same release', async () => {
    let resolveDownload!: (files: string[]) => void
    mockAutoUpdater.downloadUpdate.mockReturnValue(
      new Promise<string[]>(resolve => {
        resolveDownload = resolve
      })
    )

    const first = manager.downloadDesktopUpdate(UPDATE_VERSION)
    await vi.waitFor(() => expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledOnce())
    const second = manager.downloadDesktopUpdate(UPDATE_VERSION)

    resolveDownload([])
    await expect(Promise.all([first, second])).resolves.toEqual([
      { downloaded: true, version: '0.12.0' },
      { downloaded: true, version: '0.12.0' },
    ])
    expect(getDesktopReleasePolicy).toHaveBeenCalledOnce()
  })

  it('rejects a different release while a download is in flight', async () => {
    let resolveDownload!: (files: string[]) => void
    mockAutoUpdater.downloadUpdate.mockReturnValue(
      new Promise<string[]>(resolve => {
        resolveDownload = resolve
      })
    )

    const inFlight = manager.downloadDesktopUpdate(UPDATE_VERSION)
    await vi.waitFor(() => expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledOnce())

    await expect(manager.downloadDesktopUpdate('0.13.0')).rejects.toThrow(
      'A different Desktop update is already in progress.'
    )

    resolveDownload([])
    await expect(inFlight).resolves.toEqual({ downloaded: true, version: UPDATE_VERSION })
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('clears a rejected download so the same release can be retried', async () => {
    mockAutoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('download failed'))

    await expect(manager.downloadDesktopUpdate(UPDATE_VERSION)).rejects.toThrow('download failed')
    await expect(
      fs.readFile(path.join(userDataPath, 'desktop-update-pending.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(manager.downloadDesktopUpdate(UPDATE_VERSION)).resolves.toEqual({
      downloaded: true,
      version: UPDATE_VERSION,
    })
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('restarts immediately after the explicitly requested startup update', async () => {
    await expect(manager.downloadDesktopUpdate(UPDATE_VERSION, true)).resolves.toEqual({
      downloaded: true,
      version: '0.12.0',
    })

    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
    await expect(
      fs.readFile(path.join(userDataPath, 'desktop-update-pending.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('revalidates and restores the cached updater path before deferred install', async () => {
    await manager.downloadDesktopUpdate(UPDATE_VERSION)
    const reopenedManager = new DesktopUpdateManager(service, vi.fn())

    await expect(reopenedManager.getPendingDesktopUpdate()).resolves.toEqual({
      version: UPDATE_VERSION,
    })
    await expect(reopenedManager.installDownloadedUpdate(UPDATE_VERSION)).resolves.toEqual({
      installed: true,
    })

    // A new updater instance must call downloadUpdate to validate and restore
    // electron-updater's cache path. The updater reuses the checked cache file.
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(2)
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  it('coalesces same-version installs and rejects a different version in flight', async () => {
    await manager.downloadDesktopUpdate(UPDATE_VERSION)

    let resolveStatus!: (policy: ReturnType<typeof createReleasePolicy>) => void
    getDesktopReleasePolicy.mockImplementationOnce(
      () => new Promise(resolve => (resolveStatus = resolve))
    )
    const first = manager.installDownloadedUpdate(UPDATE_VERSION)
    await vi.waitFor(() => expect(getDesktopReleasePolicy).toHaveBeenCalledTimes(2))

    const duplicate = manager.installDownloadedUpdate(UPDATE_VERSION)
    await expect(manager.installDownloadedUpdate('0.13.0')).rejects.toThrow(
      'A different Desktop update is already being installed.'
    )

    resolveStatus(createReleasePolicy())
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { installed: true },
      { installed: true },
    ])
    expect(getDesktopReleasePolicy).toHaveBeenCalledTimes(3)
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('clears a rejected install so the same release can be retried', async () => {
    await manager.downloadDesktopUpdate(UPDATE_VERSION)
    getDesktopReleasePolicy.mockRejectedValueOnce(new Error('backend unavailable'))

    await expect(manager.installDownloadedUpdate(UPDATE_VERSION)).rejects.toThrow(
      'backend unavailable'
    )
    await expect(manager.installDownloadedUpdate(UPDATE_VERSION)).resolves.toEqual({
      installed: true,
    })
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledOnce()
  })
})
