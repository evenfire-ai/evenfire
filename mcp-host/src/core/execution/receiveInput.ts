import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, addAbortSignal } from 'node:stream'

export const EXECUTION_INPUT_MAX_BYTES = 11_534_336
const MAX_INPUT_TIMEOUT_MS = 1_500_000

export type InputReceiveErrorCode =
  | 'invalid_input_contract'
  | 'input_length_mismatch'
  | 'input_digest_mismatch'
  | 'input_directory_invalid'
  | 'input_write_failed'

export class InputReceiveError extends Error {
  constructor(readonly code: InputReceiveErrorCode) {
    super(code)
    this.name = 'InputReceiveError'
  }
}

/**
 * Trusted init-container entrypoint. The executor mounts this private volume
 * read-only and cannot start until initialization succeeds. It receives no
 * store path or runtime authority. This function never interprets input bytes.
 */
export async function receiveExecutionInput(
  input: Readable,
  directory: string,
  expectedBytes: number,
  expectedDigest: string,
  timeoutMs: number
): Promise<void> {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > EXECUTION_INPUT_MAX_BYTES ||
    !/^[0-9a-f]{64}$/.test(expectedDigest) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_INPUT_TIMEOUT_MS
  )
    throw new InputReceiveError('invalid_input_contract')
  const root = await fs.lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new InputReceiveError('input_directory_invalid')
  }
  const stage = join(directory, '.receiving')
  const final = join(directory, 'source')
  // The init process is the sole volume writer. Exclusive creation refuses
  // interrupted or replayed input rather than replacing another operation.
  const handle = await fs.open(
    stage,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  let closed = false
  let received = 0
  const hash = createHash('sha256')
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    for await (const chunk of addAbortSignal(signal, input)) {
      if (!Buffer.isBuffer(chunk) || received + chunk.length > expectedBytes) {
        throw new InputReceiveError('input_length_mismatch')
      }
      received += chunk.length
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.length) {
        signal.throwIfAborted()
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
        if (bytesWritten <= 0) throw new InputReceiveError('input_write_failed')
        offset += bytesWritten
      }
    }
    signal.throwIfAborted()
    if (received !== expectedBytes) throw new InputReceiveError('input_length_mismatch')
    if (hash.digest('hex') !== expectedDigest) throw new InputReceiveError('input_digest_mismatch')
    await handle.chmod(0o444)
    await handle.close()
    closed = true
    // link publishes atomically without replacing an existing object. This
    // volume is ephemeral; durability belongs to the original-file store.
    await fs.link(stage, final)
  } finally {
    if (!closed) await handle.close()
    await fs.unlink(stage)
  }
}

if (require.main === module) {
  const [size, digest, timeout, ...extra] = process.argv.slice(2)
  if (
    extra.length ||
    !size ||
    !digest ||
    !timeout ||
    !/^\d+$/.test(size) ||
    !/^\d+$/.test(timeout)
  ) {
    process.stderr.write(JSON.stringify({ level: 'error', code: 'invalid_input_contract' }) + '\n')
    process.exitCode = 1
  } else {
    receiveExecutionInput(process.stdin, '/input', Number(size), digest, Number(timeout))
      .then(() =>
        process.stdout.write(
          JSON.stringify({ level: 'info', event: 'input_ready', bytes: Number(size) }) + '\n'
        )
      )
      .catch(error => {
        // Never include raw data, digest, paths, scripts or exception messages.
        const code = error instanceof InputReceiveError ? error.code : 'input_receive_failed'
        process.stderr.write(JSON.stringify({ level: 'error', code }) + '\n')
        process.exitCode = 1
      })
  }
}
