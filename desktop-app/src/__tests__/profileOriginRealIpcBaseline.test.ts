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
const saved = Object.fromEntries(
  [
    'CLERUM_DESKTOP_CONFIG_PATH',
    'EXTERNAL_REST_API_BASE_URL',
    'RPC_PROXY_BASE_URL',
    'PROFILE_UI_BASE_URL',
    'NODE_ENV',
    'CLERUM_DEV_MODE',
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
  ].map(k => [k, process.env[k]])
)
let dir = ''
let server: http.Server | undefined
afterEach(async () => {
  try {
    if (server?.listening)
      await new Promise<void>((resolve, reject) =>
        server!.close(error => (error ? reject(error) : resolve()))
      )
  } finally {
    server = undefined
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.restoreAllMocks()
    vi.doUnmock('electron')
    vi.resetModules()
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  }
})
const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
it.each(['app', 'gfs'] as const)(
  '%s IPC copies the real service origin and rejects a deleted profile response',
  async kind => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-ipc-baseline-'))
    const loopback = ['127', '0', '0', '1'].join('.')
    const file = path.join(dir, 'runtime.json'),
      origin = `http://${loopback}:3217`,
      rpc = `http://${loopback}:8094`
    let rest = '',
      calls = 0,
      releaseResponse: (() => void) | undefined
    const requestPaths: string[] = []
    server = http.createServer()
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => {
        server!.off('error', reject)
        resolve()
      })
    })
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('missing server port')
    rest = `http://127.0.0.1:${addr.port}`
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
      EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL: rpc,
      EXTERNAL_REST_API_DESKTOP_APP_NAME: 'A',
    })
    delete process.env.CLERUM_DEV_MODE
    vi.resetModules()
    const { createDesktopRouter } = await import('../../../external-rest-api/src/routes/desktop.js')
    const express = createRequire(path.resolve(process.cwd(), '../external-rest-api/package.json'))(
      'express'
    )
    const app = express()
    app.use((request: { originalUrl: string }, _response: unknown, next: () => void) => {
      calls++
      requestPaths.push(request.originalUrl)
      if (calls === 2) releaseResponse = next
      else next()
    })
    app.use('/api/v1', createDesktopRouter())
    server.on('request', app)
    const initial = { externalRestApiBaseUrl: rest, rpcProxyBaseUrl: rpc, appName: 'A' }
    await fs.writeFile(file, JSON.stringify(initial))
    process.env.CLERUM_DESKTOP_CONFIG_PATH = file
    delete process.env.EXTERNAL_REST_API_BASE_URL
    delete process.env.RPC_PROXY_BASE_URL
    delete process.env.PROFILE_UI_BASE_URL
    const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.doMock('electron', () => ({
      BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
      Notification: vi.fn(),
      app: {
        on: vi.fn(),
        getPath: () => dir,
        getVersion: () => '0.0.0',
        isReady: () => true,
        isPackaged: false,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      clipboard: { writeText },
      dialog: { showSaveDialog: vi.fn() },
      ipcMain: {
        handle: vi.fn((channel, fn) => handlers.set(channel, fn)),
        on: vi.fn(),
        removeHandler: vi.fn(),
      },
      shell: { openExternal: vi.fn() },
    }))
    const [{ AppService }, cfg, driver, ipc] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
      import('../sandboxUiDriver.js'),
      import('../ipc.js'),
    ])
    vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/tasks/42',
    })
    const service = new AppService() as any
    service.sessionToken = 'synthetic-session'
    service.me = { id: 'user-1', email: 'user@example.test' }
    service.tokenStore = {
      clearSessionToken: vi.fn().mockResolvedValue(undefined),
      getSessionToken: vi.fn().mockResolvedValue(null),
      setSessionToken: vi.fn().mockResolvedValue(undefined),
    }
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
    service.stopAllStreams = vi.fn()
    service.ensureEntityChangeConnection = vi.fn()
    ipc.registerIpcHandlers(service, async () => 0)
    const handler = handlers.get(kind === 'app' ? 'sandboxUi:copyDeepLink' : 'gfs:copyDeepLink')
    if (!handler) throw new Error('missing IPC handler')
    const expected =
      kind === 'app'
        ? `${origin}/open/apps/sandbox-recipes/task-board?path=%2Ftasks%2F42`
        : `${origin}/open/files?uri=${encodeURIComponent(uri)}`
    const payload = kind === 'app' ? {} : { uri }
    const event = { senderFrame: { url: 'file:///app/index.html' } }
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('IPC call did not settle')), 4000)
    })
    let stale: Promise<unknown> | undefined
    let releaseWrite: (() => void) | undefined
    const queued: Promise<unknown>[] = []
    try {
      await expect(Promise.race([handler(event, payload), deadline])).resolves.toEqual({
        url: expected,
      })
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(writeText).toHaveBeenCalledWith(expected)
      expect(JSON.parse(await fs.readFile(file, 'utf8')).profileUiBaseUrl).toBe(origin)
      expect(cfg.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
      await service.deleteRuntimeConfig('custom-file')
      await service.saveRuntimeConfig(initial)
      service.sessionToken = 'synthetic-session'
      service.me = { id: 'user-1', email: 'user@example.test' }
      writeText.mockClear()
      const generation = service.sessionGeneration
      stale = handler(event, payload)
      void stale.catch(() => undefined)
      await vi.waitFor(() => expect(releaseResponse).toBeDefined())
      await service.deleteRuntimeConfig('custom-file')
      expect(service.sessionGeneration).toBeGreaterThan(generation)
      expect(cfg.getDesktopRuntimeConfigState().activeOptionId).not.toBe('custom-file')
      releaseResponse!()
      releaseResponse = undefined
      await expect(Promise.race([stale, deadline])).rejects.toThrow()
      expect(writeText).not.toHaveBeenCalled()
      await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' })

      await service.saveRuntimeConfig(initial)
      service.sessionToken = 'synthetic-session'
      service.me = { id: 'user-1', email: 'user@example.test' }
      const generationBeforeWrite = service.sessionGeneration
      const realWrite = fs.writeFile.bind(fs)
      let sawWrite = false
      const writeGate = new Promise<void>(resolve => {
        releaseWrite = resolve
      })
      vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        if (!sawWrite && args[0] === file && String(args[1]).includes(origin)) {
          sawWrite = true
          await writeGate
        }
        return realWrite(...args)
      })
      const owner = vi.spyOn(service, 'withNativeAuthEnvironmentCommit')
      const heldAction = handler(event, payload)
      void heldAction.catch(() => undefined)
      queued.push(heldAction)
      await vi.waitFor(() => expect(sawWrite).toBe(true))
      const beforeDelete = owner.mock.calls.length
      const deletion = service.deleteRuntimeConfig('custom-file')
      void deletion.catch(() => undefined)
      queued.push(deletion)
      await vi.waitFor(() => expect(owner.mock.calls.length).toBeGreaterThan(beforeDelete))
      const beforeRecreate = owner.mock.calls.length
      const recreation = service.saveRuntimeConfig(initial)
      void recreation.catch(() => undefined)
      queued.push(recreation)
      await vi.waitFor(() => expect(owner.mock.calls.length).toBeGreaterThan(beforeRecreate))
      expect(cfg.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).not.toHaveProperty('profileUiBaseUrl')
      releaseWrite!()
      const finalResults = await Promise.race([Promise.allSettled(queued), deadline])
      expect(finalResults[0].status).toBe('rejected')
      if (finalResults[0].status === 'rejected')
        expect(finalResults[0].reason.message).toBe('stale_session_generation')
      expect(finalResults[1].status).toBe('fulfilled')
      expect(finalResults[2].status).toBe('fulfilled')
      expect(service.sessionGeneration).toBeGreaterThan(generationBeforeWrite)
      expect(cfg.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).not.toHaveProperty('profileUiBaseUrl')
      expect(writeText).not.toHaveBeenCalled()
      expect(requestPaths).toEqual(Array(3).fill('/api/v1/desktop/environment'))
    } finally {
      releaseResponse?.()
      releaseWrite?.()
      try {
        await Promise.race([Promise.allSettled([...(stale ? [stale] : []), ...queued]), deadline])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
  },
  15000
)
