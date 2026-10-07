import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clearPendingExternalLogout,
  hasPendingExternalLogout,
  recordPendingExternalLogout,
} from '../pendingExternalLogout.js'

let userDataDirectory = ''

afterEach(async () => {
  if (userDataDirectory) await fs.rm(userDataDirectory, { recursive: true, force: true })
  userDataDirectory = ''
})

describe('pending external logout intent', () => {
  it('durably records an idempotent marker without storing credentials', async () => {
    userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-pending-logout-'))

    recordPendingExternalLogout(userDataDirectory)
    recordPendingExternalLogout(userDataDirectory)

    const markerPath = path.join(userDataDirectory, 'pending-external-logout')
    expect(hasPendingExternalLogout(userDataDirectory)).toBe(true)
    expect(await fs.readFile(markerPath, 'utf8')).toBe('')
    expect((await fs.readdir(userDataDirectory)).sort()).toEqual(['pending-external-logout'])

    clearPendingExternalLogout(userDataDirectory)
    expect(hasPendingExternalLogout(userDataDirectory)).toBe(false)
  })

  it('rejects markers outside the app userData directory contract', async () => {
    userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-pending-logout-'))
    const markerPath = path.join(userDataDirectory, 'pending-external-logout')
    await fs.symlink(path.join(userDataDirectory, 'missing-target'), markerPath)

    expect(() => hasPendingExternalLogout(userDataDirectory)).toThrow(
      'Pending logout marker is not a regular file'
    )
  })
})
