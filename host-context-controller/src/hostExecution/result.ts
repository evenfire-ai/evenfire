/** Result protocol emitted by the private execution launcher, not service logs. */
export interface HostExecutionResult {
  reason: 'exited' | 'timeout' | 'output_limit' | 'spawn_failed' | 'invalid_contract'
  exitCode: number | null
  signal: string | null
  truncated: boolean
  stdout: string
  stderr: string
}

export const EXECUTION_RESULT_MAX_BYTES = 98_304
const OUTPUT_MAX_BYTES = 65_536
const KEYS = ['reason', 'exitCode', 'signal', 'truncated', 'stdout', 'stderr']
const REASONS = new Set(['exited', 'timeout', 'output_limit', 'spawn_failed', 'invalid_contract'])

function invalid(): never {
  throw new Error('execution_result_invalid')
}

function decodedSize(value: unknown): number {
  if (typeof value !== 'string' || value.length > 87_384) invalid()
  if (Buffer.from(value, 'base64').toString('base64') !== value) invalid()
  return Buffer.byteLength(value, 'base64')
}

/**
 * Fail closed on an incomplete/oversized frame or a noncanonical binary field.
 * Raw bytes never become text implicitly and a bad result never reruns a tool.
 */
export function parseHostExecutionResult(frame: string): HostExecutionResult {
  if (Buffer.byteLength(frame, 'utf8') > EXECUTION_RESULT_MAX_BYTES) invalid()
  let value: unknown
  try {
    value = JSON.parse(frame)
  } catch {
    invalid()
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== KEYS.length || KEYS.some(key => !(key in result))) invalid()
  if (typeof result.reason !== 'string' || !REASONS.has(result.reason)) invalid()
  if (
    result.exitCode !== null &&
    (!Number.isSafeInteger(result.exitCode) ||
      (result.exitCode as number) < 0 ||
      (result.exitCode as number) > 255)
  )
    invalid()
  if (
    result.signal !== null &&
    (typeof result.signal !== 'string' || !/^SIG[A-Z0-9]{1,16}$/.test(result.signal))
  )
    invalid()
  if (typeof result.truncated !== 'boolean') invalid()
  if (decodedSize(result.stdout) + decodedSize(result.stderr) > OUTPUT_MAX_BYTES) invalid()
  return Object.freeze(result) as unknown as HostExecutionResult
}
