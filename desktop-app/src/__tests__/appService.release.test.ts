import { describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { AppService } from '../appService.js'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/clerum-desktop-test'),
    getVersion: vi.fn(() => '0.1.249'),
    isPackaged: false,
    isReady: vi.fn(() => false),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(),
  },
}))

describe('AppService.getDesktopReleaseStatus', () => {
  it('uses the desktop package version in local Electron runs', async () => {
    vi.mocked(app.getVersion).mockReturnValue('41.3.0')
    const previousPackageVersion = process.env.npm_package_version
    process.env.npm_package_version = '0.1.249'

    const service = new AppService() as unknown as {
      sessionToken: string
      authClient: {
        getDesktopReleasePolicy: ReturnType<typeof vi.fn>
      }
      getDesktopReleaseStatus: () => Promise<{
        checked: boolean
        currentVersion: string
        latestVersion: string
        minimumVersion: string
        updateRequired: boolean
        releaseUrl: string
        releaseId?: string
        releaseTag?: string
        externalRestApiVersion?: string
        rpcProxyVersion?: string
      }>
      getDesktopAppInfo: () => Promise<{
        appName: string
        version: string
        isPackaged: boolean
      }>
    }
    service.sessionToken = 'session-token'
    service.authClient = {
      getDesktopReleasePolicy: vi.fn().mockResolvedValue({
        releaseId: 'master-abc123',
        externalRestApiVersion: '0.1.50',
        rpcProxyVersion: '0.1.36',
        desktopVersion: '0.1.250',
        minimumDesktopVersion: '0.1.250',
        releaseTag: 'desktop-app-0.1.250',
        releaseUrl: 'https://github.com/your-org/evenfire/releases/tag/desktop-app-0.1.250',
      }),
    }

    try {
      await expect(service.getDesktopReleaseStatus()).resolves.toEqual({
        checked: true,
        currentVersion: '0.1.249',
        latestVersion: '0.1.250',
        minimumVersion: '0.1.250',
        updateRequired: true,
        releaseUrl: 'https://github.com/your-org/evenfire/releases/tag/desktop-app-0.1.250',
        releaseId: 'master-abc123',
        releaseTag: 'desktop-app-0.1.250',
        externalRestApiVersion: '0.1.50',
        rpcProxyVersion: '0.1.36',
      })
      expect(service.authClient.getDesktopReleasePolicy).toHaveBeenCalledWith('session-token')

      await expect(service.getDesktopAppInfo()).resolves.toEqual({
        appName: 'Evenfire',
        version: '0.1.249',
        isPackaged: false,
      })
    } finally {
      if (previousPackageVersion === undefined) {
        delete process.env.npm_package_version
      } else {
        process.env.npm_package_version = previousPackageVersion
      }
    }
  })
})
