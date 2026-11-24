import { afterEach, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

const envNames = [
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
] as const
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]))
let server: http.Server | undefined

afterEach(async () => {
  try {
    if (server?.listening)
      await new Promise<void>((resolve, reject) =>
        server!.close(error => (error ? reject(error) : resolve()))
      )
  } finally {
    server = undefined
    for (const name of envNames) {
      const value = originalEnv[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    vi.restoreAllMocks()
    vi.doUnmock('electron')
    vi.resetModules()
    await cleanupNativeCommitTestHarness()
  }
})

it.each(['R1-first', 'R2-first'] as const)(
  'keeps overlapping origins bound after RPC rebind (%s)',
  async order => {
    const origin1 = 'https://profile-old.example.test'
    const origin2 = 'https://profile-new.example.test'
    const rpc1 = 'https://rpc-a.example.test'
    const rpc2 = 'https://rpc-r2.example.test'
    const releases: Array<(() => void) | undefined> = []
    const paths: string[] = []
    server = http.createServer()
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => {
        server!.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP')
    const rest = `http://127.0.0.1:${address.port}`
    const publicKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }).publicKey
    Object.assign(process.env, {
      NODE_ENV: 'production',
      EXTERNAL_REST_API_CORS_ORIGIN: origin1,
      EXTERNAL_REST_API_GOOGLE_CLIENT_ID: 'synthetic-client',
      EXTERNAL_REST_API_CONTROL_API_BASE_URL: 'https://control.example.test/api/v1',
      EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: 'synthetic-test-service-token',
      EXTERNAL_REST_API_JWT_PUBLIC_KEY: publicKey,
      EXTERNAL_REST_API_JWT_ISSUER: 'control-api',
      EXTERNAL_REST_API_JWT_AUDIENCE: 'profile-ui',
      EXTERNAL_REST_API_PUBLIC_BASE_URL: rest,
      EXTERNAL_REST_API_DESKTOP_APP_NAME: 'Environment A',
    })
    delete process.env.CLERUM_DEV_MODE
    const routers = []
    for (const [origin, rpc] of [
      [origin1, rpc1],
      [origin2, rpc2],
    ]) {
      process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = origin
      process.env.EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL = rpc
      vi.resetModules()
      const { createDesktopRouter } =
        await import('../../../external-rest-api/src/routes/desktop.js')
      routers.push(createDesktopRouter())
    }
    const express = createRequire(path.resolve(process.cwd(), '../external-rest-api/package.json'))(
      'express'
    )
    const app = express()
    app.use('/api/v1', (request: any, response: any, next: (error?: unknown) => void) => {
      const index = paths.push(request.originalUrl) - 1
      if (index >= routers.length) {
        response.status(503).end()
        return
      }
      releases[index] = () => routers[index](request, response, next)
    })
    server.on('request', app)
    const h = await createNativeCommitTestHarness({ restA: rest })
    const service = h.service as unknown as {
      openForgotPassword: (email: string) => Promise<{ profileUiUrl: string }>
      saveRuntimeConfig: (config: {
        externalRestApiBaseUrl: string
        rpcProxyBaseUrl: string
        appName: string
      }) => Promise<unknown>
    }
    const { shell } = await import('electron')
    const action1 = service.openForgotPassword('user@example.test')
    void action1.catch(() => undefined)
    let action2: Promise<{ profileUiUrl: string }> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('overlap schedule timed out')), 4000)
    })
    try {
      await Promise.race([vi.waitFor(() => expect(releases[0]).toBeDefined()), deadline])
      await service.saveRuntimeConfig({
        externalRestApiBaseUrl: rest,
        rpcProxyBaseUrl: rpc2,
        appName: 'Environment A',
      })
      action2 = service.openForgotPassword('user@example.test')
      void action2.catch(() => undefined)
      await Promise.race([vi.waitFor(() => expect(releases[1]).toBeDefined()), deadline])
      expect(paths).toEqual(['/api/v1/desktop/environment', '/api/v1/desktop/environment'])
      expect(JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8')).rpcProxyBaseUrl).toBe(
        rpc2
      )
      expect(JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8'))).not.toHaveProperty(
        'profileUiBaseUrl'
      )
      const first = order === 'R1-first' ? 0 : 1
      releases[first]!()
      releases[first] = undefined
      if (order === 'R1-first') {
        await expect(Promise.race([action1, deadline])).rejects.toThrow(
          'Profile UI deployment changed'
        )
        expect(JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8'))).not.toHaveProperty(
          'profileUiBaseUrl'
        )
      } else {
        await expect(Promise.race([action2, deadline])).resolves.toEqual({
          profileUiUrl: `${origin2}/forgot-password?email=user%40example.test`,
        })
        expect(JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8')).profileUiBaseUrl).toBe(
          origin2
        )
      }
      const second = first === 0 ? 1 : 0
      releases[second]!()
      releases[second] = undefined
      await expect(Promise.race([action1, deadline])).rejects.toThrow(
        'Profile UI deployment changed'
      )
      await expect(Promise.race([action2, deadline])).resolves.toEqual({
        profileUiUrl: `${origin2}/forgot-password?email=user%40example.test`,
      })
      const finalProfile = JSON.parse(await fs.readFile(h.optionA.configPath!, 'utf8'))
      expect(finalProfile.rpcProxyBaseUrl).toBe(rpc2)
      expect(finalProfile.profileUiBaseUrl).toBe(origin2)
      expect(h.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(h.optionA.id)
      expect(paths).toHaveLength(2)
      expect(shell.openExternal).not.toHaveBeenCalledWith(expect.stringContaining(origin1))
      expect(shell.openExternal).toHaveBeenCalledWith(
        `${origin2}/forgot-password?email=user%40example.test`
      )
    } finally {
      for (const release of releases) release?.()
      try {
        await Promise.race([Promise.allSettled([action1, ...(action2 ? [action2] : [])]), deadline])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
  },
  15000
)
