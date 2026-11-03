import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { verifyWindowsSessionAuthorityDirectory } from '../windowsSessionAuthorityAcl.js'

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
const validEvidence = {
  userSid: 'S-1-5-21-1000',
  rootIdentity: '00000001:00000001',
  authorityIdentity: '00000001:00000002',
  objectCount: 1,
  authorityOwnerSid: 'S-1-5-21-1000',
}

function processResult(overrides: Record<string, unknown> = {}) {
  return {
    pid: 123,
    output: [],
    stdout: JSON.stringify({ ok: true, ...validEvidence }),
    stderr: '',
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  }
}

function captureError(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw new Error('Expected the Windows ACL verifier to fail')
}

function runVerifier(): ReturnType<typeof verifyWindowsSessionAuthorityDirectory> {
  return verifyWindowsSessionAuthorityDirectory('C:\\private\\data', 'C:\\private\\data\\sessions')
}

describe('Windows session authority PowerShell launcher', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      ...platformDescriptor,
      value: 'win32',
    })
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.stubEnv('TEMP', 'C:\\Users\\fixture\\Temp')
    vi.stubEnv('TMP', 'C:\\Users\\fixture\\Temp')
    vi.stubEnv('EVENFIRE_TEST_SECRET', 'must-not-be-inherited')
    spawnSyncMock.mockReturnValue(processResult())
  })

  afterEach(() => {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('loads the fixed native helper and keeps verifier data off the process command line', () => {
    expect(runVerifier()).toEqual(validEvidence)

    const [executable, args, options] = spawnSyncMock.mock.calls[0]!
    expect(args.slice(0, 3)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive'])
    expect(
      args[3] === '-Command' &&
        typeof args[4] === 'string' &&
        args[4].length < 256 &&
        args[4].includes('[Console]::In.ReadToEnd()') &&
        args[4].includes('[scriptblock]::Create($sourceText)')
    ).toBe(true)
    expect(typeof options.input).toBe('string')
    expect(options.input).toContain('Add-Type -Path $nativeAssemblyPath')
    expect(options.input).not.toContain('Add-Type -TypeDefinition')
    expect(options.input.length).toBeGreaterThan(8_192)
    expect(options.timeout).toBe(30_000)
    expect(options.env.EVENFIRE_TEST_SECRET).toBeUndefined()
    expect(Object.keys(options.env).sort()).toEqual([
      'COMSPEC',
      'EVENFIRE_SESSION_AUTHORITY_ACL_REQUEST',
      'EVENFIRE_SESSION_AUTHORITY_NATIVE_ASSEMBLY',
      'PATH',
      'PATHEXT',
      'SystemDrive',
      'SystemRoot',
      'TEMP',
      'TMP',
      'WINDIR',
    ])
    expect(options.env.EVENFIRE_SESSION_AUTHORITY_NATIVE_ASSEMBLY).toContain(
      'WindowsSessionAuthorityNative.dll'
    )

    const commandLineLength =
      executable.length + args.reduce((length: number, arg: string) => length + arg.length + 1, 0)
    expect(commandLineLength).toBeLessThan(32_767)
    expect(executable).toBe(
      path.win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    )
  })

  it('classifies a process-launch error without exposing its message or paths', () => {
    const failure = Object.assign(new Error('private path and command contents'), { code: 'E2BIG' })
    spawnSyncMock.mockReturnValue(
      processResult({
        pid: -1,
        status: null,
        stdout: null,
        stderr: null,
        error: failure,
      })
    )

    const message = captureError(runVerifier)
    expect(message).toMatch(/"phase":"process-launch".*"processErrorCode":"E2BIG"/)
    expect(message).not.toContain('private path')
    expect(message).not.toContain('C:\\private')
  })

  it('reports only an allowlisted verifier phase when a started process times out', () => {
    const failure = Object.assign(new Error('private path and command contents'), {
      code: 'ETIMEDOUT',
    })
    spawnSyncMock.mockReturnValue(
      processResult({
        status: null,
        signal: 'SIGTERM',
        error: failure,
        stderr:
          'EVENFIRE_ACL_PHASE=validate-user-data-root\n' +
          'EVENFIRE_ACL_PHASE=untrusted-value\nprivate path',
      })
    )

    const message = captureError(runVerifier)
    expect(message).toMatch(
      /"processErrorCode":"ETIMEDOUT".*"verifierExecutionPhase":"validate-user-data-root"/
    )
    expect(message).not.toContain('private path')
    expect(message).not.toContain('command contents')
  })

  it('distinguishes native helper load failures from verifier ACL rejection', () => {
    spawnSyncMock.mockReturnValue(
      processResult({
        status: 2,
        stdout: JSON.stringify({
          ok: false,
          phase: 'load-native-helper',
          errorType: 'FileNotFoundException',
          hresult: '0x80131500',
          detail: 'native-helper-path-missing',
        }),
        stderr: 'PowerShell loader output is intentionally not surfaced',
      })
    )

    const helperLoadFailure = captureError(runVerifier)
    expect(helperLoadFailure).toMatch(
      /"phase":"powershell-native-helper-load-failed".*"verifierPhase":"load-native-helper"/
    )
    expect(helperLoadFailure).not.toContain('loader output')

    spawnSyncMock.mockReturnValue(
      processResult({
        status: 2,
        stdout: JSON.stringify({
          ok: false,
          phase: 'validate-ancestor-owner-depth-7',
          errorType: 'UnauthorizedAccessException',
          hresult: '0x80070005',
          detail: 'owner-invalid',
          innerErrorType: 'Win32Exception',
          innerHresult: '0x80070005',
          innerNativeOperation: 'access-check',
          innerNativeErrorCode: 5,
          ownerClass: 'trusted-installer',
          aceClass: 'builtin-users',
          aceWriteContent: true,
          aceDeleteChild: false,
          aceDelete: false,
          aceWriteDacl: false,
          aceTakeOwnership: false,
          aceWriteMetadata: false,
          aceInherited: true,
        }),
      })
    )
    expect(captureError(runVerifier)).toMatch(
      /"phase":"acl-verifier-rejected".*"verifierPhase":"validate-ancestor-owner-depth-7".*"verifierDetail":"owner-invalid".*"verifierInnerErrorType":"Win32Exception".*"verifierInnerHresult":"0x80070005".*"verifierInnerNativeOperation":"access-check".*"verifierInnerNativeErrorCode":5.*"verifierOwnerClass":"trusted-installer".*"verifierAceClass":"builtin-users".*"verifierAceWriteContent":true.*"verifierAceDeleteChild":false.*"verifierAceWriteDacl":false.*"verifierAceInherited":true/
    )
  })

  it('reports a started PowerShell process that returns no structured output', () => {
    spawnSyncMock.mockReturnValue(processResult({ stdout: '', stderr: '' }))

    expect(captureError(runVerifier)).toMatch(
      /"phase":"structured-output-missing".*"processStarted":true.*"exitStatus":0.*"stdoutPresent":false/
    )
  })

  it('classifies structured-output parsing failures without exposing output', () => {
    spawnSyncMock.mockReturnValue(
      processResult({
        stdout: 'sensitive-unstructured-output',
        stderr: 'private stderr',
      })
    )

    const message = captureError(runVerifier)
    expect(message).toMatch(
      /"phase":"structured-output-invalid".*"stdoutPresent":true.*"stderrPresent":true/
    )
    expect(message).not.toContain('sensitive-unstructured-output')
    expect(message).not.toContain('private stderr')
  })
})
