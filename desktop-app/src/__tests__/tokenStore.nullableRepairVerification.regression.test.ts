import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type SessionTokenReadAuthority, TokenStore } from '../tokenStore.js'

const fixture = vi.hoisted(() => ({ directory: '', keychain: new Map<string, string>() }))
vi.mock('electron', () => ({
  app: { isReady: () => true, getPath: () => fixture.directory },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('keytar', () => ({
  getPassword: vi.fn(async (_service, account) => fixture.keychain.get(account) ?? null),
  setPassword: vi.fn(async (_service, account, token) => {
    fixture.keychain.set(account, token)
  }),
  deletePassword: vi.fn(async (_service, account) => fixture.keychain.delete(account)),
}))

const ENV = 'null_repair-111111111111'
const TOKEN = 'fixture-rejected-candidate'
const account = `session-token::${ENV}`
let candidateAuthority: SessionTokenReadAuthority | undefined
beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-nullable-verification-'))
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
  candidateAuthority = undefined
  await new TokenStore().setSessionToken(TOKEN, ENV, {
    requireKeytar: true,
    onMutationSettled: (_source, authority) => {
      candidateAuthority = authority
    },
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture.directory, { recursive: true, force: true })
})

describe('R21-M14 conditional native absence is verified in its lane', () => {
  it.each([false, true])(
    'rejects backend acknowledgement %s while the produced candidate remains',
    async result => {
      const keytar = await import('keytar')
      vi.mocked(keytar.deletePassword).mockImplementationOnce(async () => result)
      await expect(
        new TokenStore().repairKeytarSessionTokenIfMatches(TOKEN, null, ENV, {
          candidateAuthority,
        })
      ).rejects.toThrow('Native session token remains after conditional deletion')
      expect(fixture.keychain.get(account)).toBe(TOKEN)
      expect(keytar.getPassword).toHaveBeenCalledTimes(2)
    }
  )

  it('accepts false acknowledgement only after an actual null read proves absence', async () => {
    const keytar = await import('keytar')
    vi.mocked(keytar.deletePassword).mockImplementationOnce(async (_service, target) => {
      fixture.keychain.delete(target)
      return false
    })
    await expect(
      new TokenStore().repairKeytarSessionTokenIfMatches(TOKEN, null, ENV, {
        candidateAuthority,
      })
    ).resolves.toBe(true)
    expect(fixture.keychain.has(account)).toBe(false)
    expect(keytar.getPassword).toHaveBeenCalledTimes(2)
  })

  it('propagates locked verification rather than interpreting it as generic fallback absence', async () => {
    const keytar = await import('keytar')
    const locked = new Error('fixture-native-verification-locked')
    let unavailable = false
    vi.mocked(keytar.deletePassword).mockImplementationOnce(async () => {
      unavailable = true
      return false
    })
    vi.mocked(keytar.getPassword).mockImplementation(async (_service, target) => {
      if (unavailable) throw locked
      return fixture.keychain.get(target) ?? null
    })
    await expect(
      new TokenStore().repairKeytarSessionTokenIfMatches(TOKEN, null, ENV, {
        candidateAuthority,
      })
    ).rejects.toBe(locked)
    expect(fixture.keychain.get(account)).toBe(TOKEN)
    expect(keytar.getPassword).toHaveBeenCalledTimes(2)
  })

  it('keeps accepted cleanup in quit drain through the actual post-delete verification', async () => {
    const keytar = await import('keytar')
    let release!: () => void
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    let reads = 0
    let verifying = false
    vi.mocked(keytar.getPassword).mockImplementation(async (_service, target) => {
      if (++reads === 2) {
        verifying = true
        await held
      }
      return fixture.keychain.get(target) ?? null
    })
    const store = new TokenStore()
    const cleanup = store.repairKeytarSessionTokenIfMatches(TOKEN, null, ENV, {
      candidateAuthority,
    })
    let drained = false
    let drain: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(verifying).toBe(true), { timeout: 1000 })
      drain = store.prepareForQuit().then(() => {
        drained = true
      })
      await expect(store.repairKeytarSessionTokenIfMatches(TOKEN, null, ENV)).rejects.toThrow(
        'Application is shutting down'
      )
      expect(drained).toBe(false)
    } finally {
      release()
      await Promise.allSettled([cleanup, drain])
    }
    await expect(cleanup).resolves.toBe(true)
    expect(drained).toBe(true)
    expect(fixture.keychain.has(account)).toBe(false)
  })
})
