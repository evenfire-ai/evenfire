import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clearPendingExternalLogout,
  hasPendingExternalLogout,
  readPendingExternalLogoutIntent,
  recordPendingExternalLogout,
  recordPendingKeytarCleanup,
} from '../pendingExternalLogout.js'

let userDataDirectory = ''
const ENV_A = 'env_a-000000000000'
const ENV_B = 'env_b-111111111111'
const LEGACY_MARKER = 'pending-external-logout'

function markerPath(envKey: string): string {
  const environmentId = createHash('sha256').update(envKey).digest('hex')
  return path.join(userDataDirectory, `pending-external-logout-${environmentId}`)
}

afterEach(async () => {
  vi.restoreAllMocks()
  if (userDataDirectory) await fs.rm(userDataDirectory, { recursive: true, force: true })
  userDataDirectory = ''
})

describe('pending external logout intent', () => {
  it('durably records an idempotent marker without storing credentials', async () => {
    userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-pending-logout-'))

    recordPendingExternalLogout(userDataDirectory, ENV_A)
    recordPendingExternalLogout(userDataDirectory, ENV_A)

    expect(hasPendingExternalLogout(userDataDirectory, ENV_A)).toBe(true)
    expect(JSON.parse(await fs.readFile(markerPath(ENV_A), 'utf8'))).toEqual({
      version: 1,
      revision: expect.any(String),
      intent: 'logout-pending',
    })
    expect((await fs.stat(markerPath(ENV_A))).mode & 0o777).toBe(0o600)
    expect(await fs.readdir(userDataDirectory)).toEqual([
      `pending-external-logout-${createHash('sha256').update(ENV_A).digest('hex')}`,
    ])

    clearPendingExternalLogout(userDataDirectory, ENV_A)
    expect(hasPendingExternalLogout(userDataDirectory, ENV_A)).toBe(false)
  })

  it('keeps logout intents isolated by environment without exposing the environment key', async () => {
    userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-pending-logout-'))

    recordPendingExternalLogout(userDataDirectory, ENV_A)

    expect(hasPendingExternalLogout(userDataDirectory, ENV_A)).toBe(true)
    expect(hasPendingExternalLogout(userDataDirectory, ENV_B)).toBe(false)
    expect((await fs.readdir(userDataDirectory)).join('')).not.toContain(ENV_A)
  })

  it('distinguishes a secure credential cleanup from a pending logout', async () => {
    userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-pending-logout-'))

    recordPendingExternalLogout(userDataDirectory, ENV_A)
    recordPendingKeytarCleanup(userDataDirectory, ENV_A, 'safe-storage')

    expect(readPendingExternalLogoutIntent(userDataDirectory, ENV_A)).toEqual({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })

    recordPendingExternalLogout(userDataDirectory, ENV_A)
    expect(readPendingExternalLogoutIntent(userDataDirectory, ENV_A)).toEqual({
      intent: 'logout-pending',
    })
  })

  it('ignores the unscoped marker and leaves it untouched by environment cleanup', async () => {
    userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-pending-logout-'))
    await fs.writeFile(path.join(userDataDirectory, LEGACY_MARKER), '', { mode: 0o600 })

    expect(hasPendingExternalLogout(userDataDirectory, ENV_A)).toBe(false)
    expect(hasPendingExternalLogout(userDataDirectory, ENV_B)).toBe(false)

    clearPendingExternalLogout(userDataDirectory, ENV_A)

    expect(hasPendingExternalLogout(userDataDirectory, ENV_A)).toBe(false)
    expect(await fs.readdir(userDataDirectory)).toEqual([LEGACY_MARKER])
  })

  it('rejects markers outside the app userData directory contract', async () => {
    userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-pending-logout-'))
    await fs.symlink(path.join(userDataDirectory, 'missing-target'), markerPath(ENV_A))

    expect(() => hasPendingExternalLogout(userDataDirectory, ENV_A)).toThrow(
      'Pending logout marker is not a regular file'
    )
  })

  it('reads the opened marker when its path is replaced', async () => {
    userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-pending-logout-'))
    const filePath = markerPath(ENV_A)
    const replacementDirectory = path.join(userDataDirectory, 'replacement')
    const replacementPath = path.join(replacementDirectory, path.basename(filePath))
    await fs.mkdir(replacementDirectory)
    recordPendingExternalLogout(userDataDirectory, ENV_A)
    recordPendingKeytarCleanup(replacementDirectory, ENV_A, 'safe-storage')
    const originalLstat = fsSync.lstatSync.bind(fsSync)
    const originalOpen = fsSync.openSync.bind(fsSync)
    let replaced = false

    const replaceMarkerPath = () => {
      if (replaced) return
      fsSync.renameSync(replacementPath, filePath)
      replaced = true
    }

    vi.spyOn(fsSync, 'lstatSync').mockImplementation((checkedPath, options) => {
      const stat = originalLstat(checkedPath, options)
      if (checkedPath === filePath) replaceMarkerPath()
      return stat
    })
    vi.spyOn(fsSync, 'openSync').mockImplementation((openedPath, flags, mode) => {
      const descriptor = originalOpen(openedPath, flags, mode)
      if (openedPath === filePath) replaceMarkerPath()
      return descriptor
    })

    expect(readPendingExternalLogoutIntent(userDataDirectory, ENV_A)).toEqual({
      intent: 'logout-pending',
    })
    expect(replaced).toBe(true)
  })

  it('rejects invalid environment identities before constructing a marker path', async () => {
    userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-pending-logout-'))

    expect(() => hasPendingExternalLogout(userDataDirectory, '../outside')).toThrow(
      'Pending logout intent requires a valid environment key'
    )
  })
})
