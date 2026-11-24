import { afterEach, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'

const externalEnvironmentNames = [
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
const originalExternalEnvironment = Object.fromEntries(
  externalEnvironmentNames.map(name => [name, process.env[name]])
)
let server: http.Server | undefined

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close(error => (error ? reject(error) : resolve()))
    )
  server = undefined
  for (const name of externalEnvironmentNames) {
    const value = originalExternalEnvironment[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  vi.restoreAllMocks()
  vi.resetModules()
  await cleanupNativeCommitTestHarness()
})

it('does not persist an R1 HTTP discovery into the successful R2 retry after a failed save', async () => {
  let requestCount = 0
  const origin = 'https://profile-unique.example.test'
  const rpc1 = 'https://rpc-a.example.test'
  const rpc2 = 'https://rpc-r2.example.test'
  server = http.createServer()
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server!.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP')
  const restA = `http://127.0.0.1:${address.port}`
  const publicKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).publicKey
  Object.assign(process.env, {
    NODE_ENV: 'production',
    EXTERNAL_REST_API_PUBLIC_BASE_URL: restA,
    EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL: rpc1,
    CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL: origin,
    EXTERNAL_REST_API_DESKTOP_APP_NAME: 'Environment A',
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
  app.use('/api/v1/desktop/environment', (request: any, response: any, next: () => void) => {
    requestCount++
    expect(request.originalUrl).toBe('/api/v1/desktop/environment')
    if (requestCount > 1) {
      response.status(503).end()
      return
    }
    next()
  })
  app.use('/api/v1', createDesktopRouter())
  server!.removeAllListeners('request')
  server!.on('request', app)
  const harness = await createNativeCommitTestHarness({
    restA,
    restB: 'https://api-b.example.test',
  })
  const service = harness.service as unknown as {
    authClient: unknown
    openForgotPassword: (email: string) => Promise<{ profileUiUrl: string }>
    saveRuntimeConfig: (config: {
      externalRestApiBaseUrl: string
      rpcProxyBaseUrl: string
      appName: string
    }) => Promise<unknown>
    sessionGeneration: number
    sessionToken: string | null
    me: { id: string } | null
  }
  const realWrite = fs.writeFile.bind(fs)
  const realRenameSync = fsSync.renameSync.bind(fsSync)
  let failed = false
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (!failed && args[0] === harness.optionA.configPath && String(args[1]).includes(rpc2)) {
      failed = true
      throw Object.assign(new Error('injected profile write failure'), { code: 'EACCES' })
    }
    return realWrite(...args)
  })
  // The current candidate writes the target through fs.promises.writeFile;
  // the verified PR-head implementation commits the same target by renaming
  // its staged file. Keep the same one-shot target-file fault source-reachable
  // on both implementations so the expected-red prior-head run is meaningful.
  vi.spyOn(fsSync, 'renameSync').mockImplementation((...args) => {
    if (!failed && args[1] === harness.optionA.configPath) {
      failed = true
      throw Object.assign(new Error('injected profile write failure'), { code: 'EACCES' })
    }
    return realRenameSync(...args)
  })

  let action: Promise<{ profileUiUrl: string }> | undefined
  try {
    await expect(
      service.saveRuntimeConfig({
        externalRestApiBaseUrl: restA,
        rpcProxyBaseUrl: rpc2,
        appName: 'Environment A',
      })
    ).rejects.toMatchObject({ code: 'EACCES' })
    expect(failed).toBe(true)
    const stateAfterFailure = harness.runtimeConfig.getDesktopRuntimeConfigState()
    expect(stateAfterFailure.activeOptionId).toBe(harness.optionA.id)
    expect(harness.runtimeConfig.config.rpcProxyBaseUrl).toBe(rpc1)
    expect(
      stateAfterFailure.options.find(option => option.id === harness.optionA.id)?.rpcProxyBaseUrl
    ).toBe(rpc2)
    const diskAfterFailure = JSON.parse(await fs.readFile(harness.optionA.configPath!, 'utf8'))
    expect(diskAfterFailure.rpcProxyBaseUrl).toBe(rpc1)
    const indexFile = path.join(path.dirname(harness.optionA.configPath!), 'index.json')
    const indexBytesAfterFailure = await fs.readFile(indexFile, 'utf8')
    const indexAfterFailure = JSON.parse(indexBytesAfterFailure)
    expect(indexAfterFailure.activeProfileId).toBe(harness.optionA.id)
    const generationAfterFailure = service.sessionGeneration
    const tokenAfterFailure = service.sessionToken
    const userIdAfterFailure = service.me?.id ?? null

    action = service.openForgotPassword('User@example.test')
    const result = await action
    expect(result.profileUiUrl).toBe(`${origin}/forgot-password?email=user%40example.test`)
    expect(requestCount).toBe(1)
    expect(service.sessionGeneration).toBe(generationAfterFailure)
    expect(service.sessionToken).toBe(tokenAfterFailure)
    expect(service.me?.id ?? null).toBe(userIdAfterFailure)
    expect(await fs.readFile(indexFile, 'utf8')).toBe(indexBytesAfterFailure)

    await service.saveRuntimeConfig({
      externalRestApiBaseUrl: restA,
      rpcProxyBaseUrl: rpc2,
      appName: 'Environment A',
    })
    const retryIndex = JSON.parse(await fs.readFile(indexFile, 'utf8'))
    expect(retryIndex.activeProfileId).toBe(harness.optionA.id)
    expect(harness.runtimeConfig.getDesktopRuntimeConfigState().activeOptionId).toBe(
      harness.optionA.id
    )
    const retryGeneration = service.sessionGeneration
    const finalProfile = JSON.parse(await fs.readFile(harness.optionA.configPath!, 'utf8'))
    expect(finalProfile.rpcProxyBaseUrl).toBe(rpc2)
    expect(finalProfile).not.toHaveProperty('profileUiBaseUrl')

    const offlineR2 = await service.openForgotPassword('User@example.test')
    expect(offlineR2.profileUiUrl).not.toContain(origin)
    expect(requestCount).toBe(2)
    expect(service.sessionGeneration).toBe(retryGeneration)
    expect(await fs.readFile(harness.optionA.configPath!, 'utf8')).not.toContain(origin)
  } finally {
    if (action) await Promise.allSettled([action])
  }
})
