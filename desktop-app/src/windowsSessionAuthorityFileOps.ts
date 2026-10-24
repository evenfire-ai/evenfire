import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import path from 'node:path'

const REQUEST_ENV = 'EVENFIRE_SESSION_AUTHORITY_FILE_OPS'
const POWERSHELL_OPERATION_TIMEOUT_MS = 30_000
const LAUNCHER = '$sourceText = [Console]::In.ReadToEnd(); & ([scriptblock]::Create($sourceText))'
const ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', LAUNCHER] as const
const VERIFIER_PHASES = new Set(['compile-native-move', 'validate-request', 'native-move'])
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$phase = 'compile-native-move'
$null = [Console]::Error.WriteLine('EVENFIRE_SESSION_AUTHORITY_PHASE:' + $phase)
[Console]::Error.Flush()
$code = @'
using System;
using System.Runtime.InteropServices;
public static class EvenfireSessionAuthorityMove {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true,
    EntryPoint = "MoveFileExW")]
  static extern bool MoveFileEx(string source, string destination, uint flags);
  public static int Move(string source, string destination, uint flags) {
    return MoveFileEx(source, destination, flags) ? 0 : Marshal.GetLastWin32Error();
  }
}
'@
try {
  Add-Type -TypeDefinition $code -Language CSharp -ErrorAction Stop
  $phase = 'validate-request'
  [Console]::Error.WriteLine('EVENFIRE_SESSION_AUTHORITY_PHASE:' + $phase)
  [Console]::Error.Flush()
  $payload = [Environment]::GetEnvironmentVariable('EVENFIRE_SESSION_AUTHORITY_FILE_OPS')
  if (-not $payload) { throw 'request-missing' }
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) |
    ConvertFrom-Json
  if (-not $request -or -not $request.source -or -not $request.destination) {
    throw 'request-invalid'
  }
  $flags = [uint32]8
  if ($request.replaceExisting -eq $true) { $flags = [uint32]9 }
  $phase = 'native-move'
  [Console]::Error.WriteLine('EVENFIRE_SESSION_AUTHORITY_PHASE:' + $phase)
  [Console]::Error.Flush()
  $errorCode = [EvenfireSessionAuthorityMove]::Move(
    [string]$request.source, [string]$request.destination, $flags)
  if ($errorCode -eq 0) {
    [Console]::Out.WriteLine('{"ok":true}')
    exit 0
  }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress @{ ok = $false; phase = $phase;
    errorCode = $errorCode }))
  exit 2
} catch {
  [Console]::Out.WriteLine((ConvertTo-Json -Compress @{ ok = $false; phase = $phase;
    errorType = $_.Exception.GetType().Name }))
  exit 2
}
`

export class SessionAuthorityFileMutationError extends Error {
  readonly code: string

  constructor(
    code: string,
    readonly outcome: 'rejected' | 'indeterminate',
    readonly diagnostic?: {
      phase:
        | 'path-validation'
        | 'process-launch'
        | 'process-interrupted'
        | 'powershell-compilation-failed'
        | 'powershell-execution-failed'
        | 'native-operation-rejected'
        | 'file-validation-failed'
        | 'file-durability-failed'
        | 'file-readback-failed'
        | 'directory-validation-failed'
        | 'publication-rejected'
        | 'directory-sync-failed'
        | 'destination-readback-failed'
        | 'source-retirement-failed'
        | 'structured-output-missing'
        | 'structured-output-invalid'
      processStarted: boolean
      processErrorCode?: string
      exitStatus: number | null
      processSignaled: boolean
      stdoutPresent: boolean
      stderrPresent: boolean
      verifierPhase?: string
      nativeErrorCode?: number
    }
  ) {
    super('Session authority file mutation did not establish durable completion')
    this.name = 'SessionAuthorityFileMutationError'
    this.code = code
  }
}

function normalizedParent(value: string): string {
  return path.win32
    .normalize(path.win32.dirname(value))
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

function validateMovePaths(source: string, destination: string): void {
  if (
    !path.win32.isAbsolute(source) ||
    !path.win32.isAbsolute(destination) ||
    source.includes('\0') ||
    destination.includes('\0') ||
    source.length > 32_000 ||
    destination.length > 32_000 ||
    normalizedParent(source) !== normalizedParent(destination)
  )
    throw new SessionAuthorityFileMutationError('EINVAL', 'rejected', {
      phase: 'path-validation',
      processStarted: false,
      exitStatus: null,
      processSignaled: false,
      stdoutPresent: false,
      stderrPresent: false,
    })
}

function diagnostic(
  result: SpawnSyncReturns<string>,
  code?: string
): SessionAuthorityFileMutationError {
  const started = typeof result.pid === 'number' && result.pid > 0
  const processError = result.error as NodeJS.ErrnoException | undefined
  const errorCode = processError?.code
  const safeProcessErrorCode =
    typeof errorCode === 'string' &&
    ['E2BIG', 'EACCES', 'EINVAL', 'ENOENT', 'EPERM', 'ETIMEDOUT'].includes(errorCode)
      ? errorCode
      : errorCode
        ? 'OTHER'
        : undefined
  const diagnosticFields = {
    processStarted: started,
    ...(safeProcessErrorCode ? { processErrorCode: safeProcessErrorCode } : {}),
    exitStatus: result.status,
    processSignaled: Boolean(result.signal),
    stdoutPresent: Boolean(result.stdout),
    stderrPresent: Boolean(result.stderr),
  }
  const verifierPhase = observedVerifierPhase(result)
  const codeForError = safeProcessErrorCode ?? code ?? 'EIO'
  if (result.signal || errorCode === 'ETIMEDOUT' || (result.error && started)) {
    return new SessionAuthorityFileMutationError(codeForError, 'indeterminate', {
      ...diagnosticFields,
      phase: 'process-interrupted',
      ...(verifierPhase ? { verifierPhase } : {}),
    })
  }
  if (!started && processError) {
    return new SessionAuthorityFileMutationError(codeForError, 'rejected', {
      ...diagnosticFields,
      phase: 'process-launch',
    })
  }
  if (!result.stdout) {
    return new SessionAuthorityFileMutationError(codeForError, 'indeterminate', {
      ...diagnosticFields,
      phase: 'structured-output-missing',
    })
  }
  try {
    const response = JSON.parse(result.stdout.trim()) as Record<string, unknown>
    const verifierPhase =
      typeof response.phase === 'string' && /^[a-z-]{1,40}$/.test(response.phase)
        ? response.phase
        : undefined
    if (response.ok === false && Number.isInteger(response.errorCode)) {
      const nativeErrorCode = response.errorCode as number
      const nativeCode =
        nativeErrorCode === 2 || nativeErrorCode === 3
          ? 'ENOENT'
          : nativeErrorCode === 80 || nativeErrorCode === 183
            ? 'EEXIST'
            : `WIN32_${nativeErrorCode}`
      return new SessionAuthorityFileMutationError(nativeCode, 'rejected', {
        ...diagnosticFields,
        phase: 'native-operation-rejected',
        ...(verifierPhase ? { verifierPhase } : {}),
        nativeErrorCode,
      })
    }
    if (response.ok === false && typeof response.errorType === 'string') {
      const phase =
        verifierPhase === 'compile-native-move'
          ? 'powershell-compilation-failed'
          : 'powershell-execution-failed'
      return new SessionAuthorityFileMutationError(codeForError, 'rejected', {
        ...diagnosticFields,
        phase,
        ...(verifierPhase ? { verifierPhase } : {}),
      })
    }
  } catch {
    return new SessionAuthorityFileMutationError(codeForError, 'indeterminate', {
      ...diagnosticFields,
      phase: 'structured-output-invalid',
    })
  }
  return new SessionAuthorityFileMutationError(codeForError, 'indeterminate', {
    ...diagnosticFields,
    phase: 'structured-output-invalid',
  })
}

function observedVerifierPhase(result: SpawnSyncReturns<string>): string | undefined {
  const output = [result.stdout, result.stderr]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
  const expression = /EVENFIRE_SESSION_AUTHORITY_PHASE:([a-z-]{1,40})/g
  let phase: string | undefined
  for (const match of output.matchAll(expression)) {
    const candidate = match[1]
    if (candidate && VERIFIER_PHASES.has(candidate)) phase = candidate
  }
  return phase
}

/** Use same-directory MoveFileExW with WRITE_THROUGH; never use copy-across-volume fallback. */
export function moveSessionAuthorityFileDurablySync(
  source: string,
  destination: string,
  replaceExisting = false
): void {
  if (process.platform !== 'win32')
    throw new SessionAuthorityFileMutationError('ENOTSUP', 'rejected')
  validateMovePaths(source, destination)
  const systemRoot = process.env.SystemRoot
  const temporaryDirectory = process.env.TEMP ?? process.env.TMP
  if (
    !systemRoot ||
    !temporaryDirectory ||
    !path.win32.isAbsolute(systemRoot) ||
    !path.win32.isAbsolute(temporaryDirectory)
  )
    throw new SessionAuthorityFileMutationError('EINVAL', 'rejected')
  const executable = path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const system32 = path.win32.join(systemRoot, 'System32')
  const powershellDirectory = path.win32.join(system32, 'WindowsPowerShell', 'v1.0')
  const safePath = [
    system32,
    path.win32.join(system32, 'Wbem'),
    powershellDirectory,
    path.win32.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319'),
    path.win32.join(systemRoot, 'Microsoft.NET', 'Framework', 'v4.0.30319'),
  ].join(';')
  const request = Buffer.from(
    JSON.stringify({ source, destination, replaceExisting }),
    'utf8'
  ).toString('base64')
  const result = spawnSync(executable, [...ARGS], {
    encoding: 'utf8',
    // Add-Type's CodeDOM compiler and PowerShell need a system-only PATH and COMSPEC. Do not pass
    // unrelated application credentials or user-defined command hooks to the child process.
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      SystemDrive: path.win32.parse(systemRoot).root.replace(/[\\/]+$/, ''),
      PATH: safePath,
      COMSPEC: path.win32.join(system32, 'cmd.exe'),
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      TEMP: temporaryDirectory,
      TMP: temporaryDirectory,
      [REQUEST_ENV]: request,
    },
    input: SCRIPT,
    maxBuffer: 4096,
    // Add-Type compiles the fixed native MoveFileEx wrapper on each isolated invocation. Keep the
    // wait bounded; timeout remains indeterminate and carries only a sanitized phase marker.
    timeout: POWERSHELL_OPERATION_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.error || result.signal || !result.stdout) throw diagnostic(result)

  let response: unknown
  try {
    response = JSON.parse(result.stdout.trim())
  } catch {
    throw diagnostic(result)
  }
  if (typeof response !== 'object' || response === null) throw diagnostic(result)
  const fields = response as Record<string, unknown>
  if (fields.ok === true && result.status === 0) return
  if (fields.ok === false) throw diagnostic(result)
  throw diagnostic(result)
}
