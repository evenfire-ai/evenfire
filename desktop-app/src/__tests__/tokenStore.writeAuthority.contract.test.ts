import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  type SessionTokenMutationOptions,
  type SessionTokenMutationSource,
  type SessionTokenReadAuthority,
  SessionTokenStorageSupersededBeforeWriteError,
  TokenStore,
  isSessionTokenMutationCallbackFailure,
  isSessionTokenReadAuthorityCurrent,
} from '../tokenStore.js'

const fixture = vi.hoisted(() => ({
  directory: '',
  encryptionAvailable: true,
  keychain: new Map<string, string>(),
}))
vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => fixture.directory },
  safeStorage: {
    isEncryptionAvailable: () => fixture.encryptionAvailable,
    encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length),
  },
}))
vi.mock('keytar', () => ({
  getPassword: vi.fn(async (_service, account) => fixture.keychain.get(account) ?? null),
  setPassword: vi.fn(async (_service, account, token) => {
    fixture.keychain.set(account, token)
  }),
  deletePassword: vi.fn(async (_service, account) => fixture.keychain.delete(account)),
}))

const ENV = 'writer-111111111111'
const OTHER_ENV = 'writer-222222222222'
const TOKEN = 'fixture-own-candidate'
const HOME = 'fixture-previous-home'
const account = `session-token::${ENV}`
const encrypted = () => path.join(fixture.directory, `session-token-${ENV}.enc`)

beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-own-publication-'))
  fixture.encryptionAvailable = true
  fixture.keychain.clear()
  vi.clearAllMocks()
  const keytar = await import('keytar')
  vi.mocked(keytar.getPassword)
    .mockReset()
    .mockImplementation(async (_service, target) => fixture.keychain.get(target) ?? null)
  vi.mocked(keytar.setPassword)
    .mockReset()
    .mockImplementation(async (_service, target, token) => {
      fixture.keychain.set(target, token)
    })
  vi.mocked(keytar.deletePassword)
    .mockReset()
    .mockImplementation(async (_service, target) => fixture.keychain.delete(target))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture.directory, { recursive: true, force: true })
})

type Source = 'native' | 'encrypted' | 'plaintext'
const readSource = (source: Source) =>
  source === 'native' ? 'keytar' : source === 'encrypted' ? 'safe-storage' : 'historical-plaintext'
async function makeStore(source: Source) {
  if (source === 'plaintext') fixture.encryptionAvailable = false
  return new TokenStore(source === 'plaintext' ? { isolatedUserDataPath: fixture.directory } : {})
}
async function write(
  store: TokenStore,
  source: Source,
  token: string,
  options: SessionTokenMutationOptions = {}
) {
  return source === 'encrypted'
    ? store.setSafeStorageSessionToken(token, ENV, options)
    : store.setSessionToken(token, ENV, { ...options, requireKeytar: source === 'native' })
}
async function read(store: TokenStore, source: Source) {
  return source === 'native'
    ? store.getKeytarSessionToken(ENV)
    : source === 'encrypted'
      ? store.getSafeStorageSessionToken(ENV)
      : store.getSessionToken(ENV, { allowLegacyMigration: false })
}
function receipt() {
  let authority: SessionTokenReadAuthority | undefined
  let source: SessionTokenMutationSource | undefined
  const onMutationSettled = vi.fn(
    (settledSource: SessionTokenMutationSource, settledAuthority: SessionTokenReadAuthority) => {
      source = settledSource
      authority = settledAuthority
    }
  )
  return {
    onMutationSettled,
    get authority() {
      return authority
    },
    get source() {
      return source
    },
  }
}

describe('own write settlement precedes any late verification read', () => {
  it.each(['native', 'encrypted', 'plaintext'] as const)(
    'keeps original %s publication identity instead of adopting a newer identical write',
    async source => {
      const store = await makeStore(source)
      const own = receipt()
      await write(store, source, TOKEN, own)
      expect(isSessionTokenReadAuthorityCurrent(own.authority, readSource(source), ENV)).toBe(true)
      await write(
        new TokenStore(source === 'plaintext' ? { isolatedUserDataPath: fixture.directory } : {}),
        source,
        TOKEN
      )
      expect(await read(store, source)).toBe(TOKEN)
      expect(isSessionTokenReadAuthorityCurrent(own.authority, readSource(source), ENV)).toBe(false)
      if (source !== 'plaintext') {
        await expect(
          source === 'native'
            ? store.repairKeytarSessionTokenIfMatches(TOKEN, null, ENV, {
                candidateAuthority: own.authority,
              })
            : store.repairSafeStorageSessionTokenIfMatches(TOKEN, null, ENV, {
                candidateAuthority: own.authority,
              })
        ).resolves.toBe(false)
        expect(await read(store, source)).toBe(TOKEN)
      }
    }
  )

  it.each(['native', 'encrypted', 'plaintext'] as const)(
    'does not report %s ownership before a declined actual dispatch',
    async source => {
      const store = await makeStore(source)
      const own = receipt()
      const failure = new Error('fixture-pre-dispatch denial')
      await expect(
        write(store, source, TOKEN, {
          ...own,
          onMutationDispatched: () => {
            throw failure
          },
        })
      ).rejects.toBe(failure)
      expect(own.onMutationSettled).not.toHaveBeenCalled()
      expect(await read(store, source)).toBeNull()
    }
  )

  it('retains native own-publication authority when the setter rejects after writing', async () => {
    const keytar = await import('keytar')
    const own = receipt()
    const failure = new Error('fixture-partial-native-write')
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (_service, target, token) => {
      fixture.keychain.set(target, token)
      throw failure
    })
    await expect(write(new TokenStore(), 'native', TOKEN, own)).rejects.toMatchObject({
      errors: [failure],
    })
    expect(own.onMutationSettled).toHaveBeenCalledTimes(1)
    expect(isSessionTokenReadAuthorityCurrent(own.authority, 'keytar', ENV)).toBe(true)
    expect(fixture.keychain.get(account)).toBe(TOKEN)
  })

  it('keeps both own partial-native and completed encrypted fallback receipts without adopting another source', async () => {
    const keytar = await import('keytar')
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (_service, target, token) => {
      fixture.keychain.set(target, token)
      throw new Error('fixture-partial-fallback')
    })
    const authorities = new Map<SessionTokenMutationSource, SessionTokenReadAuthority>()
    const events: string[] = []
    await new TokenStore().setSessionToken(TOKEN, ENV, {
      onMutationDispatched: source => {
        events.push(`dispatch:${source}`)
      },
      onMutationSettled: (source, authority) => {
        events.push(`settle:${source}`)
        authorities.set(source, authority)
        expect(
          isSessionTokenReadAuthorityCurrent(
            authority,
            source === 'keytar' ? 'keytar' : 'safe-storage',
            ENV
          )
        ).toBe(true)
      },
    })
    expect(events).toEqual([
      'dispatch:keytar',
      'settle:keytar',
      'dispatch:safe-storage',
      'settle:safe-storage',
    ])
    expect(isSessionTokenReadAuthorityCurrent(authorities.get('keytar'), 'keytar', ENV)).toBe(true)
    expect(
      isSessionTokenReadAuthorityCurrent(authorities.get('safe-storage'), 'safe-storage', ENV)
    ).toBe(true)
    expect(isSessionTokenReadAuthorityCurrent(authorities.get('keytar'), 'safe-storage', ENV)).toBe(
      false
    )
    await expect(new TokenStore().getSafeStorageSessionToken(ENV)).resolves.toBe(TOKEN)
  })

  it('settles accepted native metadata before its tracked quit drain completes', async () => {
    const keytar = await import('keytar')
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let started = false
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (_service, target, token) => {
      started = true
      await held
      fixture.keychain.set(target, token)
    })
    const own = receipt()
    const store = new TokenStore()
    const accepted = write(store, 'native', TOKEN, own)
    let drained = false
    let drain: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(started).toBe(true), { timeout: 1000 })
      drain = store.prepareForQuit().then(() => {
        drained = true
      })
      await expect(write(store, 'native', TOKEN, own)).rejects.toThrow(
        'Application is shutting down'
      )
      expect(own.onMutationSettled).not.toHaveBeenCalled()
      expect(drained).toBe(false)
    } finally {
      release()
      await Promise.allSettled([accepted, drain])
    }
    await expect(accepted).resolves.toBeUndefined()
    expect(own.onMutationSettled).toHaveBeenCalledTimes(1)
    expect(drained).toBe(true)
    expect(isSessionTokenReadAuthorityCurrent(own.authority, 'keytar', ENV)).toBe(true)
    await expect(new TokenStore().getKeytarSessionToken(ENV)).resolves.toBe(TOKEN)
  })

  it('retains encrypted own-publication authority after rename succeeds but directory sync rejects', async () => {
    const own = receipt()
    const open = fs.open.bind(fs)
    const failure = new Error('fixture-post-rename-sync')
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]) === fixture.directory && args[1] === 'r')
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure)
      return handle
    })
    await expect(write(new TokenStore(), 'encrypted', TOKEN, own)).rejects.toBe(failure)
    expect(own.onMutationSettled).toHaveBeenCalledTimes(1)
    expect(isSessionTokenReadAuthorityCurrent(own.authority, 'safe-storage', ENV)).toBe(true)
    expect(await fs.readFile(encrypted(), 'utf8')).toBe(`encrypted:${TOKEN}`)
  })

  it('does not authorize secure-file fallback when native settlement reporting rejects', async () => {
    const failure = new Error('fixture-settlement-observer')
    const store = new TokenStore()
    await expect(
      store.setSessionToken(TOKEN, ENV, {
        onMutationSettled: () => {
          throw failure
        },
      })
    ).rejects.toBe(failure)
    expect(isSessionTokenMutationCallbackFailure(failure)).toBe(true)
    expect(fixture.keychain.get(account)).toBe(TOKEN)
    await expect(fs.access(encrypted())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves the primary native mutation failure if settlement reporting also rejects', async () => {
    const keytar = await import('keytar')
    const primary = new Error('fixture-primary-native')
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (_service, target, token) => {
      fixture.keychain.set(target, token)
      throw primary
    })
    await expect(
      new TokenStore().setSessionToken(TOKEN, ENV, {
        onMutationSettled: () => {
          throw new Error('fixture-secondary-observer')
        },
      })
    ).rejects.toBe(primary)
    expect(isSessionTokenMutationCallbackFailure(primary)).toBe(true)
    await expect(fs.access(encrypted())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves the primary file mutation failure if settlement reporting also rejects', async () => {
    const primary = new Error('fixture-primary-rename')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(primary)
    await expect(
      new TokenStore().setSafeStorageSessionToken(TOKEN, ENV, {
        onMutationSettled: () => {
          throw new Error('fixture-secondary-observer')
        },
      })
    ).rejects.toBe(primary)
    expect(isSessionTokenMutationCallbackFailure(primary)).toBe(true)
    await expect(fs.access(encrypted())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['native', 'encrypted'] as const)(
    'hands off %s prior repair inside its own lane and preserves a newer identical Home',
    async source => {
      const store = await makeStore(source)
      const candidate = receipt()
      await write(store, source, TOKEN, candidate)
      const repaired = receipt()
      await expect(
        source === 'native'
          ? store.repairKeytarSessionTokenIfMatches(TOKEN, HOME, ENV, {
              ...repaired,
              candidateAuthority: candidate.authority,
            })
          : store.repairSafeStorageSessionTokenIfMatches(TOKEN, HOME, ENV, {
              ...repaired,
              candidateAuthority: candidate.authority,
            })
      ).resolves.toBe(true)
      expect(isSessionTokenReadAuthorityCurrent(repaired.authority, readSource(source), ENV)).toBe(
        true
      )
      await write(new TokenStore(), source, HOME)
      expect(await read(store, source)).toBe(HOME)
      expect(isSessionTokenReadAuthorityCurrent(repaired.authority, readSource(source), ENV)).toBe(
        false
      )
      await expect(
        source === 'native'
          ? store.repairKeytarSessionTokenIfMatches(HOME, null, ENV, {
              candidateAuthority: repaired.authority,
            })
          : store.repairSafeStorageSessionTokenIfMatches(HOME, null, ENV, {
              candidateAuthority: repaired.authority,
            })
      ).resolves.toBe(false)
      expect(await read(store, source)).toBe(HOME)
    }
  )

  it('requires original encrypted absence for conditional Home creation from a native receipt', async () => {
    const store = new TokenStore()
    const candidate = receipt()
    await write(store, 'native', TOKEN, candidate)
    const repaired = receipt()
    await expect(
      store.repairSafeStorageSessionTokenIfMatches(TOKEN, HOME, ENV, {
        ...repaired,
        candidateAuthority: candidate.authority,
        createIfAbsent: true,
      })
    ).resolves.toBe(true)
    expect(isSessionTokenReadAuthorityCurrent(repaired.authority, 'safe-storage', ENV)).toBe(true)
    expect(await read(store, 'encrypted')).toBe(HOME)
    await expect(
      store.repairSafeStorageSessionTokenIfMatches(HOME, null, ENV, {
        candidateAuthority: candidate.authority,
      })
    ).resolves.toBe(false)
    expect(await read(store, 'encrypted')).toBe(HOME)
  })

  it('does not transfer stale native candidate authority into an unchanged encrypted absence', async () => {
    const store = new TokenStore()
    const candidate = receipt()
    await write(store, 'native', TOKEN, candidate)
    await write(new TokenStore(), 'native', TOKEN)
    await expect(
      store.repairSafeStorageSessionTokenIfMatches(TOKEN, HOME, ENV, {
        candidateAuthority: candidate.authority,
        createIfAbsent: true,
      })
    ).resolves.toBe(false)
    await expect(fs.access(encrypted())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await read(store, 'native')).toBe(TOKEN)
  })

  it('rechecks original cross-source ownership immediately before an encrypted repair rename', async () => {
    const store = new TokenStore()
    const candidate = receipt()
    await write(store, 'native', TOKEN, candidate)
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let syncing = false
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]).startsWith(`${encrypted()}.`) && args[1] === 'w') {
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          syncing = true
          await held
          await sync()
        })
      }
      return handle
    })
    const repaired = receipt()
    const repair = store.repairSafeStorageSessionTokenIfMatches(TOKEN, HOME, ENV, {
      ...repaired,
      candidateAuthority: candidate.authority,
      createIfAbsent: true,
    })
    const outcome = repair.catch(error => error)
    try {
      await vi.waitFor(() => expect(syncing).toBe(true), { timeout: 1000 })
      await write(new TokenStore(), 'native', TOKEN)
    } finally {
      release()
      await outcome
    }
    expect(await outcome).toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
    expect(repaired.onMutationSettled).not.toHaveBeenCalled()
    await expect(fs.access(encrypted())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await read(store, 'native')).toBe(TOKEN)
  })

  it('rechecks original encrypted ownership after the native comparison awaits', async () => {
    const store = new TokenStore()
    await write(store, 'native', TOKEN)
    const candidate = receipt()
    await write(store, 'encrypted', TOKEN, candidate)
    const keytar = await import('keytar')
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let comparing = false
    vi.mocked(keytar.getPassword).mockImplementationOnce(async (_service, target) => {
      comparing = true
      await held
      return fixture.keychain.get(target) ?? null
    })
    const repair = store.repairKeytarSessionTokenIfMatches(TOKEN, null, ENV, {
      candidateAuthority: candidate.authority,
    })
    try {
      await vi.waitFor(() => expect(comparing).toBe(true), { timeout: 1000 })
      await write(new TokenStore(), 'encrypted', TOKEN)
    } finally {
      release()
      await repair
    }
    await expect(repair).resolves.toBe(false)
    expect(await read(store, 'native')).toBe(TOKEN)
    expect(await read(store, 'encrypted')).toBe(TOKEN)
  })

  it('rejects forged and wrong-environment candidate authority without changing native storage', async () => {
    const store = new TokenStore()
    await write(store, 'native', TOKEN)
    const other = receipt()
    await store.setSessionToken(TOKEN, OTHER_ENV, { requireKeytar: true, ...other })
    for (const authority of [{} as SessionTokenReadAuthority, other.authority]) {
      await expect(
        store.repairKeytarSessionTokenIfMatches(TOKEN, null, ENV, {
          candidateAuthority: authority,
        })
      ).resolves.toBe(false)
    }
    expect(await read(store, 'native')).toBe(TOKEN)
  })
})
