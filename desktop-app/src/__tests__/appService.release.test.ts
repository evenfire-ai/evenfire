import { describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { buildDesktopReleasePolicy } from '../../../external-rest-api/src/desktopReleasePolicy.js'
import { releaseManifest } from '../../../external-rest-api/src/releaseManifest.js'
import { AppService } from '../appService.js'
import { requestJson } from '../httpClient.js'

function makeReleasePolicy(
  overrides: Partial<typeof releaseManifest> = {}
): ReturnType<typeof buildDesktopReleasePolicy> {
  return buildDesktopReleasePolicy(
    {
      ...releaseManifest,
      releaseId: 'master-abc123',
      externalRestApiVersion: '0.1.50',
      rpcProxyVersion: '0.1.36',
      desktopVersion: '0.1.250',
      compatibleDesktopVersions: ['0.1.250'],
      minimumDesktopVersion: '0.1.250',
      ...overrides,
    },
    'https://github.com/your-org/evenfire/releases'
  )
}

function createServiceWithPolicy(policy: ReturnType<typeof makeReleasePolicy>) {
  const getDesktopReleasePolicy = vi.fn().mockResolvedValue(policy)
  const service = new AppService() as unknown as {
    authClient: { getDesktopReleasePolicy: typeof getDesktopReleasePolicy }
  }
  service.authClient = { getDesktopReleasePolicy }
  return { service: service as unknown as AppService, getDesktopReleasePolicy }
}

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
  it.each([
    { installed: '0.12.0', compatible: true, updateAvailable: false, updateRequired: false },
    { installed: '0.11.9', compatible: false, updateAvailable: true, updateRequired: true },
    { installed: '0.12.1', compatible: false, updateAvailable: true, updateRequired: true },
  ])(
    'uses backend compatibility membership for installed version $installed',
    async ({ installed, compatible, updateAvailable, updateRequired }) => {
      const oldPackaged = app.isPackaged
      ;(app as unknown as { isPackaged: boolean }).isPackaged = true
      vi.mocked(app.getVersion).mockReturnValue(installed)
      const { service } = createServiceWithPolicy(
        makeReleasePolicy({
          desktopVersion: '0.12.0',
          compatibleDesktopVersions: ['0.12.0'],
          minimumDesktopVersion: '0.8.0',
        })
      )

      try {
        await expect(service.getDesktopReleaseStatus()).resolves.toMatchObject({
          currentVersion: installed,
          latestVersion: '0.12.0',
          compatibleVersions: ['0.12.0'],
          compatible,
          updateAvailable,
          updateRequired,
        })
      } finally {
        ;(app as unknown as { isPackaged: boolean }).isPackaged = oldPackaged
      }
    }
  )

  it('uses the desktop package version in local Electron runs', async () => {
    vi.mocked(app.getVersion).mockReturnValue('41.3.0')
    const previousPackageVersion = process.env.npm_package_version
    process.env.npm_package_version = '0.1.249'

    const { service, getDesktopReleasePolicy } = createServiceWithPolicy(makeReleasePolicy())

    try {
      await expect(service.getDesktopReleaseStatus()).resolves.toEqual({
        checked: true,
        currentVersion: '0.1.249',
        latestVersion: '0.1.250',
        compatibleVersions: ['0.1.250'],
        compatible: false,
        updateAvailable: true,
        minimumVersion: '0.1.250',
        updateRequired: true,
        releaseUrl: 'https://github.com/your-org/evenfire/releases/tag/v0.1.250',
        releaseId: 'master-abc123',
        releaseTag: 'v0.1.250',
        externalRestApiVersion: '0.1.50',
        rpcProxyVersion: '0.1.36',
      })
      expect(getDesktopReleasePolicy).toHaveBeenCalledWith()

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

  it('accepts a compatible installed version even when the backend recommends a newer build', async () => {
    const previousPackageVersion = process.env.npm_package_version
    process.env.npm_package_version = '0.1.249'
    const { service } = createServiceWithPolicy(
      makeReleasePolicy({
        releaseId: 'release-v2',
        compatibleDesktopVersions: ['0.1.249', '0.1.250'],
        minimumDesktopVersion: '0.1.252',
      })
    )
    vi.mocked(app.getVersion).mockReturnValue('0.1.249')

    try {
      await expect(service.getDesktopReleaseStatus()).resolves.toMatchObject({
        compatibleVersions: ['0.1.249', '0.1.250'],
        compatible: true,
        updateAvailable: true,
        updateRequired: false,
      })
    } finally {
      if (previousPackageVersion === undefined) {
        delete process.env.npm_package_version
      } else {
        process.env.npm_package_version = previousPackageVersion
      }
    }
  })

  it('rejects a backend policy with no certified compatible version set', async () => {
    const { service } = createServiceWithPolicy(
      makeReleasePolicy({
        compatibleDesktopVersions: [],
        minimumDesktopVersion: '0.1.252',
      })
    )

    await expect(service.getDesktopReleaseStatus()).rejects.toThrow(
      'invalid Desktop compatibility policy'
    )
  })

  it('rejects a target that is older than another compatible build', async () => {
    const { service } = createServiceWithPolicy(
      makeReleasePolicy({
        compatibleDesktopVersions: ['0.1.250', '0.1.251'],
        minimumDesktopVersion: '0.1.252',
      })
    )

    await expect(service.getDesktopReleaseStatus()).rejects.toThrow(
      'invalid Desktop compatibility policy'
    )
  })

  it('rejects duplicate compatible Desktop versions', async () => {
    const { service } = createServiceWithPolicy(
      makeReleasePolicy({ compatibleDesktopVersions: ['0.1.250', '0.1.250'] })
    )

    await expect(service.getDesktopReleaseStatus()).rejects.toThrow(
      'invalid Desktop compatibility policy'
    )
  })

  it('normalizes release API errors without exposing response bodies or endpoint secrets', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"message":"token=secret-response-body"}', {
        status: 401,
        statusText: 'Unauthorized',
      })
    ) as typeof fetch

    try {
      const upstreamError = await requestJson(
        'GET',
        'https://user:password@api.example.test/api/v1/desktop/release?access_token=secret-query'
      ).catch(error => error)
      const { service, getDesktopReleasePolicy } = createServiceWithPolicy(makeReleasePolicy())
      getDesktopReleasePolicy.mockRejectedValue(upstreamError)

      let reportedError: unknown
      try {
        await service.getDesktopReleaseStatus()
      } catch (error) {
        reportedError = error
      }

      expect(reportedError).toBeInstanceOf(Error)
      expect((reportedError as Error).message).toBe(
        'The selected API rejected the Desktop release check (HTTP 401).'
      )
      expect((reportedError as Error).message).not.toContain('secret-response-body')
      expect((reportedError as Error).message).not.toContain('secret-query')
      expect((reportedError as Error).message).not.toContain('password')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
