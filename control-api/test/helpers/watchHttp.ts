import { type IncomingHttpHeaders, request as httpRequest } from 'node:http'

export type OpenedWatch = {
  status: number
  headers: IncomingHttpHeaders
  /** The parsed body of a non-streaming reply. */
  body: unknown
  /** The first NDJSON frame of a streaming 200. */
  firstFrame: Record<string, unknown> | null
  /** Destroys the request; a streaming reply stays open until this is called. */
  close(): void
}

/**
 * GET the GFS watch. A streaming reply resolves on its first frame and is left
 * open for the caller to close; any other reply resolves once its body ends.
 * Resolving early keeps a regression that admits the stream from surfacing
 * only as a test timeout.
 */
export function openWatch(url: string, headers: Record<string, string>): Promise<OpenedWatch> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'GET', headers })
    const close = () => req.destroy()
    req.on('response', res => {
      res.setEncoding('utf8')
      let buf = ''
      const streaming = String(res.headers['content-type']).startsWith('application/x-ndjson')
      res.on('data', (chunk: string) => {
        buf += chunk
        const nl = buf.indexOf('\n')
        if (streaming && nl >= 0) {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: null,
            firstFrame: JSON.parse(buf.slice(0, nl)) as Record<string, unknown>,
            close,
          })
        }
      })
      res.on('end', () => {
        if (streaming) return
        let body: unknown = null
        try {
          body = buf ? (JSON.parse(buf) as unknown) : null
        } catch {
          body = buf
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          firstFrame: null,
          close,
        })
      })
    })
    req.on('error', err => {
      if (!req.destroyed) reject(err)
    })
    req.end()
  })
}
