import { afterEach, describe, expect, it } from 'vitest'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createSessionAuthorityFileDurablySync,
  renameSessionAuthorityFileDurablySync,
} from '../sessionAuthorityDurableFileOps.js'
import { SessionAuthorityFileMutationError } from '../windowsSessionAuthorityFileOps.js'

if (process.env.EVENFIRE_REQUIRE_WINDOWS_DURABLE_TEST === '1' && process.platform !== 'win32') {
  throw new Error('The required native session-authority durability test must run on Windows')
}

const roots: string[] = []
const LOCK_TARGET_ENV = 'EVENFIRE_TEST_LOCK_TARGET'
const LOCK_READY = 'EVENFIRE_TEST_FILE_LOCK_READY'
const MAX_LOCK_HELPER_OUTPUT_CHARS = 512
const LOCK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$stream = [System.IO.File]::Open($env:EVENFIRE_TEST_LOCK_TARGET,
  [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
[Console]::Out.WriteLine('EVENFIRE_TEST_FILE_LOCK_READY')
[Console]::Out.Flush()
[void][Console]::In.ReadLine()
$stream.Dispose()
`

function createRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'evenfire-session-authority-durable-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runNativeOperation(operation: () => void): void {
  try {
    operation()
  } catch (error) {
    if (!(error instanceof SessionAuthorityFileMutationError)) throw error
    const diagnostic = error.diagnostic
    throw new Error(
      `Windows authority publication failed: ${JSON.stringify({
        code: error.code,
        outcome: error.outcome,
        phase: diagnostic?.phase,
        processErrorCode: diagnostic?.processErrorCode,
        exitStatus: diagnostic?.exitStatus,
        processStarted: diagnostic?.processStarted,
        processSignaled: diagnostic?.processSignaled,
        stdoutPresent: diagnostic?.stdoutPresent,
        stderrPresent: diagnostic?.stderrPresent,
        verifierPhase: diagnostic?.verifierPhase,
      })}`
    )
  }
}

function waitForChildOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = ''
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const finish = (error?: Error) => {
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString()
      if (output.length + text.length > MAX_LOCK_HELPER_OUTPUT_CHARS) {
        finish(new Error('Windows destination-lock process emitted unexpected output'))
        return
      }
      output += text
      if (output.includes(expected)) finish()
    }
    const onError = () => finish(new Error('Windows destination-lock process failed to start'))
    const onExit = () => finish(new Error('Windows destination-lock process exited before ready'))
    const timer = setTimeout(
      () => finish(new Error('Windows destination-lock process did not become ready')),
      timeoutMs
    )
    child.stdout.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode === 0 && child.signalCode === null) return Promise.resolve()
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.reject(new Error('Windows destination-lock process exited unsuccessfully'))
  return new Promise((resolve, reject) => {
    let exitDeadlineExceeded = false
    let killDeadline: NodeJS.Timeout | undefined
    const cleanup = () => {
      clearTimeout(timer)
      if (killDeadline) clearTimeout(killDeadline)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const finish = (error?: Error) => {
      cleanup()
      if (error) reject(error)
      else resolve()
    }
    const onError = () => finish(new Error('Windows destination-lock process failed'))
    const onExit = (code: number | null) => {
      if (exitDeadlineExceeded) {
        finish(new Error('Windows destination-lock process exceeded its exit deadline'))
        return
      }
      finish(
        code === 0 ? undefined : new Error('Windows destination-lock process exited unsuccessfully')
      )
    }
    const timer = setTimeout(() => {
      exitDeadlineExceeded = true
      child.kill()
      killDeadline = setTimeout(
        () => finish(new Error('Windows destination-lock process could not be stopped')),
        timeoutMs
      )
    }, timeoutMs)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function withDestinationLockedWithoutDeleteSharing(
  destination: string,
  operation: () => void
): Promise<void> {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('SystemRoot is required for the native Windows lock test')
  const system32 = path.win32.join(systemRoot, 'System32')
  const executable = path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const child = spawn(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', LOCK_SCRIPT],
    {
      env: {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        [LOCK_TARGET_ENV]: destination,
      },
      stdio: 'pipe',
      windowsHide: true,
    }
  )

  try {
    await waitForChildOutput(child, LOCK_READY, 10_000)
    operation()
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end('\n')
    await waitForChildExit(child, 5_000)
  }
}

describe('Windows session-authority durable file operations', () => {
  it.skipIf(process.platform !== 'win32')(
    'creates an authority file through a same-directory write-through move',
    () => {
      const root = createRoot()
      const authority = path.join(root, 'authority.record')

      runNativeOperation(() =>
        createSessionAuthorityFileDurablySync(authority, '{"revision":"first"}')
      )
      expect(readFileSync(authority, 'utf8')).toBe('{"revision":"first"}')
    },
    40_000
  )

  it.skipIf(process.platform !== 'win32')(
    'replaces an authority file through a same-directory write-through move',
    () => {
      const root = createRoot()
      const authority = path.join(root, 'authority.record')
      const replacement = path.join(root, 'authority.next')
      writeFileSync(authority, '{"revision":"first"}')
      writeFileSync(replacement, '{"revision":"second"}')

      runNativeOperation(() => renameSessionAuthorityFileDurablySync(replacement, authority, true))

      expect(readFileSync(authority, 'utf8')).toBe('{"revision":"second"}')
      expect(() => readFileSync(replacement)).toThrow()
    },
    40_000
  )

  it.skipIf(process.platform !== 'win32')(
    'never accepts a failed non-replacing native move when the target already exists',
    () => {
      const root = createRoot()
      const authority = path.join(root, 'authority.record')
      const candidate = path.join(root, 'candidate.tmp')
      writeFileSync(authority, '{"owner":"current"}')
      writeFileSync(candidate, '{"owner":"candidate"}')

      let failure: unknown
      try {
        renameSessionAuthorityFileDurablySync(candidate, authority, false)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(SessionAuthorityFileMutationError)
      expect(failure).toMatchObject({
        code: 'EEXIST',
        outcome: 'rejected',
        diagnostic: {
          phase: 'native-operation-rejected',
          verifierPhase: 'native-move',
        },
      })
      expect(readFileSync(authority, 'utf8')).toBe('{"owner":"current"}')
      expect(readFileSync(candidate, 'utf8')).toBe('{"owner":"candidate"}')
    },
    40_000
  )

  it.skipIf(process.platform !== 'win32')(
    'preserves prior authority bytes when replacement is rejected by a native sharing lock',
    async () => {
      const root = createRoot()
      const authority = path.join(root, 'authority.record')
      const candidate = path.join(root, 'authority.next')
      writeFileSync(authority, '{"owner":"current"}')
      writeFileSync(candidate, '{"owner":"candidate"}')

      let failure: unknown
      await withDestinationLockedWithoutDeleteSharing(authority, () => {
        try {
          renameSessionAuthorityFileDurablySync(candidate, authority, true)
        } catch (error) {
          failure = error
        }
      })

      expect(failure).toBeInstanceOf(SessionAuthorityFileMutationError)
      if (!(failure instanceof SessionAuthorityFileMutationError))
        throw new Error('Expected native replacement to be rejected')
      expect(failure.outcome).toBe('rejected')
      expect(failure.diagnostic).toMatchObject({
        phase: 'native-operation-rejected',
        verifierPhase: 'native-move',
      })
      expect(readFileSync(authority, 'utf8')).toBe('{"owner":"current"}')
      expect(readFileSync(candidate, 'utf8')).toBe('{"owner":"candidate"}')
    },
    40_000
  )
})
