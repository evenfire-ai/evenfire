import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PluginStoragePrivacyError,
  inspectWindowsPluginStoragePaths,
  validateWindowsPluginStorageEvidence,
} from '../pluginStorageWindowsAcl.js'

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.unstubAllEnvs()
  spawnSyncMock.mockReset()
})

function prepareWindowsInspection(): void {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  vi.stubEnv('TEMP', 'C:\\fixture')
}

describe('Windows plugin storage native evidence contract', () => {
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
      stderr: 'C:\\private\\raw output',
    })

    try {
      inspectWindowsPluginStoragePaths([
        { path: 'C:\\fixture\\directory', directory: true, requireInherited: false },
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
          elapsedMs: expect.any(Number),
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
      stderr: 'raw PowerShell output',
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
        nativePhase: 'inspect-object',
        nativeErrorType: 'UnauthorizedAccessException',
        hresult: '0x80070005',
        nativeOperation: 'get-security-info',
        win32Error: 5,
        nativeReason: 'unauthorized-principal-access',
      }),
    })
    expect(spawnSyncMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'missing',
      { error: undefined, signal: null, status: 0, stdout: '', stderr: '' },
      'native-inspection-response-missing',
    ],
    [
      'malformed',
      { error: undefined, signal: null, status: 0, stdout: 'not-json', stderr: '' },
      'native-inspection-response-malformed',
    ],
    [
      'unstructured exit',
      { error: undefined, signal: null, status: 2, stdout: '{"detail":"private"}', stderr: '' },
      'native-inspection-process-exit-failed',
    ],
  ])('fails closed on %s native response', (_label, result, reason) => {
    prepareWindowsInspection()
    spawnSyncMock.mockReturnValue(result)

    try {
      inspectWindowsPluginStoragePaths([
        { path: 'C:\\fixture\\file', directory: false, requireInherited: true },
      ])
      throw new Error('Expected native inspection to fail closed')
    } catch (error) {
      expect(error).toBeInstanceOf(PluginStoragePrivacyError)
      expect(error).toMatchObject({ reason })
      expect(JSON.stringify(error)).not.toMatch(/private|detail/)
    }
  })
})
