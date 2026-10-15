import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionTokenStorageUnavailableBeforeWriteError, TokenStore } from '../tokenStore.js'

const fixture = vi.hoisted(() => {
  const keychain = new Map<string, string>()
  return {
    directory: '',
    keychain,
    keytar: {
      getPassword: vi.fn(
        async (_service: string, account: string) => keychain.get(account) ?? null
      ),
      setPassword: vi.fn(async (_service: string, account: string, token: string) => {
        keychain.set(account, token)
      }),
      deletePassword: vi.fn(async (_service: string, account: string) => keychain.delete(account)),
    },
  }
})
vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => fixture.directory },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length),
  },
}))
vi.mock('keytar', () => fixture.keytar)

const ENV = 'ordered-111111111111'
const OTHER_ENV = 'ordered-222222222222'
const account = `session-token::${ENV}`
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
async function boundedActor(actor: Promise<unknown>, description: string) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    expect(
      await Promise.race([
        actor.then(() => true),
        new Promise<boolean>(done => {
          timeout = setTimeout(() => done(false), 2000)
        }),
      ]),
      description
    ).toBe(true)
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
async function settleOrQueue(operation: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      operation.catch(() => undefined),
      new Promise<void>(done => {
        timer = setTimeout(done, 50)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-native-order-'))
  fixture.keychain.clear()
  vi.clearAllMocks()
  await new TokenStore().setSessionToken('fixture-home', ENV, { requireKeytar: true })
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
  vi.mocked(keytar.deletePassword).mockImplementation(async (_service, target) =>
    fixture.keychain.delete(target)
  )
  await fs.rm(fixture.directory, { recursive: true, force: true })
})

describe('same-account native operations', () => {
  it('retries an unavailable provider after the import cohort settles', async () => {
    const store = new TokenStore()
    vi.doMock('keytar', () => ({}))
    try {
      await expect(
        store.setSessionToken('fixture-retry', ENV, { requireKeytar: true })
      ).rejects.toBeInstanceOf(SessionTokenStorageUnavailableBeforeWriteError)
      expect(fixture.keychain.get(account)).toBe('fixture-home')
      vi.doMock('keytar', () => fixture.keytar)
      await expect(
        store.setSessionToken('fixture-retry', ENV, { requireKeytar: true })
      ).resolves.toBeUndefined()
      expect(await new TokenStore().getKeytarSessionToken(ENV)).toBe('fixture-retry')
    } finally {
      vi.doMock('keytar', () => fixture.keytar)
    }
  })

  it('preserves the last accepted account mutation across varied native completion delays', async () => {
    const keytar = await import('keytar')
    const events: string[] = []
    vi.mocked(keytar.setPassword).mockImplementation(async (_service, target, token) => {
      events.push(`set-start:${target}:${token}`)
      await new Promise<void>(done => setImmediate(done))
      events.push(`set-finish:${target}:${token}`)
      fixture.keychain.set(target, token)
    })
    vi.mocked(keytar.deletePassword).mockImplementation(async (_service, target) => {
      events.push(`delete:${target}`)
      return fixture.keychain.delete(target)
    })
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), async writes => {
        fixture.keychain.delete(account)
        events.length = 0
        const mutations = writes.map((write, index) =>
          write
            ? new TokenStore().setSessionToken(`fixture-property-${index}`, ENV, {
                requireKeytar: true,
              })
            : new TokenStore().clearKeytarSessionTokensStrictly(ENV)
        )
        await Promise.all(mutations)
        expect(await new TokenStore().getKeytarSessionToken(ENV), events.join(',')).toBe(
          writes.at(-1) ? `fixture-property-${writes.length - 1}` : null
        )
      }),
      { numRuns: 100 }
    )
  })

  it('does not let an older clear delete a newer accepted replacement across stores', async () => {
    const keytar = await import('keytar')
    const entered = deferred()
    const release = deferred()
    vi.mocked(keytar.deletePassword).mockImplementationOnce(async (_service, target) => {
      entered.resolve()
      await release.promise
      return fixture.keychain.delete(target)
    })
    const clearing = new TokenStore().clearSessionToken(ENV)
    let replacing: Promise<void> | undefined
    try {
      await boundedActor(entered.promise, 'accepted native clear reaches its real boundary')
      replacing = new TokenStore().setSessionToken('fixture-younger', ENV, { requireKeytar: true })
      await settleOrQueue(replacing)
    } finally {
      release.resolve()
      await Promise.allSettled([clearing, ...(replacing ? [replacing] : [])])
    }
    await expect(clearing).resolves.toBeUndefined()
    await expect(replacing).resolves.toBeUndefined()
    expect(await new TokenStore().getSessionToken(ENV)).toBe('fixture-younger')
  })

  it('cannot restore an older native write after a later completed clear', async () => {
    const keytar = await import('keytar')
    const entered = deferred()
    const release = deferred()
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (_service, target, token) => {
      entered.resolve()
      await release.promise
      fixture.keychain.set(target, token)
    })
    const replacing = new TokenStore().setSessionToken('fixture-late', ENV, { requireKeytar: true })
    let clearing: Promise<unknown> | undefined
    try {
      await boundedActor(entered.promise, 'accepted native write reaches its real boundary')
      clearing = new TokenStore().clearSessionToken(ENV)
      await settleOrQueue(clearing)
    } finally {
      release.resolve()
      await Promise.allSettled([replacing, ...(clearing ? [clearing] : [])])
    }
    await expect(replacing).resolves.toBeUndefined()
    await expect(clearing).resolves.toBeUndefined()
    expect(
      vi.mocked(keytar.deletePassword).mock.calls.some(([, target]) => target === account),
      'the controlled native cleanup must actually run before asserting restart'
    ).toBe(true)
    expect(await new TokenStore().getSessionToken(ENV)).toBeNull()
    expect(fixture.keychain.has(account)).toBe(false)
  })

  it('orders source reads after an accepted native replacement', async () => {
    const keytar = await import('keytar')
    const entered = deferred()
    const release = deferred()
    vi.mocked(keytar.setPassword).mockImplementationOnce(async (_service, target, token) => {
      entered.resolve()
      await release.promise
      fixture.keychain.set(target, token)
    })
    const replacing = new TokenStore().setSessionToken('fixture-current', ENV, {
      requireKeytar: true,
    })
    let reading: Promise<string | null> | undefined
    try {
      await boundedActor(entered.promise, 'accepted native write reaches its real boundary')
      reading = new TokenStore().getKeytarSessionToken(ENV)
      await settleOrQueue(reading)
    } finally {
      release.resolve()
      await replacing
    }
    expect(await reading).toBe('fixture-current')
    expect(await new TokenStore().getSessionToken(ENV)).toBe('fixture-current')
  })

  it('releases a failed account lane and keeps other environments independent', async () => {
    const keytar = await import('keytar')
    const entered = deferred()
    const release = deferred()
    vi.mocked(keytar.setPassword).mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      throw new Error('fixture-native-write-rejected')
    })
    const rejected = new TokenStore().setSessionToken('fixture-rejected', ENV, {
      requireKeytar: true,
    })
    const rejection = expect(rejected).rejects.toThrow('Failed to replace session token in Keytar')
    let replacing: Promise<void> | undefined
    try {
      await boundedActor(entered.promise, 'accepted native write reaches its real boundary')
      await boundedActor(
        new TokenStore().setSessionToken('fixture-independent', OTHER_ENV, { requireKeytar: true }),
        'another account does not wait on this lane'
      )
      replacing = new TokenStore().setSessionToken('fixture-after-error', ENV, {
        requireKeytar: true,
      })
    } finally {
      release.resolve()
      await rejection
      if (replacing) await replacing
    }
    expect(await new TokenStore().getSessionToken(ENV)).toBe('fixture-after-error')
    expect(await new TokenStore().getSessionToken(OTHER_ENV)).toBe('fixture-independent')
  })
})
