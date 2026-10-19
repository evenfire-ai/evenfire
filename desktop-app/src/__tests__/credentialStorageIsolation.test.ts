import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { takeCredentialStorageIsolationAttempts } from '../../test/setup/credentialStorageIsolation.js'

describe('unit-test credential storage boundary', () => {
  it('blocks Node-native Keytar before executing the installed backend', () => {
    const require = createRequire(import.meta.url)
    expect(() => require('keytar')).toThrow('refused native-keytar')
    expect(takeCredentialStorageIsolationAttempts()).toEqual(['native-keytar'])
  })

  it('blocks the official credential path before reading it', async () => {
    await expect(
      fs.readFile(path.join(os.homedir(), '.evenfire', 'session-token.json'))
    ).rejects.toThrow('refused official-credential-files')
    expect(takeCredentialStorageIsolationAttempts()).toEqual(['official-credential-files'])
  })

  it('permits real owned temporary resources', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-isolation-guard-'))
    const file = path.join(directory, 'fixture.txt')
    try {
      await fs.writeFile(file, 'fixture-owned-data')
      expect(await fs.readFile(file, 'utf8')).toBe('fixture-owned-data')
      expect(takeCredentialStorageIsolationAttempts()).toEqual([])
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('blocks Buffer paths and symlink ancestors before official file dispatch', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-isolation-link-'))
    const officialBase = path.join(os.homedir(), '.evenfire')
    try {
      await expect(
        fs.readFile(Buffer.from(path.join(officialBase, 'fixture.txt')))
      ).rejects.toThrow('refused official-credential-files')
      const link = path.join(directory, 'home-link')
      await fs.symlink(os.homedir(), link)
      await expect(fs.readFile(path.join(link, '.evenfire', 'fixture.txt'))).rejects.toThrow(
        'refused official-credential-files'
      )
      expect(takeCredentialStorageIsolationAttempts()).toEqual([
        'official-credential-files',
        'official-credential-files',
      ])
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
