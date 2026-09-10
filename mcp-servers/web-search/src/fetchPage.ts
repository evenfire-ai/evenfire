import http, { type IncomingMessage } from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { checkServerIdentity as tlsCheck } from 'node:tls'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { parsePageUrl, resolvePageAddress } from './fetchPageDestination.js'
import { FetchPageError } from './fetchPageError.js'

export const FETCH_PAGE_LIMITS = Object.freeze({
  timeoutMs: 15000,
  maxBytes: 1024 * 1024,
  maxRedirects: 5,
  maxConcurrent: 4,
})
let active = 0 // Process-wide, including distinct MCP sessions.
const redirects = new Set([301, 302, 303, 307, 308])

/** Linear tag stripping, including malformed input with many unclosed '<'. */
export function pageText(html: string): string {
  const pieces: string[] = []
  let offset = 0
  while (offset < html.length) {
    const start = html.indexOf('<', offset)
    if (start === -1) {
      pieces.push(html.slice(offset))
      break
    }
    const end = html.indexOf('>', start + 1)
    if (end === -1) {
      pieces.push(html.slice(offset))
      break
    }
    pieces.push(html.slice(offset, start), ' ')
    offset = end + 1
  }
  return pieces.join('').replace(/\s+/g, ' ').trim()
}

function titleText(html: string): string {
  const lower = html.toLowerCase()
  const start = lower.indexOf('<title')
  if (start === -1 || !/[\s>]/.test(lower[start + 6] ?? '')) return ''
  const body = lower.indexOf('>', start + 6)
  const end = lower.indexOf('</title>', body + 1)
  return body < 0 || end < 0 ? '' : pageText(html.slice(body + 1, end))
}

function connect(url: URL, address: string, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const client = url.protocol === 'https:' ? https : http
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: address,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        method: 'GET',
        path: url.pathname + url.search,
        agent: false,
        signal,
        maxHeaderSize: 16 * 1024,
        headers: {
          Host: url.host,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Encoding': 'identity',
          'User-Agent': 'EvenfireWebSearch/1.0',
        },
        ...(url.protocol === 'https:'
          ? {
              servername: isIP(hostname) ? undefined : hostname,
              checkServerIdentity: (_host: string, cert: import('node:tls').PeerCertificate) =>
                // HTTPS connects to the pinned IP, but authenticates the URL host.
                tlsCheck(hostname, cert),
            }
          : {}),
      },
      resolve
    )
    req.once('error', reject)
    // A protocol switch does not emit a normal response. Explicitly release
    // its socket and settle the call; otherwise the concurrency slot can leak.
    req.once('upgrade', (_response, socket) => {
      socket.destroy()
      reject(new FetchPageError('upstream_failure'))
    })
    req.once('close', () => reject(new FetchPageError('upstream_failure')))
    req.end()
  })
}
async function readBody(res: IncomingMessage, signal: AbortSignal): Promise<string> {
  const length = res.headers['content-length']
  if (
    length !== undefined &&
    (!/^\d+$/.test(length) || Number(length) > FETCH_PAGE_LIMITS.maxBytes)
  ) {
    throw new FetchPageError('response_too_large')
  }
  const encoding = (res.headers['content-encoding'] ?? 'identity').trim().toLowerCase()
  const decoder =
    encoding === 'identity'
      ? undefined
      : encoding === 'gzip'
        ? createGunzip()
        : encoding === 'deflate'
          ? createInflate()
          : encoding === 'br'
            ? createBrotliDecompress()
            : null
  if (decoder === null) throw new FetchPageError('unsupported_encoding')
  let wireBytes = 0
  let decodedBytes = 0
  const chunks: Buffer[] = []
  const wire = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      wireBytes += chunk.length
      callback(
        wireBytes > FETCH_PAGE_LIMITS.maxBytes ? new FetchPageError('response_too_large') : null,
        chunk
      )
    },
  })
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      decodedBytes += chunk.length
      if (decodedBytes > FETCH_PAGE_LIMITS.maxBytes) {
        callback(new FetchPageError('response_too_large'))
        return
      }
      chunks.push(chunk)
      callback()
    },
  })
  if (decoder) await pipeline(res, wire, decoder, sink, { signal })
  else await pipeline(res, wire, sink, { signal })
  return Buffer.concat(chunks).toString('utf8')
}

export async function fetchPage(
  input: string,
  maxChars: number,
  callerSignal?: AbortSignal
): Promise<{ title: string; content: string }> {
  if (!Number.isInteger(maxChars) || maxChars < 100 || maxChars > 100000)
    throw new FetchPageError('invalid_url')
  if (active >= FETCH_PAGE_LIMITS.maxConcurrent) throw new FetchPageError('busy')
  active++
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new FetchPageError('deadline_exceeded')),
    FETCH_PAGE_LIMITS.timeoutMs
  )
  const cancel = () => controller.abort(new FetchPageError('cancelled'))
  if (callerSignal?.aborted) cancel()
  else callerSignal?.addEventListener('abort', cancel, { once: true })
  const seen = new Set<string>()
  try {
    let url = parsePageUrl(input)
    for (let hop = 0; ; hop++) {
      controller.signal.throwIfAborted()
      if (seen.has(url.href)) throw new FetchPageError('redirect_limit')
      seen.add(url.href)
      const address = await resolvePageAddress(url, controller.signal)
      const res = await connect(url, address, controller.signal)
      try {
        if (redirects.has(res.statusCode ?? 0)) {
          if (hop >= FETCH_PAGE_LIMITS.maxRedirects) throw new FetchPageError('redirect_limit')
          const location = res.headers.location
          if (!location) throw new FetchPageError('upstream_failure')
          let next: URL
          try {
            next = parsePageUrl(new URL(location, url).href)
          } catch {
            throw new FetchPageError('invalid_url')
          }
          if (url.protocol === 'https:' && next.protocol !== 'https:')
            throw new FetchPageError('destination_blocked')
          url = next
          // Do not consume untrusted redirect bodies at all. No bytes from
          // intermediate responses enter our accumulated body buffers.
          continue
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300)
          throw new FetchPageError('upstream_failure')
        const html = await readBody(res, controller.signal)
        controller.signal.throwIfAborted()
        return {
          title: titleText(html).slice(0, maxChars),
          content: pageText(html).slice(0, maxChars),
        }
      } finally {
        res.destroy()
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    throw error instanceof FetchPageError ? error : new FetchPageError('upstream_failure')
  } finally {
    clearTimeout(timeout)
    callerSignal?.removeEventListener('abort', cancel)
    active--
  }
}
