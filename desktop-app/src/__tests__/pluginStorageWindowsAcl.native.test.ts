import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AUDIT_MAX_AGE_MS, type AuditEntry, PluginAuditLog } from '../pluginAuditLog.js'
import { type ConsentGrant, LocalConsentStore } from '../pluginConsentStore.js'
import {
  PluginStoragePrivacyError,
  PluginStoragePrivacyGuard,
  inspectWindowsPluginStoragePaths,
} from '../pluginStorageWindowsAcl.js'
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

type CleanupEvent = {
  event: 'plugin-acl-cleanup'
  phase: string
  ordinal: number
  elapsedMs: number
  errorCode?: string
}

const cleanupEvents: CleanupEvent[] = []

function cleanupPhase(phase: string, ordinal: number, elapsedMs: number, code?: string): void {
  const allowedCodes = new Set(['EBUSY', 'EACCES', 'EPERM', 'ENOTEMPTY', 'ENOENT', 'UNKNOWN'])
  const safeCode = code && allowedCodes.has(code) ? code : undefined
  const record: CleanupEvent = {
    event: 'plugin-acl-cleanup',
    phase,
    ordinal,
    elapsedMs: Math.max(0, Math.min(60_000, Math.round(elapsedMs))),
    ...(safeCode ? { errorCode: safeCode } : {}),
  }
  cleanupEvents.push(record)
  process.stderr.write(`${JSON.stringify(record)}\n`)
  const progressPath = process.env.PR977_PROGRESS_PATH
  if (progressPath) {
    appendFileSync(
      progressPath,
      `${JSON.stringify({
        elapsedMs: Date.now() - cleanupProcessStartedAt,
        event: 'plugin-acl-cleanup-phase',
        activeFile: 'pluginStorageWindowsAcl.native.test.ts',
        activeCase: null,
        activeHook: 'afterEach',
        lastCompletedOperation: phase,
        filesStarted: 1,
        filesCompleted: 0,
        casesCompleted: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        cleanupPhase: record.phase,
        cleanupOrdinal: record.ordinal,
        cleanupElapsedMs: record.elapsedMs,
        ...(record.errorCode ? { cleanupErrorCode: record.errorCode } : {}),
      })}\n`,
      { encoding: 'utf8' }
    )
  }
}

const cleanupProcessStartedAt = Date.now()

type CleanupOperations = {
  enumerate(directory: string): Promise<import('node:fs').Dirent[]>
  deleteEntry(entryPath: string, directory: boolean): Promise<void>
  removeDirectory(directory: string): Promise<void>
}

async function cleanupTestDirectory(
  directory: string,
  operations: CleanupOperations = {
    enumerate: async target => fs.readdir(target, { withFileTypes: true }),
    deleteEntry: async (entryPath, isDirectory) =>
      isDirectory ? fs.rmdir(entryPath) : fs.rm(entryPath),
    removeDirectory: async target => fs.rmdir(target),
  }
): Promise<void> {
  const started = performance.now()
  let ordinal = 0
  const entriesToDelete: { path: string; directory: boolean; ordinal: number }[] = []
  cleanupPhase('cleanup-start', 0, 0)
  try {
    const enumerate = async (target: string, directoryOrdinal = 0): Promise<void> => {
      const enumerationStarted = performance.now()
      cleanupPhase('enumeration-start', directoryOrdinal, 0)
      const entries = await operations.enumerate(target)
      cleanupPhase('enumeration-complete', directoryOrdinal, performance.now() - enumerationStarted)
      for (const entry of entries) {
        const entryOrdinal = ++ordinal
        const entryPath = path.join(target, entry.name)
        const isDirectory = entry.isDirectory()
        if (isDirectory) await enumerate(entryPath, entryOrdinal)
        entriesToDelete.push({ path: entryPath, directory: isDirectory, ordinal: entryOrdinal })
      }
    }
    await enumerate(directory)
    for (const entry of entriesToDelete) {
      const entryStarted = performance.now()
      cleanupPhase(
        entry.directory ? 'entry-directory-delete-start' : 'entry-file-delete-start',
        entry.ordinal,
        0
      )
      await operations.deleteEntry(entry.path, entry.directory)
      cleanupPhase('entry-delete-complete', entry.ordinal, performance.now() - entryStarted)
    }
    const directoryStarted = performance.now()
    await operations.removeDirectory(directory)
    cleanupPhase('directory-remove-complete', ordinal, performance.now() - directoryStarted)
    cleanupPhase('cleanup-complete', ordinal, performance.now() - started)
  } catch (error) {
    const rawCode = (error as NodeJS.ErrnoException).code
    const code =
      rawCode && ['EBUSY', 'EACCES', 'EPERM', 'ENOTEMPTY', 'ENOENT'].includes(rawCode)
        ? rawCode
        : 'UNKNOWN'
    cleanupPhase('cleanup-failed', ordinal, performance.now() - started, code)
    throw error
  }
}

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

async function expectUnauthorizedPrincipalRejection(operation: Promise<unknown>) {
  const error = await operation.then(
    () => undefined,
    rejection => rejection
  )
  expect(error).toBeInstanceOf(PluginStoragePrivacyError)
  expect(error).toMatchObject({
    reason: 'native-verifier-rejected',
    diagnostic: {
      failure: 'verifier-rejected',
      nativePhase: 'inspect-complete',
      nativeReason: 'unauthorized-principal-access',
    },
  })
  return error
}

beforeEach(async () => {
  userDataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-plugin-acl-'))
})

afterEach(async () => {
  if (!userDataDirectory) return
  await cleanupTestDirectory(userDataDirectory)
  userDataDirectory = ''
})

describe('Windows plugin storage DACL privacy', () => {
  it('records bounded cleanup phases and entry ordinals', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-plugin-cleanup-'))
    const progressPath = `${directory}.progress.jsonl`
    const previousProgressPath = process.env.PR977_PROGRESS_PATH
    const nested = path.join(directory, 'nested')
    await fs.mkdir(nested)
    await fs.writeFile(path.join(directory, 'fixture.txt'), 'owned fixture')
    await fs.writeFile(path.join(nested, 'nested-fixture.txt'), 'owned nested fixture')
    cleanupEvents.length = 0

    try {
      process.env.PR977_PROGRESS_PATH = progressPath
      await cleanupTestDirectory(directory)

      expect(cleanupEvents[0]?.phase).toBe('cleanup-start')
      expect(cleanupEvents.filter(event => event.phase === 'enumeration-start')).toHaveLength(2)
      expect(cleanupEvents.filter(event => event.phase === 'enumeration-complete')).toHaveLength(2)
      expect(cleanupEvents.filter(event => event.phase === 'entry-file-delete-start')).toHaveLength(
        2
      )
      expect(
        cleanupEvents.filter(event => event.phase === 'entry-directory-delete-start')
      ).toHaveLength(1)
      expect(cleanupEvents.filter(event => event.phase === 'entry-delete-complete')).toHaveLength(3)
      expect(
        cleanupEvents
          .filter(event => event.phase.endsWith('-delete-start'))
          .map(event => event.ordinal)
          .sort((left, right) => left - right)
      ).toEqual([1, 2, 3])
      expect(cleanupEvents.at(-2)?.phase).toBe('directory-remove-complete')
      expect(cleanupEvents.at(-1)?.phase).toBe('cleanup-complete')
      for (const event of cleanupEvents) {
        expect(event.elapsedMs).toBeGreaterThanOrEqual(0)
        expect(event.elapsedMs).toBeLessThanOrEqual(60_000)
        expect(JSON.stringify(event)).not.toContain(directory)
      }
      const progress = (await fs.readFile(progressPath, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      expect(progress.map(event => event.cleanupPhase)).toContain('cleanup-start')
      expect(progress.map(event => event.cleanupPhase)).toContain('cleanup-complete')
      expect(
        progress.every(event => event.cleanupElapsedMs >= 0 && event.cleanupElapsedMs <= 60_000)
      ).toBe(true)
      expect(JSON.stringify(progress)).not.toContain(directory)
    } finally {
      if (previousProgressPath === undefined) delete process.env.PR977_PROGRESS_PATH
      else process.env.PR977_PROGRESS_PATH = previousProgressPath
      await fs.rm(progressPath, { force: true })
    }
    expect(await fs.lstat(directory).catch(() => null)).toBeNull()
  })

  it('reports an allowlisted cleanup error and leaves teardown fatal', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-plugin-cleanup-error-'))
    cleanupEvents.length = 0
    const operations: CleanupOperations = {
      enumerate: async target => fs.readdir(target, { withFileTypes: true }),
      deleteEntry: async (entryPath, isDirectory) =>
        isDirectory ? fs.rmdir(entryPath) : fs.rm(entryPath),
      removeDirectory: async () => {
        throw Object.assign(new Error('fixture cleanup failed'), { code: 'EACCES' })
      },
    }

    try {
      await expect(cleanupTestDirectory(directory, operations)).rejects.toMatchObject({
        code: 'EACCES',
      })
      expect(cleanupEvents.at(-1)).toMatchObject({
        phase: 'cleanup-failed',
        ordinal: 0,
        errorCode: 'EACCES',
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

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
      await expectUnauthorizedPrincipalRejection(reopened.get(grant()))
      await expectUnauthorizedPrincipalRejection(reopened.put(grant({ capability: 'org.read' })))
      expect(await fs.readFile(file)).toEqual(before)
    }
  )

  windowsIt('rejects an unsafe user-data parent before creating consent files', async () => {
    const directory = path.join(userDataDirectory, 'plugin-consent')
    await addAuthenticatedUsersAccess(userDataDirectory, true)

    await expectUnauthorizedPrincipalRejection(new LocalConsentStore(directory).put(grant()))
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

    await expectUnauthorizedPrincipalRejection(store.get(grant()))
  })

  windowsIt('rejects an in-place DACL change without a filesystem identity change', async () => {
    const directory = path.join(userDataDirectory, 'plugin-consent')
    const file = path.join(directory, `${ENV_KEY}.json`)
    const store = new LocalConsentStore(directory)
    await store.put(grant())
    expect(await store.get(grant())).not.toBeNull()
    const before = await fs.lstat(file, { bigint: true })
    const originalBytes = await fs.readFile(file)

    await addAuthenticatedUsersAccess(file)

    const after = await fs.lstat(file, { bigint: true })
    expect(after.dev).toBe(before.dev)
    expect(after.ino).toBe(before.ino)
    await expectUnauthorizedPrincipalRejection(store.get(grant()))
    await expectUnauthorizedPrincipalRejection(store.put(grant({ capability: 'org.read' })))
    expect(await fs.readFile(file)).toEqual(originalBytes)
  })

  windowsIt('rejects consent when the produced atomic replacement becomes unsafe', async () => {
    const directory = path.join(userDataDirectory, 'plugin-consent')
    const file = path.join(directory, `${ENV_KEY}.json`)
    const originalRename = fs.rename.bind(fs)
    const renameCalls: { source: string; destination: string }[] = []
    let temporaryFileExistedAtRename = false
    let destinationMutationCompleted = false
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      const sourcePath = String(source)
      const destinationPath = String(destination)
      renameCalls.push({ source: sourcePath, destination: destinationPath })
      if (sourcePath.includes('.tmp-')) {
        await fs.lstat(sourcePath)
        temporaryFileExistedAtRename = true
      }
      await originalRename(source, destination)
      if (sourcePath.includes('.tmp-')) {
        await addAuthenticatedUsersAccess(destinationPath)
        destinationMutationCompleted = true
      }
    })

    try {
      await expectUnauthorizedPrincipalRejection(new LocalConsentStore(directory).put(grant()))
    } finally {
      renameSpy.mockRestore()
    }

    expect(renameCalls).toHaveLength(1)
    expect(renameCalls[0]?.source).toContain('.tmp-')
    expect(renameCalls[0]?.destination).toBe(file)
    expect(temporaryFileExistedAtRename).toBe(true)
    expect(destinationMutationCompleted).toBe(true)
    expect((await fs.lstat(file)).isFile()).toBe(true)
    await expectUnauthorizedPrincipalRejection(new LocalConsentStore(directory).get(grant()))
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

    await expectUnauthorizedPrincipalRejection(store.get(grant()))
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
    let currentTime = Date.now()
    const log = new PluginAuditLog(directory, () => currentTime)

    // Keep native inspection to two appends while exercising the same rename path as size rotation.
    await log.append(ENV_KEY, auditEntry())
    currentTime = (await fs.stat(file)).birthtimeMs + AUDIT_MAX_AGE_MS + 1
    await log.append(ENV_KEY, auditEntry({ capability: 'org.read' }))

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
    expect(JSON.parse(await fs.readFile(rotated, 'utf8'))).toMatchObject({
      capability: 'identity.read',
    })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({
      capability: 'org.read',
    })
    expect(await log.read(ENV_KEY, { limit: 1 })).toMatchObject([{ capability: 'org.read' }])
  })

  windowsIt(
    'does not append after rotated audit verification rejects the destination',
    async () => {
      const directory = path.join(userDataDirectory, 'plugin-audit')
      const file = path.join(directory, `${ENV_KEY}.jsonl`)
      const rotated = `${file}.1`
      const log = new PluginAuditLog(directory, () => Date.now() + 91 * 24 * 60 * 60 * 1000)
      const originalRename = fs.rename.bind(fs)
      await log.append(ENV_KEY, auditEntry())
      const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
        await originalRename(source, destination)
        if (String(destination) === rotated) await addAuthenticatedUsersAccess(String(destination))
      })
      const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      try {
        await log.append(ENV_KEY, auditEntry())
      } finally {
        renameSpy.mockRestore()
        warningSpy.mockRestore()
      }

      expect(await fs.readFile(rotated, 'utf8')).toContain('identity.read')
      await expectUnauthorizedPrincipalRejection(
        evidence({ path: rotated, directory: false, requireInherited: true })
      )
      await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await new PluginAuditLog(directory).read(ENV_KEY)).toEqual([])
    }
  )

  windowsIt('does not append to an audit file with unauthorized effective access', async () => {
    const directory = path.join(userDataDirectory, 'plugin-audit')
    const file = path.join(directory, `${ENV_KEY}.jsonl`)
    const log = new PluginAuditLog(directory)
    await log.append(ENV_KEY, auditEntry())
    const before = await fs.readFile(file)
    await addAuthenticatedUsersAccess(file)

    const reopened = new PluginAuditLog(directory)
    const originalVerifyFile = PluginStoragePrivacyGuard.prototype.verifyFile
    const verificationFailures: unknown[] = []
    const verifyFileSpy = vi
      .spyOn(PluginStoragePrivacyGuard.prototype, 'verifyFile')
      .mockImplementation(async function (this: PluginStoragePrivacyGuard, target) {
        try {
          return await originalVerifyFile.call(this, target)
        } catch (error) {
          if (target === file) verificationFailures.push(error)
          throw error
        }
      })
    try {
      await reopened.append(ENV_KEY, auditEntry({ capability: 'org.read' }))
    } finally {
      verifyFileSpy.mockRestore()
    }
    expect(verificationFailures).toHaveLength(1)
    expect(verificationFailures[0]).toBeInstanceOf(PluginStoragePrivacyError)
    expect(verificationFailures[0]).toMatchObject({
      reason: 'native-verifier-rejected',
      diagnostic: {
        failure: 'verifier-rejected',
        nativePhase: 'inspect-complete',
        nativeReason: 'unauthorized-principal-access',
      },
    })
    expect(await fs.readFile(file)).toEqual(before)
    expect(await reopened.read(ENV_KEY)).toEqual([])
  })
})
