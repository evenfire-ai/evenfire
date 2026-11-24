// AppService/file model only; clipboard IPC ordering is covered by focused IPC suites.
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { generateKeyPairSync } from 'node:crypto'
import fsSync from 'node:fs'
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
const originalEnv = {
  config: process.env.CLERUM_DESKTOP_CONFIG_PATH,
  rest: process.env.EXTERNAL_REST_API_BASE_URL,
  rpc: process.env.RPC_PROXY_BASE_URL,
  profile: process.env.PROFILE_UI_BASE_URL,
}
const producerEnvironmentNames = [
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
const originalProducerEnv = Object.fromEntries(
  producerEnvironmentNames.map(name => [name, process.env[name]])
)
const dirs = new Set<string>()
async function cleanup() {
  for (const [key, value] of Object.entries({
    CLERUM_DESKTOP_CONFIG_PATH: originalEnv.config,
    EXTERNAL_REST_API_BASE_URL: originalEnv.rest,
    RPC_PROXY_BASE_URL: originalEnv.rpc,
    PROFILE_UI_BASE_URL: originalEnv.profile,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const [key, value] of Object.entries(originalProducerEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.restoreAllMocks()
  vi.doUnmock('electron')
  vi.resetModules()
  await Promise.all([...dirs].map(dir => fs.rm(dir, { recursive: true, force: true })))
  dirs.clear()
}
afterEach(cleanup)
const rest = 'https://api.p.example.test',
  rpc = 'https://rpc.p.example.test',
  qRest = 'https://api.q.example.test',
  origin = 'https://profile-unique.example.test',
  nextOrigin = 'https://profile-next.example.test',
  uri = 'gfs://main/0123456789abcdef0123456789abcdef'
let producerResponses: { r1: unknown; r2: unknown; legacy: unknown }

beforeAll(async () => {
  const server = http.createServer()
  try {
    const publicKey = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }).publicKey
    Object.assign(process.env, {
      NODE_ENV: 'production',
      EXTERNAL_REST_API_CORS_ORIGIN: origin,
      EXTERNAL_REST_API_GOOGLE_CLIENT_ID: 'synthetic-client',
      EXTERNAL_REST_API_CONTROL_API_BASE_URL: 'https://control.example.test/api/v1',
      EXTERNAL_REST_API_CONTROL_API_SERVICE_TOKEN: 'synthetic-test-service-token',
      EXTERNAL_REST_API_JWT_PUBLIC_KEY: publicKey,
      EXTERNAL_REST_API_JWT_ISSUER: 'control-api',
      EXTERNAL_REST_API_JWT_AUDIENCE: 'profile-ui',
      EXTERNAL_REST_API_PUBLIC_BASE_URL: rest,
      EXTERNAL_REST_API_DESKTOP_APP_NAME: 'P',
    })
    delete process.env.CLERUM_DEV_MODE
    const express = createRequire(path.resolve(process.cwd(), '../external-rest-api/package.json'))(
      'express'
    )
    const app = express()
    for (const [name, profile, proxy] of [
      ['r1', origin, rpc],
      ['r2', nextOrigin, 'https://rpc.next.example.test'],
      ['legacy', undefined, rpc],
    ] as const) {
      if (profile === undefined) delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
      else process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = profile
      process.env.EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL = proxy
      vi.resetModules()
      const { createDesktopRouter } =
        await import('../../../external-rest-api/src/routes/desktop.js')
      app.use(`/${name}`, createDesktopRouter())
    }
    server.on('request', app)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('producer fixture server did not bind TCP')
    const read = async (name: string) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/${name}/desktop/environment`)
      if (!response.ok) throw new Error(`producer fixture ${name} returned ${response.status}`)
      return response.json()
    }
    const responseUrl = `${rest}/api/v1/desktop/environment`
    producerResponses = {
      r1: { ...(await read('r1')), responseUrl },
      r2: { ...(await read('r2')), responseUrl },
      legacy: { ...(await read('legacy')), responseUrl },
    }
    expect(producerResponses.r1).toMatchObject({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: rpc,
      profileUiBaseUrl: origin,
    })
    expect(producerResponses.r2).toMatchObject({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: 'https://rpc.next.example.test',
      profileUiBaseUrl: nextOrigin,
    })
    expect(producerResponses.legacy).not.toHaveProperty('profileUiBaseUrl')
  } finally {
    try {
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        )
    } finally {
      for (const [key, value] of Object.entries(originalProducerEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      vi.resetModules()
    }
  }
})
type Kind = 'forgot' | 'app' | 'gfs'
type Model = {
  mode: 'indexed' | 'explicit' | 'configured' | 'enrich' | 'failed-save'
  phase:
    | 'idle'
    | 'pending'
    | 'done'
    | 'restarted'
    | 'ready'
    | 'save-failed'
    | 'origin-resolved'
    | 'retried'
  selected: 'P' | 'Q' | 'none'
  live: boolean
  replaced: boolean
  renamed: boolean
  rebound: boolean
  secondDone: boolean
  generation?: number
  kind?: Kind
  cachedRecordRestRpc?: string
  diskRestRpc?: string
  originPersistedAfterDiscovery?: boolean
  requestCountBeforeOrigin?: number
  originRequestCount?: number
  indexBytesAfterFailure?: string
  sessionTokenAfterFailure?: string | null
  userIdAfterFailure?: string | null
}
type Service = {
  authClient: {
    getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn>
    getDesktopEnvironment?: ReturnType<typeof vi.fn>
    passwordLogin?: ReturnType<typeof vi.fn>
  }
  passwordLogin: (email: string, password: string) => Promise<unknown>
  tokenStore: unknown
  sessionGeneration: number
  sessionToken: string | null
  me: { id: string; email: string } | null
  openForgotPassword: (email: string) => Promise<{ profileUiUrl: string }>
  createSandboxUiDeepLink: (team?: string) => Promise<{ url: string }>
  createGfsResourceDeepLink: (uri: string) => Promise<{ url: string }>
  selectRuntimeConfig: (id: string) => Promise<unknown>
  saveRuntimeConfig: (config: {
    externalRestApiBaseUrl: string
    rpcProxyBaseUrl: string
    appName: string
  }) => Promise<unknown>
  deleteRuntimeConfig: (id: string) => Promise<unknown>
  suspendDesktopGfsUploadsForAuthBoundary: () => Promise<void>
  stopAllStreams: () => void
}
type Real = {
  service: Service
  cfg: {
    getDesktopRuntimeConfigState: () => {
      activeOptionId: string | null
      currentConfig?: { externalRestApiBaseUrl: string; rpcProxyBaseUrl?: string }
      options: Array<{ id: string; externalRestApiBaseUrl: string; rpcProxyBaseUrl: string }>
    }
    captureProfileOriginBinding: () => {
      profileId: string | null
      profileUiBaseUrl?: string | null
    }
  }
  scheduler: fc.Scheduler
  get: ReturnType<typeof vi.fn>
  requestCount: () => number
  requestPaths: () => string[]
  pId: string
  pFile: string
  qId?: string
  qFile?: string
  qBytes?: string
  indexFile?: string
  forbiddenIndex?: string
  requestStarted: Promise<void>
  newRequestStarted: Promise<void>
  releaseOld: () => void
  releaseNew: () => void
  enableR2: () => void
  closeServer: () => Promise<void>
  action?: Promise<unknown>
  secondAction?: Promise<unknown>
  shell: ReturnType<typeof vi.fn>
}
const coverage = {
  indexedStale: 0,
  explicitReplacement: 0,
  explicitRename: 0,
  replacementApp: 0,
  replacementGfs: 0,
  carry: 0,
  restart: 0,
  app: 0,
  gfs: 0,
  enrich: 0,
}
const failedSaveCoverage = { failedSave: 0, postFailureOrigin: 0, retry: 0 }
const r48ModelCoverage = { e20N30: 0 }
async function assertFailedSaveReference(
  m: Readonly<Model>,
  r: Real,
  stage: string,
  checkIndex = true
) {
  const disk = JSON.parse(await fs.readFile(r.pFile, 'utf8'))
  const state = r.cfg.getDesktopRuntimeConfigState()
  const cached = state.options.find(option => option.id === r.pId)
  const binding = r.cfg.captureProfileOriginBinding()
  const expectedDiskRest = m.diskRestRpc?.split('|')[0]
  const expectedCachedRest = m.cachedRecordRestRpc?.split('|')[0]
  const expectedDiskRpc = m.diskRestRpc?.split('|')[1]
  const expectedCachedRpc = m.cachedRecordRestRpc?.split('|')[1]
  expect(state.activeOptionId, `${stage}: selected profile`).toBe(r.pId)
  expect(binding.profileId, `${stage}: origin binding profile`).toBe(r.pId)
  expect(state.currentConfig?.externalRestApiBaseUrl, `${stage}: active REST`).toBe(
    expectedDiskRest
  )
  expect(disk.externalRestApiBaseUrl, `${stage}: disk REST`).toBe(expectedDiskRest)
  expect(cached?.externalRestApiBaseUrl, `${stage}: cached REST`).toBe(expectedCachedRest)
  expect(state.currentConfig?.rpcProxyBaseUrl, `${stage}: active RPC`).toBe(expectedDiskRpc)
  expect(disk.rpcProxyBaseUrl, `${stage}: disk RPC`).toBe(expectedDiskRpc)
  expect(cached?.rpcProxyBaseUrl, `${stage}: cached RPC`).toBe(expectedCachedRpc)
  const expectedOrigin = m.originPersistedAfterDiscovery === true
  expect(Object.hasOwn(disk, 'profileUiBaseUrl'), `${stage}: disk origin ownership`).toBe(
    expectedOrigin
  )
  expect(Object.hasOwn(binding, 'profileUiBaseUrl'), `${stage}: cached origin ownership`).toBe(
    false
  )
  if (checkIndex && r.indexFile && m.indexBytesAfterFailure) {
    expect(await fs.readFile(r.indexFile, 'utf8'), `${stage}: index bytes`).toBe(
      m.indexBytesAfterFailure
    )
  }
}
class StartEnrich implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return m.mode === 'enrich' && m.phase === 'idle'
  }
  async run(m: Model, r: Real) {
    r.action = r.service.passwordLogin('user@example.test', 'synthetic-password')
    void r.action.catch(() => undefined)
    await r.requestStarted
    m.phase = 'pending'
  }
  toString() {
    return 'start-missing-rpc-enrichment'
  }
}
class SettleEnrich implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return m.mode === 'enrich' && m.phase === 'pending'
  }
  async run(m: Model, r: Real) {
    const outcome = await r.scheduler.waitFor(
      r.action!.then(
        () => 'unexpected success',
        error => (error as Error).message
      )
    )
    expect(outcome).toContain('login rejected for test')
    const disk = JSON.parse(await fs.readFile(r.pFile, 'utf8'))
    expect(disk.externalRestApiBaseUrl).toBe(rest)
    expect(disk.rpcProxyBaseUrl).toBe(rpc)
    expect(disk.profileUiBaseUrl).toBe(origin)
    expect(r.cfg.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
    m.phase = 'done'
    coverage.enrich++
  }
  toString() {
    return 'settle-enrichment-and-compare-file'
  }
}
class Start implements fc.AsyncCommand<Model, Real> {
  constructor(readonly kind: Kind) {}
  check(m: Readonly<Model>) {
    return (
      m.phase === 'idle' &&
      m.live &&
      m.selected === 'P' &&
      m.mode !== 'enrich' &&
      (m.mode !== 'configured' || this.kind === 'forgot')
    )
  }
  async run(m: Model, r: Real) {
    m.kind = this.kind
    m.phase = 'pending'
    m.generation = r.service.sessionGeneration
    r.action =
      this.kind === 'forgot'
        ? r.service.openForgotPassword('user@example.test')
        : this.kind === 'app'
          ? r.service.createSandboxUiDeepLink()
          : r.service.createGfsResourceDeepLink(uri)
    void r.action.catch(() => undefined)
    const first = await Promise.race([
      r.requestStarted.then(() => 'request-started'),
      r.action.then(
        () => 'settled-before-request',
        () => 'rejected-before-request'
      ),
    ])
    expect(first).toBe('request-started')
  }
  toString() {
    return `start-${this.kind}-origin-get`
  }
}
class SelectQ implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return m.mode === 'indexed' && m.phase === 'pending' && m.selected === 'P'
  }
  async run(m: Model, r: Real) {
    await r.service.selectRuntimeConfig(r.qId!)
    m.selected = 'Q'
  }
  toString() {
    return 'select-Q-while-P-get-pending'
  }
}
class Rename implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return (
      m.mode !== 'configured' &&
      m.mode !== 'enrich' &&
      m.phase === 'pending' &&
      m.live &&
      m.selected === 'P' &&
      !m.replaced &&
      !m.renamed &&
      !m.rebound
    )
  }
  async run(m: Model, r: Real) {
    await r.service.saveRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: rpc,
      appName: 'Renamed P',
    })
    m.renamed = true
  }
  toString() {
    return 'same-P-app-name-save'
  }
}
class DeleteExplicit implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return m.mode === 'explicit' && m.phase === 'pending' && m.live && !m.replaced && !m.rebound
  }
  async run(m: Model, r: Real) {
    await r.service.deleteRuntimeConfig(r.pId)
    expect(r.service.sessionGeneration).toBeGreaterThan(m.generation!)
    await expect(fs.access(r.pFile)).rejects.toMatchObject({ code: 'ENOENT' })
    m.live = false
    m.selected = 'none'
  }
  toString() {
    return 'delete-explicit-P'
  }
}
class RecreateExplicit implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return m.mode === 'explicit' && m.phase === 'pending' && !m.live && !m.replaced && !m.rebound
  }
  async run(m: Model, r: Real) {
    await r.service
      .saveRuntimeConfig({ externalRestApiBaseUrl: rest, rpcProxyBaseUrl: rpc, appName: 'P' })
      .catch(() => undefined)
    expect(JSON.parse(await fs.readFile(r.pFile, 'utf8')).externalRestApiBaseUrl).toBe(rest)
    m.live = true
    m.replaced = true
    m.selected = 'P'
  }
  toString() {
    return 'recreate-explicit-P-same-binding'
  }
}
class Settle implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return m.phase === 'pending' && m.mode !== 'enrich'
  }
  async run(m: Model, r: Real) {
    const indexBefore = r.indexFile ? await fs.readFile(r.indexFile, 'utf8') : undefined
    r.releaseOld()
    await Promise.resolve()
    await r.scheduler.waitAll()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('action did not settle')), 3000)
    })
    let result: { ok: boolean; value?: any; error?: unknown }
    try {
      result = await Promise.race([
        r.action!.then(
          value => ({ ok: true, value }),
          error => ({ ok: false, error })
        ),
        deadline,
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
    const stale = m.selected !== 'P' || m.replaced || m.rebound
    if (stale) {
      expect(result.ok).toBe(false)
      if (m.rebound && m.kind === 'forgot')
        expect(result.error).toHaveProperty('message', 'Profile UI deployment changed')
    } else {
      expect(result.ok).toBe(true)
      const expected =
        m.kind === 'forgot'
          ? `${origin}/forgot-password?email=user%40example.test`
          : m.kind === 'app'
            ? `${origin}/open/apps/sandbox-recipes/task-board?path=%2Ftasks%2F42`
            : `${origin}/open/files?uri=${encodeURIComponent(uri)}`
      expect(m.kind === 'forgot' ? result.value.profileUiUrl : result.value.url).toBe(expected)
      if (m.kind === 'forgot') expect(r.shell).toHaveBeenCalledWith(expected)
    }
    if (m.mode === 'configured') {
      expect(r.cfg.getDesktopRuntimeConfigState().activeOptionId).toBeNull()
      await expect(fs.access(r.forbiddenIndex!)).rejects.toMatchObject({ code: 'ENOENT' })
    } else if (!m.live) await expect(fs.access(r.pFile)).rejects.toMatchObject({ code: 'ENOENT' })
    else {
      const disk = JSON.parse(await fs.readFile(r.pFile, 'utf8'))
      if (m.secondDone) expect(disk.profileUiBaseUrl).toBe(nextOrigin)
      else if (stale) expect(disk.profileUiBaseUrl).not.toBe(origin)
      else expect(disk.profileUiBaseUrl).toBe(origin)
    }
    if (r.indexFile) expect(await fs.readFile(r.indexFile, 'utf8')).toBe(indexBefore)
    if (r.qFile) expect(await fs.readFile(r.qFile, 'utf8')).toBe(r.qBytes)
    if (m.mode === 'indexed' && m.selected === 'Q') coverage.indexedStale++
    if (m.mode === 'explicit' && m.replaced) {
      coverage.explicitReplacement++
      if (m.kind === 'app') coverage.replacementApp++
      if (m.kind === 'gfs') coverage.replacementGfs++
    }
    if (m.mode === 'explicit' && m.renamed && !m.replaced) coverage.explicitRename++
    if (m.kind === 'app') coverage.app++
    if (m.kind === 'gfs') coverage.gfs++
    m.phase = 'done'
  }
  toString() {
    return 'settle-and-compare-disk-index-and-action'
  }
}
class RebindRpc implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return (
      m.mode !== 'configured' &&
      m.mode !== 'enrich' &&
      m.phase === 'pending' &&
      m.live &&
      m.selected === 'P' &&
      !m.replaced &&
      !m.rebound
    )
  }
  async run(m: Model, r: Real) {
    await r.service.saveRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: 'https://rpc.next.example.test',
      appName: 'P',
    })
    m.rebound = true
    r.enableR2()
  }
  toString() {
    return 'true-RPC-rebind-while-old-get-pending'
  }
}
class StartR2Action implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return m.phase === 'pending' && m.rebound && !m.secondDone
  }
  async run(m: Model, r: Real) {
    const second = r.service.openForgotPassword('user@example.test')
    r.secondAction = second
    void second.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('R2 action did not settle')), 1000)
    })
    try {
      await Promise.race([r.newRequestStarted, deadline])
      r.releaseNew()
      const result = await Promise.race([r.scheduler.waitFor(second), deadline])
      expect(result.profileUiUrl).toBe(`${nextOrigin}/forgot-password?email=user%40example.test`)
    } finally {
      if (timer) clearTimeout(timer)
    }
    expect(JSON.parse(await fs.readFile(r.pFile, 'utf8')).profileUiBaseUrl).toBe(nextOrigin)
    m.secondDone = true
  }
  toString() {
    return 'R2-action-before-old-response'
  }
}
class SettleR1BeforeR2 implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return m.phase === 'pending' && m.rebound && !m.secondDone
  }
  async run(m: Model, r: Real) {
    const second = r.service.openForgotPassword('user@example.test')
    r.secondAction = second
    void second.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('overlap model did not settle')), 3000)
    })
    try {
      await Promise.race([r.newRequestStarted, deadline])
      r.releaseOld()
      await Promise.resolve()
      await expect(Promise.race([r.scheduler.waitFor(r.action!), deadline])).rejects.toThrow(
        'Profile UI deployment changed'
      )
      const beforeR2 = JSON.parse(await fs.readFile(r.pFile, 'utf8'))
      expect(beforeR2.rpcProxyBaseUrl).toBe('https://rpc.next.example.test')
      expect(beforeR2).not.toHaveProperty('profileUiBaseUrl')
      r.releaseNew()
      await Promise.resolve()
      const result = await Promise.race([r.scheduler.waitFor(second), deadline])
      expect(result.profileUiUrl).toBe(`${nextOrigin}/forgot-password?email=user%40example.test`)
      expect(JSON.parse(await fs.readFile(r.pFile, 'utf8')).profileUiBaseUrl).toBe(nextOrigin)
      expect(r.shell).not.toHaveBeenCalledWith(expect.stringContaining(origin))
      expect(r.shell).toHaveBeenCalledWith(result.profileUiUrl)
      m.secondDone = true
      m.phase = 'done'
    } finally {
      r.releaseNew()
      if (timer) clearTimeout(timer)
    }
  }
  toString() {
    return 'R1-response-before-R2-response-after-rebind'
  }
}
class SaveAfterOrigin implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return (
      m.mode !== 'configured' &&
      m.mode !== 'enrich' &&
      m.phase === 'done' &&
      m.live &&
      m.selected === 'P' &&
      !m.replaced &&
      !m.rebound
    )
  }
  async run(m: Model, r: Real) {
    await r.service.saveRuntimeConfig({
      externalRestApiBaseUrl: rest,
      rpcProxyBaseUrl: rpc,
      appName: 'Saved after origin',
    })
    const disk = JSON.parse(await fs.readFile(r.pFile, 'utf8'))
    expect(disk.appName).toBe('Saved after origin')
    expect(disk.profileUiBaseUrl).toBe(origin)
    m.renamed = true
    coverage.carry++
  }
  toString() {
    return 'ordinary-P-save-carries-stored-origin'
  }
}
class RestartRead implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return (
      m.mode !== 'configured' &&
      m.mode !== 'enrich' &&
      m.phase === 'done' &&
      m.live &&
      m.selected === 'P' &&
      !m.replaced &&
      !m.rebound
    )
  }
  async run(m: Model, r: Real) {
    expect(JSON.parse(await fs.readFile(r.pFile, 'utf8')).profileUiBaseUrl).toBe(origin)
    vi.resetModules()
    const [{ AppService }, cfg] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
    ])
    const service = new AppService() as unknown as {
      authClient: { getDesktopEnvironmentForEndpoint: ReturnType<typeof vi.fn> }
      openForgotPassword: (email: string) => Promise<{ profileUiUrl: string }>
    }
    const offline = vi.fn().mockRejectedValue(new Error('offline'))
    service.authClient = { getDesktopEnvironmentForEndpoint: offline }
    expect(cfg.getDesktopRuntimeConfigState().activeOptionId).toBe(r.pId)
    const result = await service.openForgotPassword('user@example.test')
    expect(result.profileUiUrl).toBe(`${origin}/forgot-password?email=user%40example.test`)
    expect(offline).not.toHaveBeenCalled()
    expect(r.shell).toHaveBeenLastCalledWith(result.profileUiUrl)
    m.phase = 'restarted'
    coverage.restart++
  }
  toString() {
    return 'restart-and-read-origin-offline'
  }
}
class FailIndexedRpcSave implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return m.mode === 'failed-save' && m.phase === 'ready'
  }
  async run(m: Model, r: Real) {
    const currentRest = r.cfg.getDesktopRuntimeConfigState().currentConfig!.externalRestApiBaseUrl
    const realWrite = fs.writeFile.bind(fs)
    const realRenameSync = fsSync.renameSync.bind(fsSync)
    let failed = false
    const write = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (
        !failed &&
        args[0] === r.pFile &&
        String(args[1]).includes('https://rpc-r2.example.test')
      ) {
        failed = true
        throw Object.assign(new Error('injected profile write failure'), { code: 'EACCES' })
      }
      return realWrite(...args)
    })
    const rename = vi.spyOn(fsSync, 'renameSync').mockImplementation((...args) => {
      if (!failed && args[1] === r.pFile) {
        failed = true
        throw Object.assign(new Error('injected profile write failure'), { code: 'EACCES' })
      }
      return realRenameSync(...args)
    })
    try {
      await expect(
        r.service.saveRuntimeConfig({
          externalRestApiBaseUrl: currentRest,
          rpcProxyBaseUrl: 'https://rpc-r2.example.test',
          appName: 'P',
        })
      ).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      write.mockRestore()
      rename.mockRestore()
    }
    expect(failed).toBe(true)
    const state = r.cfg.getDesktopRuntimeConfigState()
    const cached = state.options.find(option => option.id === r.pId)
    const disk = JSON.parse(await fs.readFile(r.pFile, 'utf8'))
    const indexBytes = await fs.readFile(r.indexFile!, 'utf8')
    const index = JSON.parse(indexBytes)
    expect(state.activeOptionId).toBe(r.pId)
    expect(state.currentConfig?.rpcProxyBaseUrl).toBe(rpc)
    expect(cached?.rpcProxyBaseUrl).toBe('https://rpc-r2.example.test')
    expect(disk.rpcProxyBaseUrl).toBe(rpc)
    expect(index.activeProfileId).toBe(r.pId)
    // A failed R2 environment transition may advance the generation while it
    // unwinds. The origin response and later retry must preserve that baseline.
    m.generation = r.service.sessionGeneration
    m.cachedRecordRestRpc = `${currentRest}|https://rpc-r2.example.test`
    m.diskRestRpc = `${currentRest}|${rpc}`
    m.requestCountBeforeOrigin = r.requestCount()
    m.indexBytesAfterFailure = indexBytes
    m.sessionTokenAfterFailure = r.service.sessionToken
    m.userIdAfterFailure = r.service.me?.id ?? null
    expect(m.cachedRecordRestRpc).not.toBe(m.diskRestRpc)
    m.phase = 'save-failed'
    failedSaveCoverage.failedSave++
    await assertFailedSaveReference(m, r, 'E20 failed file write')
  }
  toString() {
    return 'fail-public-indexed-save-after-cache-update'
  }
}
class ResolveR1OriginAfterFailure implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return m.mode === 'failed-save' && m.phase === 'save-failed'
  }
  async run(m: Model, r: Real) {
    const action = r.service.openForgotPassword('user@example.test')
    r.action = action
    void action.catch(() => undefined)
    if (m.mode !== 'failed-save') {
      await r.requestStarted
      r.releaseOld()
    }
    const result = await r.scheduler.waitFor(action)
    expect(result.profileUiUrl).toBe(`${origin}/forgot-password?email=user%40example.test`)
    expect(r.requestCount() - (m.requestCountBeforeOrigin || 0)).toBe(1)
    expect(r.requestPaths()).toEqual(['/api/v1/desktop/environment'])
    const originBinding = r.cfg.captureProfileOriginBinding()
    expect(originBinding.profileId).toBe(r.pId)
    expect(Object.hasOwn(originBinding, 'profileUiBaseUrl'), 'N30 cached origin ownership').toBe(
      false
    )
    expect(r.service.sessionGeneration).toBe(m.generation)
    const disk = JSON.parse(await fs.readFile(r.pFile, 'utf8'))
    const indexBytes = await fs.readFile(r.indexFile!, 'utf8')
    const index = JSON.parse(indexBytes)
    expect(disk.rpcProxyBaseUrl).toBe(rpc)
    m.originPersistedAfterDiscovery = m.cachedRecordRestRpc === m.diskRestRpc
    expect(Object.prototype.hasOwnProperty.call(disk, 'profileUiBaseUrl')).toBe(
      m.originPersistedAfterDiscovery
    )
    expect(index.activeProfileId).toBe(r.pId)
    expect(indexBytes).toBe(m.indexBytesAfterFailure)
    expect(r.get).toHaveBeenCalledTimes(1)
    expect(r.service.sessionGeneration).toBe(m.generation)
    expect(r.service.sessionToken).toBe(m.sessionTokenAfterFailure)
    expect(r.service.me?.id ?? null).toBe(m.userIdAfterFailure)
    m.originRequestCount = r.requestCount()
    expect(m.cachedRecordRestRpc).not.toBe(m.diskRestRpc)
    m.phase = 'origin-resolved'
    failedSaveCoverage.postFailureOrigin++
    await assertFailedSaveReference(m, r, 'N30 R1 origin response')
  }
  toString() {
    return 'resolve-original-r1-origin-after-failed-save'
  }
}
class RetryIndexedRpcSave implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return m.mode === 'failed-save' && m.phase === 'origin-resolved'
  }
  async run(m: Model, r: Real) {
    const currentRest = r.cfg.getDesktopRuntimeConfigState().currentConfig!.externalRestApiBaseUrl
    await r.service.saveRuntimeConfig({
      externalRestApiBaseUrl: currentRest,
      rpcProxyBaseUrl: 'https://rpc-r2.example.test',
      appName: 'P',
    })
    const disk = JSON.parse(await fs.readFile(r.pFile, 'utf8'))
    expect(disk.rpcProxyBaseUrl).toBe('https://rpc-r2.example.test')
    expect(disk).not.toHaveProperty('profileUiBaseUrl')
    expect(m.originPersistedAfterDiscovery).toBe(false)
    const state = r.cfg.getDesktopRuntimeConfigState()
    const index = JSON.parse(await fs.readFile(r.indexFile!, 'utf8'))
    expect(state.activeOptionId).toBe(r.pId)
    expect(state.currentConfig?.rpcProxyBaseUrl).toBe('https://rpc-r2.example.test')
    expect(index.activeProfileId).toBe(r.pId)
    expect(r.requestCount()).toBe(m.originRequestCount)
    m.generation = r.service.sessionGeneration
    m.phase = 'retried'
    m.diskRestRpc = m.cachedRecordRestRpc
    expect(m.diskRestRpc).toBe(m.cachedRecordRestRpc)
    failedSaveCoverage.retry++
    await assertFailedSaveReference(m, r, 'N30 R2 retry quiescence', false)
  }
  toString() {
    return 'retry-indexed-rpc-save-and-check-final-disk'
  }
}
class E20N30 implements fc.AsyncCommand<Model, Real> {
  check(m: Readonly<Model>) {
    return m.mode === 'failed-save' && m.phase === 'ready'
  }
  async run(m: Model, r: Real) {
    await new FailIndexedRpcSave().run(m, r)
    expect(m.phase).toBe('save-failed')
    await new ResolveR1OriginAfterFailure().run(m, r)
    expect(m.phase).toBe('origin-resolved')
    await new RetryIndexedRpcSave().run(m, r)
    expect(m.phase).toBe('retried')
    r48ModelCoverage.e20N30++
  }
  toString() {
    return 'E20-N30-failed-save-origin-retry'
  }
}
async function fixture(mode: Model['mode'], scheduler: fc.Scheduler): Promise<Real> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'origin-unified-'))
  dirs.add(dir)
  const explicitFile = path.join(dir, 'runtime.json')
  let fixtureRest = rest
  let server: ReturnType<typeof http.createServer> | undefined
  let closeServer = async () => {}
  let actualHttpRequestCount = 0
  const actualHttpRequestPaths: string[] = []
  try {
    if (mode === 'failed-save') {
      server = http.createServer()
      closeServer = () =>
        server!.listening
          ? new Promise<void>((resolve, reject) =>
              server!.close(error => (error ? reject(error) : resolve()))
            )
          : Promise.resolve()
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject)
        server!.listen(0, '127.0.0.1', () => {
          server!.off('error', reject)
          resolve()
        })
      })
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('model HTTP server did not bind TCP')
      fixtureRest = `http://127.0.0.1:${address.port}`
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
        EXTERNAL_REST_API_PUBLIC_BASE_URL: fixtureRest,
        EXTERNAL_REST_API_DESKTOP_RPC_PROXY_BASE_URL: rpc,
        EXTERNAL_REST_API_DESKTOP_APP_NAME: 'P',
      })
      delete process.env.CLERUM_DEV_MODE
      vi.resetModules()
      const { createDesktopRouter } =
        await import('../../../external-rest-api/src/routes/desktop.js')
      const express = createRequire(
        path.resolve(process.cwd(), '../external-rest-api/package.json')
      )('express')
      const app = express()
      app.use(
        (request: { originalUrl: string }, _response: unknown, next: (error?: unknown) => void) => {
          actualHttpRequestCount++
          actualHttpRequestPaths.push(request.originalUrl)
          void scheduler
            .schedule(Promise.resolve(), 'R1 actual HTTP environment response')
            .then(() => next(), next)
        }
      )
      app.use('/api/v1', createDesktopRouter())
      server.on('request', app)
    }
    delete process.env.EXTERNAL_REST_API_BASE_URL
    delete process.env.RPC_PROXY_BASE_URL
    delete process.env.PROFILE_UI_BASE_URL
    if (mode === 'explicit' || mode === 'enrich') {
      process.env.CLERUM_DESKTOP_CONFIG_PATH = explicitFile
      await fs.writeFile(
        explicitFile,
        JSON.stringify({
          externalRestApiBaseUrl: rest,
          rpcProxyBaseUrl: mode === 'enrich' ? '' : rpc,
          appName: 'P',
          ...(mode === 'enrich' ? { profileUiBaseUrl: origin } : {}),
        })
      )
    } else {
      delete process.env.CLERUM_DESKTOP_CONFIG_PATH
      if (mode === 'configured') {
        process.env.EXTERNAL_REST_API_BASE_URL = rest
        process.env.RPC_PROXY_BASE_URL = rpc
      }
    }
    vi.resetModules()
    const shell = vi.fn().mockResolvedValue(undefined)
    vi.doMock('electron', () => ({
      app: {
        getPath: (name: string) => (name === 'appData' ? path.dirname(dir) : dir),
        isPackaged: false,
        isReady: () => true,
        setName: vi.fn(),
        setPath: vi.fn(),
      },
      shell: { openExternal: shell },
    }))
    const [{ AppService }, cfg, driver] = await Promise.all([
      import('../appService.js'),
      import('../config.js'),
      import('../sandboxUiDriver.js'),
    ])
    vi.spyOn(driver, 'getActiveSandboxUiLocation').mockReturnValue({
      recipeNs: 'sandbox-recipes',
      recipeName: 'task-board',
      path: '/tasks/42',
    })
    let pId = 'custom-file',
      pFile = explicitFile,
      qId: string | undefined,
      qFile: string | undefined,
      indexFile: string | undefined,
      qBytes: string | undefined
    if (mode === 'indexed' || mode === 'failed-save') {
      await cfg.saveDesktopRuntimeConfig({
        externalRestApiBaseUrl: fixtureRest,
        rpcProxyBaseUrl: rpc,
        appName: 'P',
      })
      const p = cfg
        .getDesktopRuntimeConfigState()
        .options.find(option => option.externalRestApiBaseUrl === fixtureRest)!
      await cfg.saveDesktopRuntimeConfig({
        externalRestApiBaseUrl: qRest,
        rpcProxyBaseUrl: 'https://rpc.q.example.test',
        appName: 'Q',
      })
      const q = cfg
        .getDesktopRuntimeConfigState()
        .options.find(option => option.externalRestApiBaseUrl === qRest)!
      await cfg.selectDesktopRuntimeConfigOption(p.id)
      pId = p.id
      pFile = p.configPath!
      qId = q.id
      qFile = q.configPath!
      qBytes = await fs.readFile(qFile, 'utf8')
      indexFile = path.join(path.dirname(pFile), 'index.json')
    }
    const service = new AppService() as unknown as Service
    service.tokenStore = {
      clearSessionToken: vi.fn().mockResolvedValue(undefined),
      getSessionToken: vi.fn().mockResolvedValue(null),
      setSessionToken: vi.fn().mockResolvedValue(undefined),
    }
    service.suspendDesktopGfsUploadsForAuthBoundary = vi.fn().mockResolvedValue(undefined)
    service.stopAllStreams = vi.fn()
    if (mode !== 'enrich') {
      service.sessionToken = 'synthetic-session'
      service.me = { id: 'user-1', email: 'user@example.test' }
    }
    let announce!: () => void
    const requestStarted = new Promise<void>(resolve => {
      announce = resolve
    })
    let releaseOld!: () => void
    const oldReady = new Promise<void>(resolve => {
      releaseOld = resolve
    })
    let r2Enabled = false
    let announceNew!: () => void
    const newRequestStarted = new Promise<void>(resolve => {
      announceNew = resolve
    })
    let releaseNew!: () => void
    const newReady = new Promise<void>(resolve => {
      releaseNew = resolve
    })
    let get: ReturnType<typeof vi.fn>
    let requestCount: () => number = () => get.mock.calls.length
    if (mode === 'failed-save') {
      get = vi.spyOn(
        service.authClient,
        'getDesktopEnvironmentForEndpoint'
      ) as unknown as ReturnType<typeof vi.fn>
      requestCount = () => actualHttpRequestCount
    } else {
      get = vi
        .fn()
        .mockImplementationOnce(() => {
          announce()
          return oldReady.then(() =>
            scheduler.schedule(Promise.resolve(producerResponses.r1), 'P-origin-response')
          )
        })
        .mockImplementation(() => {
          if (!r2Enabled) return Promise.reject(new Error('subsequent discovery offline'))
          announceNew()
          return newReady.then(() =>
            scheduler.schedule(Promise.resolve(producerResponses.r2), 'R2-origin-response')
          )
        })
      if (mode === 'enrich')
        get.mockReset().mockImplementation(() => {
          announce()
          return scheduler.schedule(
            Promise.resolve(producerResponses.legacy),
            'verified RPC enrichment'
          )
        })
      service.authClient = {
        getDesktopEnvironment: get,
        getDesktopEnvironmentForEndpoint: get,
        passwordLogin: vi.fn().mockRejectedValue(new Error('login rejected for test')),
      }
    }
    return {
      service,
      cfg,
      scheduler,
      get,
      requestCount,
      requestPaths: () => [...actualHttpRequestPaths],
      pId,
      pFile,
      qId,
      qFile,
      qBytes,
      indexFile,
      forbiddenIndex:
        mode === 'configured' ? path.join(dir, 'runtime-configs', 'index.json') : undefined,
      requestStarted,
      newRequestStarted,
      releaseOld,
      releaseNew,
      enableR2: () => {
        r2Enabled = true
      },
      closeServer,
      shell,
    }
  } catch (error) {
    const cleanupErrors: unknown[] = []
    try {
      await closeServer()
    } catch (closeError) {
      cleanupErrors.push(closeError)
    }
    try {
      await cleanup()
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    if (cleanupErrors.length)
      throw new AggregateError([error, ...cleanupErrors], 'Model fixture setup and cleanup failed')
    throw error
  }
}
it.each(['indexed', 'explicit', 'configured', 'enrich', 'failed-save'] as const)(
  'unified model: %s profile events',
  async mode => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(
          [
            fc.constant(new StartEnrich()),
            fc.constant(new SettleEnrich()),
            fc.constant(new Start('forgot')),
            fc.constant(new Start('app')),
            fc.constant(new Start('gfs')),
            fc.constant(new SelectQ()),
            fc.constant(new Rename()),
            fc.constant(new DeleteExplicit()),
            fc.constant(new RecreateExplicit()),
            fc.constant(new RebindRpc()),
            fc.constant(new StartR2Action()),
            ...(mode === 'indexed' ? [fc.constant(new SettleR1BeforeR2())] : []),
            fc.constant(new Settle()),
            fc.constant(new SaveAfterOrigin()),
            fc.constant(new RestartRead()),
            fc.constant(new FailIndexedRpcSave()),
            fc.constant(new ResolveR1OriginAfterFailure()),
            fc.constant(new RetryIndexedRpcSave()),
            ...(mode === 'failed-save' ? [fc.constant(new E20N30())] : []),
          ],
          { maxCommands: 22 }
        ),
        async (scheduler, commands) => {
          const model: Model = {
            mode,
            phase: mode === 'failed-save' ? 'ready' : 'idle',
            selected: 'P',
            live: true,
            replaced: false,
            renamed: false,
            rebound: false,
            secondDone: false,
            ...(mode === 'failed-save' ? { originPersistedAfterDiscovery: false } : {}),
          }
          const real = await fixture(mode, scheduler)
          try {
            await fc.asyncModelRun(() => ({ model, real }), commands)
            if (mode === 'failed-save') {
              if (model.phase === 'ready') await new FailIndexedRpcSave().run(model, real)
              if (model.phase === 'save-failed')
                await new ResolveR1OriginAfterFailure().run(model, real)
              if (model.phase === 'origin-resolved')
                await new RetryIndexedRpcSave().run(model, real)
              expect(model.phase).toBe('retried')
              expect(model.diskRestRpc).toBe(model.cachedRecordRestRpc)
            } else if (model.phase === 'pending')
              await (mode === 'enrich' ? new SettleEnrich() : new Settle()).run(model, real)
          } finally {
            real.releaseOld()
            real.releaseNew()
            try {
              await Promise.resolve()
              await scheduler.waitAll()
              await Promise.allSettled([
                ...(real.action ? [real.action] : []),
                ...(real.secondAction ? [real.secondAction] : []),
              ])
            } finally {
              try {
                await real.closeServer()
              } finally {
                await cleanup()
              }
            }
          }
        }
      ),
      {
        seed:
          mode === 'indexed'
            ? 146347
            : mode === 'explicit'
              ? 146348
              : mode === 'enrich'
                ? 146351
                : mode === 'failed-save'
                  ? 148301
                  : 146349,
        numRuns: mode === 'explicit' ? 1200 : 80,
        endOnFailure: true,
      }
    )
    if (mode === 'enrich') expect(coverage.enrich).toBeGreaterThan(0)
    else if (mode === 'indexed') expect(coverage.indexedStale).toBeGreaterThan(0)
    else if (mode === 'explicit') {
      expect(coverage.explicitReplacement).toBeGreaterThan(0)
      expect(coverage.explicitRename).toBeGreaterThan(0)
      expect(coverage.replacementApp).toBeGreaterThan(0)
      expect(coverage.replacementGfs).toBeGreaterThan(0)
      expect(coverage.carry).toBeGreaterThan(0)
      expect(coverage.restart).toBeGreaterThan(0)
      expect(coverage.app).toBeGreaterThan(0)
      expect(coverage.gfs).toBeGreaterThan(0)
    } else if (mode === 'failed-save') {
      expect(failedSaveCoverage.failedSave).toBeGreaterThan(0)
      expect(failedSaveCoverage.postFailureOrigin).toBeGreaterThan(0)
      expect(failedSaveCoverage.retry).toBeGreaterThan(0)
      expect(r48ModelCoverage.e20N30).toBeGreaterThan(0)
    }
  },
  60000
)

it.each(['R1-first', 'R2-first'] as const)(
  'unified model: overlapping rebind %s',
  async order => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async scheduler => {
        const model: Model = {
          mode: 'indexed',
          phase: 'idle',
          selected: 'P',
          live: true,
          replaced: false,
          renamed: false,
          rebound: false,
          secondDone: false,
        }
        const real = await fixture('indexed', scheduler)
        try {
          const commands =
            order === 'R1-first'
              ? [new Start('forgot'), new RebindRpc(), new SettleR1BeforeR2()]
              : [new Start('forgot'), new RebindRpc(), new StartR2Action(), new Settle()]
          await fc.asyncModelRun(() => ({ model, real }), commands)
          expect(model.phase).toBe('done')
          expect(model.secondDone).toBe(true)
          expect(real.get).toHaveBeenCalledTimes(2)
        } finally {
          real.releaseOld()
          real.releaseNew()
          try {
            await Promise.resolve()
            await scheduler.waitAll()
            await Promise.allSettled([
              ...(real.action ? [real.action] : []),
              ...(real.secondAction ? [real.secondAction] : []),
            ])
          } finally {
            try {
              await real.closeServer()
            } finally {
              await cleanup()
            }
          }
        }
      }),
      { seed: order === 'R1-first' ? 146352 : 146353, numRuns: 12, endOnFailure: true }
    )
  },
  30000
)
