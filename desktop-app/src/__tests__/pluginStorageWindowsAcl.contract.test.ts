import { afterEach, describe, expect, it, vi } from 'vitest'
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
const inspectedPaths: string[] = []

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.unstubAllEnvs()
  rejectedInspectionPath = undefined
  inspectedPaths.length = 0
  spawnSyncMock.mockReset()
})

function prepareWindowsInspection(): void {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  vi.stubEnv('TEMP', 'C:\\fixture')
}

function mockFreshNativeInspection(): void {
  spawnSyncMock.mockImplementation((_executable, _args, options) => {
    const env = (options as { env: NodeJS.ProcessEnv }).env
    const request = JSON.parse(
      Buffer.from(env.EVENFIRE_PLUGIN_STORAGE_ACL_REQUEST!, 'base64').toString('utf8')
    ) as { items: { path: string; directory: boolean }[] }
    inspectedPaths.push(...request.items.map(item => item.path))
    if (request.items.some(item => item.path === rejectedInspectionPath)) {
      return {
        error: undefined,
        signal: null,
        status: 2,
        stdout: JSON.stringify({ ok: false, phase: 'inspect-object', reason: 'inspection-failed' }),
        stderr: '',
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

function auditEntry() {
  return {
    ts: '2026-10-30T00:00:00.000Z',
    userId: 'contract-user',
    pluginId: 'fixture/plugin',
    capability: 'identity.read',
    outcome: 'allowed' as const,
  }
}

describe('Windows plugin storage native evidence contract', () => {
  it('reinspects a consent file when its identity is unchanged', async () => {
    prepareWindowsInspection()
    mockFreshNativeInspection()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-acl-freshness-'))
    const directory = path.join(root, 'consent')
    const file = path.join(directory, 'testenv-0123456789ab.json')
    const store = new LocalConsentStore(directory)
    try {
      await store.put(consentGrant())
      await store.get(consentGrant())
      const before = await fs.lstat(file, { bigint: true })
      rejectedInspectionPath = file

      await expect(store.get(consentGrant())).rejects.toThrow('privacy could not be verified')

      const after = await fs.lstat(file, { bigint: true })
      expect(after.dev).toBe(before.dev)
      expect(after.ino).toBe(before.ino)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
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
    prepareWindowsInspection()
    mockFreshNativeInspection()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-acl-consent-failure-'))
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
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('verifies the produced consent destination after atomic replacement', async () => {
    prepareWindowsInspection()
    mockFreshNativeInspection()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-acl-consent-rename-'))
    const directory = path.join(root, 'consent')
    const file = path.join(directory, 'testenv-0123456789ab.json')
    const originalRename = fs.rename.bind(fs)
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      await originalRename(source, destination)
      if (String(source).includes('.tmp-')) rejectedInspectionPath = String(destination)
    })
    try {
      await expect(new LocalConsentStore(directory).put(consentGrant())).rejects.toThrow(
        'privacy could not be verified'
      )
      expect(await fs.readFile(file, 'utf8')).toContain('identity.read')
      expect(spawnSyncMock).toHaveBeenCalledTimes(4)
      expect(inspectedPaths.at(-1)).toBe(file)
    } finally {
      renameSpy.mockRestore()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('verifies the produced consent corruption quarantine before accepting recovery', async () => {
    prepareWindowsInspection()
    mockFreshNativeInspection()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-acl-consent-quarantine-'))
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

      await expect(new LocalConsentStore(directory).get(consentGrant())).rejects.toThrow(
        'privacy could not be verified'
      )

      const names = await fs.readdir(directory)
      expect(names).toHaveLength(1)
      expect(names[0]).toMatch(/\.corrupt-/)
      expect(await fs.readFile(path.join(directory, names[0]!), 'utf8')).toBe('{')
    } finally {
      renameSpy.mockRestore()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('verifies the rotated audit destination before appending again', async () => {
    prepareWindowsInspection()
    mockFreshNativeInspection()
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-acl-audit-rename-'))
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
      await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await log.read('testenv-0123456789ab')).toEqual([])
    } finally {
      renameSpy.mockRestore()
      warningSpy.mockRestore()
      await fs.rm(root, { recursive: true, force: true })
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
