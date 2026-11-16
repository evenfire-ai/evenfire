import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { type Server as HttpServer, createServer as createHttpServer } from 'node:http'
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
}
let externalRestProcess: Awaited<ReturnType<typeof startExternalRestHttpProcess>> | undefined
let legacyServer: HttpServer | undefined
let desktopDataDirectory: string | undefined

// Source-pinned fixture for the pre-feature producer at
// 1b1b1131ef784929f7f5551c509f0aa2f4b19de6:
// external-rest-api/src/routes/desktop.ts. Keep this three-field response
// builder independent from the current router so new config validation cannot
// accidentally manufacture an old-server response.
const pinnedLegacyDesktopEnvironment = {
  sourceRevision: '1b1b1131ef784929f7f5551c509f0aa2f4b19de6',
  createResponse: (legacyConfig: {
    desktopAppName: string
    publicBaseUrl: string
    desktopRpcProxyBaseUrl: string
  }) => ({
    appName: legacyConfig.desktopAppName,
    externalRestApiBaseUrl: legacyConfig.publicBaseUrl,
    rpcProxyBaseUrl: legacyConfig.desktopRpcProxyBaseUrl,
  }),
}

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
  if (legacyServer?.listening) {
    await new Promise<void>((resolve, reject) =>
      legacyServer!.close(error => (error ? reject(error) : resolve()))
    )
  }
  legacyServer = undefined
  if (desktopDataDirectory) await rm(desktopDataDirectory, { recursive: true, force: true })
  desktopDataDirectory = undefined
  for (const [key, value] of Object.entries({
    CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: originalEnvironment.profileUi,
    CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL: originalEnvironment.controlRest,
    CLERUM_DESKTOP_CONFIG_PATH: originalEnvironment.desktopConfig,
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
    const identity = desktopConfig.getActiveRuntimeConfigProfileIdentity()
    if (!identity) throw new Error('Desktop runtime profile identity was not created')

    const discovered = await new AuthClient().getDesktopEnvironmentForEndpoint(externalRestBaseUrl)
    expect(discovered.profileUiBaseUrl).toBe(profileUiBaseUrl)
    const validated = desktopConfig.validateProfileUiOrigin(
      discovered.profileUiBaseUrl,
      identity.externalRestApiBaseUrl
    )
    await desktopConfig.persistProfileUiOrigin(identity, validated)
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

  it('keeps the pinned pre-feature discovery response compatible with the updated client', async () => {
    delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
    const legacyConfig = {
      desktopAppName: 'Example Tenant',
      publicBaseUrl: '',
      desktopRpcProxyBaseUrl: 'http://127.0.0.1:8092',
    }
    legacyServer = createHttpServer((request, response) => {
      if (request.url !== '/api/v1/desktop/environment') {
        response.writeHead(404).end()
        return
      }
      const address = legacyServer?.address()
      if (!address || typeof address === 'string') {
        response.writeHead(500).end()
        return
      }
      legacyConfig.publicBaseUrl = `http://127.0.0.1:${address.port}`
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(pinnedLegacyDesktopEnvironment.createResponse(legacyConfig)))
    })
    await new Promise<void>((resolve, reject) => {
      legacyServer!.once('error', reject)
      legacyServer!.listen(0, '127.0.0.1', () => resolve())
    })
    const address = legacyServer.address()
    if (!address || typeof address === 'string')
      throw new Error('legacy REST listener is unavailable')
    const legacyBaseUrl = `http://127.0.0.1:${address.port}`
    desktopDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'evenfire-legacy-desktop-origin-'))
    desktopElectron.userDataPath = desktopDataDirectory
    const desktopConfig = await import('../../desktop-app/src/config.js')
    await desktopConfig.saveDesktopRuntimeConfig({
      externalRestApiBaseUrl: legacyBaseUrl,
      rpcProxyBaseUrl: legacyConfig.desktopRpcProxyBaseUrl,
      appName: 'Legacy server',
    })
    const { AuthClient } = await import('../../desktop-app/src/authClient.js')
    const received = await new AuthClient().getDesktopEnvironmentForEndpoint(legacyBaseUrl)
    expect(received.externalRestApiBaseUrl).toBe(legacyBaseUrl)
    expect(received.profileUiBaseUrl).toBeUndefined()
    expect(received.responseUrl).toBe(`${legacyBaseUrl}/api/v1/desktop/environment`)

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
