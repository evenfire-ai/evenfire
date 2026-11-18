import type fc from 'fast-check'
import { frameLine } from './fakeWatchServer.js'
import type { Decision } from './fakeWatchServer.js'

/**
 * The network boundary of the watch in memory, for the model test: a `fetch`
 * that answers with real WHATWG `Response` objects (so the real `requestJson`
 * and the real stream reader run on top of it), where every delivery (a
 * response, a frame, an EOF) is a task of a fast-check scheduler. Frames of one
 * stream keep their order; anything else may interleave.
 */

export type MGet = {
  n: number
  keys: string[]
  token: string
  signal: AbortSignal
  state: 'pending' | 'answered' | 'aborted'
  resolve: (r: Response) => void
  reject: (e: unknown) => void
  conn?: MConn
}
export type MPut = {
  n: number
  seq: number
  keys: string[]
  connId: string
  token: string
  signal: AbortSignal
  state: 'pending' | 'answered' | 'aborted'
  /** The client has the response (or the abort). */
  delivered: boolean
  resolve: (r: Response) => void
  reject: (e: unknown) => void
}
export type MConn = {
  connId: string
  getN: number
  keys: Set<string>
  lastSeq: number
  /** The stream is open for the client: not closed, errored or cancelled. */
  alive: boolean
  controller: ReadableStreamDefaultController<Uint8Array>
  chain: Promise<void>
  cmds: MPut[]
  readySent: boolean
  /** Written and not yet read by the client; the stream is pulled, so a frame is labelled when read. */
  queue: Array<{ label: string; item: Uint8Array | 'EOF' | 'ERROR' }>
  pull: (() => void) | null
}

const abortError = () => new DOMException('This operation was aborted', 'AbortError')
const encoder = new TextEncoder()

export class MemoryWatch {
  gets: MGet[] = []
  puts: MPut[] = []
  conns: MConn[] = []
  private connCounter = 0
  /** Label of the last response or frame handed to the client. */
  lastDelivered = ''
  /** Called as a response reaches a request the client has not aborted. */
  onDeliver:
    | ((
        d:
          | { kind: 'get'; rec: MGet; status: number | 'network' | 'noBody' }
          | { kind: 'put'; rec: MPut; status: number | 'network' }
      ) => void)
    | null = null
  /** Called when the client sends a PUT. */
  onPutRequest: ((rec: MPut) => void) | null = null

  constructor(private s: fc.Scheduler) {}

  fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const headers = new Headers(init?.headers)
    const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '')
    const signal = init?.signal ?? new AbortController().signal
    return new Promise<Response>((resolve, reject) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as {
          connId: string
          seq: number
          keys: string[]
        }
        const rec: MPut = {
          n: this.puts.length + 1,
          ...body,
          token,
          signal,
          state: 'pending',
          delivered: false,
          resolve,
          reject,
        }
        this.puts.push(rec)
        this.onPutRequest?.(rec)
        signal.addEventListener('abort', () => {
          if (rec.delivered) return
          rec.state = 'aborted'
          rec.delivered = true
          reject(abortError())
        })
      } else {
        const rec: MGet = {
          n: this.gets.length + 1,
          keys: url.searchParams.getAll('k'),
          token,
          signal,
          state: 'pending',
          resolve,
          reject,
        }
        this.gets.push(rec)
        signal.addEventListener('abort', () => {
          if (rec.state !== 'answered') {
            rec.state = 'aborted'
            reject(abortError())
          }
          if (rec.conn?.alive) {
            rec.conn.alive = false
            try {
              rec.conn.controller.error(abortError())
            } catch {
              // already closed
            }
          }
        })
      }
    })
  }

  pendingGets(): MGet[] {
    return this.gets.filter(g => g.state === 'pending' && !g.signal.aborted)
  }

  pendingPuts(): MPut[] {
    return this.puts.filter(p => p.state === 'pending' && !p.signal.aborted)
  }

  /** PUTs the client is still waiting on. */
  putsInFlight(): MPut[] {
    return this.puts.filter(p => !p.delivered && !p.signal.aborted)
  }

  liveConns(): MConn[] {
    return this.conns.filter(c => c.alive)
  }

  /** GETs alive from the client's point of view: waiting for an answer or streaming. */
  liveGets(): MGet[] {
    return this.gets.filter(g => (g.state === 'pending' && !g.signal.aborted) || g.conn?.alive)
  }

  private deliver(label: string, fn: () => void): void {
    void this.s.schedule(Promise.resolve(label), label).then(() => {
      this.lastDelivered = label
      fn()
    })
  }

  answerGetReady(
    rec: MGet,
    d: Decision,
    heartbeatMs = 20_000,
    opts: { skipReady?: boolean } = {}
  ): void {
    rec.state = 'answered'
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const conn: MConn = {
      connId: (++this.connCounter).toString(16).padStart(32, '0'),
      getN: rec.n,
      keys: new Set(d.accepted),
      lastSeq: 0,
      alive: true,
      controller: undefined as unknown as ReadableStreamDefaultController<Uint8Array>,
      chain: Promise.resolve(),
      cmds: [],
      readySent: !opts.skipReady,
      queue: [],
      pull: null,
    }
    const body = new ReadableStream<Uint8Array>(
      {
        start: c => {
          controller = c
        },
        pull: () =>
          new Promise<void>(resolve => {
            conn.pull = () => {
              conn.pull = null
              this.drainQueue(conn)
              resolve()
            }
            if (conn.queue.length > 0) conn.pull()
          }),
        cancel: () => {
          conn.alive = false
        },
      },
      { highWaterMark: 0 }
    )
    conn.controller = controller
    rec.conn = conn
    this.conns.push(conn)
    if (!opts.skipReady) {
      conn.queue.push({
        label: `${conn.connId} frame:ready`,
        item: encoder.encode(
          frameLine({ type: 'ready', connId: conn.connId, heartbeatMs, ...decision(d) })
        ),
      })
    }
    this.deliver(`GET#${rec.n} ready`, () =>
      rec.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
      )
    )
  }

  answerGet(
    rec: MGet,
    r: { status: number; code?: string; retryAfter?: string } | 'noBody' | 'network'
  ): void {
    rec.state = 'answered'
    this.deliver(
      `GET#${rec.n} ${typeof r === 'string' ? r : `${r.status} ${r.code ?? ''}`}`,
      () => {
        if (!rec.signal.aborted)
          this.onDeliver?.({ kind: 'get', rec, status: typeof r === 'string' ? r : r.status })
        if (r === 'network') return rec.reject(new TypeError('fetch failed'))
        if (r === 'noBody') return rec.resolve(new Response(null, { status: 204 }))
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (r.code) headers['x-watch-error'] = r.code
        if (r.retryAfter !== undefined) headers['retry-after'] = r.retryAfter
        rec.resolve(
          new Response(JSON.stringify({ error: r.code ?? 'error' }), { status: r.status, headers })
        )
      }
    )
  }

  /** Writes raw text on a stream after everything already written on it. */
  write(conn: MConn, raw: string | 'EOF' | 'ERROR'): void {
    conn.chain = conn.chain
      .then(() => this.s.schedule(Promise.resolve(), `${conn.connId} ${labelOf(raw)}`))
      .then(() => {
        if (!conn.alive) return
        conn.queue.push({
          label: `${conn.connId} ${labelOf(raw)}`,
          item: raw === 'EOF' || raw === 'ERROR' ? raw : encoder.encode(raw),
        })
        conn.pull?.()
      })
  }

  /** Hands the client the next written item, as it reads. */
  private drainQueue(conn: MConn): void {
    const next = conn.queue.shift()
    if (!next || !conn.alive) return
    this.lastDelivered = next.label
    try {
      if (next.item === 'EOF') {
        conn.alive = false
        conn.controller.close()
      } else if (next.item === 'ERROR') {
        conn.alive = false
        conn.controller.error(new TypeError('terminated'))
      } else {
        conn.controller.enqueue(next.item)
      }
    } catch {
      conn.alive = false
    }
  }

  /** The ready of a stream opened with `skipReady`, written later on it. */
  writeReady(conn: MConn, d: Decision, heartbeatMs = 20_000): void {
    if (conn.readySent) return
    conn.readySent = true
    conn.keys = new Set(d.accepted)
    this.frame(conn, { type: 'ready', connId: conn.connId, heartbeatMs, ...decision(d) })
  }

  frame(conn: MConn, f: Record<string, unknown>): void {
    this.write(conn, frameLine(f))
  }

  /**
   * Answers a PUT. A 2xx also hands the command to the owner of its
   * connection, which applies it later (`applyCommand`), independently of the
   * client seeing the 2xx.
   */
  answerPut(
    rec: MPut,
    r: { status: number; code?: string; retryAfter?: string; body?: string } | 'network'
  ): void {
    rec.state = 'answered'
    if (r !== 'network' && r.status >= 200 && r.status < 300) {
      const conn = this.conns.find(c => c.connId === rec.connId && c.alive)
      conn?.cmds.push(rec)
    }
    this.deliver(
      `PUT#${rec.n} ${typeof r === 'string' ? r : `${r.status} ${r.code ?? ''}`}`,
      () => {
        if (rec.delivered) return
        rec.delivered = true
        this.lastDelivered = `PUT#${rec.n} ${typeof r === 'string' ? r : `${r.status} ${r.code ?? ''}`}`
        this.onDeliver?.({ kind: 'put', rec, status: r === 'network' ? 'network' : r.status })
        if (r === 'network') return rec.reject(new TypeError('fetch failed'))
        const headers: Record<string, string> = {}
        if (r.retryAfter !== undefined) headers['retry-after'] = r.retryAfter
        const body =
          r.body ??
          (r.status >= 200 && r.status < 300
            ? JSON.stringify({ seq: rec.seq })
            : JSON.stringify({ error: r.code ?? 'error' }))
        rec.resolve(new Response(r.status === 204 ? null : body, { status: r.status, headers }))
      }
    )
  }

  /** The owning replica applies its newest command in the seq window and writes the decision. */
  applyCommand(conn: MConn, decide: (keys: string[]) => Decision): boolean {
    const cmd = conn.cmds
      .filter(c => c.seq > conn.lastSeq && c.seq <= conn.lastSeq + 1024)
      .sort((a, b) => b.seq - a.seq)[0]
    conn.cmds = []
    if (!cmd || !conn.alive) return false
    conn.lastSeq = cmd.seq
    const d = decide(cmd.keys)
    conn.keys = new Set(d.accepted)
    this.frame(conn, { type: 'subscriptions', seq: cmd.seq, ...decision(d) })
    return true
  }
}

/** `frame:<type>` or `frame:<type>:<reason>` for a frame line, the raw marker otherwise. */
function labelOf(raw: string): string {
  if (raw === 'EOF' || raw === 'ERROR') return raw
  try {
    const f = JSON.parse(raw) as { type?: unknown; reason?: unknown }
    return `frame:${String(f.type)}${typeof f.reason === 'string' ? `:${f.reason}` : ''}`
  } catch {
    return 'frame:invalid'
  }
}

function decision(d: Decision): Record<string, unknown> {
  return {
    accepted: d.accepted,
    rejected: d.rejected,
    deferred: d.deferred,
    ...(d.retryAfterMs === undefined ? {} : { retryAfterMs: d.retryAfterMs }),
  }
}
