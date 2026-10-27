import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  type SessionTokenReadAuthority,
  type SessionTokenReadSource,
  TokenStore,
  isSessionTokenReadAuthorityCurrent,
} from '../tokenStore.js'

const fixture = vi.hoisted(() => ({
  directory: '',
  keychain: new Map<string, string>(),
  keytarWritesAvailable: true,
  encryptionAvailable: true,
}))

vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => fixture.directory },
  safeStorage: {
    isEncryptionAvailable: () => fixture.encryptionAvailable,
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
    if (!fixture.keytarWritesAvailable) throw new Error('fixture-keytar-unavailable')
    fixture.keychain.set(account, token)
  }),
  deletePassword: vi.fn(async (_service: string, account: string) =>
    fixture.keychain.delete(account)
  ),
}))

const ENV = 'current-000000000000'
const LEGACY_ENV = 'legacy-111111111111'
const TOKEN = 'fixture-migration-token'
const currentAccount = `session-token::${ENV}`
const oldAccount = `session-token::${LEGACY_ENV}`

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}

async function boundedActor<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Producer did not reach ${label}`)), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

type Migration = {
  name: string
  scope: 'environment' | 'global'
  source: 'keytar' | 'encrypted' | 'plaintext'
}

const migrations: Migration[] = [
  { name: 'environment Keytar', scope: 'environment', source: 'keytar' },
  { name: 'environment encrypted file', scope: 'environment', source: 'encrypted' },
  { name: 'global Keytar', scope: 'global', source: 'keytar' },
  { name: 'global encrypted file', scope: 'global', source: 'encrypted' },
]

beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-accepted-migration-'))
  fixture.keychain.clear()
  fixture.keytarWritesAvailable = true
  fixture.encryptionAvailable = true
  vi.clearAllMocks()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture.directory, { recursive: true, force: true })
})

async function seedMigration(migration: Migration) {
  // Seed through the real persistence producer. Global fixtures use the same
  // stored bytes/account value with the historical pre-environment name;
  // no consumer response or token-file representation is handwritten.
  fixture.keytarWritesAvailable = migration.source === 'keytar'
  fixture.encryptionAvailable = migration.source !== 'plaintext'
  await new TokenStore(
    migration.source === 'plaintext' ? { isolatedUserDataPath: fixture.directory } : {}
  ).setSessionToken(TOKEN, LEGACY_ENV)
  const extension = migration.source === 'encrypted' ? 'enc' : 'json'
  const scopedFile = path.join(fixture.directory, `session-token-${LEGACY_ENV}.${extension}`)
  const sourceAccount = migration.scope === 'global' ? 'session-token' : oldAccount
  const sourceFile =
    migration.scope === 'global'
      ? path.join(fixture.directory, `session-token.${extension}`)
      : scopedFile
  if (migration.scope === 'global') {
    if (migration.source === 'keytar') {
      const stored = fixture.keychain.get(oldAccount)!
      fixture.keychain.delete(oldAccount)
      fixture.keychain.set(sourceAccount, stored)
    } else {
      await fs.rename(scopedFile, sourceFile)
    }
  }
  // The migrated credential has a functioning destination Keytar slot.
  fixture.keytarWritesAvailable = true
  return { sourceAccount, sourceFile }
}

describe('TokenStore migrations stay inside an already accepted read', () => {
  it.each(migrations)('finishes $name after quit admission closes', async migration => {
    const { sourceAccount, sourceFile } = await seedMigration(migration)
    const sourceStarted = deferred()
    const releaseSource = deferred()
    const destinationStarted = deferred()
    const releaseDestination = deferred()
    const keytar = await import('keytar')
    const store = new TokenStore()
    if (migration.source === 'keytar') {
      vi.mocked(keytar.getPassword).mockImplementation(async (_service, account) => {
        if (account === sourceAccount) {
          sourceStarted.resolve()
          await releaseSource.promise
        }
        return fixture.keychain.get(account) ?? null
      })
    } else {
      const sourceReader = store as unknown as {
        readMigrationFileSource: (
          file: string,
          source: 'safe-storage' | 'historical-plaintext',
          options: unknown
        ) => Promise<string | null>
      }
      const readSource = sourceReader.readMigrationFileSource.bind(sourceReader)
      vi.spyOn(sourceReader, 'readMigrationFileSource').mockImplementation(async (...args) => {
        const token = await readSource(...args)
        if (args[0] === sourceFile && token !== null) {
          sourceStarted.resolve()
          await releaseSource.promise
        }
        return token
      })
    }
    vi.mocked(keytar.setPassword).mockImplementation(async (_service, account, token) => {
      if (account === currentAccount) {
        destinationStarted.resolve()
        await releaseDestination.promise
      }
      fixture.keychain.set(account, token)
    })
    let selectedAuthority: SessionTokenReadAuthority | undefined
    let selectedSource: SessionTokenReadSource | undefined
    let writtenAuthority: SessionTokenReadAuthority | undefined
    const settlements: string[] = []
    const accepted = store.getSessionToken(ENV, {
      legacyEnvKeys: migration.scope === 'environment' ? [LEGACY_ENV] : [],
      onTokenRead: (source, authority) => {
        selectedSource = source
        selectedAuthority = authority
      },
      onMutationSettled: (source, authority) => {
        settlements.push(source)
        writtenAuthority = authority
      },
    })
    let drained = false
    let drain: Promise<void> | undefined
    try {
      await boundedActor(sourceStarted.promise, `${migration.name} selected source`)
      drain = store.prepareForQuit().then(() => {
        drained = true
      })
      await expect(store.getSessionToken(ENV)).rejects.toThrow('Application is shutting down')
      releaseSource.resolve()
      const next = await boundedActor(
        Promise.race([
          destinationStarted.promise.then(() => 'migration-write'),
          accepted.then(token => {
            expect(token, 'accepted migration must return the persisted source credential').toBe(
              TOKEN
            )
            return 'read-finished'
          }),
        ]),
        `${migration.name} destination publication`
      )
      expect(next, 'the accepted read must persist its migrated credential').toBe('migration-write')
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(drained, 'quit must wait for the accepted migration write').toBe(false)
      releaseDestination.resolve()
      await expect(accepted).resolves.toBe(TOKEN)
      await drain
      expect(drained).toBe(true)
      expect(selectedSource).toBe('keytar')
      expect(settlements).toEqual(['keytar'])
      expect(isSessionTokenReadAuthorityCurrent(writtenAuthority, 'keytar', ENV)).toBe(true)
      expect(isSessionTokenReadAuthorityCurrent(selectedAuthority, 'keytar', ENV)).toBe(true)
      expect(isSessionTokenReadAuthorityCurrent(selectedAuthority, 'safe-storage', ENV)).toBe(false)
      // Restart restores the migrated token with no legacy upgrade options.
      await expect(new TokenStore().getSessionToken(ENV)).resolves.toBe(TOKEN)
      if (migration.source === 'keytar') {
        expect(fixture.keychain.has(sourceAccount)).toBe(false)
      } else {
        await expect(fs.access(sourceFile)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      releaseSource.resolve()
      releaseDestination.resolve()
      await Promise.allSettled([accepted, drain])
      // Module mock implementations cannot retain a prior test's deferred
      // boundary or it would hold the next producer during fixture setup.
      vi.mocked(keytar.getPassword).mockImplementation(
        async (_service, account) => fixture.keychain.get(account) ?? null
      )
      vi.mocked(keytar.setPassword).mockImplementation(async (_service, account, token) => {
        if (!fixture.keytarWritesAvailable) throw new Error('fixture-keytar-unavailable')
        fixture.keychain.set(account, token)
      })
    }
  })

  it.each([
    { name: 'environment', scope: 'environment' as const },
    { name: 'global', scope: 'global' as const },
  ])('does not automatically import a historical $name plaintext credential', async migration => {
    const { sourceFile } = await seedMigration({ ...migration, source: 'plaintext' })
    fixture.encryptionAvailable = true
    const originalBytes = await fs.readFile(sourceFile)
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockClear()
    const store = new TokenStore()
    const onTokenRead = vi.fn()
    const onMutationDispatched = vi.fn()

    await expect(
      store.getSessionToken(ENV, {
        legacyEnvKeys: migration.scope === 'environment' ? [LEGACY_ENV] : [],
        onTokenRead,
        onMutationDispatched,
      })
    ).resolves.toBeNull()

    expect(onTokenRead).not.toHaveBeenCalled()
    expect(onMutationDispatched).not.toHaveBeenCalled()
    expect(keytar.setPassword).not.toHaveBeenCalled()
    await expect(fs.readFile(sourceFile)).resolves.toEqual(originalBytes)
  })
})
