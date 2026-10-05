import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { EXECUTION_INPUT_MAX_BYTES, receiveExecutionInput } from './receiveInput'

/** Fixed in-Pod port for the private input session (the result session uses 9300). */
export const EXECUTION_INPUT_PORT = 9301
/** Downward-API variable carrying the real Pod UID of this Job Pod. */
export const EXECUTION_POD_UID_ENV = 'EXECUTION_POD_UID'
/** Exact UID header; the same Downward-API gate the result session uses. */
export const EXECUTION_INPUT_UID_HEADER = 'x-execution-pod-uid'
/** Fixed private directory the trusted receiver writes. */
export const EXECUTION_INPUT_DIRECTORY = '/input'
export const EXECUTION_INPUT_CONTENT_TYPE = 'application/octet-stream'
/** Mirrors the receiver's own stream-deadline ceiling for CLI validation. */
export const EXECUTION_INPUT_TIMEOUT_MAX_MS = 1_500_000
/** Total session life after the input deadline. */
export const EXECUTION_INPUT_GRACE_MS = 60_000

export type ReceiveSessionOutcome = 'received' | 'rejected'
export type ReceiveSessionErrorCode = 'invalid_session_contract' | 'session_bind_failed'

export class ReceiveSessionError extends Error {
  constructor(readonly code: ReceiveSessionErrorCode) {
    super(code)
    this.name = 'ReceiveSessionError'
  }
}

export interface ReceiveSessionOptions {
  bytes: number
  sha256: string
  timeoutMs: number
  podUid: string
  /** Tests write to a temporary directory; the Pod uses the fixed /input. */
  directory?: string
  host?: string
  port?: number
  graceMs?: number
  /** Injectable for tests only; production always uses the receiver. */
  receive?: typeof receiveExecutionInput
  /** Called once with the final outcome, after the response is flushed. */
  onSettled?: (outcome: ReceiveSessionOutcome) => void
}

export interface ReceiveSession {
  readonly port: number
  close(): Promise<void>
}

const POD_UID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

function invalidContract(options: ReceiveSessionOptions): boolean {
  const graceMs = options.graceMs ?? EXECUTION_INPUT_GRACE_MS
  return (
    !POD_UID_PATTERN.test(options.podUid) ||
    !Number.isSafeInteger(options.bytes) ||
    options.bytes < 0 ||
    options.bytes > EXECUTION_INPUT_MAX_BYTES ||
    typeof options.sha256 !== 'string' ||
    !SHA256_PATTERN.test(options.sha256) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > EXECUTION_INPUT_TIMEOUT_MAX_MS ||
    !Number.isSafeInteger(graceMs) ||
    graceMs < 0 ||
    typeof (options.directory ?? EXECUTION_INPUT_DIRECTORY) !== 'string' ||
    (options.directory ?? EXECUTION_INPUT_DIRECTORY).length === 0
  )
}

/**
 * Private input session for one approved operation. The listener is reserved
 * before a single `POST /input` is accepted, the body is streamed straight into
 * the trusted receiver (never buffered whole, never logged), and the CLI exits
 * only after the response is flushed — that exit is what lets Kubernetes start
 * the executor. The Pod UID header stops an IP-reuse or bystander caller; the
 * real authority stays with HCC admission and the network policy.
 */
export async function startReceiveSession(options: ReceiveSessionOptions): Promise<ReceiveSession> {
  if (invalidContract(options)) throw new ReceiveSessionError('invalid_session_contract')
  const {
    bytes,
    sha256,
    timeoutMs,
    podUid,
    directory = EXECUTION_INPUT_DIRECTORY,
    host = '0.0.0.0',
    port = EXECUTION_INPUT_PORT,
    graceMs = EXECUTION_INPUT_GRACE_MS,
    receive = receiveExecutionInput,
    onSettled,
  } = options

  let state: 'idle' | 'receiving' | 'received' | 'failed' = 'idle'
  let settled = false
  let deadline: NodeJS.Timeout | undefined
  let closing: Promise<void> | undefined

  const settle = (outcome: ReceiveSessionOutcome): void => {
    if (settled) return
    settled = true
    onSettled?.(outcome)
  }
  const authorized = (req: IncomingMessage): boolean =>
    req.headers[EXECUTION_INPUT_UID_HEADER] === podUid
  const reply = (res: ServerResponse, status: number): void => {
    res.statusCode = status
    res.setHeader(EXECUTION_INPUT_UID_HEADER, podUid)
    res.setHeader('cache-control', 'no-store')
    res.end()
  }
  // A caller without the exact Pod UID gets no body, no state change and no echo.
  const deny = (req: IncomingMessage, res: ServerResponse): void => {
    // Drain any body so a denied caller cannot reset the connection.
    req.resume()
    res.statusCode = 404
    res.end()
  }

  const server = createServer((req, res) => {
    if (!authorized(req)) {
      deny(req, res)
      return
    }
    if (req.method === 'GET' && req.url === '/ready') {
      if (state === 'received' || state === 'failed') {
        deny(req, res)
        return
      }
      reply(res, 204)
      return
    }
    if (req.method === 'POST' && req.url === '/input') {
      // The single POST context is consumed by the first accepted attempt; a
      // replay never re-runs the receiver and never replaces a published file.
      if (state !== 'idle') {
        req.resume()
        reply(res, 409)
        return
      }
      if (req.headers['content-type'] !== EXECUTION_INPUT_CONTENT_TYPE) {
        state = 'failed'
        req.resume()
        res.once('finish', () => settle('rejected'))
        reply(res, 415)
        return
      }
      state = 'receiving'
      receive(req, directory, bytes, sha256, timeoutMs).then(
        () => {
          state = 'received'
          res.once('finish', () => settle('received'))
          reply(res, 204)
        },
        () => {
          state = 'failed'
          // Fixed empty rejection: never the reason, the bytes or the digest.
          res.once('finish', () => settle('rejected'))
          reply(res, 400)
        }
      )
      return
    }
    deny(req, res)
  })
  server.headersTimeout = 5_000
  server.requestTimeout = 10_000
  server.keepAliveTimeout = 1_000
  server.maxConnections = 8

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch {
    throw new ReceiveSessionError('session_bind_failed')
  }

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port

  async function close(): Promise<void> {
    if (closing) return closing
    if (deadline) clearTimeout(deadline)
    closing = new Promise<void>(resolve => server.close(() => resolve()))
    // A stalled transfer holds a non-idle socket; drop it rather than wait.
    server.closeAllConnections()
    return closing
  }

  deadline = setTimeout(() => {
    // Finite life: a peer that stalls mid-transfer still ends the session.
    // The library only closes; the CLI owns the PID1 exit.
    void close()
    settle('rejected')
  }, timeoutMs + graceMs)

  return { port: boundPort, close }
}

if (require.main === module) {
  // CLI: <bytes> <sha256> <timeoutMs>. Nothing is printed: the input arrives
  // over the private listener; UID guards IP reuse, not caller authority.
  const podUid = process.env[EXECUTION_POD_UID_ENV] ?? ''
  const [rawBytes, rawSha256, rawTimeoutMs] = process.argv.slice(2)
  if (
    !/^\d+$/.test(rawBytes ?? '') ||
    !/^[0-9a-f]{64}$/.test(rawSha256 ?? '') ||
    !/^\d+$/.test(rawTimeoutMs ?? '')
  ) {
    process.exit(1)
  }
  startReceiveSession({
    bytes: Number(rawBytes),
    sha256: rawSha256,
    timeoutMs: Number(rawTimeoutMs),
    podUid,
    // Exit 0 only after a flushed 204: Kubernetes starts the executor then.
    onSettled: outcome => process.exit(outcome === 'received' ? 0 : 1),
  }).catch(() => process.exit(1))
}
