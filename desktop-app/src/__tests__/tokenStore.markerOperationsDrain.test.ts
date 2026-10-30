import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type SessionTokenFallbackSnapshot, TokenStore } from '../tokenStore.js'

const fixture = vi.hoisted(() => ({
  directory: '',
  keychain: new Map<string, string>(),
}))

vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => fixture.directory },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
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
vi.mock('../windowsSessionAuthorityFileOps.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../windowsSessionAuthorityFileOps.js')>()
  const { createWindowsSessionAuthorityFileOpsUnitFixture } =
    await import('../../testSupport/windowsSessionAuthorityFileOpsUnitFixture.js')
  return createWindowsSessionAuthorityFileOpsUnitFixture(actual)
})

const ENV = 'drain-000000000000'
const TOKEN = 'fixture-drain-token'
const NEXT_TOKEN = 'fixture-next-token'
const account = `session-token::${ENV}`
const encryptedPath = () => path.join(fixture.directory, `session-token-${ENV}.enc`)
let fallbackSnapshot: SessionTokenFallbackSnapshot

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}

async function awaitStorageBoundary(boundary: Promise<void>, operation: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const entered = await Promise.race([
      boundary.then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 2000)
      }),
    ])
    expect(entered, `${operation} must reach its real storage boundary`).toBe(true)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type Operation = {
  name: string
  run: (store: TokenStore) => Promise<unknown>
  boundary:
    | 'read-file'
    | 'rename-file'
    | 'get-keytar'
    | 'delete-keytar'
    | 'sync-directory'
    | 'snapshot-file-lane'
  expected: unknown
  remainingKeytarToken: string | null
  remainingFileToken: string | null
}

const operations: Operation[] = [
  {
    name: 'snapshotSessionTokenFallbackFiles',
    run: store => store.snapshotSessionTokenFallbackFiles(ENV),
    boundary: 'snapshot-file-lane',
    expected: expect.any(Object),
    remainingKeytarToken: TOKEN,
    remainingFileToken: TOKEN,
  },
  {
    name: 'retireSessionTokenFallbackFilesIfUnchanged',
    run: store => store.retireSessionTokenFallbackFilesIfUnchanged(fallbackSnapshot),
    boundary: 'sync-directory',
    expected: true,
    remainingKeytarToken: TOKEN,
    remainingFileToken: null,
  },
  {
    name: 'retireSessionTokenFallbackFilesIfUnchanged with encrypted authority',
    run: store =>
      store.retireSessionTokenFallbackFilesIfUnchanged(fallbackSnapshot, {
        preserveActiveEncryptedToken: TOKEN,
      }),
    boundary: 'sync-directory',
    expected: true,
    remainingKeytarToken: TOKEN,
    remainingFileToken: TOKEN,
  },
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
    name: 'discardSafeStorageSessionTokenIfMatches',
    run: store => store.discardSafeStorageSessionTokenIfMatches(TOKEN, ENV),
    boundary: 'sync-directory',
    expected: true,
    remainingKeytarToken: TOKEN,
    remainingFileToken: null,
  },
  {
    name: 'repairKeytarSessionTokenIfMatches',
    run: store => store.repairKeytarSessionTokenIfMatches(TOKEN, NEXT_TOKEN, ENV),
    boundary: 'get-keytar',
    expected: true,
    remainingKeytarToken: NEXT_TOKEN,
    remainingFileToken: TOKEN,
  },
  {
    name: 'repairSafeStorageSessionTokenIfMatches',
    run: store => store.repairSafeStorageSessionTokenIfMatches(TOKEN, NEXT_TOKEN, ENV),
    boundary: 'rename-file',
    expected: true,
    remainingKeytarToken: TOKEN,
    remainingFileToken: NEXT_TOKEN,
  },
  {
    name: 'repairKeytarSessionTokenIfMatches cleanup',
    run: store => store.repairKeytarSessionTokenIfMatches(TOKEN, null, ENV),
    boundary: 'get-keytar',
    expected: true,
    remainingKeytarToken: null,
    remainingFileToken: TOKEN,
  },
  {
    name: 'repairSafeStorageSessionTokenIfMatches cleanup',
    run: store => store.repairSafeStorageSessionTokenIfMatches(TOKEN, null, ENV),
    boundary: 'sync-directory',
    expected: true,
    remainingKeytarToken: TOKEN,
    remainingFileToken: null,
  },
  {
    name: 'clearSessionTokenStrictly',
    run: store => store.clearSessionTokenStrictly(ENV),
    boundary: 'delete-keytar',
    expected: {
      keytarAvailable: true,
      keytarDisabled: false,
      keytarDisposition: 'available',
    },
    remainingKeytarToken: null,
    remainingFileToken: null,
  },
  {
    name: 'clearKeytarSessionTokensStrictly',
    run: store => store.clearKeytarSessionTokensStrictly(ENV),
    boundary: 'delete-keytar',
    expected: {
      keytarAvailable: true,
      keytarDisabled: false,
      keytarDisposition: 'available',
    },
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
  fallbackSnapshot = await producer.snapshotSessionTokenFallbackFiles(ENV)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture.directory, { recursive: true, force: true })
})

async function pauseBoundary(boundary: Operation['boundary'], store: TokenStore) {
  const started = deferred()
  const release = deferred()
  const keytar = await import('keytar')
  let predecessor: Promise<void> | undefined
  const pauseAtomicFileWrite = () => {
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      const file = String(args[0])
      if (file.startsWith(`${encryptedPath()}.`) && file.endsWith('.tmp')) {
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          started.resolve()
          await release.promise
          return sync()
        })
      }
      return handle
    })
  }
  if (
    boundary === 'snapshot-file-lane' ||
    (process.platform === 'win32' && boundary === 'sync-directory')
  ) {
    if (process.platform === 'win32') {
      pauseAtomicFileWrite()
    } else {
      const rename = fs.rename.bind(fs)
      vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, destination) => {
        started.resolve()
        await release.promise
        return rename(source, destination)
      })
    }
    predecessor = new TokenStore().setSafeStorageSessionToken(TOKEN, ENV)
    try {
      await awaitStorageBoundary(started.promise, 'earlier actual encrypted producer')
    } catch (error) {
      release.resolve()
      await Promise.allSettled([predecessor])
      throw error
    }
  } else if (boundary === 'read-file') {
    const selectedReader = store as unknown as {
      readFileSelection: (...args: unknown[]) => Promise<unknown>
    }
    const readSelection = selectedReader.readFileSelection.bind(selectedReader)
    vi.spyOn(selectedReader, 'readFileSelection').mockImplementation(async (...args) => {
      const selection = await readSelection(...args)
      if (String(args[0]) === encryptedPath() && selection !== null) {
        started.resolve()
        await release.promise
      }
      return selection
    })
  } else if (boundary === 'rename-file') {
    if (process.platform === 'win32') pauseAtomicFileWrite()
    else {
      const rename = fs.rename.bind(fs)
      vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
        if (String(destination) === encryptedPath()) {
          started.resolve()
          await release.promise
        }
        return rename(source, destination)
      })
    }
  } else if (boundary === 'sync-directory') {
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]) === fixture.directory && args[1] === 'r') {
        started.resolve()
        await release.promise
      }
      return open(...args)
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
  return { started, release, predecessor }
}

describe('TokenStore marker operations participate in quit draining', () => {
  it.each(operations)('drains accepted $name through its storage boundary', async operation => {
    const store = new TokenStore()
    const { started, release, predecessor } = await pauseBoundary(operation.boundary, store)
    const accepted = operation.run(store)
    let drained = false
    let drain: Promise<void> | undefined
    try {
      await awaitStorageBoundary(started.promise, operation.name)
      drain = store.prepareForQuit().then(() => {
        drained = true
      })
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
      await Promise.allSettled([
        accepted,
        ...(drain ? [drain] : []),
        ...(predecessor ? [predecessor] : []),
      ])
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
