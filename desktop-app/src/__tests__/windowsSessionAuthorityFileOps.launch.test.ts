import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SessionAuthorityFileMutationError,
  moveSessionAuthorityFileDurablySync,
} from '../windowsSessionAuthorityFileOps.js'

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

function processResult(overrides: Record<string, unknown> = {}) {
  return {
    pid: 123,
    output: [],
    stdout: '{"ok":true}',
    stderr: '',
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  }
}

function captureError(action: () => void): SessionAuthorityFileMutationError {
  try {
    action()
  } catch (error) {
    if (error instanceof SessionAuthorityFileMutationError) return error
    throw error
  }
  throw new Error('Expected the native file operation to fail')
}

describe('Windows session-authority native file-operation launcher', () => {
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

  it('keeps the fixed script off the process command line and passes only bounded data', () => {
    const source = 'C:\\Users\\fixture\\Evenfire\\authority.next'
    const destination = 'C:\\Users\\fixture\\Evenfire\\authority.json'
    moveSessionAuthorityFileDurablySync(source, destination, true)

    const [executable, args, options] = spawnSyncMock.mock.calls[0]!
    expect(args.slice(0, 3)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive'])
    expect(args[3]).toBe('-Command')
    expect(args[4]).toContain('[Console]::In.ReadToEnd()')
    expect(args[4]).toContain('[scriptblock]::Create($sourceText)')
    expect(args[4].length).toBeLessThan(256)
    expect(options.input).toContain('Add-Type -Path $assemblyPath')
    expect(options.input).not.toContain('Add-Type -TypeDefinition')
    expect(options.input).toContain('[EvenfireSessionAuthorityMove]::Move(')
    expect(options.input).not.toContain('nativeErrorCode')
    expect(options.input).toContain('$flags = [uint32]8')
    expect(options.input).toContain('$flags = [uint32]9')
    expect(options.input).toContain("$phase = 'native-move'")
    expect(options.input.length).toBeGreaterThan(512)
    expect(options.env.EVENFIRE_TEST_SECRET).toBeUndefined()
    expect(Object.keys(options.env).sort()).toEqual([
      'COMSPEC',
      'EVENFIRE_SESSION_AUTHORITY_FILE_OPS',
      'EVENFIRE_SESSION_AUTHORITY_NATIVE_ASSEMBLY',
      'PATH',
      'PATHEXT',
      'SystemDrive',
      'SystemRoot',
      'TEMP',
      'TMP',
      'WINDIR',
    ])
    expect(options.env.PATH).toBe(
      [
        'C:\\Windows\\System32',
        'C:\\Windows\\System32\\Wbem',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
        'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319',
        'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319',
      ].join(';')
    )
    expect(options.env.COMSPEC).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(options.env.SystemDrive).toBe('C:')
    expect(options.env.EVENFIRE_SESSION_AUTHORITY_FILE_OPS).toBeTruthy()
    expect(options.env.EVENFIRE_SESSION_AUTHORITY_NATIVE_ASSEMBLY).toContain(
      'WindowsSessionAuthorityNative.dll'
    )
    expect(options.timeout).toBe(30_000)

    const request = JSON.parse(
      Buffer.from(options.env.EVENFIRE_SESSION_AUTHORITY_FILE_OPS, 'base64').toString('utf8')
    )
    expect(request).toEqual({ source, destination, replaceExisting: true })
    const commandLineLength =
      executable.length + args.reduce((length: number, arg: string) => length + arg.length + 1, 0)
    expect(commandLineLength).toBeLessThan(32_767)
  })

  it('keeps a failed native move rejected without trusting last-error state', () => {
    spawnSyncMock.mockReturnValue(
      processResult({
        status: 2,
        stdout: '{"ok":false,"phase":"native-move","errorCode":5}',
      })
    )

    const error = captureError(() => {
      moveSessionAuthorityFileDurablySync(
        'C:\\Users\\fixture\\Evenfire\\candidate.next',
        'C:\\Users\\fixture\\Evenfire\\candidate.json',
        false
      )
    })
    expect(error).toMatchObject({ code: 'WIN32_5', outcome: 'rejected' })
    expect(error.diagnostic).toMatchObject({
      phase: 'native-operation-rejected',
      verifierPhase: 'native-move',
      nativeErrorCode: 5,
    })
    expect(error.message).not.toContain('C:\\Users')
  })

  it('classifies native helper load errors without exposing PowerShell details', () => {
    spawnSyncMock.mockReturnValue(
      processResult({
        status: 2,
        stdout: '{"ok":false,"phase":"load-native-helper","errorType":"FileNotFoundException"}',
      })
    )

    const error = captureError(() =>
      moveSessionAuthorityFileDurablySync(
        'C:\\Users\\fixture\\Evenfire\\candidate.next',
        'C:\\Users\\fixture\\Evenfire\\candidate.json'
      )
    )

    expect(error).toMatchObject({ code: 'EIO', outcome: 'rejected' })
    expect(error.diagnostic).toMatchObject({
      phase: 'powershell-native-helper-load-failed',
      verifierPhase: 'load-native-helper',
    })
    expect(error.message).not.toContain('FileNotFoundException')
  })

  it('classifies process-start failure as rejected and post-start timeout as indeterminate', () => {
    const startError = Object.assign(new Error('private command and path'), {
      code: 'E2BIG',
    })
    spawnSyncMock.mockReturnValue(
      processResult({
        pid: undefined,
        status: null,
        stdout: null,
        stderr: null,
        error: startError,
      })
    )
    const launchFailure = captureError(() =>
      moveSessionAuthorityFileDurablySync(
        'C:\\Users\\fixture\\Evenfire\\a',
        'C:\\Users\\fixture\\Evenfire\\b'
      )
    )
    expect(launchFailure).toMatchObject({ code: 'E2BIG', outcome: 'rejected' })
    expect(launchFailure.diagnostic).toMatchObject({ phase: 'process-launch' })
    expect(launchFailure.cause).toBeUndefined()

    const timeout = Object.assign(new Error('private command and path'), {
      code: 'ETIMEDOUT',
    })
    spawnSyncMock.mockReturnValue(
      processResult({
        status: null,
        signal: 'SIGTERM',
        stdout: null,
        stderr: 'EVENFIRE_SESSION_AUTHORITY_PHASE:native-move',
        error: timeout,
      })
    )
    const interruption = captureError(() => {
      moveSessionAuthorityFileDurablySync(
        'C:\\Users\\fixture\\Evenfire\\a',
        'C:\\Users\\fixture\\Evenfire\\b'
      )
    })
    expect(interruption).toMatchObject({ outcome: 'indeterminate' })
    expect(interruption.diagnostic).toMatchObject({
      phase: 'process-interrupted',
      processErrorCode: 'ETIMEDOUT',
    })
    expect(interruption.message).not.toContain('private command')
  })

  it('rejects cross-directory paths before starting PowerShell', () => {
    const invalidPath = captureError(() =>
      moveSessionAuthorityFileDurablySync(
        'C:\\Users\\fixture\\Evenfire\\a',
        'C:\\Users\\fixture\\Other\\b'
      )
    )
    expect(invalidPath).toMatchObject({ code: 'EINVAL', outcome: 'rejected' })
    expect(invalidPath.diagnostic).toMatchObject({ phase: 'path-validation' })
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })
})
