import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type AuditEntry, PluginAuditLog } from '../pluginAuditLog.js'
import { type ConsentGrant, LocalConsentStore } from '../pluginConsentStore.js'
import { inspectWindowsPluginStoragePaths } from '../pluginStorageWindowsAcl.js'
import {
  WINDOWS_SESSION_AUTHORITY_NATIVE_ASSEMBLY_ENV,
  windowsSessionAuthorityNativeAssemblyPath,
} from '../windowsSessionAuthorityNativeAssembly.js'
import { createWindowsSessionAuthorityPowerShellEnvironment } from '../windowsSessionAuthorityPowerShellEnvironment.js'

const windowsIt = it.skipIf(process.platform !== 'win32')
const ENV_KEY = 'testenv-0123456789ab'
const REQUEST_ENV = 'EVENFIRE_PLUGIN_ACL_FIXTURE_TARGET'
const DIRECTORY_ENV = 'EVENFIRE_PLUGIN_ACL_FIXTURE_DIRECTORY'
const MUTATE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('EVENFIRE_PLUGIN_ACL_FIXTURE_TARGET')
$isDirectory = [Environment]::GetEnvironmentVariable('EVENFIRE_PLUGIN_ACL_FIXTURE_DIRECTORY') -eq 'true'
$sid = [Security.Principal.SecurityIdentifier]::new('S-1-5-11')
$rights = [Security.AccessControl.FileSystemRights]::ReadData -bor
  [Security.AccessControl.FileSystemRights]::WriteData -bor
  [Security.AccessControl.FileSystemRights]::AppendData
$rule = [Security.AccessControl.FileSystemAccessRule]::new(
  $sid, $rights, [Security.AccessControl.AccessControlType]::Allow)
$file = if ($isDirectory) { [IO.DirectoryInfo]::new($target) } else { [IO.FileInfo]::new($target) }
$security = $file.GetAccessControl()
$security.AddAccessRule($rule)
$file.SetAccessControl($security)
`

let userDataDirectory = ''

function grant(overrides: Partial<ConsentGrant> = {}): ConsentGrant {
  return {
    envKey: ENV_KEY,
    userId: 'fixture-user',
    pluginId: 'fixture/plugin',
    capability: 'identity.read',
    grantedAt: '2026-10-30T00:00:00.000Z',
    lastUsedAt: null,
    descriptorVersion: 1,
    revision: 0,
    ...overrides,
  }
}

function auditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: '2026-10-30T00:00:00.000Z',
    userId: 'fixture-user',
    pluginId: 'fixture/plugin',
    capability: 'identity.read',
    outcome: 'allowed',
    ...overrides,
  }
}

async function addAuthenticatedUsersAccess(file: string, directory = false): Promise<void> {
  const systemRoot = process.env.SystemRoot
  const temporaryDirectory = process.env.TEMP ?? process.env.TMP
  if (!systemRoot || !temporaryDirectory) throw new Error('Windows fixture environment unavailable')
  const result = spawnSync(
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$source = [Console]::In.ReadToEnd(); & ([scriptblock]::Create($source))',
    ],
    {
      encoding: 'utf8',
      env: {
        ...createWindowsSessionAuthorityPowerShellEnvironment(systemRoot, temporaryDirectory),
        [REQUEST_ENV]: file,
        [DIRECTORY_ENV]: String(directory),
        [WINDOWS_SESSION_AUTHORITY_NATIVE_ASSEMBLY_ENV]:
          windowsSessionAuthorityNativeAssemblyPath(),
      },
      input: MUTATE_SCRIPT,
      maxBuffer: 2048,
      timeout: 10_000,
      windowsHide: true,
    }
  )
  if (result.error || result.signal || result.status !== 0) {
    throw new Error('Disposable Windows ACL fixture mutation failed')
  }
}

async function evidence(
  ...items: { path: string; directory: boolean; requireInherited: boolean }[]
) {
  return inspectWindowsPluginStoragePaths(items)
}

beforeEach(async () => {
  userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-plugin-acl-'))
})

afterEach(async () => {
  if (userDataDirectory) await fs.rm(userDataDirectory, { recursive: true, force: true })
  userDataDirectory = ''
})

describe('Windows plugin storage DACL privacy', () => {
  windowsIt(
    'verifies the real user-data, consent directory, and produced consent file',
    async () => {
      const directory = path.join(userDataDirectory, 'plugin-consent')
      const file = path.join(directory, `${ENV_KEY}.json`)
      const store = new LocalConsentStore(directory)

      await store.put(grant())
      expect(await new LocalConsentStore(directory).get(grant())).toMatchObject({
        pluginId: 'fixture/plugin',
        capability: 'identity.read',
        revision: 1,
      })

      const [parent, child, consent] = await evidence(
        { path: userDataDirectory, directory: true, requireInherited: false },
        { path: directory, directory: true, requireInherited: true },
        { path: file, directory: false, requireInherited: true }
      )
      for (const item of [parent, child, consent]) {
        expect(item?.effectiveRead).toBe(true)
        expect(item?.effectiveWrite).toBe(true)
        expect(item?.allowedPrincipalsOnly).toBe(true)
      }
      expect(child?.inheritedUserAccess).toBe(true)
      expect(consent?.inheritedUserAccess).toBe(true)
    }
  )

  windowsIt(
    'rejects an unsafe existing consent file without reading or overwriting it',
    async () => {
      const directory = path.join(userDataDirectory, 'plugin-consent')
      const file = path.join(directory, `${ENV_KEY}.json`)
      await new LocalConsentStore(directory).put(grant())
      const before = await fs.readFile(file)
      await addAuthenticatedUsersAccess(file)

      const reopened = new LocalConsentStore(directory)
      await expect(reopened.get(grant())).rejects.toThrow('privacy could not be verified')
      await expect(reopened.put(grant({ capability: 'org.read' }))).rejects.toThrow(
        'privacy could not be verified'
      )
      expect(await fs.readFile(file)).toEqual(before)
    }
  )

  windowsIt('rejects an unsafe user-data parent before creating consent files', async () => {
    const directory = path.join(userDataDirectory, 'plugin-consent')
    await addAuthenticatedUsersAccess(userDataDirectory, true)

    await expect(new LocalConsentStore(directory).put(grant())).rejects.toThrow(
      'privacy could not be verified'
    )
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  windowsIt('rechecks a replaced consent file instead of returning cached grants', async () => {
    const directory = path.join(userDataDirectory, 'plugin-consent')
    const file = path.join(directory, `${ENV_KEY}.json`)
    const store = new LocalConsentStore(directory)
    await store.put(grant())
    expect(await store.get(grant())).not.toBeNull()
    const previous = `${file}.previous`
    await fs.rename(file, previous)
    await fs.copyFile(previous, file)
    await addAuthenticatedUsersAccess(file)

    await expect(store.get(grant())).rejects.toThrow('privacy could not be verified')
  })

  windowsIt('rechecks a replaced consent directory before returning cached grants', async () => {
    const directory = path.join(userDataDirectory, 'plugin-consent')
    const file = path.join(directory, `${ENV_KEY}.json`)
    const store = new LocalConsentStore(directory)
    await store.put(grant())
    expect(await store.get(grant())).not.toBeNull()

    const previous = `${directory}.previous`
    await fs.rename(directory, previous)
    await fs.mkdir(directory)
    await fs.copyFile(path.join(previous, `${ENV_KEY}.json`), file)
    await addAuthenticatedUsersAccess(directory, true)

    await expect(store.get(grant())).rejects.toThrow('privacy could not be verified')
  })

  windowsIt('retains inherited effective access after an atomic consent replacement', async () => {
    const directory = path.join(userDataDirectory, 'plugin-consent')
    const file = path.join(directory, `${ENV_KEY}.json`)
    const store = new LocalConsentStore(directory)
    await store.put(grant())
    await store.put(grant({ lastUsedAt: '2026-10-30T00:01:00.000Z' }))

    const [consent] = await evidence({ path: file, directory: false, requireInherited: true })
    expect(consent?.effectiveRead).toBe(true)
    expect(consent?.effectiveWrite).toBe(true)
    expect(consent?.inheritedUserAccess).toBe(true)
    expect(await new LocalConsentStore(directory).get(grant())).toMatchObject({
      lastUsedAt: '2026-10-30T00:01:00.000Z',
      revision: 2,
    })
  })

  windowsIt('preserves consent corruption recovery as a verified inherited-DACL file', async () => {
    const directory = path.join(userDataDirectory, 'plugin-consent')
    const file = path.join(directory, `${ENV_KEY}.json`)
    await new LocalConsentStore(directory).put(grant())
    await fs.writeFile(file, '{')

    expect(await new LocalConsentStore(directory).get(grant())).toBeNull()
    const quarantineName = (await fs.readdir(directory)).find(name =>
      name.startsWith(`${ENV_KEY}.json.corrupt-`)
    )
    expect(quarantineName).toBeDefined()
    const [quarantine] = await evidence({
      path: path.join(directory, quarantineName!),
      directory: false,
      requireInherited: true,
    })
    expect(quarantine?.effectiveRead).toBe(true)
    expect(quarantine?.effectiveWrite).toBe(true)
    expect(quarantine?.inheritedUserAccess).toBe(true)
    expect(quarantine?.allowedPrincipalsOnly).toBe(true)
  })

  windowsIt('verifies actual audit files and the rotated generation', async () => {
    const directory = path.join(userDataDirectory, 'plugin-audit')
    const file = path.join(directory, `${ENV_KEY}.jsonl`)
    const rotated = `${file}.1`
    const log = new PluginAuditLog(directory)
    const largeShape = { fields: Array.from({ length: 8_000 }, () => 'field') }

    for (let index = 0; index < 90; index += 1) {
      await log.append(ENV_KEY, auditEntry({ shape: largeShape }))
    }

    const [parent, child, active, prior] = await evidence(
      { path: userDataDirectory, directory: true, requireInherited: false },
      { path: directory, directory: true, requireInherited: true },
      { path: file, directory: false, requireInherited: true },
      { path: rotated, directory: false, requireInherited: true }
    )
    for (const item of [parent, child, active, prior]) {
      expect(item?.effectiveRead).toBe(true)
      expect(item?.effectiveWrite).toBe(true)
      expect(item?.allowedPrincipalsOnly).toBe(true)
    }
    expect(active?.inheritedUserAccess).toBe(true)
    expect(prior?.inheritedUserAccess).toBe(true)
    expect((await fs.stat(rotated)).size).toBeGreaterThan(0)
    expect(await log.read(ENV_KEY, { limit: 1 })).toHaveLength(1)
  })

  windowsIt('does not append to an audit file with unauthorized effective access', async () => {
    const directory = path.join(userDataDirectory, 'plugin-audit')
    const file = path.join(directory, `${ENV_KEY}.jsonl`)
    const log = new PluginAuditLog(directory)
    await log.append(ENV_KEY, auditEntry())
    const before = await fs.readFile(file)
    await addAuthenticatedUsersAccess(file)

    await log.append(ENV_KEY, auditEntry({ capability: 'org.read' }))
    expect(await fs.readFile(file)).toEqual(before)
    expect(await log.read(ENV_KEY)).toEqual([])
  })
})
