import type http from 'node:http'

/**
 * The watch harnesses' record of every request their clients send to a
 * `FakeWatchServer`, from both ends of the wire, so `settle()` can tell a
 * quiet system from one with I/O still in flight. A request sent but not yet
 * received, a response written but not yet read, and a close the other end
 * has not yet seen change no field of a harness signature; without this record
 * `settle()` would return while they are still on their way.
 *
 * One module instance per test file serves every harness and every server,
 * including servers a test builds outside a harness. It imports nothing from
 * the test runner: `test/native/gfs-watch-ipc.fixture.ts` loads
 * `FakeWatchServer` under Electron, and requests without the header are ignored.
 */

const WIRE_HEADER = 'x-harness-wire'

type WireEntry = {
  id: string
  method: string
  path: string
  /** The test that sent the request, so a leftover names its owner. */
  owner: string
  /** The request reached a tapped server, which will report its response's close. */
  tapped: boolean
  /** The server's handler took the request (GET: on arrival; PUT: once its body is read). */
  received: boolean
  /** The server wrote the status line. */
  headersOut: boolean
  /** The client's `fetch` resolved with the response head. */
  responded: boolean
  bytesOut: number
  bytesIn: number
  /** The server's response emitted `close`: ended and flushed, or destroyed. */
  serverClosed: boolean
  /** The client is done with it: rejected, settled, body ended, errored or cancelled. */
  clientDone: boolean
}

type InTransit = { id: string; method: string; path: string; owner: string; phase: string }

type PutOptions = { token?: string; body: unknown; signal: AbortSignal; timeoutMs: number }
type PutWithHeaders = (
  method: 'PUT',
  url: string,
  options: PutOptions & { headers?: Record<string, string> }
) => Promise<unknown>
type PutTransport = (method: 'PUT', url: string, options: PutOptions) => Promise<unknown>

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

class WireLedger {
  private entries = new Map<string, WireEntry>()
  private counter = 0

  private open(method: string, url: string, owner: string): WireEntry {
    const id = `w${++this.counter}`
    const entry: WireEntry = {
      id,
      method,
      path: new URL(url).pathname,
      owner,
      tapped: false,
      received: false,
      headersOut: false,
      responded: false,
      bytesOut: 0,
      bytesIn: 0,
      serverClosed: false,
      clientDone: false,
    }
    this.entries.set(id, entry)
    return entry
  }

  /**
   * Removes an entry once both ends are done with it: the client, and the
   * server when the request reached a tapped one. A response that never went
   * through `tapServer` (a stubbed `fetch`) has no server end to wait for.
   */
  private sweep(entry: WireEntry): void {
    if (entry.clientDone && (!entry.tapped || entry.serverClosed)) this.entries.delete(entry.id)
  }

  private clientDone(entry: WireEntry): void {
    entry.clientDone = true
    this.sweep(entry)
  }

  /**
   * A `fetch` that tags each request and counts its response body as the
   * client reads it. `inner` is looked up at call time, so a test's stub of
   * the global `fetch` still applies.
   */
  fetch(
    owner: () => string,
    inner: typeof fetch = (input, init) => fetch(input, init)
  ): typeof fetch {
    return (input, init) => {
      // As `fetch` does, `init` overrides a `Request`'s method, and its headers replace the Request's.
      const request = input instanceof Request ? input : undefined
      const entry = this.open(init?.method ?? request?.method ?? 'GET', urlOf(input), owner())
      const headers = new Headers(init?.headers ?? request?.headers)
      headers.set(WIRE_HEADER, entry.id)
      let pending: Promise<Response>
      try {
        pending = inner(input, { ...init, headers })
      } catch (error) {
        this.clientDone(entry)
        throw error
      }
      return pending.then(
        res => {
          try {
            return this.counted(entry, res)
          } catch (error) {
            this.clientDone(entry)
            throw error
          }
        },
        error => {
          this.clientDone(entry)
          throw error
        }
      )
    }
  }

  /** The response with a body that counts the bytes the client pulls from it. */
  private counted(entry: WireEntry, res: Response): Response {
    entry.responded = true
    if (res.body === null) {
      // A null-body status (204) cannot be rebuilt with a stream; nothing is left to read.
      this.clientDone(entry)
      return res
    }
    const reader = res.body.getReader()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull: async controller => {
          let chunk: ReadableStreamReadResult<Uint8Array>
          try {
            chunk = await reader.read()
          } catch (error) {
            this.clientDone(entry)
            throw error
          }
          if (cancelled) return
          if (chunk.done) {
            this.clientDone(entry)
            controller.close()
            return
          }
          entry.bytesIn += chunk.value.byteLength
          controller.enqueue(chunk.value)
        },
        cancel: reason => {
          cancelled = true
          this.clientDone(entry)
          // The server sees its response close only once the original body is cancelled.
          return reader.cancel(reason)
        },
      },
      { highWaterMark: 0 }
    )
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }

  /** A `requestJson` for the PUT that tags each request; done when it settles. */
  requestJson(owner: () => string, inner: PutWithHeaders): PutTransport {
    return (method, url, options) => {
      const entry = this.open(method, url, owner())
      let pending: Promise<unknown>
      try {
        pending = inner(method, url, { ...options, headers: { [WIRE_HEADER]: entry.id } })
      } catch (error) {
        this.clientDone(entry)
        throw error
      }
      return pending.then(
        value => {
          this.clientDone(entry)
          return value
        },
        error => {
          this.clientDone(entry)
          throw error
        }
      )
    }
  }

  /**
   * Taps a server response of a tagged request; returns the call that marks
   * it received, or `undefined` for a request without the header.
   */
  tapServer(req: http.IncomingMessage, res: http.ServerResponse): (() => void) | undefined {
    const id = req.headers[WIRE_HEADER]
    const entry = typeof id === 'string' ? this.entries.get(id) : undefined
    if (!entry) return undefined
    entry.tapped = true
    const byteLength = (chunk: unknown): number =>
      typeof chunk === 'string'
        ? Buffer.byteLength(chunk)
        : chunk instanceof Uint8Array
          ? chunk.byteLength
          : 0
    const writeHead = res.writeHead
    const write = res.write
    const end = res.end
    res.writeHead = function (this: http.ServerResponse, ...args: unknown[]) {
      entry.headersOut = true
      return (writeHead as (...a: unknown[]) => http.ServerResponse).apply(this, args)
    } as typeof res.writeHead
    res.write = function (this: http.ServerResponse, ...args: unknown[]) {
      entry.headersOut = true
      entry.bytesOut += byteLength(args[0])
      return (write as (...a: unknown[]) => boolean).apply(this, args)
    } as typeof res.write
    res.end = function (this: http.ServerResponse, ...args: unknown[]) {
      entry.headersOut = true
      if (typeof args[0] !== 'function') entry.bytesOut += byteLength(args[0])
      return (end as (...a: unknown[]) => http.ServerResponse).apply(this, args)
    } as typeof res.end
    res.on('close', () => {
      entry.serverClosed = true
      this.sweep(entry)
    })
    return () => {
      entry.received = true
    }
  }

  /** Every tracked request still on its way, with the step it waits on. */
  inTransit(): InTransit[] {
    const out: InTransit[] = []
    for (const e of this.entries.values()) {
      const phase = e.clientDone
        ? 'server close not seen'
        : !(e.received || e.headersOut || e.responded)
          ? 'not received'
          : e.headersOut && !e.responded
            ? 'response head not read'
            : e.bytesOut > e.bytesIn
              ? `body unread (${e.bytesOut - e.bytesIn} bytes)`
              : e.serverClosed
                ? 'end not read'
                : null
      if (phase) out.push({ id: e.id, method: e.method, path: e.path, owner: e.owner, phase })
    }
    return out
  }
}

export const wireLedger = new WireLedger()

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Waits until no tracked request is in transit and `signature()` is the same
 * for three rounds of real I/O in a row; throws once `maxMs` passes without that.
 */
export async function settle(opts: { signature: () => string; maxMs?: number }): Promise<void> {
  const maxMs = opts.maxMs ?? 3_000
  const started = Date.now()
  let last = ''
  let stable = 0
  let transit: InTransit[] = []
  while (Date.now() - started < maxMs) {
    await new Promise<void>(resolve => setImmediate(resolve))
    await sleep(2)
    transit = wireLedger.inTransit()
    const s = opts.signature()
    if (transit.length === 0 && s === last) {
      stable += 1
      if (stable >= 3) return
    } else {
      stable = 0
      last = s
    }
  }
  const pending = transit.map(t => `${t.id} ${t.method} ${t.path} (${t.phase}; ${t.owner})`)
  throw new Error(
    `settle: not quiet after ${maxMs} ms; in transit: [${pending.join(', ')}]; last signature: ${last}`
  )
}
