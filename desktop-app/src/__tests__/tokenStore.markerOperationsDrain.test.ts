import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TokenStore } from '../tokenStore.js'

const fixture = vi.hoisted(() => ({
  directory: '',
  keychain: new Map<string, string>(),
}))

vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => fixture.directory },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length),
  },
}))
vi.mock('keytar', () => ({
  getPassword: vi.fn(
    async (_service: string, account: string) => fixture.keychain.get(account) ?? null
  ),
  setPassword: vi.fn(async (_service: string, account: string, token: string) => {
    fixture.keychain.set(account, token)
  }),
  deletePassword: vi.fn(async (_service: string, account: string) =>
    fixture.keychain.delete(account)
  ),
}))

const ENV = 'drain-000000000000'
const TOKEN = 'fixture-drain-token'
const NEXT_TOKEN = 'fixture-next-token'
const account = `session-token::${ENV}`
const encryptedPath = () => path.join(fixture.directory, `session-token-${ENV}.enc`)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}

type Operation = {
  name: string
  run: (store: TokenStore) => Promise<unknown>
  boundary: 'read-file' | 'rename-file' | 'get-keytar' | 'delete-keytar'
  expected: unknown
  remainingKeytarToken: string | null
  remainingFileToken: string | null
}

const operations: Operation[] = [
  {
    name: 'getSafeStorageSessionToken',
    run: store => store.getSafeStorageSessionToken(ENV),
    boundary: 'read-file',
    expected: TOKEN,
    remainingKeytarToken: TOKEN,
    remainingFileToken: TOKEN,
  },
  {
    name: 'getKeytarSessionToken',
    run: store => store.getKeytarSessionToken(ENV),
    boundary: 'get-keytar',
    expected: TOKEN,
    remainingKeytarToken: TOKEN,
    remainingFileToken: TOKEN,
  },
  {
    name: 'setSafeStorageSessionToken',
    run: store => store.setSafeStorageSessionToken(NEXT_TOKEN, ENV),
    boundary: 'rename-file',
    expected: undefined,
    remainingKeytarToken: TOKEN,
    remainingFileToken: NEXT_TOKEN,
  },
  {
    name: 'clearSessionTokenStrictly',
    run: store => store.clearSessionTokenStrictly(ENV),
    boundary: 'delete-keytar',
    expected: { keytarAvailable: true, keytarDisabled: false },
    remainingKeytarToken: null,
    remainingFileToken: null,
  },
  {
    name: 'clearKeytarSessionTokensStrictly',
    run: store => store.clearKeytarSessionTokensStrictly(ENV),
    boundary: 'delete-keytar',
    expected: { keytarAvailable: true, keytarDisabled: false },
    remainingKeytarToken: null,
    remainingFileToken: TOKEN,
  },
]

beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-marker-drain-'))
  fixture.keychain.clear()
  vi.clearAllMocks()
  const producer = new TokenStore()
  await producer.setSessionToken(TOKEN, ENV)
  await producer.setSafeStorageSessionToken(TOKEN, ENV)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture.directory, { recursive: true, force: true })
})

async function pauseBoundary(boundary: Operation['boundary']) {
  const started = deferred()
  const release = deferred()
  const keytar = await import('keytar')
  if (boundary === 'read-file') {
    const readFile = fs.readFile.bind(fs)
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (String(args[0]) === encryptedPath()) {
        started.resolve()
        await release.promise
      }
      return readFile(...args)
    })
  } else if (boundary === 'rename-file') {
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination) === encryptedPath()) {
        started.resolve()
        await release.promise
      }
      return rename(source, destination)
    })
  } else if (boundary === 'get-keytar') {
    vi.mocked(keytar.getPassword).mockImplementationOnce(async (_service, target) => {
      started.resolve()
      await release.promise
      return fixture.keychain.get(target) ?? null
    })
  } else {
    vi.mocked(keytar.deletePassword).mockImplementationOnce(async (_service, target) => {
      started.resolve()
      await release.promise
      return fixture.keychain.delete(target)
    })
  }
  return { started, release }
}

describe('TokenStore marker operations participate in quit draining', () => {
  it.each(operations)('drains accepted $name through its storage boundary', async operation => {
    const store = new TokenStore()
    const { started, release } = await pauseBoundary(operation.boundary)
    const accepted = operation.run(store)
    await started.promise
    let drained = false
    const drain = store.prepareForQuit().then(() => {
      drained = true
    })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(drained, `${operation.name} must finish before quit`).toBe(false)
      release.resolve()
      await expect(accepted).resolves.toEqual(operation.expected)
      await drain
      expect(drained).toBe(true)
      // A fresh consumer observes the final native/file effects, including the
      // Keytar-only clear preserving the authoritative encrypted credential.
      const consumer = new TokenStore()
      await expect(consumer.getKeytarSessionToken(ENV)).resolves.toBe(
        operation.remainingKeytarToken
      )
      await expect(consumer.getSafeStorageSessionToken(ENV)).resolves.toBe(
        operation.remainingFileToken
      )
    } finally {
      release.resolve()
      await Promise.allSettled([accepted, drain])
    }
  })

  it.each(operations)('rejects new $name after admission closes', async operation => {
    const store = new TokenStore()
    await store.prepareForQuit()
    await expect(operation.run(store)).rejects.toThrow('Application is shutting down')
    const consumer = new TokenStore()
    await expect(consumer.getKeytarSessionToken(ENV)).resolves.toBe(TOKEN)
    await expect(consumer.getSafeStorageSessionToken(ENV)).resolves.toBe(TOKEN)
    expect(fixture.keychain.get(account)).toBe(TOKEN)
  })
})
