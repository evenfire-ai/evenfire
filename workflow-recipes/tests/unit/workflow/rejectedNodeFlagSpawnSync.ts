import { spawnSync } from 'node:child_process'

export interface RejectedNodeFlagSpawnSyncResult {
  pid: number
  output: Array<Buffer | null>
  stdout: Buffer
  stderr: Buffer
  status: number | null
  signal: NodeJS.Signals | null
}

/**
 * The result shape of the Node runtime that runs the tests rejecting an unknown flag:
 * `node --bogus` exits with a non-zero status and prints `<execPath>: bad option: --bogus`
 * on stderr. Only the flag name is substituted, so the mocked status, signal and streams
 * come from the real binary instead of a hand-written copy.
 */
export function rejectedNodeFlagSpawnSyncResult(
  flag = '--permission'
): RejectedNodeFlagSpawnSyncResult {
  const real = spawnSync(process.execPath, ['--bogus'])
  if (real.status === 0) {
    throw new Error(
      `this Node runtime accepts --bogus, so it cannot model a rejected flag: ${String(real.stderr)}`
    )
  }
  const stderr = Buffer.from(String(real.stderr).replace('--bogus', flag))
  return {
    pid: real.pid ?? 0,
    output: [null, real.stdout, stderr],
    stdout: real.stdout,
    stderr,
    status: real.status,
    signal: real.signal,
  }
}
