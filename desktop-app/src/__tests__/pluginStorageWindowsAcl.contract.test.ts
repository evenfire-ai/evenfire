import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { promises as fs, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PluginAuditLog } from '../pluginAuditLog.js'
import { LocalConsentStore } from '../pluginConsentStore.js'
import {
  type PluginStorageNativeDiagnostic,
  PluginStoragePrivacyError,
  inspectWindowsPluginStoragePaths,
  validateWindowsPluginStorageEvidence,
} from '../pluginStorageWindowsAcl.js'

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
let rejectedInspectionPath: string | undefined
let rejectedInspectionCount = 0
const inspectedPaths: string[] = []

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.unstubAllEnvs()
  rejectedInspectionPath = undefined
  rejectedInspectionCount = 0
  inspectedPaths.length = 0
  spawnSyncMock.mockReset()
})

interface WindowsFixtureRoots {
  hostRoot: string
  simulatedTempRoot: string
  sentinelPath: string
  sentinelBytes: Buffer
  allocationPlatform: NodeJS.Platform
}

async function createWindowsFixtureRoots(prefix: string): Promise<WindowsFixtureRoots> {
  const allocationPlatform = process.platform
  const hostRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-host-`))
  let simulatedTempRoot: string | undefined
  try {
    simulatedTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-simulated-`))
    const sentinelPath = path.join(simulatedTempRoot, 'independent-owner-sentinel')
    const sentinelBytes = Buffer.from('owned by the simulated TEMP fixture')
    await fs.writeFile(sentinelPath, sentinelBytes, { flag: 'wx' })
    return { hostRoot, simulatedTempRoot, sentinelPath, sentinelBytes, allocationPlatform }
  } catch (error) {
    await fs.rm(hostRoot, { recursive: true, force: true })
    if (simulatedTempRoot) await fs.rm(simulatedTempRoot, { recursive: true, force: true })
    throw error
  }
}

async function cleanupWindowsFixtureRoots(roots: WindowsFixtureRoots): Promise<void> {
  try {
    await fs.rm(roots.hostRoot, { recursive: true, force: true })
    const sentinelAfterCleanup = await fs.readFile(roots.sentinelPath).catch(() => null)
    expect(sentinelAfterCleanup).toEqual(roots.sentinelBytes)
  } finally {
    await fs.rm(roots.hostRoot, { recursive: true, force: true })
    await fs.rm(roots.simulatedTempRoot, { recursive: true, force: true })
  }
}

function prepareWindowsInspection(tempRoot = 'C:\\fixture'): void {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  vi.stubEnv('TEMP', tempRoot)
}

function mockFreshNativeInspection(): void {
  spawnSyncMock.mockImplementation((_executable, _args, options) => {
    const env = (options as { env: NodeJS.ProcessEnv }).env
    const request = JSON.parse(
      Buffer.from(env.EVENFIRE_PLUGIN_STORAGE_ACL_REQUEST!, 'base64').toString('utf8')
    ) as { items: { path: string; directory: boolean }[] }
    inspectedPaths.push(...request.items.map(item => item.path))
    if (request.items.some(item => item.path === rejectedInspectionPath)) {
      rejectedInspectionCount += 1
      return {
        error: undefined,
        signal: null,
        status: 2,
        stdout: JSON.stringify({
          ok: false,
          phase: 'inspect-object',
          reason: 'unauthorized-principal-access',
        }),
        stderr: 'EVENFIRE_PLUGIN_ACL_PHASE=inspect-complete;ordinal=1;elapsedMs=1\r\n',
      }
    }
    const items = request.items.map(item => {
      const stats = statSync(item.path, { bigint: true })
      return {
        ok: true,
        identity: `${stats.dev.toString(16).toUpperCase().padStart(8, '0')}:${stats.ino
          .toString(16)
          .toUpperCase()
          .padStart(16, '0')}`,
        directory: item.directory,
        effectiveRead: true,
        effectiveWrite: true,
        inheritedUserAccess: true,
        allowedPrincipalsOnly: true,
      }
    })
    return {
      error: undefined,
      signal: null,
      status: 0,
      stdout: JSON.stringify({ ok: true, items }),
      stderr: '',
    }
  })
}

function consentGrant() {
  return {
    envKey: 'testenv-0123456789ab',
    userId: 'contract-user',
    pluginId: 'fixture/plugin',
    capability: 'identity.read',
    grantedAt: '2026-10-30T00:00:00.000Z',
    lastUsedAt: null,
    descriptorVersion: 1,
    revision: 0,
  }
}

type ConsentRevisionModel = { revision: number }
type ConsentStoreHarness = {
  store: LocalConsentStore
  scheduler: fc.Scheduler
  pendingWrites: Promise<void>[]
  scheduledReads: Promise<ReturnType<typeof consentGrant> | null>[]
  nextOperation: number
}

class PutAndReadConsentCommand implements fc.AsyncCommand<
  ConsentRevisionModel,
  ConsentStoreHarness
> {
  check(): boolean {
    return true
  }

  run(model: ConsentRevisionModel, harness: ConsentStoreHarness): void {
    const operation = harness.nextOperation++
    const expectedRevision = model.revision + 1
    harness.pendingWrites.push(
      harness.scheduler.schedule(
        harness.store.put(consentGrant()),
        `consent put ${expectedRevision}`
      )
    )
    harness.scheduledReads.push(
      harness.scheduler.schedule(
        harness.store.get(consentGrant()),
        `consent read during operation ${operation}`
      )
    )
    model.revision = expectedRevision
  }

  toString(): string {
    return 'PutAndReadConsentCommand'
  }
}

function auditEntry() {
  return {
    ts: '2026-10-30T00:00:00.000Z',
    userId: 'contract-user',
    pluginId: 'fixture/plugin',
    capability: 'identity.read',
    outcome: 'allowed' as const,
  }
}

function isUnauthorizedPrincipalRejection(error: unknown): boolean {
  return (
    error instanceof PluginStoragePrivacyError &&
    error.reason === 'native-verifier-rejected' &&
    error.diagnostic?.nativePhase === 'inspect-complete' &&
    error.diagnostic.nativeReason === 'unauthorized-principal-access'
  )
}

describe('Windows plugin storage native evidence contract', () => {
  it('keeps real producer files under the host-owned root, not simulated TEMP', async () => {
    const roots = await createWindowsFixtureRoots('plugin-acl-root-ownership')
    prepareWindowsInspection(roots.simulatedTempRoot)
    mockFreshNativeInspection()
    const directory = path.join(roots.hostRoot, 'consent')
    const store = new LocalConsentStore(directory)
    try {
      await store.put(consentGrant())
      await expect(store.get(consentGrant())).resolves.toMatchObject({
        ...consentGrant(),
        revision: 1,
      })

      expect(inspectedPaths.length).toBeGreaterThan(0)
      expect(roots.allocationPlatform).toBe(platformDescriptor.value)
      expect(
        inspectedPaths.every(
          item => item === roots.hostRoot || item.startsWith(`${roots.hostRoot}${path.sep}`)
        )
      ).toBe(true)
      expect(
        inspectedPaths.some(item => item.startsWith(`${roots.simulatedTempRoot}${path.sep}`))
      ).toBe(false)
      expect(await fs.readFile(roots.sentinelPath)).toEqual(roots.sentinelBytes)
    } finally {
      await cleanupWindowsFixtureRoots(roots)
    }
  })

  it('matches a small independent model across scheduled real consent operations', async () => {
    const roots = await createWindowsFixtureRoots('plugin-acl-a6-model')
    prepareWindowsInspection(roots.simulatedTempRoot)
    mockFreshNativeInspection()
    const directory = path.join(roots.hostRoot, 'consent')
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.scheduler(),
          fc.commands([fc.constant(new PutAndReadConsentCommand())], {
            maxCommands: 10,
            size: '+1',
          }),
          async (scheduler, generatedCommands) => {
            await fs.rm(directory, { recursive: true, force: true })
            inspectedPaths.length = 0
            spawnSyncMock.mockClear()
            const model = { revision: 0 }
            const store = new LocalConsentStore(directory)
            const harness: ConsentStoreHarness = {
              store,
              scheduler,
              pendingWrites: [],
              scheduledReads: [],
              nextOperation: 0,
            }
            const commands = [new PutAndReadConsentCommand(), ...generatedCommands]
            await fc.asyncModelRun(() => ({ model, real: harness }), commands)
            await scheduler.waitAll()
            await Promise.all(harness.pendingWrites)

            expect(harness.scheduledReads).toHaveLength(model.revision)
            for (const read of harness.scheduledReads) {
              const observed = await read
              const observedRevision = observed?.revision ?? 0
              expect(observedRevision).toBeGreaterThanOrEqual(0)
              expect(observedRevision).toBeLessThanOrEqual(model.revision)
            }
            await expect(store.get(consentGrant())).resolves.toMatchObject({
              ...consentGrant(),
              revision: model.revision,
            })
            expect(inspectedPaths.length).toBeGreaterThan(0)
            expect(
              inspectedPaths.every(
                item => item === roots.hostRoot || item.startsWith(`${roots.hostRoot}${path.sep}`)
              )
            ).toBe(true)
            expect(await fs.readFile(roots.sentinelPath)).toEqual(roots.sentinelBytes)
          }
        ),
        { numRuns: 10 }
      )
    } finally {
      await cleanupWindowsFixtureRoots(roots)
    }
  })

  it('reinspects a consent file when its identity is unchanged', async () => {
    const roots = await createWindowsFixtureRoots('plugin-acl-freshness')
    prepareWindowsInspection(roots.simulatedTempRoot)
    mockFreshNativeInspection()
    const root = roots.hostRoot
    const directory = path.join(root, 'consent')
    const file = path.join(directory, 'testenv-0123456789ab.json')
    const store = new LocalConsentStore(directory)
    try {
      await store.put(consentGrant())
      await store.get(consentGrant())
      const before = await fs.lstat(file, { bigint: true })
      rejectedInspectionPath = file

      const rejection = await store.get(consentGrant()).then(
        () => undefined,
        error => error
      )
      expect(isUnauthorizedPrincipalRejection(rejection)).toBe(true)

      const after = await fs.lstat(file, { bigint: true })
      expect(after.dev).toBe(before.dev)
      expect(after.ino).toBe(before.ino)
    } finally {
      await cleanupWindowsFixtureRoots(roots)
    }
  })

  it.each([
    ['missing', { error: undefined, signal: null, status: 0, stdout: '', stderr: '' }],
    ['malformed', { error: undefined, signal: null, status: 0, stdout: 'not-json', stderr: '' }],
    [
      'rejected',
      {
        error: undefined,
        signal: null,
        status: 2,
        stdout: JSON.stringify({ ok: false, phase: 'inspect-object' }),
        stderr: '',
      },
    ],
    [
      'timed-out',
      {
        error: Object.assign(new Error('spawnSync timed out'), { code: 'ETIMEDOUT' }),
        signal: 'SIGTERM',
        status: null,
        stdout: '',
        stderr: 'EVENFIRE_PLUGIN_ACL_PHASE=inspect-start;ordinal=1;elapsedMs=14990\r\n',
      },
    ],
  ])('%s native evidence cannot authorize a cached consent read', async (_kind, failure) => {
    const roots = await createWindowsFixtureRoots('plugin-acl-consent-failure')
    prepareWindowsInspection(roots.simulatedTempRoot)
    mockFreshNativeInspection()
    const root = roots.hostRoot
    const directory = path.join(root, 'consent')
    const file = path.join(directory, 'testenv-0123456789ab.json')
    const store = new LocalConsentStore(directory)
    try {
      await store.put(consentGrant())
      const originalBytes = await fs.readFile(file)
      spawnSyncMock.mockReturnValueOnce(failure)

      await expect(store.get(consentGrant())).rejects.toThrow('privacy could not be verified')
      expect(await fs.readFile(file)).toEqual(originalBytes)
    } finally {
      await cleanupWindowsFixtureRoots(roots)
    }
  })

  it('verifies the produced consent destination after atomic replacement', async () => {
    const roots = await createWindowsFixtureRoots('plugin-acl-consent-rename')
    prepareWindowsInspection(roots.simulatedTempRoot)
    mockFreshNativeInspection()
    const root = roots.hostRoot
    const directory = path.join(root, 'consent')
    const file = path.join(directory, 'testenv-0123456789ab.json')
    const originalRename = fs.rename.bind(fs)
    const renameCalls: { source: string; destination: string }[] = []
    let temporaryFileExistedAtRename = false
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      const sourcePath = String(source)
      const destinationPath = String(destination)
      renameCalls.push({ source: sourcePath, destination: destinationPath })
      if (sourcePath.includes('.tmp-')) {
        await fs.lstat(sourcePath)
        temporaryFileExistedAtRename = true
      }
      await originalRename(source, destination)
      if (sourcePath.includes('.tmp-')) rejectedInspectionPath = destinationPath
    })
    try {
      const rejection = await new LocalConsentStore(directory).put(consentGrant()).then(
        () => undefined,
        error => error
      )
      expect(isUnauthorizedPrincipalRejection(rejection)).toBe(true)
      expect(renameCalls).toHaveLength(1)
      expect(renameCalls[0]?.source).toContain('.tmp-')
      expect(renameCalls[0]?.destination).toBe(file)
      expect(temporaryFileExistedAtRename).toBe(true)
      expect((await fs.lstat(file)).isFile()).toBe(true)
      expect(inspectedPaths.at(-1)).toBe(file)
      expect(await fs.readFile(file, 'utf8')).toContain('identity.read')
      expect(spawnSyncMock).toHaveBeenCalledTimes(4)
    } finally {
      renameSpy.mockRestore()
      await cleanupWindowsFixtureRoots(roots)
    }
  })

  it('distinguishes a pre-rename helper timeout from a produced destination DACL denial', async () => {
    const roots = await createWindowsFixtureRoots('plugin-acl-pre-rename-timeout')
    prepareWindowsInspection(roots.simulatedTempRoot)
    const timeout = Object.assign(new Error('spawnSync timed out'), { code: 'ETIMEDOUT' })
    spawnSyncMock.mockReturnValue({
      error: timeout,
      signal: 'SIGTERM',
      status: null,
      stdout: '',
      stderr: 'EVENFIRE_PLUGIN_ACL_PHASE=helper-load-start;ordinal=0;elapsedMs=14990\r\n',
    })
    const root = roots.hostRoot
    const directory = path.join(root, 'consent')
    const renameSpy = vi.spyOn(fs, 'rename')
    try {
      const rejection = await new LocalConsentStore(directory).put(consentGrant()).then(
        () => undefined,
        error => error
      )

      // The pre-correction generic message matched this exact producer failure.
      expect(rejection).toMatchObject({
        message: 'Plugin storage privacy could not be verified',
        reason: 'native-inspection-process-timeout',
        diagnostic: {
          failure: 'process-timeout',
          processErrorCode: 'ETIMEDOUT',
          signal: 'SIGTERM',
          nativePhase: 'helper-load-start',
        },
      })
      expect(isUnauthorizedPrincipalRejection(rejection)).toBe(false)
      expect(renameSpy).not.toHaveBeenCalled()
    } finally {
      renameSpy.mockRestore()
      await cleanupWindowsFixtureRoots(roots)
    }
  })

  it('verifies the produced consent corruption quarantine before accepting recovery', async () => {
    const roots = await createWindowsFixtureRoots('plugin-acl-consent-quarantine')
    prepareWindowsInspection(roots.simulatedTempRoot)
    mockFreshNativeInspection()
    const root = roots.hostRoot
    const directory = path.join(root, 'consent')
    const file = path.join(directory, 'testenv-0123456789ab.json')
    const store = new LocalConsentStore(directory)
    const originalRename = fs.rename.bind(fs)
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      await originalRename(source, destination)
      if (String(destination).includes('.corrupt-')) rejectedInspectionPath = String(destination)
    })
    try {
      await store.put(consentGrant())
      await fs.writeFile(file, '{')

      const rejection = await new LocalConsentStore(directory).get(consentGrant()).then(
        () => undefined,
        error => error
      )
      expect(isUnauthorizedPrincipalRejection(rejection)).toBe(true)

      const names = await fs.readdir(directory)
      expect(names).toHaveLength(1)
      expect(names[0]).toMatch(/\.corrupt-/)
      expect(await fs.readFile(path.join(directory, names[0]!), 'utf8')).toBe('{')
    } finally {
      renameSpy.mockRestore()
      await cleanupWindowsFixtureRoots(roots)
    }
  })

  it('verifies the rotated audit destination before appending again', async () => {
    const roots = await createWindowsFixtureRoots('plugin-acl-audit-rename')
    prepareWindowsInspection(roots.simulatedTempRoot)
    mockFreshNativeInspection()
    const root = roots.hostRoot
    const directory = path.join(root, 'audit')
    const file = path.join(directory, 'testenv-0123456789ab.jsonl')
    const rotated = `${file}.1`
    const log = new PluginAuditLog(directory, () => Date.now() + 91 * 24 * 60 * 60 * 1000)
    const originalRename = fs.rename.bind(fs)
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      await originalRename(source, destination)
      if (String(destination) === rotated) rejectedInspectionPath = String(destination)
    })
    const warningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await log.append('testenv-0123456789ab', auditEntry())
      await log.append('testenv-0123456789ab', auditEntry())

      expect(await fs.readFile(rotated, 'utf8')).toContain('identity.read')
      expect(rejectedInspectionCount).toBe(1)
      expect(inspectedPaths).toContain(rotated)
      await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await log.read('testenv-0123456789ab')).toEqual([])
    } finally {
      renameSpy.mockRestore()
      warningSpy.mockRestore()
      await cleanupWindowsFixtureRoots(roots)
    }
  })

  it('keeps the exported native error type union aligned with the runtime allowlist', () => {
    const errorTypes: NonNullable<PluginStorageNativeDiagnostic['nativeErrorType']>[] = [
      'ArgumentException',
      'FileNotFoundException',
      'FormatException',
      'IOException',
      'InvalidDataException',
      'InvalidOperationException',
      'PlatformNotSupportedException',
      'ReflectionTypeLoadException',
      'RuntimeException',
      'SecurityException',
      'TypeLoadException',
      'TypeInitializationException',
      'UnauthorizedAccessException',
      'Win32Exception',
    ]

    expect(errorTypes).toHaveLength(14)
  })

  it('keeps the exported native reason type limited to fixed inspector outcomes', () => {
    const nativeReasons: NonNullable<PluginStorageNativeDiagnostic['nativeReason']>[] = [
      'current-user-access-insufficient',
      'inspection-failed',
      'native-helper-path-missing',
      'object-identity-or-owner-invalid',
      'request-missing',
      'unauthorized-principal-access',
      'unsupported-ace',
      'user-access-not-inherited',
    ]

    expect(nativeReasons).toHaveLength(8)
  })

  it('accepts only complete affirmative native evidence', () => {
    expect(
      validateWindowsPluginStorageEvidence({
        ok: true,
        items: [
          {
            ok: true,
            identity: '00000001:0000000000000002',
            directory: false,
            effectiveRead: true,
            effectiveWrite: true,
            inheritedUserAccess: true,
            allowedPrincipalsOnly: true,
          },
        ],
      }).items
    ).toHaveLength(1)
  })

  it.each([
    ['unavailable result', { ok: false, phase: 'inspect-object' }],
    ['missing result', null],
    ['missing item', { ok: true, items: [{ ok: true }] }],
    [
      'negative effective access',
      {
        ok: true,
        items: [
          {
            ok: true,
            identity: '00000001:0000000000000002',
            directory: false,
            effectiveRead: false,
            effectiveWrite: true,
            inheritedUserAccess: true,
            allowedPrincipalsOnly: true,
          },
        ],
      },
    ],
  ])('rejects %s evidence without downgrading it', (_label, value) => {
    expect(() => validateWindowsPluginStorageEvidence(value)).toThrow(PluginStoragePrivacyError)
  })

  it('classifies a native process timeout without treating it as safe evidence', () => {
    prepareWindowsInspection()
    const timeout = Object.assign(new Error('spawnSync timed out'), { code: 'ETIMEDOUT' })
    spawnSyncMock.mockReturnValue({
      error: timeout,
      signal: 'SIGTERM',
      status: null,
      stdout: '',
      stderr:
        'C:\\private\\raw output\n' +
        'EVENFIRE_PLUGIN_ACL_PHASE=child-start;ordinal=0;elapsedMs=0\r\n' +
        'EVENFIRE_PLUGIN_ACL_PHASE=inspect-start;ordinal=2;elapsedMs=14990\r\n',
    })

    try {
      inspectWindowsPluginStoragePaths([
        { path: 'C:\\fixture\\directory', directory: true, requireInherited: false },
        { path: 'C:\\fixture\\file', directory: false, requireInherited: true },
      ])
      throw new Error('Expected native inspection to fail closed')
    } catch (error) {
      expect(error).toBeInstanceOf(PluginStoragePrivacyError)
      expect(error).toMatchObject({
        reason: 'native-inspection-process-timeout',
        diagnostic: {
          failure: 'process-timeout',
          processErrorCode: 'ETIMEDOUT',
          exitStatus: null,
          signal: 'SIGTERM',
          nativePhase: 'inspect-start',
          nativeOrdinal: 2,
          elapsedMs: 14990,
        },
      })
      expect(JSON.stringify(error)).not.toMatch(/private|raw output|fixture/)
    }
  })

  it('preserves sanitized native rejection details from a nonzero process exit', () => {
    prepareWindowsInspection()
    spawnSyncMock.mockReturnValue({
      error: undefined,
      signal: null,
      status: 2,
      stdout: JSON.stringify({
        ok: false,
        phase: 'inspect-object',
        errorType: 'UnauthorizedAccessException',
        hresult: '0x80070005',
        nativeOperation: 'get-security-info',
        win32Error: 5,
        reason: 'unauthorized-principal-access',
        path: 'C:\\private\\secret.txt',
      }),
      stderr:
        'raw PowerShell output at C:\\private\\file\n' +
        'EVENFIRE_PLUGIN_ACL_PHASE=inspect-start;ordinal=1;elapsedMs=37\n' +
        'secret-shaped text should be ignored',
    })

    let inspectionError: unknown
    try {
      inspectWindowsPluginStoragePaths([
        { path: 'C:\\fixture\\file', directory: false, requireInherited: true },
      ])
    } catch (error) {
      inspectionError = error
    }
    expect(inspectionError).toBeInstanceOf(PluginStoragePrivacyError)
    expect(inspectionError).toMatchObject({
      reason: 'native-verifier-rejected',
      diagnostic: expect.objectContaining({
        failure: 'verifier-rejected',
        exitStatus: 2,
        nativeErrorType: 'UnauthorizedAccessException',
        hresult: '0x80070005',
        nativeOperation: 'get-security-info',
        win32Error: 5,
        nativeReason: 'unauthorized-principal-access',
        nativePhase: 'inspect-start',
        nativeOrdinal: 1,
        elapsedMs: 37,
      }),
    })
    expect(spawnSyncMock).toHaveBeenCalledTimes(1)
  })

  it('classifies native helper load failure separately from DACL rejection', () => {
    prepareWindowsInspection()
    spawnSyncMock.mockReturnValue({
      error: undefined,
      signal: null,
      status: 2,
      stdout: JSON.stringify({
        ok: false,
        phase: 'load-native-helper',
        errorType: 'FileNotFoundException',
        hresult: '0x80070002',
        reason: 'native-helper-path-missing',
      }),
      stderr:
        'private loader output\r\n' +
        'EVENFIRE_PLUGIN_ACL_PHASE=helper-load-start;ordinal=0;elapsedMs=11\r\n',
    })

    let inspectionError: unknown
    try {
      inspectWindowsPluginStoragePaths([
        { path: 'C:\\fixture\\file', directory: false, requireInherited: true },
      ])
    } catch (error) {
      inspectionError = error
    }
    expect(inspectionError).toBeInstanceOf(PluginStoragePrivacyError)
    expect(inspectionError).toMatchObject({
      reason: 'native-inspection-helper-load-failed',
      diagnostic: {
        failure: 'helper-load-failed',
        exitStatus: 2,
        nativePhase: 'helper-load-start',
        elapsedMs: 11,
        nativeErrorType: 'FileNotFoundException',
        hresult: '0x80070002',
        nativeReason: 'native-helper-path-missing',
      },
    })
    expect(JSON.stringify(inspectionError)).not.toMatch(/private loader output|fixture/)
  })

  it('classifies request preparation failures separately from helper loading', () => {
    prepareWindowsInspection()
    spawnSyncMock.mockReturnValue({
      error: undefined,
      signal: null,
      status: 2,
      stdout: JSON.stringify({
        ok: false,
        phase: 'prepare-request',
        errorType: 'FormatException',
        hresult: '0x80131537',
        reason: 'request-missing',
      }),
      stderr:
        'private request details\r\n' +
        'EVENFIRE_PLUGIN_ACL_PHASE=request-prepare-start;ordinal=0;elapsedMs=13\r\n',
    })

    let inspectionError: unknown
    try {
      inspectWindowsPluginStoragePaths([
        { path: 'C:\\fixture\\file', directory: false, requireInherited: true },
      ])
    } catch (error) {
      inspectionError = error
    }
    expect(inspectionError).toBeInstanceOf(PluginStoragePrivacyError)
    expect(inspectionError).toMatchObject({
      reason: 'native-inspection-request-setup-failed',
      diagnostic: {
        failure: 'request-setup-failed',
        exitStatus: 2,
        nativePhase: 'request-prepare-start',
        elapsedMs: 13,
        nativeErrorType: 'FormatException',
        hresult: '0x80131537',
        nativeReason: 'request-missing',
      },
    })
    expect(JSON.stringify(inspectionError)).not.toMatch(/private request details|fixture/)
  })

  it('treats response-generation errors as generic rejections', () => {
    prepareWindowsInspection()
    spawnSyncMock.mockReturnValue({
      error: undefined,
      signal: null,
      status: 2,
      stdout: JSON.stringify({
        ok: false,
        phase: 'verification',
        errorType: 'RuntimeException',
        reason: 'private-token-value',
      }),
      stderr: 'EVENFIRE_PLUGIN_ACL_PHASE=response-serialize-start;ordinal=0;elapsedMs=22\r\n',
    })

    let inspectionError: unknown
    try {
      inspectWindowsPluginStoragePaths([
        { path: 'C:\\fixture\\file', directory: false, requireInherited: true },
      ])
    } catch (error) {
      inspectionError = error
    }
    expect(inspectionError).toBeInstanceOf(PluginStoragePrivacyError)
    expect(inspectionError).toMatchObject({
      reason: 'native-inspection-response-rejected',
      diagnostic: {
        failure: 'response-rejected',
        nativePhase: 'response-serialize-start',
        elapsedMs: 22,
      },
    })
    expect(JSON.stringify(inspectionError)).not.toContain('private-token-value')
  })

  it('does not label an unrecognized native failure phase as a DACL rejection', () => {
    prepareWindowsInspection()
    spawnSyncMock.mockReturnValue({
      error: undefined,
      signal: null,
      status: 2,
      stdout: JSON.stringify({
        ok: false,
        phase: 'unrecognized-phase',
        errorType: 'RuntimeException',
      }),
      stderr: '',
    })

    let inspectionError: unknown
    try {
      inspectWindowsPluginStoragePaths([
        { path: 'C:\\fixture\\file', directory: false, requireInherited: true },
      ])
    } catch (error) {
      inspectionError = error
    }
    expect(inspectionError).toBeInstanceOf(PluginStoragePrivacyError)
    expect(inspectionError).toMatchObject({
      reason: 'native-inspection-response-rejected',
      diagnostic: { failure: 'response-rejected', exitStatus: 2 },
    })
  })

  it.each([
    [
      'missing',
      {
        error: undefined,
        signal: null,
        status: 0,
        stdout: '',
        stderr: 'EVENFIRE_PLUGIN_ACL_PHASE=response-serialize-start;ordinal=0;elapsedMs=31\r\n',
      },
      'native-inspection-response-missing',
      'response-serialize-start',
    ],
    [
      'malformed',
      {
        error: undefined,
        signal: null,
        status: 0,
        stdout: 'not-json',
        stderr: 'EVENFIRE_PLUGIN_ACL_PHASE=response-serialize-complete;ordinal=0;elapsedMs=32\r\n',
      },
      'native-inspection-response-malformed',
      'response-serialize-complete',
    ],
    [
      'unstructured exit',
      {
        error: undefined,
        signal: null,
        status: 2,
        stdout: '{"detail":"private"}',
        stderr: 'EVENFIRE_PLUGIN_ACL_PHASE=inspect-start;ordinal=1;elapsedMs=20\r\n',
      },
      'native-inspection-process-exit-failed',
      'inspect-start',
    ],
  ])('fails closed on %s native response', (_label, result, reason, nativePhase) => {
    prepareWindowsInspection()
    spawnSyncMock.mockReturnValue(result)

    try {
      inspectWindowsPluginStoragePaths([
        { path: 'C:\\fixture\\file', directory: false, requireInherited: true },
      ])
      throw new Error('Expected native inspection to fail closed')
    } catch (error) {
      expect(error).toBeInstanceOf(PluginStoragePrivacyError)
      expect(error).toMatchObject({ reason, diagnostic: { nativePhase } })
      expect(JSON.stringify(error)).not.toMatch(/private|detail/)
    }
  })
})
