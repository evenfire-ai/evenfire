import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseKeys } from '../../../control-api/src/services/gfsWatch/keys.js'
import { wireLedger } from './wireLedger.js'

/**
 * A stand-in for ERA + control-api on GET/PUT `/api/v1/me/gfs/watch`, over a
 * real HTTP server so the client runs its real `fetch` and `requestJson`.
 *
 * Wire shapes follow the producers, which cannot be imported into this package
 * (control-api and ERA have no dependencies installed for it):
 * - frames: `JSON.stringify({schemaVersion: 1, ...frame}) + '\n'`, as the
 *   registry's `send` and `finishOp` write them (gfsWatch/registry.ts), with
 *   the `ready`/`subscriptions` decision fields and `retryAfterMs` only when set;
 * - errors: `x-watch-error: <code>` plus `{"error": <code>}` and an optional
 *   `Retry-After` in seconds, as `reply` writes them (gfsWatch.routes.ts) and
 *   ERA relays them;
 * - `connId` is 16 random bytes in hex, as the registry mints it;
 * - the PUT body is validated as control-api's `putBodySchema` plus its own
 *   `parseKeys` (imported: it has no runtime dependencies), answering 400
 *   `bad_request` otherwise;
 * - the PUT answers 202 `{seq}` and the decision arrives later as a
 *   `subscriptions` frame; a command outside the seq window is dropped
 *   silently, as the registry's `onCmd` does.
 */

export type Decision = {
  accepted: string[]
  rejected: string[]
  deferred: string[]
  retryAfterMs?: number
}
export type Decide = (keys: string[]) => Decision
export const acceptAll: Decide = keys => ({ accepted: keys, rejected: [], deferred: [] })

export type GetPolicy =
  | { kind: 'ready'; heartbeatMs?: number; decide?: Decide }
  | { kind: 'error'; status: number; code?: string; retryAfter?: string }
  | { kind: 'noBody'; status: number }
  /** 200 with stream headers and no ready: the test writes the lines. */
  | { kind: 'stream' }
  | { kind: 'redirect'; location: string }
  | { kind: 'hold' }
  | { kind: 'destroy' }

export type PutPolicy =
  | { kind: 'accept'; decide?: Decide; frame?: boolean }
  | { kind: 'error'; status: number; code?: string; retryAfter?: string }
  | { kind: 'raw'; status: number; body: string; contentType?: string }
  | { kind: 'hold' }
  | { kind: 'destroy' }

export type Conn = {
  connId: string
  res: http.ServerResponse
  keys: Set<string>
  lastSeq: number
  alive: boolean
  heartbeatMs: number
}

export type GetRec = {
  n: number
  keys: string[]
  token: string
  res: http.ServerResponse
  closed: boolean
  conn?: Conn
}
export type PutRec = {
  n: number
  seq: number
  keys: string[]
  connId: string
  token: string
  res: http.ServerResponse
  closed: boolean
  answered: boolean
}

export const SEQ_WINDOW = 1024

export function frameLine(frame: Record<string, unknown>): string {
  return `${JSON.stringify({ schemaVersion: 1, ...frame })}\n`
}

function decisionFields(d: Decision): Record<string, unknown> {
  return {
    accepted: d.accepted,
    rejected: d.rejected,
    deferred: d.deferred,
    ...(d.retryAfterMs === undefined ? {} : { retryAfterMs: d.retryAfterMs }),
  }
}

const CONN_ID_RE = /^[0-9a-f]{32}$/

/** control-api's `putBodySchema` followed by `parseKeys`. */
function isValidPutBody(b: unknown): b is { connId: string; seq: number; keys: string[] } {
  if (b === null || typeof b !== 'object') return false
  const o = b as Record<string, unknown>
  return (
    typeof o.connId === 'string' &&
    CONN_ID_RE.test(o.connId) &&
    Number.isSafeInteger(o.seq) &&
    (o.seq as number) > 0 &&
    Array.isArray(o.keys) &&
    o.keys.length <= 64 &&
    parseKeys(o.keys) !== null
  )
}

export class FakeWatchServer {
  private server = http.createServer((req, res) => this.handle(req, res))
  baseUrl = ''
  gets: GetRec[] = []
  puts: PutRec[] = []
  /** Every PUT body as the client sent it, recorded before validation. */
  putBodies: string[] = []
  conns: Conn[] = []
  getPolicy: (rec: GetRec) => GetPolicy = () => ({ kind: 'ready' })
  putPolicy: (rec: PutRec) => PutPolicy = () => ({ kind: 'accept' })
  private newConnId(): string {
    return randomBytes(16).toString('hex')
  }

  async start(): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve))
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  /** The newest stream still open. */
  current(): Conn | undefined {
    return [...this.conns].reverse().find(c => c.alive)
  }

  openStreams(): Conn[] {
    return this.conns.filter(c => c.alive)
  }

  /** PUT requests whose response is still pending and whose socket is open. */
  openPuts(): PutRec[] {
    return this.puts.filter(p => !p.answered && !p.closed)
  }

  /** Bytes as given: a test can cut a line, or a character, between two writes. */
  write(raw: string | Uint8Array, conn = this.current()): void {
    if (conn?.alive) conn.res.write(raw)
  }

  frame(frame: Record<string, unknown>, conn = this.current()): void {
    this.write(frameLine(frame), conn)
  }

  eof(conn = this.current()): void {
    if (conn?.alive) conn.res.end()
  }

  destroyStream(conn = this.current()): void {
    conn?.res.destroy()
  }

  /** Applies a PUT the way the owning replica does, and writes its `subscriptions`. */
  applyCommand(rec: PutRec, decide: Decide = acceptAll, writeFrame = true): void {
    const conn = this.conns.find(c => c.connId === rec.connId && c.alive)
    if (!conn) return
    if (rec.seq <= conn.lastSeq || rec.seq > conn.lastSeq + SEQ_WINDOW) return
    conn.lastSeq = rec.seq
    const d = decide(rec.keys)
    conn.keys = new Set(d.accepted)
    if (writeFrame) this.frame({ type: 'subscriptions', seq: rec.seq, ...decisionFields(d) }, conn)
  }

  answerPut(rec: PutRec, policy: PutPolicy): void {
    if (rec.answered || rec.closed) return
    rec.answered = true
    const res = rec.res
    switch (policy.kind) {
      case 'accept':
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ seq: rec.seq }))
        setImmediate(() => this.applyCommand(rec, policy.decide, policy.frame !== false))
        return
      case 'error': {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (policy.code) headers['x-watch-error'] = policy.code
        if (policy.retryAfter !== undefined) headers['retry-after'] = policy.retryAfter
        res.writeHead(policy.status, headers)
        res.end(JSON.stringify({ error: policy.code ?? 'error' }))
        return
      }
      case 'raw':
        res.writeHead(
          policy.status,
          policy.contentType ? { 'content-type': policy.contentType } : {}
        )
        res.end(policy.body)
        return
      case 'destroy':
        res.destroy()
        return
      case 'hold':
        rec.answered = false
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://x')
    const auth = String(req.headers.authorization ?? '')
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    // Tapped before routing, so a tagged request to any path is swept once both ends are done.
    const received = wireLedger.tapServer(req, res)
    if (url.pathname !== '/api/v1/me/gfs/watch') {
      res.writeHead(404).end()
      return
    }
    if (req.method === 'GET') this.onGet(url, token, res, received)
    else if (req.method === 'PUT') this.onPut(req, token, res, received)
    else res.writeHead(405).end()
  }

  private onGet(
    url: URL,
    token: string,
    res: http.ServerResponse,
    received: (() => void) | undefined
  ): void {
    const rec: GetRec = {
      n: this.gets.length + 1,
      keys: url.searchParams.getAll('k'),
      token,
      res,
      closed: false,
    }
    this.gets.push(rec)
    received?.()
    res.on('close', () => {
      rec.closed = true
      if (rec.conn) rec.conn.alive = false
    })
    this.answerGet(rec, this.getPolicy(rec))
  }

  /** Answers a GET, e.g. one held earlier with `{kind: 'hold'}`. */
  answerGet(rec: GetRec, policy: GetPolicy): void {
    const res = rec.res
    if (rec.closed) return
    switch (policy.kind) {
      case 'stream': {
        const conn: Conn = {
          connId: this.newConnId(),
          res,
          keys: new Set(),
          lastSeq: 0,
          alive: true,
          heartbeatMs: 20_000,
        }
        rec.conn = conn
        this.conns.push(conn)
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
        res.flushHeaders()
        return
      }
      case 'ready': {
        const heartbeatMs = policy.heartbeatMs ?? 20_000
        const conn: Conn = {
          connId: this.newConnId(),
          res,
          keys: new Set(),
          lastSeq: 0,
          alive: true,
          heartbeatMs,
        }
        const d = (policy.decide ?? acceptAll)(rec.keys)
        conn.keys = new Set(d.accepted)
        rec.conn = conn
        this.conns.push(conn)
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        })
        res.flushHeaders()
        res.write(
          frameLine({ type: 'ready', connId: conn.connId, heartbeatMs, ...decisionFields(d) })
        )
        return
      }
      case 'error': {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (policy.code) headers['x-watch-error'] = policy.code
        if (policy.retryAfter !== undefined) headers['retry-after'] = policy.retryAfter
        res.writeHead(policy.status, headers)
        res.end(JSON.stringify({ error: policy.code ?? 'error' }))
        return
      }
      case 'redirect':
        res.writeHead(302, { location: policy.location })
        res.end()
        return
      case 'noBody':
        res.writeHead(policy.status)
        res.end()
        return
      case 'destroy':
        res.destroy()
        return
      case 'hold':
        return
    }
  }

  private onPut(
    req: http.IncomingMessage,
    token: string,
    res: http.ServerResponse,
    received: (() => void) | undefined
  ): void {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => (raw += chunk))
    req.on('end', () => {
      this.putBodies.push(raw)
      let body: { connId: string; seq: number; keys: string[] } | null = null
      try {
        body = JSON.parse(raw) as { connId: string; seq: number; keys: string[] }
      } catch {
        body = null
      }
      if (!isValidPutBody(body)) {
        res.writeHead(400, { 'content-type': 'application/json', 'x-watch-error': 'bad_request' })
        res.end(JSON.stringify({ error: 'bad_request' }))
        return
      }
      const rec: PutRec = {
        n: this.puts.length + 1,
        seq: body.seq,
        keys: body.keys,
        connId: body.connId,
        token,
        res,
        closed: false,
        answered: false,
      }
      this.puts.push(rec)
      received?.()
      res.on('close', () => (rec.closed = true))
      this.answerPut(rec, this.putPolicy(rec))
    })
  }
}
