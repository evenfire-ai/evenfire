import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const electronState = vi.hoisted(() => ({
  isReady: false,
  userDataDir: '',
  keychain: new Map<string, string>(),
}))

vi.mock('keytar', () => ({
  getPassword: vi.fn(
    async (service: string, account: string) =>
      electronState.keychain.get(`${service}::${account}`) ?? null
  ),
  setPassword: vi.fn(async (service: string, account: string, value: string) => {
    electronState.keychain.set(`${service}::${account}`, value)
  }),
  deletePassword: vi.fn(async (service: string, account: string) =>
    electronState.keychain.delete(`${service}::${account}`)
  ),
}))

vi.mock('electron', () => ({
  app: {
    isReady: vi.fn(() => electronState.isReady),
    getPath: vi.fn(() => electronState.userDataDir),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`unit-enc:${value}`, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8').replace(/^unit-enc:/, '')),
  },
}))

const ENV = 'env_a-000000000000'
const SERVICE = 'Evenfire'
const LEGACY_ACCOUNT = 'session-token'
const SCOPED_ACCOUNT = `${LEGACY_ACCOUNT}::${ENV}`
const OFFICIAL_SCOPED_FILE = `session-token-${ENV}.json`
const OFFICIAL_LEGACY_FILE = 'session-token.json'

let officialHome = ''
let isolatedDir = ''
let TokenStore: typeof import('../tokenStore.js').TokenStore

beforeEach(async () => {
  electronState.isReady = false
  electronState.userDataDir = ''
  electronState.keychain.clear()
  officialHome = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-official-home-'))
  isolatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-isolated-user-data-'))
  vi.spyOn(os, 'homedir').mockReturnValue(officialHome)
  TokenStore = (await import('../tokenStore.js')).TokenStore
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(officialHome, { recursive: true, force: true })
  await fs.rm(isolatedDir, { recursive: true, force: true })
})

async function seedOfficialStorage(): Promise<{ scoped: string; legacy: string }> {
  const officialStorage = path.join(officialHome, '.evenfire')
  const scopedValue = ['unit', ENV, 'scoped'].join(':')
  const legacyValue = ['unit', 'legacy'].join(':')
  const scoped = JSON.stringify({ token: scopedValue })
  const legacy = JSON.stringify({ token: legacyValue })
  await fs.mkdir(officialStorage, { recursive: true })
  await fs.writeFile(path.join(officialStorage, OFFICIAL_SCOPED_FILE), scoped)
  await fs.writeFile(path.join(officialStorage, OFFICIAL_LEGACY_FILE), legacy)
  electronState.keychain.set(`${SERVICE}::${SCOPED_ACCOUNT}`, scopedValue)
  electronState.keychain.set(`${SERVICE}::${LEGACY_ACCOUNT}`, legacyValue)
  return { scoped, legacy }
}

async function keytarCalls(): Promise<number> {
  const keytar = await import('keytar')
  return (
    vi.mocked(keytar.getPassword).mock.calls.length +
    vi.mocked(keytar.setPassword).mock.calls.length +
    vi.mocked(keytar.deletePassword).mock.calls.length
  )
}

async function officialDocuments(): Promise<{ scoped: string; legacy: string }> {
  const officialStorage = path.join(officialHome, '.evenfire')
  return {
    scoped: await fs.readFile(path.join(officialStorage, OFFICIAL_SCOPED_FILE), 'utf8'),
    legacy: await fs.readFile(path.join(officialStorage, OFFICIAL_LEGACY_FILE), 'utf8'),
  }
}

describe('TokenStore dev isolation', () => {
  it('reads an empty isolated store without importing official storage', async () => {
    const official = await seedOfficialStorage()
    electronState.isReady = true
    electronState.userDataDir = isolatedDir
    const store = new TokenStore({ isolatedUserDataPath: isolatedDir })

    await expect(store.getSessionToken(ENV)).resolves.toBeNull()

    expect(await keytarCalls()).toBe(0)
    expect(electronState.keychain.get(`${SERVICE}::${SCOPED_ACCOUNT}`)).toBe(
      ['unit', ENV, 'scoped'].join(':')
    )
    expect(electronState.keychain.get(`${SERVICE}::${LEGACY_ACCOUNT}`)).toBe(
      ['unit', 'legacy'].join(':')
    )
    expect(await officialDocuments()).toEqual(official)
  })

  it('persists and clears an encrypted isolated file without keytar calls', async () => {
    const official = await seedOfficialStorage()
    const isolatedValue = ['unit', 'isolated'].join(':')
    electronState.isReady = true
    electronState.userDataDir = isolatedDir
    const store = new TokenStore({ isolatedUserDataPath: isolatedDir })
    const encryptedFile = path.join(isolatedDir, `session-token-${ENV}.enc`)

    await store.setSessionToken(isolatedValue, ENV)
    expect(await store.getSessionToken(ENV)).toBe(isolatedValue)
    expect((await fs.stat(encryptedFile)).mode & 0o777).toBe(0o600)
    expect(await fs.readdir(isolatedDir)).toEqual([path.basename(encryptedFile)])

    await store.clearSessionToken(ENV)
    await expect(store.getSessionToken(ENV)).resolves.toBeNull()
    await expect(fs.access(encryptedFile)).rejects.toMatchObject({ code: 'ENOENT' })

    expect(await keytarCalls()).toBe(0)
    expect(await officialDocuments()).toEqual(official)
  })

  it('rejects isolated operations before Electron is ready', async () => {
    const store = new TokenStore({ isolatedUserDataPath: isolatedDir })
    const isolatedValue = ['unit', 'isolated'].join(':')

    await expect(store.getSessionToken(ENV)).rejects.toThrow(/requires Electron readiness/)
    await expect(store.setSessionToken(isolatedValue, ENV)).rejects.toThrow(
      /requires Electron readiness/
    )
    await expect(store.clearSessionToken(ENV)).rejects.toThrow(/requires Electron readiness/)

    expect(await keytarCalls()).toBe(0)
    expect(await fs.readdir(isolatedDir)).toEqual([])
  })

  it('rejects isolated operations when declared and actual userData differ', async () => {
    const actualDir = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-actual-user-data-'))
    try {
      const isolatedValue = ['unit', 'isolated'].join(':')
      electronState.isReady = true
      electronState.userDataDir = actualDir
      const store = new TokenStore({ isolatedUserDataPath: isolatedDir })

      await expect(store.getSessionToken(ENV)).rejects.toThrow(/directory mismatch/)
      await expect(store.setSessionToken(isolatedValue, ENV)).rejects.toThrow(/directory mismatch/)
      await expect(store.clearSessionToken(ENV)).rejects.toThrow(/directory mismatch/)

      expect(await keytarCalls()).toBe(0)
      expect(await fs.readdir(actualDir)).toEqual([])
      expect(await fs.readdir(isolatedDir)).toEqual([])
    } finally {
      await fs.rm(actualDir, { recursive: true, force: true })
    }
  })
})
