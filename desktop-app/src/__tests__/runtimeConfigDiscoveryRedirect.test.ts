import { afterEach, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

const names = [
  'NODE_ENV',
  'CLERUM_DEV_MODE',
  'CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL',
  'EXTERNAL_REST_API_PUBLIC_BASE_URL',
  'EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL',
  'EXTERNAL_REST_API_DESKTOP_APP_NAME',
  'EXTERNAL_REST_API_CORS_ORIGIN',
  'EXTERNAL_REST_API_GOOGLE_CLIENT_ID',
  'EXTERNAL_REST_API_CONTROL_API_BASE_URL',
  'EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN',
  'EXTERNAL_REST_API_JWT_PUBLIC_KEY',
  'EXTERNAL_REST_API_JWT_ISSUER',
  'EXTERNAL_REST_API_JWT_AUDIENCE',
] as const
const original = Object.fromEntries(names.map(name => [name, process.env[name]]))
let server: http.Server | undefined

afterEach(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server!.close(error => (error ? reject(error) : resolve()))
    )
  }
  server = undefined
  for (const name of names) {
    const value = original[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  vi.restoreAllMocks()
  vi.resetModules()
  await cleanupNativeCommitTestHarness()
})

it('rejects redirected RPC discovery during an ordinary environment save', async () => {
  server = http.createServer()
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP')
  const rest = `http://127.0.0.1:${address.port}`
  const rpc = 'https://rpc-discovered.example.test'
  const publicKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).publicKey
  Object.assign(process.env, {
    NODE_ENV: 'production',
    EXTERNAL_REST_API_PUBLIC_BASE_URL: rest,
    EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL: rpc,
    EXTERNAL_REST_API_DESKTOP_APP_NAME: 'Environment A',
    EXTERNAL_REST_API_CORS_ORIGIN: 'https://profile.example.test',
    EXTERNAL_REST_API_GOOGLE_CLIENT_ID: 'synthetic-client',
    EXTERNAL_REST_API_CONTROL_API_BASE_URL: 'https://control.example.test/api/v1',
    EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: 'synthetic-test-service-token',
    EXTERNAL_REST_API_JWT_PUBLIC_KEY: publicKey,
    EXTERNAL_REST_API_JWT_ISSUER: 'control-api',
    EXTERNAL_REST_API_JWT_AUDIENCE: 'profile-ui',
  })
  delete process.env.CLERUM_DEV_MODE
  process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = 'https://profile.example.test'
  vi.resetModules()
  const { createDesktopRouter } = await import('../../../external-rest-api/src/routes/desktop.js')
  const express = createRequire(path.resolve(process.cwd(), '../external-rest-api/package.json'))(
    'express'
  )
  const app = express()
  let redirects = 0
  let producerCalls = 0
  app.get('/api/v1/desktop/environment', (_request: unknown, response: any) => {
    redirects++
    response.redirect(302, '/actual/api/v1/desktop/environment')
  })
  app.use(
    '/actual/api/v1',
    (_request: unknown, _response: unknown, next: () => void) => {
      producerCalls++
      next()
    },
    createDesktopRouter()
  )
  server.on('request', app)
  const { service, runtimeConfig, optionA } = await createNativeCommitTestHarness({ restA: rest })
  const appService = service as unknown as {
    saveRuntimeConfig: (value: {
      externalRestApiBaseUrl: string
      rpcProxyBaseUrl: string
      appName: string
    }) => Promise<unknown>
  }

  await appService.saveRuntimeConfig({
    externalRestApiBaseUrl: rest,
    rpcProxyBaseUrl: '',
    appName: 'Environment A',
  })

  expect(redirects).toBe(1)
  expect(runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(optionA.id)
  expect(runtimeConfig.config.rpcProxyBaseUrl).toBe('')
  expect(producerCalls).toBe(0)
})
