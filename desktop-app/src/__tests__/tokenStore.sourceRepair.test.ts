import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionTokenStorageSupersededBeforeWriteError, TokenStore } from '../tokenStore.js'

const fixture = vi.hoisted(() => ({ directory: '', keychain: new Map<string, string>() }))
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
const ENV = 'repair-111111111111'
const LEGACY_ENV = 'repair-222222222222'
const account = `session-token::${ENV}`
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function boundedActor(actor: Promise<unknown>) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    expect(
      await Promise.race([
        actor.then(() => true),
        new Promise<boolean>(done => {
          timeout = setTimeout(() => done(false), 2000)
        }),
      ]),
      'real storage actor must reach its boundary'
    ).toBe(true)
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-source-repair-'))
  fixture.keychain.clear()
  vi.clearAllMocks()
})
afterEach(async () => {
  vi.restoreAllMocks()
  const keytar = await import('keytar')
  vi.mocked(keytar.getPassword).mockImplementation(
    async (_service, target) => fixture.keychain.get(target) ?? null
  )
  vi.mocked(keytar.setPassword).mockImplementation(async (_service, target, token) => {
    fixture.keychain.set(target, token)
  })
  await fs.rm(fixture.directory, { recursive: true, force: true })
})
const sources = ['keytar', 'encrypted'] as const
function sourceOperations(source: (typeof sources)[number], store = new TokenStore()) {
  return {
    write: (token: string) =>
      source === 'keytar'
        ? store.setSessionToken(token, ENV, { requireKeytar: true })
        : store.setSafeStorageSessionToken(token, ENV),
    read: () =>
      source === 'keytar'
        ? store.getKeytarSessionToken(ENV)
        : store.getSafeStorageSessionToken(ENV),
    repair: (attempted: string, previous: string | null, mayWrite?: () => boolean) =>
      source === 'keytar'
        ? store.repairKeytarSessionTokenIfMatches(attempted, previous, ENV, { mayWrite })
        : store.repairSafeStorageSessionTokenIfMatches(attempted, previous, ENV, { mayWrite }),
  }
}
describe('source publication dispatch receipts', () => {
  it.each(sources)('notifies immediately before the actual %s publication', async source => {
    const events: string[] = []
    const receipt = vi.fn(() => events.push('dispatch'))
    const keytar = await import('keytar')
    const rename = fs.rename.bind(fs)
    if (source === 'keytar') {
      vi.mocked(keytar.setPassword).mockImplementationOnce(async (_service, target, token) => {
        events.push('native-set')
        fixture.keychain.set(target, token)
      })
    } else {
      vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
        events.push('file-rename')
        return rename(from, to)
      })
    }
    const options = { mayWrite: () => true, onMutationDispatched: receipt }
    const store = new TokenStore()
    if (source === 'keytar') {
      await store.setSessionToken('fixture-dispatched', ENV, { ...options, requireKeytar: true })
    } else {
      await store.setSafeStorageSessionToken('fixture-dispatched', ENV, options)
    }
    expect(events).toEqual(['dispatch', source === 'keytar' ? 'native-set' : 'file-rename'])
    expect(receipt).toHaveBeenCalledTimes(1)
    expect(receipt).toHaveBeenCalledWith(
      source === 'keytar' ? 'keytar' : 'safe-storage',
      'fixture-dispatched'
    )
    expect(await sourceOperations(source).read()).toBe('fixture-dispatched')
  })

  it.each(sources)(
    'does not report %s publication when ownership rejects before dispatch',
    async source => {
      const receipt = vi.fn()
      const store = new TokenStore()
      const options = { mayWrite: () => false, onMutationDispatched: receipt }
      const writing =
        source === 'keytar'
          ? store.setSessionToken('fixture-never-published', ENV, options)
          : store.setSafeStorageSessionToken('fixture-never-published', ENV, options)
      await expect(writing).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
      expect(receipt).not.toHaveBeenCalled()
      expect(await sourceOperations(source).read()).toBeNull()
      expect(await fs.readdir(fixture.directory)).toEqual([])
    }
  )

  it('does not count temporary-file creation as an encrypted publication', async () => {
    const receipt = vi.fn()
    const open = fs.open.bind(fs)
    let owned = true
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith('.tmp')) owned = false
      return handle
    })
    await expect(
      new TokenStore().setSafeStorageSessionToken('fixture-never-published', ENV, {
        mayWrite: () => owned,
        onMutationDispatched: receipt,
      })
    ).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
    expect(receipt).not.toHaveBeenCalled()
    expect(await fs.readdir(fixture.directory)).toEqual([])
  })

  it('keeps a native partial-publication receipt when a later fallback is superseded', async () => {
    const receipt = vi.fn()
    const keytar = await import('keytar')
    let owned = true
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (_service, target, token) => {
      fixture.keychain.set(target, token)
      owned = false
      throw new Error('fixture-native post-write rejection')
    })
    await expect(
      new TokenStore().setSessionToken('fixture-partial', ENV, {
        mayWrite: () => owned,
        onMutationDispatched: receipt,
      })
    ).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
    expect(receipt).toHaveBeenCalledTimes(1)
    expect(await new TokenStore().getKeytarSessionToken(ENV)).toBe('fixture-partial')
    expect(await fs.readdir(fixture.directory)).toEqual([])
  })

  it('reports an attempted rename even when publication succeeds but its completion rejects', async () => {
    const receipt = vi.fn()
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      await rename(from, to)
      throw new Error('fixture-rename completion rejected')
    })
    await expect(
      new TokenStore().setSafeStorageSessionToken('fixture-partial', ENV, {
        onMutationDispatched: receipt,
      })
    ).rejects.toThrow('fixture-rename completion rejected')
    expect(receipt).toHaveBeenCalledTimes(1)
    expect(await new TokenStore().getSafeStorageSessionToken(ENV)).toBe('fixture-partial')
    expect(await fs.readdir(fixture.directory)).toEqual([`session-token-${ENV}.enc`])
  })

  it('propagates the receipt through an already accepted legacy-source migration', async () => {
    await new TokenStore().setSessionToken('fixture-legacy', LEGACY_ENV, { requireKeytar: true })
    const receipt = vi.fn()
    await expect(
      new TokenStore().getSessionToken(ENV, {
        legacyEnvKeys: [LEGACY_ENV],
        onMutationDispatched: receipt,
      })
    ).resolves.toBe('fixture-legacy')
    expect(receipt).toHaveBeenCalledTimes(1)
    expect(receipt).toHaveBeenCalledWith('keytar', 'fixture-legacy')
    expect(await new TokenStore().getKeytarSessionToken(ENV)).toBe('fixture-legacy')
    expect(await new TokenStore().getKeytarSessionToken(LEGACY_ENV)).toBeNull()
  })
})

describe('exact-candidate source repair', () => {
  it.each(sources)('reports the actual restored token before a %s repair', async source => {
    const store = new TokenStore()
    await sourceOperations(source).write('fixture-rejected')
    const receipt = vi.fn()
    const options = { onMutationDispatched: receipt }
    await expect(
      source === 'keytar'
        ? store.repairKeytarSessionTokenIfMatches('fixture-rejected', 'fixture-prior', ENV, options)
        : store.repairSafeStorageSessionTokenIfMatches(
            'fixture-rejected',
            'fixture-prior',
            ENV,
            options
          )
    ).resolves.toBe(true)
    expect(receipt).toHaveBeenCalledWith(
      source === 'keytar' ? 'keytar' : 'safe-storage',
      'fixture-prior'
    )
    expect(await sourceOperations(source).read()).toBe('fixture-prior')
  })

  it('does not discard an exact encrypted candidate after runtime ownership changes', async () => {
    const store = new TokenStore()
    await store.setSafeStorageSessionToken('fixture-candidate', ENV)
    await expect(
      store.discardSafeStorageSessionTokenIfMatches('fixture-candidate', ENV, {
        mayWrite: () => false,
      })
    ).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
    expect(await new TokenStore().getSafeStorageSessionToken(ENV)).toBe('fixture-candidate')
  })
  it.each(sources)(
    'cleans only this rejected %s credential when no previous authority existed',
    async source => {
      const operations = sourceOperations(source)
      await operations.write('fixture-rejected')
      await expect(operations.repair('fixture-rejected', null)).resolves.toBe(true)
      expect(await sourceOperations(source).read()).toBeNull()
      await operations.write('fixture-newer-user')
      await expect(operations.repair('fixture-rejected', null)).resolves.toBe(false)
      expect(await sourceOperations(source).read()).toBe('fixture-newer-user')
    }
  )
  it.each(sources)(
    'repairs only the actual %s candidate and verifies the restarted source',
    async source => {
      const operations = sourceOperations(source)
      await operations.write('fixture-rejected')
      expect(await operations.repair('fixture-rejected', 'fixture-previous')).toBe(true)
      expect(await sourceOperations(source).read()).toBe('fixture-previous')
    }
  )
  it.each(sources)('preserves a newer %s winner and absent source', async source => {
    const operations = sourceOperations(source)
    expect(await operations.repair('fixture-rejected', 'fixture-previous')).toBe(false)
    await operations.write('fixture-newer-user')
    expect(await operations.repair('fixture-rejected', 'fixture-previous')).toBe(false)
    expect(await sourceOperations(source).read()).toBe('fixture-newer-user')
  })
  it.each(sources)('does not repair %s after its runtime owner changed', async source => {
    const operations = sourceOperations(source)
    await operations.write('fixture-rejected')
    await expect(
      operations.repair('fixture-rejected', 'fixture-previous', () => false)
    ).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
    expect(await sourceOperations(source).read()).toBe('fixture-rejected')
  })
  it('rechecks native repair ownership after its actual stored-value read', async () => {
    const operations = sourceOperations('keytar')
    await operations.write('fixture-rejected')
    const keytar = await import('keytar')
    const entered = deferred()
    const release = deferred()
    let owned = true
    vi.mocked(keytar.getPassword).mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      return fixture.keychain.get(account) ?? null
    })
    const repairing = operations.repair('fixture-rejected', 'fixture-previous', () => owned)
    const rejected = expect(repairing).rejects.toBeInstanceOf(
      SessionTokenStorageSupersededBeforeWriteError
    )
    try {
      await boundedActor(entered.promise)
      owned = false
    } finally {
      release.resolve()
      await rejected
    }
    expect(await sourceOperations('keytar').read()).toBe('fixture-rejected')
  })
  it('rejects a queued native writer without triggering a fallback or replacing the winner', async () => {
    const keytar = await import('keytar')
    const entered = deferred()
    const release = deferred()
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (_service, target, token) => {
      entered.resolve()
      await release.promise
      fixture.keychain.set(target, token)
    })
    const writing = new TokenStore().setSessionToken('fixture-winner', ENV)
    let owned = true
    let stale: Promise<void> | undefined
    try {
      await boundedActor(entered.promise)
      stale = new TokenStore().setSessionToken('fixture-stale', ENV, { mayWrite: () => owned })
      await new Promise<void>(done => setImmediate(done))
      owned = false
    } finally {
      release.resolve()
      await writing
    }
    await expect(stale).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
    expect(await new TokenStore().getSessionToken(ENV)).toBe('fixture-winner')
    expect(await fs.readdir(fixture.directory)).toEqual([])
  })
  it('rejects an already accepted migration after its runtime owner changes without deleting legacy storage', async () => {
    await new TokenStore().setSessionToken('fixture-legacy', LEGACY_ENV, { requireKeytar: true })
    const keytar = await import('keytar')
    const entered = deferred()
    const release = deferred()
    let owned = true
    vi.mocked(keytar.getPassword).mockImplementation(async (_service, target) => {
      if (target === `session-token::${LEGACY_ENV}`) {
        entered.resolve()
        await release.promise
      }
      return fixture.keychain.get(target) ?? null
    })
    const migrating = new TokenStore().getSessionToken(ENV, {
      legacyEnvKeys: [LEGACY_ENV],
      mayWrite: () => owned,
    })
    const rejected = expect(migrating).rejects.toBeInstanceOf(
      SessionTokenStorageSupersededBeforeWriteError
    )
    try {
      await boundedActor(entered.promise)
      owned = false
    } finally {
      release.resolve()
      await rejected
    }
    expect(fixture.keychain.has(account)).toBe(false)
    expect(await new TokenStore().getKeytarSessionToken(LEGACY_ENV)).toBe('fixture-legacy')
    expect(await fs.readdir(fixture.directory)).toEqual([])
  })

  it('rejects a queued encrypted writer after its runtime owner changes', async () => {
    const entered = deferred()
    const release = deferred()
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, destination) => {
      entered.resolve()
      await release.promise
      return rename(source, destination)
    })
    const writing = new TokenStore().setSafeStorageSessionToken('fixture-winner', ENV)
    let owned = true
    let stale: Promise<void> | undefined
    try {
      await boundedActor(entered.promise)
      stale = new TokenStore().setSafeStorageSessionToken('fixture-stale', ENV, {
        mayWrite: () => owned,
      })
      await new Promise<void>(done => setImmediate(done))
      owned = false
    } finally {
      release.resolve()
      await writing
    }
    await expect(stale).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
    expect(await new TokenStore().getSafeStorageSessionToken(ENV)).toBe('fixture-winner')
    expect(await fs.readdir(fixture.directory)).toEqual([`session-token-${ENV}.enc`])
  })

  it('does not publish a repaired file after ownership changes while its temporary file opens', async () => {
    const operations = sourceOperations('encrypted')
    await operations.write('fixture-rejected')
    const entered = deferred()
    const release = deferred()
    const open = fs.open.bind(fs)
    let owned = true
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (String(args[0]).endsWith('.tmp')) {
        entered.resolve()
        await release.promise
      }
      return handle
    })
    const repairing = operations.repair('fixture-rejected', 'fixture-previous', () => owned)
    const rejected = expect(repairing).rejects.toBeInstanceOf(
      SessionTokenStorageSupersededBeforeWriteError
    )
    try {
      await boundedActor(entered.promise)
      owned = false
    } finally {
      release.resolve()
      await rejected
    }
    expect(await sourceOperations('encrypted').read()).toBe('fixture-rejected')
    expect(await fs.readdir(fixture.directory)).toEqual([`session-token-${ENV}.enc`])
  })
})
