import type { IncomingMessage } from 'node:http'

export type BodyReadResult =
  | { kind: 'ok'; body: Buffer }
  | { kind: 'too_large' }
  | { kind: 'idle_timeout' }
  | { kind: 'aborted' }

/**
 * Read the raw request body byte-by-byte into a Buffer, capped at
 * `maxBodyBytes`. NEVER use a body-parser middleware — the verifier
 * needs the original bytes the provider sent, not a re-serialised
 * form (spec §7 invariant + must-fix #3).
 *
 * Body-side slowloris protection: if no bytes arrive for
 * `bodyIdleTimeoutMs`, the read is aborted with `idle_timeout`.
 *
 * Cap is checked AS chunks arrive (not just at end-of-stream), so an
 * attacker can't trick us into buffering an arbitrarily large body
 * before we notice — first-chunk-too-large gets caught immediately.
 */
export function readRawBody(
  req: IncomingMessage,
  maxBodyBytes: number,
  bodyIdleTimeoutMs: number
): Promise<BodyReadResult> {
  return new Promise<BodyReadResult>(resolve => {
    let resolved = false
    const settle = (result: BodyReadResult) => {
      if (resolved) return
      resolved = true
      clearTimeout(idleTimer)
      if (result.kind !== 'ok') {
        // Drain so the kernel doesn't keep buffering more bytes.
        req.destroy()
      }
      resolve(result)
    }

    const chunks: Buffer[] = []
    let total = 0
    let idleTimer: NodeJS.Timeout = setTimeout(() => {
      settle({ kind: 'idle_timeout' })
    }, bodyIdleTimeoutMs)

    const armIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => settle({ kind: 'idle_timeout' }), bodyIdleTimeoutMs)
    }

    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBodyBytes) {
        settle({ kind: 'too_large' })
        return
      }
      chunks.push(chunk)
      armIdle()
    })

    req.on('end', () => {
      settle({ kind: 'ok', body: Buffer.concat(chunks, total) })
    })

    req.on('error', () => {
      settle({ kind: 'aborted' })
    })

    req.on('close', () => {
      // `close` fires after `end` for normal cases; for client TCP-disconnect
      // mid-body we get `close` without an `end` first. The check guarantees
      // we settle as `aborted` (→ caller maps to synthetic 499) only when we
      // haven't already produced an `ok` outcome.
      if (!resolved) settle({ kind: 'aborted' })
    })
  })
}
