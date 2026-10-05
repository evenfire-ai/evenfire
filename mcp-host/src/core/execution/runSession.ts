import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import { type ExecutionResult, MAX_EXECUTION_TIMEOUT_MS, runExecution } from './runExecution'

/** Fixed in-Pod port for the private result session. */
export const EXECUTION_RESULT_PORT = 9300
/** Downward-API variable carrying the real Pod UID of this Job Pod. */
export const EXECUTION_POD_UID_ENV = 'EXECUTION_POD_UID'
/** Exact UID header required on every result request and echoed on replies. */
export const EXECUTION_RESULT_UID_HEADER = 'x-execution-pod-uid'
/** One bounded result frame; the captured base64 output fits with headroom. */
export const EXECUTION_RESULT_MAX_BYTES = 96 * 1024
/** Total session life after the execution deadline. */
export const EXECUTION_SESSION_GRACE_MS = 60_000

export type ExecutionSessionErrorCode = 'invalid_session_contract' | 'session_bind_failed'

export class ExecutionSessionError extends Error {
  constructor(readonly code: ExecutionSessionErrorCode) {
    super(code)
    this.name = 'ExecutionSessionError'
  }
}

export interface ExecutionSessionOptions {
  timeoutMs: number
  argv: string[]
  podUid: string
  /** Tests bind loopback and port 0; the Pod uses the fixed port. */
  host?: string
  port?: number
  graceMs?: number
  /** Injectable for tests only; production always uses runExecution. */
  run?: (timeoutMs: number, argv: string[]) => Promise<ExecutionResult>
  /** Called once the session can no longer serve a result. */
  onClosed?: () => void
}

export interface ExecutionSession {
  readonly port: number
  close(): Promise<void>
}

const POD_UID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function invalidContract(options: ExecutionSessionOptions): boolean {
  return (
    !POD_UID_PATTERN.test(options.podUid) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > MAX_EXECUTION_TIMEOUT_MS ||
    !Number.isSafeInteger(options.graceMs ?? EXECUTION_SESSION_GRACE_MS) ||
    (options.graceMs ?? EXECUTION_SESSION_GRACE_MS) < 0 ||
    !Array.isArray(options.argv) ||
    options.argv.length === 0 ||
    typeof options.argv[0] !== 'string' ||
    options.argv[0].length === 0 ||
    options.argv.some(argument => typeof argument !== 'string' || argument.includes('\0'))
  )
}

/**
 * Private result session for one approved operation. The listener is reserved
 * before the command starts, serves exactly one bounded result frame to a
 * HCC over its private network lane. The UID prevents Pod-IP reuse; it is not
 * user authorization. HCC must separately validate the signed caller and the
 * original operation binding. Nothing is written to stdout, stderr or logs.
 *
 * A successful DELETE closes the session. Verified Pod runtime termination is
 * the physical cleanup boundary; HTTP or API absence alone does not prove it.
 */
export async function startExecutionSession(
  options: ExecutionSessionOptions
): Promise<ExecutionSession> {
  if (invalidContract(options)) throw new ExecutionSessionError('invalid_session_contract')
  const {
    timeoutMs,
    argv,
    podUid,
    host = '0.0.0.0',
    port = EXECUTION_RESULT_PORT,
    graceMs = EXECUTION_SESSION_GRACE_MS,
    run = runExecution,
    onClosed,
  } = options

  let state: 'running' | 'ready' | 'failed' = 'running'
  let frame: string | null = null
  let closed = false
  let deadline: NodeJS.Timeout | undefined
  let closing: Promise<void> | undefined

  const authorized = (req: IncomingMessage): boolean =>
    req.headers[EXECUTION_RESULT_UID_HEADER] === podUid
  const reply = (res: ServerResponse, status: number, body?: string): void => {
    res.statusCode = status
    res.setHeader(EXECUTION_RESULT_UID_HEADER, podUid)
    res.setHeader('cache-control', 'no-store')
    if (body === undefined) {
      res.end()
      return
    }
    res.setHeader('content-type', 'application/json')
    res.setHeader('content-length', String(Buffer.byteLength(body)))
    res.end(body)
  }
  // A caller without the exact Pod UID gets no body, no result and no UID echo.
  const deny = (res: ServerResponse): void => {
    res.statusCode = 404
    res.end()
  }

  const server = createServer((req, res) => {
    if (req.url !== '/result') {
      deny(res)
      return
    }
    if (!authorized(req)) {
      deny(res)
      return
    }
    if (req.method === 'GET') {
      if (state === 'running') {
        reply(res, 425)
        return
      }
      if (
        state === 'failed' ||
        frame === null ||
        Buffer.byteLength(frame) > EXECUTION_RESULT_MAX_BYTES
      ) {
        reply(res, 500)
        return
      }
      reply(res, 200, frame)
      return
    }
    if (req.method === 'DELETE') {
      frame = null
      reply(res, 204)
      // The caller reads the empty acknowledgement first; then the listener and
      // the PID1 lifetime end.
      res.on('finish', () => {
        void close()
      })
      return
    }
    deny(res)
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
    throw new ExecutionSessionError('session_bind_failed')
  }

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port

  async function close(): Promise<void> {
    if (closing) return closing
    closed = true
    if (deadline) clearTimeout(deadline)
    frame = null
    // Revocation must not wait indefinitely on a partial request or an active
    // download. The acknowledgement is already finished before DELETE calls
    // this path; outstanding result streams are invalidated by closure.
    closing = new Promise<void>(resolve => server.close(() => resolve())).then(() => {
      onClosed?.()
    })
    server.closeAllConnections()
    return closing
  }

  deadline = setTimeout(() => {
    // Finite life: the executor may never settle, so the session ends anyway.
    // The library only closes; the CLI owns the PID1 exit.
    void close()
  }, timeoutMs + graceMs)

  // The listener is already reserved; the approved command starts only now.
  run(timeoutMs, argv).then(
    result => {
      if (closed) return
      frame = JSON.stringify(result)
      state = 'ready'
    },
    () => {
      if (closed) return
      state = 'failed'
    }
  )

  return { port: boundPort, close }
}

if (require.main === module) {
  // CLI: <timeoutMs> <exe> [...args]. Nothing is printed: the result is served
  // over the private listener; network policy and HCC own caller authority.
  const podUid = process.env[EXECUTION_POD_UID_ENV] ?? ''
  const [rawTimeoutMs, ...approvedArgv] = process.argv.slice(2)
  const timeoutMs = Number(rawTimeoutMs)
  if (!/^\d+$/.test(rawTimeoutMs ?? '')) process.exit(1)
  startExecutionSession({
    timeoutMs,
    argv: approvedArgv,
    podUid,
    // The Pod is PID1 here: a served DELETE or the finite session deadline ends
    // it. The closed listener is not by itself proof of cleanup.
    onClosed: () => process.exit(0),
  }).catch(() => process.exit(1))
}
