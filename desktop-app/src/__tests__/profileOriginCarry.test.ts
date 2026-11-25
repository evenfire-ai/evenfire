import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const originalPath = process.env.CLERUM_DESKTOP_CONFIG_PATH
let directory: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  if (originalPath === undefined) delete process.env.CLERUM_DESKTOP_CONFIG_PATH
  else process.env.CLERUM_DESKTOP_CONFIG_PATH = originalPath
  if (directory) await fs.rm(directory, { recursive: true, force: true })
  directory = undefined
  vi.doUnmock('electron')
  vi.resetModules()
})

it.each([
  ['same binding', 'https://rpc.example.test', 'https://rpc.example.test', false, true],
  ['trusted RPC enrichment', '', 'https://rpc.example.test', true, true],
  ['untrusted RPC change', '', 'https://rpc.example.test', false, false],
  ['RPC rebind', 'https://rpc.example.test', 'https://rpc-other.example.test', true, false],
])(
  '%s carries only the same deployment origin',
  async (_name, oldRpc, newRpc, trusted, retained) => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-origin-carry-'))
    const file = path.join(directory, 'profile.json')
    process.env.CLERUM_DESKTOP_CONFIG_PATH = file
    await fs.writeFile(
      file,
      JSON.stringify({
        externalRestApiBaseUrl: 'https://api.example.test',
        rpcProxyBaseUrl: oldRpc,
        appName: 'Before',
        profileUiBaseUrl: 'https://profile.example.test',
      })
    )
    vi.doMock('electron', () => ({
      app: { isReady: () => false, isPackaged: false, setName: vi.fn(), setPath: vi.fn() },
    }))
    const runtime = await import('../config.js')
    await runtime.saveDesktopRuntimeConfig(
      {
        externalRestApiBaseUrl: 'https://api.example.test',
        rpcProxyBaseUrl: newRpc,
        appName: 'After',
      },
      { trustedRpcEnrichment: trusted }
    )
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(saved.appName).toBe('After')
    if (retained) expect(saved.profileUiBaseUrl).toBe('https://profile.example.test')
    else expect(saved).not.toHaveProperty('profileUiBaseUrl')
  }
)

it.each([
  ['same binding', 'https://rpc.example.test', true],
  ['RPC rebind', 'https://rpc-other.example.test', false],
])(
  'preserves explicit-file semantics after a failed save and %s retry',
  async (_name, nextRpc, retained) => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-origin-explicit-retry-'))
    const file = path.join(directory, 'profile.json')
    process.env.CLERUM_DESKTOP_CONFIG_PATH = file
    const profile = {
      externalRestApiBaseUrl: 'https://api.example.test',
      rpcProxyBaseUrl: 'https://rpc.example.test',
      appName: 'Before',
      profileUiBaseUrl: 'https://profile.example.test',
    }
    await fs.writeFile(file, JSON.stringify(profile))
    vi.doMock('electron', () => ({
      app: { isReady: () => false, isPackaged: false, setName: vi.fn(), setPath: vi.fn() },
    }))
    const runtime = await import('../config.js')
    const before = runtime.captureProfileOriginBinding()
    expect(before.witness).not.toBeNull()
    const initialBytes = await fs.readFile(file, 'utf8')
    const realWrite = fs.writeFile.bind(fs)
    let failed = false
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (!failed && args[0] === file) {
        failed = true
        throw Object.assign(new Error('injected profile write failure'), { code: 'EACCES' })
      }
      return realWrite(...args)
    })

    const next = {
      externalRestApiBaseUrl: profile.externalRestApiBaseUrl,
      rpcProxyBaseUrl: nextRpc,
      appName: 'After',
    }
    await expect(runtime.saveDesktopRuntimeConfig(next)).rejects.toMatchObject({ code: 'EACCES' })
    expect(failed).toBe(true)
    expect(await fs.readFile(file, 'utf8')).toBe(initialBytes)
    expect(runtime.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
    expect(runtime.getDesktopRuntimeConfigState().currentConfig?.rpcProxyBaseUrl).toBe(
      profile.rpcProxyBaseUrl
    )
    const afterFailure = runtime.captureProfileOriginBinding()
    expect(afterFailure).toMatchObject({
      profileId: 'custom-file',
      profileUiBaseUrl: profile.profileUiBaseUrl,
    })
    expect(afterFailure.witness).toBe(before.witness)

    await runtime.saveDesktopRuntimeConfig(next)
    const saved = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(saved.rpcProxyBaseUrl).toBe(nextRpc)
    expect(saved.appName).toBe('After')
    if (retained) expect(saved.profileUiBaseUrl).toBe(profile.profileUiBaseUrl)
    else expect(saved).not.toHaveProperty('profileUiBaseUrl')
    expect(runtime.getDesktopRuntimeConfigState().activeOptionId).toBe('custom-file')
    expect(runtime.captureProfileOriginBinding().witness).toBe(before.witness)
  }
)

it('keeps a witness for ordinary saves but rejects a deleted and recreated profile', async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-origin-lifetime-'))
  const file = path.join(directory, 'profile.json')
  process.env.CLERUM_DESKTOP_CONFIG_PATH = file
  const profile = {
    externalRestApiBaseUrl: 'https://api.example.test',
    rpcProxyBaseUrl: 'https://rpc.example.test',
    appName: 'Original',
  }
  await fs.writeFile(file, JSON.stringify(profile))
  vi.doMock('electron', () => ({
    app: { isReady: () => false, isPackaged: false, setName: vi.fn(), setPath: vi.fn() },
  }))
  const runtime = await import('../config.js')
  const original = runtime.captureProfileOriginBinding()
  await runtime.saveDesktopRuntimeConfig({ ...profile, appName: 'Renamed' })
  await runtime.persistProfileOriginForBinding(original, 'https://profile.example.test')
  expect(JSON.parse(await fs.readFile(file, 'utf8')).profileUiBaseUrl).toBe(
    'https://profile.example.test'
  )
  await runtime.deleteDesktopRuntimeConfigOption('custom-file')
  await runtime.saveDesktopRuntimeConfig(profile)
  await expect(
    runtime.persistProfileOriginForBinding(original, 'https://profile.example.test')
  ).rejects.toThrow('Profile UI deployment changed')
  expect(JSON.parse(await fs.readFile(file, 'utf8'))).not.toHaveProperty('profileUiBaseUrl')
})
