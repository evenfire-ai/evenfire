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
        // Deprecated compat field: deliberately different from desktopVersion
        // to prove the client ignores it.
        minimumDesktopVersion: '0.0.1',
        releaseTag: 'desktop-app-0.1.250',
        releaseUrl: 'https://github.com/your-org/evenfire/releases/tag/desktop-app-0.1.250',
      }),
    }

    try {
      await expect(service.getDesktopReleaseStatus()).resolves.toEqual({
        checked: true,
        currentVersion: '0.1.249',
        latestVersion: '0.1.250',
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

  describe('updateRequired is driven by the release desktopVersion', () => {
    const statusFor = async (currentVersion: string, policyOverrides: Record<string, unknown>) => {
      const previousPackageVersion = process.env.npm_package_version
      process.env.npm_package_version = currentVersion
      const service = new AppService() as unknown as {
        sessionToken: string
        authClient: { getDesktopReleasePolicy: ReturnType<typeof vi.fn> }
        getDesktopReleaseStatus: () => Promise<{ latestVersion: string; updateRequired: boolean }>
      }
      service.sessionToken = 'session-token'
      service.authClient = {
        getDesktopReleasePolicy: vi.fn().mockResolvedValue({
          releaseId: 'release-0.11.0',
          releaseTag: 'v0.11.0',
          releaseUrl: 'https://github.com/your-org/evenfire/releases/tag/v0.11.0',
          ...policyOverrides,
        }),
      }
      try {
        return await service.getDesktopReleaseStatus()
      } finally {
        if (previousPackageVersion === undefined) {
          delete process.env.npm_package_version
        } else {
          process.env.npm_package_version = previousPackageVersion
        }
      }
    }

    it('requires an update when the installed version is older', async () => {
      await expect(statusFor('0.10.9', { desktopVersion: '0.11.0' })).resolves.toMatchObject({
        latestVersion: '0.11.0',
        updateRequired: true,
      })
    })

    it('does not require an update when the installed version is equal', async () => {
      await expect(statusFor('0.11.0', { desktopVersion: '0.11.0' })).resolves.toMatchObject({
        latestVersion: '0.11.0',
        updateRequired: false,
      })
    })

    it('does not require an update when the installed version is newer', async () => {
      await expect(statusFor('0.12.0', { desktopVersion: '0.11.0' })).resolves.toMatchObject({
        latestVersion: '0.11.0',
        updateRequired: false,
      })
    })

    it('ignores the deprecated minimumDesktopVersion field', async () => {
      await expect(
        statusFor('0.11.0', { desktopVersion: '0.11.0', minimumDesktopVersion: '0.12.0' })
      ).resolves.toMatchObject({ updateRequired: false })
      await expect(
        statusFor('0.10.0', { desktopVersion: '0.11.0', minimumDesktopVersion: '0.1.0' })
      ).resolves.toMatchObject({ updateRequired: true })
    })

    it('does not require an update or throw when desktopVersion is missing', async () => {
      await expect(statusFor('0.10.0', {})).resolves.toMatchObject({
        latestVersion: '',
        updateRequired: false,
      })
    })

    it('does not require an update or throw when desktopVersion is malformed', async () => {
      for (const desktopVersion of ['', 'not-a-version', 42, null]) {
        await expect(statusFor('0.10.0', { desktopVersion })).resolves.toMatchObject({
          latestVersion: '',
          updateRequired: false,
        })
      }
    })
  })
})
