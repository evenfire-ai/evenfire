import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Synthetic unit material demonstrates cross-scope consumption/deletion.
// Only OS boundaries are mocked here; browser E2E uses real authentication.
const fixture = vi.hoisted(() => ({
  userData: '',
  ready: true,
  rejectPrivateDelete: false,
  rejectFileDelete: false,
  records: new Map<string, string>(),
  rejectFileBasename: '',
  fileFailureCode: 'EACCES',
  absentOtherFiles: false,
  calls: [] as Array<{ operation: string; service: string; account: string }>,
  files: [] as Array<{ operation: string; filename: string }>,
}))
vi.mock('electron', () => ({
  app: {
    isReady: () => fixture.ready,
    getPath(kind: string) {
      if (kind !== 'userData') throw new Error('Unexpected fixture path')
      return fixture.userData
    },
  },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('keytar', () => ({
  async getPassword(service: string, account: string) {
    fixture.calls.push({ operation: 'get', service, account })
    return fixture.records.get(`${service}|${account}`) ?? null
  },
  async setPassword(service: string, account: string, value: string) {
    fixture.calls.push({ operation: 'set', service, account })
    fixture.records.set(`${service}|${account}`, value)
  },
  async deletePassword(service: string, account: string) {
    fixture.calls.push({ operation: 'delete', service, account })
    if (fixture.rejectPrivateDelete) throw new Error('Synthetic private deletion failure')
    return fixture.records.delete(`${service}|${account}`)
  },
}))
vi.mock('node:fs/promises', () => ({
  default: {
    async mkdir() {},
    async readFile(filename: string) {
      fixture.files.push({ operation: 'read', filename })
      throw Object.assign(new Error('Synthetic fixture absence'), { code: 'ENOENT' })
    },
    async unlink(filename: string) {
      fixture.files.push({ operation: 'delete', filename })
      if (fixture.rejectFileDelete)
        throw Object.assign(new Error('Synthetic file permission failure'), { code: 'EACCES' })
      if (fixture.rejectFileBasename && path.basename(filename) === fixture.rejectFileBasename)
        throw Object.assign(new Error('Synthetic legacy file permission failure'), {
          code: fixture.fileFailureCode,
        })
      if (fixture.absentOtherFiles)
        throw Object.assign(new Error('Synthetic fixture absence'), { code: 'ENOENT' })
    },
    async open() {
      return { async sync() {}, async close() {} }
    },
  },
}))
const currentEnv = 'fixture-000000000001'
const legacyEnv = 'legacy-000000000001'
const slotName = 'session-token'
const currentAccount = `${slotName}::${currentEnv}`
const legacyAccount = `${slotName}::${legacyEnv}`
const material = 'synthetic-unit-material'
let directory: string
let otherDirectory: string
beforeEach(() => {
  vi.resetModules()
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-isolated-auth-'))
  otherDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-isolated-auth-other-'))
  fs.chmodSync(directory, 0o700)
  fs.chmodSync(otherDirectory, 0o700)
  fixture.userData = directory
  fixture.ready = true
  fixture.rejectPrivateDelete = false
  fixture.rejectFileDelete = false
  fixture.rejectFileBasename = ''
  fixture.fileFailureCode = 'EACCES'
  fixture.absentOtherFiles = false
  fixture.records.clear()
  fixture.calls.length = 0
  fixture.files.length = 0
  fixture.records.set(`Evenfire|${slotName}`, material)
  fixture.records.set(`Evenfire|${legacyAccount}`, material)
})
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
  fs.rmSync(otherDirectory, { recursive: true, force: true })
})
describe('verified dev-isolation authentication storage', () => {
  it('never reads or migrates the normal global/legacy slot for a fresh isolated run', async () => {
    const { bindTokenStoreIsolation, TokenStore } = await import('../tokenStore')
    bindTokenStoreIsolation(directory)
    expect(
      await new TokenStore().getSessionToken(currentEnv, { legacyEnvKeys: [legacyEnv] })
    ).toBeNull()
    expect(fixture.calls.length).toBeGreaterThan(0)
    expect(
      fixture.calls.every(call => call.service !== 'Evenfire' && call.account === currentAccount)
    ).toBe(true)
    expect(fixture.records.get(`Evenfire|${slotName}`)).toBe(material)
    expect(
      fixture.files.every(
        call =>
          path.dirname(call.filename) === directory &&
          ![`${slotName}.json`, `${slotName}.enc`].includes(path.basename(call.filename)) &&
          !path.basename(call.filename).includes(legacyEnv)
      )
    ).toBe(true)
  })
  it('sets, reads and clears only its private service, including files inside its own directory', async () => {
    const { bindTokenStoreIsolation, TokenStore } = await import('../tokenStore')
    bindTokenStoreIsolation(directory)
    const store = new TokenStore()
    await store.setSessionToken(material, currentEnv)
    expect(await store.getSessionToken(currentEnv)).toBe(material)
    await store.clearSessionToken(currentEnv, { legacyEnvKeys: [legacyEnv] })
    expect(fixture.calls.map(call => call.operation)).toEqual(['set', 'get', 'delete'])
    expect(
      fixture.calls.every(call => call.service !== 'Evenfire' && call.account === currentAccount)
    ).toBe(true)
    expect(fixture.records.get(`Evenfire|${slotName}`)).toBe(material)
    expect(fixture.records.get(`Evenfire|${legacyAccount}`)).toBe(material)
    expect(
      fixture.files.every(
        call =>
          path.dirname(call.filename) === directory &&
          !path.basename(call.filename).includes(legacyEnv)
      )
    ).toBe(true)
    expect(
      fixture.files
        .filter(call => call.operation === 'delete')
        .map(call => path.basename(call.filename))
    ).toEqual(expect.arrayContaining([`${slotName}.json`, `${slotName}.enc`]))
  })
  it('keeps two actual userData directories separate with the same environment', async () => {
    const first = await import('../tokenStore')
    first.bindTokenStoreIsolation(directory)
    await new first.TokenStore().setSessionToken(material, currentEnv)
    const firstService = fixture.calls[0]!.service
    vi.resetModules()
    fixture.userData = otherDirectory
    const second = await import('../tokenStore')
    second.bindTokenStoreIsolation(otherDirectory)
    expect(await new second.TokenStore().getSessionToken(currentEnv)).toBeNull()
    expect(fixture.calls.find(call => call.operation === 'get')!.service).not.toBe(firstService)
    expect(fixture.records.get(`${firstService}|${currentAccount}`)).toBe(material)
  })
  it('preserves the existing normal-mode global migration', async () => {
    const { TokenStore } = await import('../tokenStore')
    expect(await new TokenStore().getSessionToken(currentEnv)).toBe(material)
    expect(fixture.calls).toEqual([
      { operation: 'get', service: 'Evenfire', account: currentAccount },
      { operation: 'get', service: 'Evenfire', account: slotName },
      { operation: 'set', service: 'Evenfire', account: currentAccount },
      { operation: 'delete', service: 'Evenfire', account: slotName },
    ])
  })
  it('rejects mismatched runtime context before credential access', async () => {
    const { bindTokenStoreIsolation } = await import('../tokenStore')
    expect(() => bindTokenStoreIsolation(otherDirectory)).toThrow(
      'TokenStoreIsolationUserDataMismatch'
    )
    expect(fixture.calls).toEqual([])
    expect(fixture.files).toEqual([])
  })
  it('rejects unready runtime context before credential access', async () => {
    const { bindTokenStoreIsolation } = await import('../tokenStore')
    fixture.ready = false
    expect(() => bindTokenStoreIsolation(directory)).toThrow(
      'TokenStoreIsolationAfterStorageAccess'
    )
    expect(fixture.calls).toEqual([])
    expect(fixture.files).toEqual([])
  })
  it('rejects late binding after the first actual operation', async () => {
    const { bindTokenStoreIsolation, TokenStore } = await import('../tokenStore')
    bindTokenStoreIsolation(directory)
    expect(await new TokenStore().getSessionToken(currentEnv)).toBeNull()
    expect(() => bindTokenStoreIsolation(directory)).toThrow(
      'TokenStoreIsolationAfterStorageAccess'
    )
  })
  it('latches required mode before binding and blocks every global fallback', async () => {
    const { requireTokenStoreIsolation, TokenStore } = await import('../tokenStore')
    requireTokenStoreIsolation()
    const store = new TokenStore()
    await expect(store.getSessionToken(currentEnv)).rejects.toThrow('TokenStoreIsolationNotBound')
    await expect(store.setSessionToken(material, currentEnv)).rejects.toThrow(
      'TokenStoreIsolationNotBound'
    )
    await expect(store.clearSessionToken(currentEnv)).rejects.toThrow('TokenStoreIsolationNotBound')
    expect(fixture.calls).toEqual([])
    expect(fixture.files).toEqual([])
    expect(fixture.records.get(`Evenfire|${slotName}`)).toBe(material)
  })
  it('failed binding remains fail closed rather than restoring a normal/global session', async () => {
    const { bindTokenStoreIsolation, TokenStore } = await import('../tokenStore')
    expect(() => bindTokenStoreIsolation(otherDirectory)).toThrow()
    const store = new TokenStore()
    await expect(store.getSessionToken(currentEnv)).rejects.toThrow('TokenStoreIsolationNotBound')
    await expect(store.setSessionToken(material, currentEnv)).rejects.toThrow(
      'TokenStoreIsolationNotBound'
    )
    await expect(store.clearSessionToken(currentEnv)).rejects.toThrow('TokenStoreIsolationNotBound')
    expect(fixture.calls).toEqual([])
    expect(fixture.files).toEqual([])
  })
  it('rejects a later userData change before touching another profile or shared credentials', async () => {
    const { bindTokenStoreIsolation, TokenStore } = await import('../tokenStore')
    bindTokenStoreIsolation(directory)
    fixture.userData = otherDirectory
    await expect(new TokenStore().getSessionToken(currentEnv)).rejects.toThrow(
      'TokenStoreIsolationContextChanged'
    )
    expect(fixture.calls).toEqual([])
    expect(fixture.files).toEqual([])
  })
  it('rejects isolated logout on private keychain deletion failure and preserves diagnostics', async () => {
    const { bindTokenStoreIsolation, TokenStore } = await import('../tokenStore')
    bindTokenStoreIsolation(directory)
    fixture.rejectPrivateDelete = true
    await expect(new TokenStore().clearSessionToken(currentEnv)).rejects.toMatchObject({
      code: 'TokenStoreIsolationCleanupFailed',
      surface: 'keychain',
    })
    expect(fixture.calls.every(call => call.service !== 'Evenfire')).toBe(true)
    expect(fixture.files).toEqual([])
    expect(fixture.records.get(`Evenfire|${slotName}`)).toBe(material)
  })
  it('rejects isolated logout on own file failure without touching another directory', async () => {
    const { bindTokenStoreIsolation, TokenStore } = await import('../tokenStore')
    bindTokenStoreIsolation(directory)
    fixture.rejectFileDelete = true
    await expect(new TokenStore().clearSessionToken(currentEnv)).rejects.toMatchObject({
      code: 'TokenStoreIsolationCleanupFailed',
      surface: 'file',
    })
    expect(fixture.files.every(call => path.dirname(call.filename) === directory)).toBe(true)
  })
  it.each([
    ['enc', 'EPERM'],
    ['enc', 'EACCES'],
    ['json', 'EPERM'],
    ['json', 'EACCES'],
  ] as const)(
    'rejects isolated logout when only its owned legacy %s file rejects deletion with %s',
    async (extension, code) => {
      const { bindTokenStoreIsolation, TokenStore } = await import('../tokenStore')
      bindTokenStoreIsolation(directory)
      const store = new TokenStore()
      await store.setSessionToken(material, currentEnv)
      const service = fixture.calls[0]!.service
      fixture.calls.length = 0
      fixture.files.length = 0
      fixture.rejectFileBasename = `${slotName}.${extension}`
      fixture.fileFailureCode = code
      fixture.absentOtherFiles = true
      await expect(store.clearSessionToken(currentEnv)).rejects.toMatchObject({
        code: 'TokenStoreIsolationCleanupFailed',
        surface: 'file',
      })
      expect(fixture.calls).toEqual([{ operation: 'delete', service, account: currentAccount }])
      expect(fixture.records.has(`${service}|${currentAccount}`)).toBe(false)
      expect(fixture.files.every(call => path.dirname(call.filename) === directory)).toBe(true)
      expect(fixture.files.map(call => path.basename(call.filename))).toEqual(
        expect.arrayContaining([
          `${slotName}-${currentEnv}.enc`,
          `${slotName}-${currentEnv}.json`,
          `${slotName}.enc`,
          `${slotName}.json`,
        ])
      )
      expect(fixture.records.get(`Evenfire|${slotName}`)).toBe(material)
    }
  )
  it('keeps normal logout best effort when the OS boundary rejects deletion', async () => {
    const { TokenStore } = await import('../tokenStore')
    fixture.rejectPrivateDelete = true
    fixture.rejectFileDelete = true
    await expect(new TokenStore().clearSessionToken(currentEnv)).resolves.toBeUndefined()
  })
})
