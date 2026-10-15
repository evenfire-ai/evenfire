import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SessionTokenStorageSupersededBeforeWriteError, TokenStore } from '../tokenStore.js'

const fixture = vi.hoisted(() => ({ directory: '', encryptionAvailable: true }))
vi.mock('electron', () => ({
  app: { isReady: () => true, isPackaged: false, getPath: () => fixture.directory },
  safeStorage: {
    isEncryptionAvailable: () => fixture.encryptionAvailable,
    encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length),
  },
}))
vi.mock('keytar', () => ({}))

const ENV = 'drain-111111111111'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}
async function reached(boundary: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    expect(
      await Promise.race([
        boundary.then(() => true),
        new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), 2000)
        }),
      ]),
      'accepted storage work must enter its real controlled boundary'
    ).toBe(true)
  } finally {
    clearTimeout(timer)
  }
}
beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-clear-drain-'))
  fixture.encryptionAvailable = true
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture.directory, { recursive: true, force: true })
})

describe('R21-M9 accepted guarded clear owns every file callback until settlement', () => {
  it.each(['strict', 'best-effort'] as const)(
    'drains accepted %s cleanup after another source callback has been superseded',
    async mode => {
      const clearingStore = new TokenStore({ isolatedUserDataPath: fixture.directory })
      const writingStore = new TokenStore({ isolatedUserDataPath: fixture.directory })
      fixture.encryptionAvailable = false
      await clearingStore.setSessionToken('fixture-previous-plain', ENV)
      fixture.encryptionAvailable = true
      await clearingStore.setSafeStorageSessionToken('fixture-previous-encrypted', ENV)
      const entered = deferred()
      const release = deferred()
      const rejectedSibling = deferred()
      const rename = fs.rename.bind(fs)
      vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, target) => {
        entered.resolve()
        await release.promise
        return rename(source, target)
      })
      const writing = writingStore.setSafeStorageSessionToken('fixture-newer-source', ENV)
      let clearing: Promise<unknown> | undefined
      let drain: Promise<void> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let finished = false
      let ownershipChecks = 0
      try {
        await reached(entered.promise)
        const options = {
          mayWrite: () => {
            ownershipChecks += 1
            if (ownershipChecks >= 3) {
              rejectedSibling.resolve()
              return false
            }
            return true
          },
        }
        clearing =
          mode === 'strict'
            ? clearingStore.clearSessionTokenStrictly(ENV, options)
            : clearingStore.clearSessionToken(ENV, options)
        void clearing.catch(() => undefined)
        await reached(rejectedSibling.promise)
        drain = clearingStore.prepareForQuit().then(() => {
          finished = true
        })
        await Promise.race([
          drain,
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, 40)
          }),
        ])
        expect(
          finished,
          'quit must await the accepted cleanup still queued in another file lane'
        ).toBe(false)
      } finally {
        clearTimeout(timer)
        release.resolve()
        await Promise.allSettled([
          writing,
          ...(clearing ? [clearing] : []),
          ...(drain ? [drain] : []),
        ])
      }
      await expect(clearing).rejects.toBeInstanceOf(SessionTokenStorageSupersededBeforeWriteError)
      expect(finished).toBe(true)
      expect(
        await new TokenStore({
          isolatedUserDataPath: fixture.directory,
        }).getSafeStorageSessionToken(ENV)
      ).toBe('fixture-newer-source')
      expect(
        JSON.parse(
          await fs.readFile(path.join(fixture.directory, `session-token-${ENV}.json`), 'utf8')
        ).token
      ).toBe('fixture-previous-plain')
    }
  )
})
