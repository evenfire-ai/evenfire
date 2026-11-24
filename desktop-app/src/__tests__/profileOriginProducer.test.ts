import { afterEach, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

vi.mock('../chatStoreBinding.js', () => ({
  bindChatStoreForUser: vi.fn(),
  unbindChatStore: vi.fn(),
  __setChatStoreBaseDirForTests: vi.fn(),
}))

const keys = [
  'NODE_ENV',
  'CLERUM_DEV_MODE',
  'CLERUM_DESKTOP_CONFIG_PATH',
  'PROFILE_UI_BASE_URL',
  'EXTERNAL_REST_API_BASE_URL',
  'RPC_PROXY_BASE_URL',
  'CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL',
  'EXTERNAL_REST_API_CORS_ORIGIN',
  'EXTERNAL_REST_API_GOOGLE_CLIENT_ID',
  'EXTERNAL_REST_API_CONTROL_API_BASE_URL',
  'EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN',
  'EXTERNAL_REST_API_JWT_PUBLIC_KEY',
  'EXTERNAL_REST_API_JWT_ISSUER',
  'EXTERNAL_REST_API_JWT_AUDIENCE',
  'EXTERNAL_REST_API_PUBLIC_BASE_URL',
  'EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL',
  'EXTERNAL_REST_API_DESKTOP_APP_NAME',
] as const
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))

function loopbackOrigin(port: number): string {
  const url = new URL('http://127.0.0.1')
  url.port = String(port)
  return url.origin
}

let directory: string | undefined
let server: http.Server | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close(error => (error ? reject(error) : resolve()))
    )
  server = undefined
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  vi.doUnmock('electron')
  vi.resetModules()
  if (directory) await fs.rm(directory, { recursive: true, force: true })
  directory = undefined
})

it('uses the real External REST discovery response for a selected profile', async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-origin-producer-'))
  const file = path.join(directory, 'profile.json')
  let handler: http.RequestListener = (_request, response) => {
    response.statusCode = 503
    response.end()
  }
  server = http.createServer((request, response) => handler(request, response))
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback server has no port')
  const rest = `http://127.0.0.1:${address.port}`
  const profileOrigin = loopbackOrigin(3217)
  const rpc = loopbackOrigin(8094)
  await fs.writeFile(
    file,
    JSON.stringify({ externalRestApiBaseUrl: rest, rpcProxyBaseUrl: rpc, appName: 'A' })
  )
  const publicKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).publicKey
  Object.assign(process.env, {
    NODE_ENV: 'production',
    CLERUM_DESKTOP_CONFIG_PATH: file,
    CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: profileOrigin,
    EXTERNAL_REST_API_CORS_ORIGIN: profileOrigin,
    EXTERNAL_REST_API_GOOGLE_CLIENT_ID: 'synthetic-client',
    EXTERNAL_REST_API_CONTROL_API_BASE_URL: 'https://control.example.test/api/v1',
    EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: 'synthetic-test-service-token',
    EXTERNAL_REST_API_JWT_PUBLIC_KEY: publicKey,
    EXTERNAL_REST_API_JWT_ISSUER: 'control-api',
    EXTERNAL_REST_API_JWT_AUDIENCE: 'profile-ui',
    EXTERNAL_REST_API_PUBLIC_BASE_URL: rest,
    EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL: rpc,
  })
  delete process.env.CLERUM_DEV_MODE
  delete process.env.PROFILE_UI_BASE_URL
  delete process.env.EXTERNAL_REST_API_BASE_URL
  delete process.env.RPC_PROXY_BASE_URL
  const openExternal = vi.fn().mockResolvedValue(undefined)
  vi.doMock('electron', () => ({
    app: {
      getPath: () => directory,
      isReady: () => true,
      isPackaged: false,
      setName: vi.fn(),
      setPath: vi.fn(),
    },
    shell: { openExternal },
  }))
  const { createDesktopRouter } = await import('../../../external-rest-api/src/routes/desktop.js')
  const express = createRequire(path.resolve(process.cwd(), '../external-rest-api/package.json'))(
    'express'
  )
  const app = express()
  app.use('/api/v1', createDesktopRouter())
  handler = app
  const producerResponse = await fetch(`${rest}/api/v1/desktop/environment`)
  expect(producerResponse.status).toBe(200)
  expect(await producerResponse.json()).toMatchObject({ profileUiBaseUrl: profileOrigin })
  const [{ AppService }, runtime] = await Promise.all([
    import('../appService.js'),
    import('../config.js'),
  ])
  expect(runtime.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
  const service = new AppService()
  const result = await service.openForgotPassword('user@example.test')
  expect(result.profileUiUrl).toBe(`${profileOrigin}/forgot-password?email=user%40example.test`)
  expect(openExternal).toHaveBeenCalledWith(result.profileUiUrl)
  expect(JSON.parse(await fs.readFile(file, 'utf8')).profileUiBaseUrl).toBe(profileOrigin)
}, 15000)

it.each([
  {
    transport: 'remote HTTP',
    configuredRest: 'http://rest.example.test',
    expectedOrigin: 'https://legacy-profile.example.test',
  },
  {
    transport: 'remote HTTPS',
    configuredRest: 'https://rest.example.test',
    expectedOrigin: 'https://profile.example.test',
  },
])(
  'applies source transport trust to $transport discovery',
  async ({ configuredRest, expectedOrigin }) => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-origin-insecure-source-'))
    const file = path.join(directory, 'profile.json')
    let handler: http.RequestListener = (_request, response) => {
      response.statusCode = 503
      response.end()
    }
    server = http.createServer((request, response) => handler(request, response))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback server has no port')
    const producerRest = `http://127.0.0.1:${address.port}`
    const profileOrigin = 'https://profile.example.test'
    const rpc = 'https://rpc.example.test'
    await fs.writeFile(
      file,
      JSON.stringify({ externalRestApiBaseUrl: configuredRest, rpcProxyBaseUrl: rpc, appName: 'A' })
    )
    const publicKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }).publicKey
    Object.assign(process.env, {
      NODE_ENV: 'production',
      CLERUM_DESKTOP_CONFIG_PATH: file,
      PROFILE_UI_BASE_URL: 'https://legacy-profile.example.test',
      CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: profileOrigin,
      EXTERNAL_REST_API_CORS_ORIGIN: profileOrigin,
      EXTERNAL_REST_API_GOOGLE_CLIENT_ID: 'synthetic-client',
      EXTERNAL_REST_API_CONTROL_API_BASE_URL: 'https://control.example.test/api/v1',
      EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: 'synthetic-test-service-token',
      EXTERNAL_REST_API_JWT_PUBLIC_KEY: publicKey,
      EXTERNAL_REST_API_JWT_ISSUER: 'control-api',
      EXTERNAL_REST_API_JWT_AUDIENCE: 'profile-ui',
      EXTERNAL_REST_API_PUBLIC_BASE_URL: configuredRest,
      EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL: rpc,
    })
    delete process.env.CLERUM_DEV_MODE
    delete process.env.EXTERNAL_REST_API_BASE_URL
    delete process.env.RPC_PROXY_BASE_URL
    const openExternal = vi.fn().mockResolvedValue(undefined)
    vi.doMock('electron', () => ({
      app: {
        getPath: () => directory,
        isReady: () => true,
        isPackaged: false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      shell: { openExternal },
    }))
    const { createDesktopRouter } = await import('../../../external-rest-api/src/routes/desktop.js')
    const express = createRequire(path.resolve(process.cwd(), '../external-rest-api/package.json'))(
      'express'
    )
    const app = express()
    app.use('/api/v1', createDesktopRouter())
    handler = app
    const producerResponse = await fetch(`${producerRest}/api/v1/desktop/environment`)
    expect(producerResponse.status).toBe(200)
    expect(await producerResponse.json()).toMatchObject({ profileUiBaseUrl: profileOrigin })
    const actualFetch = globalThis.fetch.bind(globalThis)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const target = String(input)
      const response = await actualFetch(
        target.startsWith(configuredRest) ? target.replace(configuredRest, producerRest) : input,
        init
      )
      if (!target.startsWith(configuredRest)) return response
      const mappedResponse = new Response(await response.text(), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
      Object.defineProperty(mappedResponse, 'url', { value: target })
      return mappedResponse
    })
    const [{ AppService }, runtime] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
    ])
    expect(runtime.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
    const result = await new AppService().openForgotPassword('user@example.test')
    expect(result.profileUiUrl).toBe(`${expectedOrigin}/forgot-password?email=user%40example.test`)
    expect(openExternal).toHaveBeenCalledWith(result.profileUiUrl)
    const savedProfile = JSON.parse(await fs.readFile(file, 'utf8'))
    if (expectedOrigin === profileOrigin) {
      expect(savedProfile.profileUiBaseUrl).toBe(profileOrigin)
    } else {
      expect(savedProfile).not.toHaveProperty('profileUiBaseUrl')
    }
  },
  15000
)

it('does not dispatch or persist when discovery redirects', async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-origin-redirect-'))
  const file = path.join(directory, 'profile.json')
  server = http.createServer((_request, response) => {
    response.writeHead(302, { location: 'https://redirected.example.test/environment' })
    response.end()
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback server has no port')
  const rest = `http://127.0.0.1:${address.port}`
  await fs.writeFile(
    file,
    JSON.stringify({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: loopbackOrigin(8094),
      appName: 'A',
    })
  )
  process.env.CLERUM_DESKTOP_CONFIG_PATH = file
  delete process.env.PROFILE_UI_BASE_URL
  delete process.env.EXTERNAL_REST_API_BASE_URL
  delete process.env.RPC_PROXY_BASE_URL
  const openExternal = vi.fn().mockResolvedValue(undefined)
  vi.doMock('electron', () => ({
    app: {
      getPath: () => directory,
      isReady: () => true,
      isPackaged: false,
      setName: vi.fn(),
      setPath: vi.fn(),
    },
    shell: { openExternal },
  }))
  const { AppService } = await import('../appService.js')
  await expect(new AppService().openForgotPassword('user@example.test')).rejects.toThrow(
    'desktop_environment_redirect_rejected'
  )
  expect(openExternal).not.toHaveBeenCalled()
  expect(JSON.parse(await fs.readFile(file, 'utf8'))).not.toHaveProperty('profileUiBaseUrl')
}, 15000)

it.each(['different REST endpoint', 'invalid Profile origin'] as const)(
  'rejects a discovery response with %s',
  async kind => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-origin-invalid-'))
    const file = path.join(directory, 'profile.json')
    let rest = ''
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          appName: 'A',
          externalRestApiBaseUrl:
            kind === 'different REST endpoint' ? 'https://other.example.test' : rest,
          rpcProxyBaseUrl: loopbackOrigin(8094),
          profileUiBaseUrl:
            kind === 'invalid Profile origin' ? 'javascript:alert(1)' : loopbackOrigin(3217),
        })
      )
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback server has no port')
    rest = `http://127.0.0.1:${address.port}`
    await fs.writeFile(
      file,
      JSON.stringify({
        externalRestApiBaseUrl: rest,
        rpcProxyBaseUrl: loopbackOrigin(8094),
        appName: 'A',
      })
    )
    process.env.CLERUM_DESKTOP_CONFIG_PATH = file
    delete process.env.PROFILE_UI_BASE_URL
    delete process.env.EXTERNAL_REST_API_BASE_URL
    delete process.env.RPC_PROXY_BASE_URL
    const openExternal = vi.fn().mockResolvedValue(undefined)
    vi.doMock('electron', () => ({
      app: {
        getPath: () => directory,
        isReady: () => true,
        isPackaged: false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      shell: { openExternal },
    }))
    const { AppService } = await import('../appService.js')
    await expect(new AppService().openForgotPassword('user@example.test')).rejects.toThrow()
    expect(openExternal).not.toHaveBeenCalled()
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).not.toHaveProperty('profileUiBaseUrl')
  },
  15000
)

it('rejects an invalid origin for configured REST without a saved profile', async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-origin-no-id-invalid-'))
  let rest = ''
  server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        appName: 'A',
        externalRestApiBaseUrl: rest,
        rpcProxyBaseUrl: loopbackOrigin(8094),
        profileUiBaseUrl: 'https://profile.example.test/not-an-origin',
      })
    )
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback server has no port')
  rest = `http://127.0.0.1:${address.port}`
  delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  delete process.env.PROFILE_UI_BASE_URL
  process.env.EXTERNAL_REST_API_BASE_URL = rest
  process.env.RPC_PROXY_BASE_URL = loopbackOrigin(8094)
  const openExternal = vi.fn().mockResolvedValue(undefined)
  vi.doMock('electron', () => ({
    app: {
      getPath: () => directory,
      isReady: () => true,
      isPackaged: false,
      setName: vi.fn(),
      setPath: vi.fn(),
    },
    shell: { openExternal },
  }))
  const [{ AppService }, runtime] = await Promise.all([
    import('../appService.js'),
    import('../config.js'),
  ])
  expect(runtime.getDesktopRuntimeConfigState().activeOptionId).toBeNull()
  await expect(new AppService().openForgotPassword('user@example.test')).rejects.toThrow(
    'Invalid Profile UI origin'
  )
  expect(openExternal).not.toHaveBeenCalled()
}, 15000)

it.each(['{', '[]'])(
  'uses legacy fallback when discovery payload %s is unreadable',
  async payload => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-origin-malformed-'))
    const file = path.join(directory, 'profile.json')
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(payload)
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback server has no port')
    const rest = `http://127.0.0.1:${address.port}`
    await fs.writeFile(
      file,
      JSON.stringify({
        externalRestApiBaseUrl: rest,
        rpcProxyBaseUrl: loopbackOrigin(8094),
        appName: 'A',
      })
    )
    process.env.CLERUM_DESKTOP_CONFIG_PATH = file
    delete process.env.PROFILE_UI_BASE_URL
    delete process.env.EXTERNAL_REST_API_BASE_URL
    delete process.env.RPC_PROXY_BASE_URL
    const openExternal = vi.fn().mockResolvedValue(undefined)
    vi.doMock('electron', () => ({
      app: {
        getPath: () => directory,
        isReady: () => true,
        isPackaged: false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      shell: { openExternal },
    }))
    const { AppService } = await import('../appService.js')
    const result = await new AppService().openForgotPassword('user@example.test')
    expect(result.profileUiUrl).toBe(
      `${loopbackOrigin(3001)}/forgot-password?email=user%40example.test`
    )
    expect(openExternal).toHaveBeenCalledWith(result.profileUiUrl)
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).not.toHaveProperty('profileUiBaseUrl')
  },
  15000
)

it.each(['forgot', 'password', 'social', 'app', 'gfs'] as const)(
  'preserves legacy %s when the producer omits the origin and advertises a different REST address',
  async kind => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-origin-old-server-'))
    const file = path.join(directory, 'profile.json')
    let requests = 0
    const publicKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }).publicKey
    Object.assign(process.env, {
      NODE_ENV: 'production',
      EXTERNAL_REST_API_CORS_ORIGIN: 'https://profile.example.test',
      EXTERNAL_REST_API_GOOGLE_CLIENT_ID: 'synthetic-client',
      EXTERNAL_REST_API_CONTROL_API_BASE_URL: 'https://control.example.test/api/v1',
      EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: 'synthetic-test-service-token',
      EXTERNAL_REST_API_JWT_PUBLIC_KEY: publicKey,
      EXTERNAL_REST_API_JWT_ISSUER: 'control-api',
      EXTERNAL_REST_API_JWT_AUDIENCE: 'profile-ui',
      EXTERNAL_REST_API_PUBLIC_BASE_URL: 'https://canonical.example.test',
      EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL: loopbackOrigin(8094),
      EXTERNAL_REST_API_DESKTOP_APP_NAME: 'A',
    })
    delete process.env.CLERUM_DEV_MODE
    delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
    vi.resetModules()
    const { createDesktopRouter } = await import('../../../external-rest-api/src/routes/desktop.js')
    const express = createRequire(path.resolve(process.cwd(), '../external-rest-api/package.json'))(
      'express'
    )
    const app = express()
    app.use('/api/v1', (_request: unknown, _response: unknown, next: () => void) => {
      requests += 1
      next()
    })
    app.use('/api/v1', createDesktopRouter())
    server = http.createServer(app)
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback server has no port')
    const rest = `http://127.0.0.1:${address.port}`
    const initial = JSON.stringify({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: loopbackOrigin(8094),
      appName: 'A',
    })
    await fs.writeFile(file, initial)
    process.env.CLERUM_DESKTOP_CONFIG_PATH = file
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://other.example.test'
    process.env.PROFILE_UI_BASE_URL = 'https://legacy.example.test'
    delete process.env.RPC_PROXY_BASE_URL
    const openExternal = vi.fn().mockResolvedValue(undefined)
    vi.doMock('electron', () => ({
      app: {
        getPath: () => directory,
        isReady: () => true,
        isPackaged: false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      shell: { openExternal },
    }))
    const [{ AppService }, runtime, driver] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
      import('../sandboxUiDriver.js'),
    ])
    vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/tasks/42',
    })
    const service = new AppService() as any
    service.sessionToken = 'synthetic-session'
    service.me = { id: 'user-1', email: 'user@example.test' }
    if (kind === 'forgot')
      expect((await service.openForgotPassword('user@example.test')).profileUiUrl).toBe(
        'https://legacy.example.test/forgot-password?email=user%40example.test'
      )
    if (kind === 'password')
      expect(
        (await service.openProfileSettings('user@example.test', { action: 'password' }))
          .profileUiUrl
      ).toBe('https://legacy.example.test/settings/profile?action=password')
    if (kind === 'social')
      expect(
        (
          await service.openProfileSettings('user@example.test', {
            section: 'social',
            network: 'slack',
          })
        ).profileUiUrl
      ).toBe('https://legacy.example.test/channels/slack')
    if (kind === 'app')
      expect((await service.createSandboxUiDeepLink()).url).toBe(
        `${loopbackOrigin(3001)}/open/apps/sandbox-recipes/task-board?path=%2Ftasks%2F42`
      )
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    if (kind === 'gfs')
      expect((await service.createGfsResourceDeepLink(uri)).url).toBe(
        `${loopbackOrigin(3001)}/open/files?uri=${encodeURIComponent(uri)}`
      )
    expect(requests).toBe(1)
    expect(await fs.readFile(file, 'utf8')).toBe(initial)
    expect(runtime.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
  },
  15000
)

it.each(['forgot', 'password', 'social', 'app', 'gfs'] as const)(
  'uses the real upgraded producer origin for %s instead of an unpaired override',
  async kind => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-origin-upgraded-server-'))
    const file = path.join(directory, 'profile.json')
    const origin = 'https://profile-authoritative.example.test'
    const rpc = loopbackOrigin(8094)
    let requests = 0
    server = http.createServer()
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback server has no port')
    const rest = `http://127.0.0.1:${address.port}`
    await fs.writeFile(
      file,
      JSON.stringify({ externalRestApiBaseUrl: rest, rpcProxyBaseUrl: rpc, appName: 'A' })
    )
    const publicKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }).publicKey
    Object.assign(process.env, {
      NODE_ENV: 'production',
      EXTERNAL_REST_API_PUBLIC_BASE_URL: rest,
      EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL: rpc,
      EXTERNAL_REST_API_DESKTOP_APP_NAME: 'A',
      CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: origin,
      EXTERNAL_REST_API_CORS_ORIGIN: origin,
      EXTERNAL_REST_API_GOOGLE_CLIENT_ID: 'synthetic-client',
      EXTERNAL_REST_API_CONTROL_API_BASE_URL: 'https://control.example.test/api/v1',
      EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: 'synthetic-test-service-token',
      EXTERNAL_REST_API_JWT_PUBLIC_KEY: publicKey,
      EXTERNAL_REST_API_JWT_ISSUER: 'control-api',
      EXTERNAL_REST_API_JWT_AUDIENCE: 'profile-ui',
    })
    delete process.env.CLERUM_DEV_MODE
    vi.resetModules()
    const { createDesktopRouter } = await import('../../../external-rest-api/src/routes/desktop.js')
    const express = createRequire(path.resolve(process.cwd(), '../external-rest-api/package.json'))(
      'express'
    )
    const app = express()
    app.use('/api/v1/desktop/environment', (_request: any, _response: any, next: () => void) => {
      requests += 1
      next()
    })
    app.use('/api/v1', createDesktopRouter())
    server.removeAllListeners('request')
    server.on('request', app)
    process.env.CLERUM_DESKTOP_CONFIG_PATH = file
    process.env.EXTERNAL_REST_API_BASE_URL = 'https://other.example.test'
    process.env.PROFILE_UI_BASE_URL = 'https://override.example.test'
    delete process.env.RPC_PROXY_BASE_URL
    const openExternal = vi.fn().mockResolvedValue(undefined)
    vi.doMock('electron', () => ({
      app: {
        getPath: () => directory,
        isReady: () => true,
        isPackaged: false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      shell: { openExternal },
    }))
    const [{ AppService }, runtime, driver] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
      import('../sandboxUiDriver.js'),
    ])
    vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/tasks/42',
    })
    const service = new AppService() as any
    service.sessionToken = 'synthetic-session'
    service.me = { id: 'user-1', email: 'user@example.test' }
    expect(requests).toBe(0)
    if (kind === 'forgot')
      expect((await service.openForgotPassword('user@example.test')).profileUiUrl).toBe(
        `${origin}/forgot-password?email=user%40example.test`
      )
    if (kind === 'password')
      expect(
        (await service.openProfileSettings('user@example.test', { action: 'password' }))
          .profileUiUrl
      ).toBe(`${origin}/settings/profile?action=password`)
    if (kind === 'social')
      expect(
        (
          await service.openProfileSettings('user@example.test', {
            section: 'social',
            network: 'slack',
          })
        ).profileUiUrl
      ).toBe(`${origin}/channels/slack`)
    if (kind === 'app')
      expect((await service.createSandboxUiDeepLink()).url).toBe(
        `${origin}/open/apps/sandbox-recipes/task-board?path=%2Ftasks%2F42`
      )
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    if (kind === 'gfs')
      expect((await service.createGfsResourceDeepLink(uri)).url).toBe(
        `${origin}/open/files?uri=${encodeURIComponent(uri)}`
      )
    expect(requests).toBe(1)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).profileUiBaseUrl).toBe(origin)
    expect(runtime.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
  },
  15000
)

it('uses a real upgraded REST origin without creating a saved profile', async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-origin-no-id-producer-'))
  const origin = loopbackOrigin(3217)
  let requests = 0
  server = http.createServer()
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback server has no port')
  const rest = `http://127.0.0.1:${address.port}`
  const publicKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).publicKey
  Object.assign(process.env, {
    NODE_ENV: 'production',
    CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: origin,
    EXTERNAL_REST_API_CORS_ORIGIN: origin,
    EXTERNAL_REST_API_GOOGLE_CLIENT_ID: 'synthetic-client',
    EXTERNAL_REST_API_CONTROL_API_BASE_URL: 'https://control.example.test/api/v1',
    EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: 'synthetic-test-service-token',
    EXTERNAL_REST_API_JWT_PUBLIC_KEY: publicKey,
    EXTERNAL_REST_API_JWT_ISSUER: 'control-api',
    EXTERNAL_REST_API_JWT_AUDIENCE: 'profile-ui',
    EXTERNAL_REST_API_PUBLIC_BASE_URL: rest,
    EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL: loopbackOrigin(8094),
    EXTERNAL_REST_API_DESKTOP_APP_NAME: 'A',
  })
  delete process.env.CLERUM_DEV_MODE
  vi.resetModules()
  const { createDesktopRouter } = await import('../../../external-rest-api/src/routes/desktop.js')
  const express = createRequire(path.resolve(process.cwd(), '../external-rest-api/package.json'))(
    'express'
  )
  const app = express()
  app.use('/api/v1', (_request: unknown, _response: unknown, next: () => void) => {
    requests += 1
    next()
  })
  app.use('/api/v1', createDesktopRouter())
  server.on('request', app)
  delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  delete process.env.PROFILE_UI_BASE_URL
  process.env.EXTERNAL_REST_API_BASE_URL = rest
  process.env.RPC_PROXY_BASE_URL = loopbackOrigin(8094)
  const openExternal = vi.fn().mockResolvedValue(undefined)
  vi.doMock('electron', () => ({
    app: {
      getPath: () => directory,
      isReady: () => true,
      isPackaged: false,
      setName: vi.fn(),
      setPath: vi.fn(),
    },
    shell: { openExternal },
  }))
  const [{ AppService }, runtime] = await Promise.all([
    import('../appService.js'),
    import('../config.js'),
  ])
  expect(runtime.getDesktopRuntimeConfigState().activeOptionId).toBeNull()
  const result = await new AppService().openForgotPassword('user@example.test')
  expect(result.profileUiUrl).toBe(`${origin}/forgot-password?email=user%40example.test`)
  expect(openExternal).toHaveBeenCalledWith(result.profileUiUrl)
  expect(requests).toBe(1)
  expect(runtime.getDesktopRuntimeConfigState().activeOptionId).toBeNull()
  const storagePath = runtime.getDesktopRuntimeConfigState().storagePath
  await expect(fs.access(path.join(storagePath, 'index.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
}, 15000)

it('clears the producer-persisted origin on a true RPC rebind before any refetch', async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-origin-rpc-rebind-'))
  const file = path.join(directory, 'profile.json')
  const origin = 'https://profile-authoritative.example.test'
  const rpc1 = loopbackOrigin(8094)
  const rpc2 = loopbackOrigin(8095)
  let requests = 0
  server = http.createServer()
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback server has no port')
  const rest = `http://127.0.0.1:${address.port}`
  await fs.writeFile(
    file,
    JSON.stringify({ externalRestApiBaseUrl: rest, rpcProxyBaseUrl: rpc1, appName: 'A' })
  )
  const publicKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).publicKey
  Object.assign(process.env, {
    NODE_ENV: 'production',
    EXTERNAL_REST_API_PUBLIC_BASE_URL: rest,
    EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL: rpc1,
    EXTERNAL_REST_API_DESKTOP_APP_NAME: 'A',
    CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: origin,
    EXTERNAL_REST_API_CORS_ORIGIN: origin,
    EXTERNAL_REST_API_GOOGLE_CLIENT_ID: 'synthetic-client',
    EXTERNAL_REST_API_CONTROL_API_BASE_URL: 'https://control.example.test/api/v1',
    EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: 'synthetic-test-service-token',
    EXTERNAL_REST_API_JWT_PUBLIC_KEY: publicKey,
    EXTERNAL_REST_API_JWT_ISSUER: 'control-api',
    EXTERNAL_REST_API_JWT_AUDIENCE: 'profile-ui',
  })
  delete process.env.CLERUM_DEV_MODE
  vi.resetModules()
  const { createDesktopRouter } = await import('../../../external-rest-api/src/routes/desktop.js')
  const express = createRequire(path.resolve(process.cwd(), '../external-rest-api/package.json'))(
    'express'
  )
  const app = express()
  app.use('/api/v1/desktop/environment', (_request: any, _response: any, next: () => void) => {
    requests += 1
    next()
  })
  app.use('/api/v1', createDesktopRouter())
  server.removeAllListeners('request')
  server.on('request', app)
  process.env.CLERUM_DESKTOP_CONFIG_PATH = file
  delete process.env.EXTERNAL_REST_API_BASE_URL
  delete process.env.RPC_PROXY_BASE_URL
  delete process.env.PROFILE_UI_BASE_URL
  const openExternal = vi.fn().mockResolvedValue(undefined)
  vi.doMock('electron', () => ({
    app: {
      getPath: () => directory,
      isReady: () => true,
      isPackaged: false,
      setName: vi.fn(),
      setPath: vi.fn(),
    },
    shell: { openExternal },
  }))
  const [{ AppService }, runtime] = await Promise.all([
    import('../appService.js'),
    import('../config.js'),
  ])
  const service = new AppService() as any
  service.tokenStore = {
    clearSessionToken: vi.fn().mockResolvedValue(undefined),
    getSessionToken: vi.fn().mockResolvedValue(null),
    setSessionToken: vi.fn().mockResolvedValue(undefined),
  }
  service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
  service.stopAllStreams = vi.fn()
  const result = await service.openForgotPassword('user@example.test')
  expect(result.profileUiUrl).toBe(`${origin}/forgot-password?email=user%40example.test`)
  expect(JSON.parse(await fs.readFile(file, 'utf8')).profileUiBaseUrl).toBe(origin)
  expect(runtime.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
  await service.saveRuntimeConfig({
    externalRestApiBaseUrl: rest,
    rpcProxyBaseUrl: rpc2,
    appName: 'A',
  })
  const saved = JSON.parse(await fs.readFile(file, 'utf8'))
  expect(saved.rpcProxyBaseUrl).toBe(rpc2)
  expect(runtime.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
  expect(requests).toBe(1)
  expect(saved).not.toHaveProperty('profileUiBaseUrl')
}, 15000)
