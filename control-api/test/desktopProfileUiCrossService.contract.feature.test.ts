import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createTcpServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { startExternalRestHttpProcess } from './helpers/externalRestHttpProcess.js'

const desktopElectron = vi.hoisted(() => ({ userDataPath: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: () => desktopElectron.userDataPath,
    isPackaged: false,
    isReady: () => true,
    setName: vi.fn(),
    setPath: vi.fn(),
  },
}))

const originalEnvironment = {
  profileUi: process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL,
  controlRest: process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL,
  desktopConfig: process.env.CLERUM_DESKTOP_CONFIG_PATH,
  externalPublic: process.env.EXTERNAL_REST_API_PUBLIC_BASE_URL,
  desktopRest: process.env.EXTERNAL_REST_API_BASE_URL,
  desktopRpc: process.env.RPC_PROXY_BASE_URL,
  desktopProfile: process.env.PROFILE_UI_BASE_URL,
}
let externalRestProcess: Awaited<ReturnType<typeof startExternalRestHttpProcess>> | undefined
let desktopDataDirectory: string | undefined

async function reserveLoopbackPort(): Promise<number> {
  const server = createTcpServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback port was not allocated')
  const port = address.port
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  )
  return port
}

afterEach(async () => {
  await externalRestProcess?.stop()
  externalRestProcess = undefined
  if (desktopDataDirectory) await rm(desktopDataDirectory, { recursive: true, force: true })
  desktopDataDirectory = undefined
  for (const [key, value] of Object.entries({
    CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: originalEnvironment.profileUi,
    CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL: originalEnvironment.controlRest,
    CLERUM_DESKTOP_CONFIG_PATH: originalEnvironment.desktopConfig,
    EXTERNAL_REST_API_PUBLIC_BASE_URL: originalEnvironment.externalPublic,
    EXTERNAL_REST_API_BASE_URL: originalEnvironment.desktopRest,
    RPC_PROXY_BASE_URL: originalEnvironment.desktopRpc,
    PROFILE_UI_BASE_URL: originalEnvironment.desktopProfile,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.doUnmock('../src/memberRegistrationServiceClient.js')
  vi.doUnmock('../../external-rest-api/src/config.js')
  vi.doUnmock('../../external-rest-api/src/routes/desktop.js')
  vi.resetModules()
})

describe('Profile UI origin cross-service compatibility', () => {
  it('carries the canonical origin from the real REST producer through Desktop persistence and invitation use', async () => {
    const profileUiBaseUrl = 'https://profile.legacy.example.test'
    const port = await reserveLoopbackPort()
    const externalRestBaseUrl = `http://127.0.0.1:${port}`
    process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = profileUiBaseUrl
    process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL = externalRestBaseUrl
    process.env.EXTERNAL_REST_API_PUBLIC_BASE_URL = externalRestBaseUrl
    desktopDataDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'evenfire-profile-origin-contract-')
    )
    desktopElectron.userDataPath = desktopDataDirectory
    process.env.CLERUM_DESKTOP_CONFIG_PATH = path.join(desktopDataDirectory, 'runtime.json')
    delete process.env.EXTERNAL_REST_API_BASE_URL
    delete process.env.RPC_PROXY_BASE_URL
    delete process.env.PROFILE_UI_BASE_URL

    externalRestProcess = await startExternalRestHttpProcess({
      controlApiBaseUrl: 'http://127.0.0.1:1',
      controlApiServiceToken: 'synthetic-profile-origin-contract-token',
      publicBaseUrl: externalRestBaseUrl,
      desktopProfileUiBaseUrl: profileUiBaseUrl,
    })

    const desktopConfig = await import('../../desktop-app/src/config.js')
    const { AuthClient } = await import('../../desktop-app/src/authClient.js')
    await desktopConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: externalRestBaseUrl,
      rpcProxyBaseUrl: 'http://127.0.0.1:8092',
      appName: 'Compatibility fixture',
    })
    const discovered = await new AuthClient().getDesktopEnvironmentForEndpoint(externalRestBaseUrl)
    expect(discovered.profileUiBaseUrl).toBe(profileUiBaseUrl)
    const { AppService } = await import('../../desktop-app/src/appService.js')
    const service = new AppService() as AppService & {
      me: { id: string; email: string }
      sessionToken: string
    }
    service.me = { id: 'contract-user', email: 'member@example.test' }
    service.sessionToken = 'synthetic-contract-session'
    const resource = 'gfs://main/0123456789abcdef0123456789abcdef'
    const result = await service.createGfsResourceDeepLink(resource)
    expect(result.url).toBe(`${profileUiBaseUrl}/open/files?uri=${encodeURIComponent(resource)}`)
    const identity = desktopConfig.captureProfileOriginBinding()
    const option = desktopConfig
      .getDesktopRuntimeConfigState()
      .options.find(candidate => candidate.id === identity.profileId)
    if (!option?.configPath) throw new Error('Desktop profile JSON path is unavailable')
    const saved = JSON.parse(await readFile(option.configPath, 'utf8')) as {
      profileUiBaseUrl?: string
    }
    expect(saved.profileUiBaseUrl).toBe(profileUiBaseUrl)

    const registrationRequest = vi.fn().mockResolvedValue({ sent: true, registered: true })
    vi.doMock('../src/memberRegistrationServiceClient.js', () => ({
      memberRegistrationServiceRequest: registrationRequest,
    }))
    const controlConfig = await import('../src/config.js')
    const { registerAndSendInvitation } =
      await import('../src/services/invitationFlowRegistrationService.js')
    await registerAndSendInvitation(
      'member@example.test',
      'invitation-cross-service',
      null,
      '2026-11-15T00:00:00.000Z',
      '2026-11-16T00:00:00.000Z'
    )
    expect(controlConfig.config.desktopProfileUiBaseUrl).toBe(saved.profileUiBaseUrl)
    expect(registrationRequest).toHaveBeenCalledWith(
      'POST',
      '/invitations-flow/invitations',
      expect.objectContaining({
        destinationBaseUrl: saved.profileUiBaseUrl,
        body: expect.objectContaining({ desktopProfileUiBaseUrl: saved.profileUiBaseUrl }),
      })
    )
  })

  it('keeps the actual producer response compatible when the optional origin is unset', async () => {
    delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
    const port = await reserveLoopbackPort()
    const legacyBaseUrl = `http://127.0.0.1:${port}`
    externalRestProcess = await startExternalRestHttpProcess({
      controlApiBaseUrl: 'http://127.0.0.1:1',
      controlApiServiceToken: 'synthetic-legacy-origin-contract-token',
      publicBaseUrl: legacyBaseUrl,
      desktopProfileUiBaseUrl: null,
    })
    const producerResponse = await fetch(`${legacyBaseUrl}/api/v1/desktop/environment`)
    expect(producerResponse.status).toBe(200)
    const producerPayload = await producerResponse.json()
    expect(Object.keys(producerPayload).sort()).toEqual([
      'appName',
      'externalRestApiBaseUrl',
      'rpcProxyBaseUrl',
    ])
    const rpcProxyBaseUrl = (producerPayload as { rpcProxyBaseUrl: string }).rpcProxyBaseUrl
    desktopDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'evenfire-legacy-desktop-origin-'))
    desktopElectron.userDataPath = desktopDataDirectory
    process.env.CLERUM_DESKTOP_CONFIG_PATH = path.join(desktopDataDirectory, 'runtime.json')
    delete process.env.EXTERNAL_REST_API_BASE_URL
    delete process.env.RPC_PROXY_BASE_URL
    delete process.env.PROFILE_UI_BASE_URL
    const desktopConfig = await import('../../desktop-app/src/config.js')
    await desktopConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: legacyBaseUrl,
      rpcProxyBaseUrl,
      appName: 'Legacy server',
    })
    const { AuthClient } = await import('../../desktop-app/src/authClient.js')
    const received = await new AuthClient().getDesktopEnvironmentForEndpoint(legacyBaseUrl)
    expect(received.externalRestApiBaseUrl).toBe(legacyBaseUrl)
    expect(received.profileUiBaseUrl).toBeUndefined()

    const { AppService } = await import('../../desktop-app/src/appService.js')
    const driver = await import('../../desktop-app/src/sandboxUiDriver.js')
    vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue({
      recipeNs: 'legacy-recipes',
      recipeName: 'legacy-app',
      path: '/legacy',
    })
    const service = new AppService() as AppService & {
      me: { id: string; email: string }
      sessionToken: string
      suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
      stopAllStreams: () => void
      ensureEntityChangeConnection: () => void
    }
    service.sessionToken = 'synthetic-legacy-server-session'
    service.me = { id: 'legacy-user', email: 'legacy@example.test' }
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
    service.stopAllStreams = vi.fn()
    service.ensureEntityChangeConnection = vi.fn()

    await expect(service.createSandboxUiDeepLink()).resolves.toMatchObject({
      url: 'http://127.0.0.1:3001/open/apps/legacy-recipes/legacy-app?path=%2Flegacy',
    })
    const state = desktopConfig.getDesktopRuntimeConfigState()
    const savedOption = state.options.find(option => option.id === state.activeOptionId)
    if (!savedOption?.configPath) throw new Error('Desktop legacy profile JSON is unavailable')
    const savedAfterLegacyResolution = JSON.parse(
      await readFile(savedOption.configPath, 'utf8')
    ) as Record<string, unknown>
    expect(savedAfterLegacyResolution).not.toHaveProperty('profileUiBaseUrl')
  })
})
