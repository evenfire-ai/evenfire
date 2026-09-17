/**
 * Body-budget tests for the rpc-proxy JSON parser.
 *
 * Proves on a real listening `createApp()` socket:
 *  - `POST /api/v1/rpc/hosts/:hostRef/messages` carries the documented image
 *    payloads (a 10MiB image, a 5MiB JPEG, 10MiB + 5MiB, and three 5MiB images) to the auth
 *    boundary instead of being rejected as too large.
 *  - The larger ceiling is NOT a general text allowance: non-image bytes stay
 *    capped at 6MiB, and every other route keeps its 6MiB parser.
 *  - The sandbox-ui view proxy stays parser-free, so http-proxy can stream the
 *    raw body upstream instead of the parser draining it.
 *
 * Auth is deliberately NOT mocked. A 401 is the proof that the body crossed the
 * parser and only the auth boundary stopped it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { createApp } from '../app.js'

const MIB = 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

let baseUrl: string
let server: Server

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise<void>(resolve => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  // The view-proxy case aborts a request mid-body, so drop any socket that is
  // still open: a listener left behind here would surface as a parse error in
  // whichever sibling test file ran next.
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

const pngBase64Cache = new Map<number, string>()
const jpegBase64Cache = new Map<number, string>()

function imageBase64(cache: Map<number, string>, signature: Buffer, sizeBytes: number): string {
  const cached = cache.get(sizeBytes)
  if (cached !== undefined) return cached
  const bytes = Buffer.alloc(sizeBytes)
  signature.copy(bytes, 0)
  bytes.fill(0x41, signature.length)
  const encoded = bytes.toString('base64')
  cache.set(sizeBytes, encoded)
  return encoded
}

/** Canonical base64 of a PNG whose decoded length is exactly `sizeBytes`. */
function pngBase64(sizeBytes: number): string {
  return imageBase64(pngBase64Cache, PNG_SIGNATURE, sizeBytes)
}

/** Canonical base64 of a JPEG whose decoded length is exactly `sizeBytes`. */
function jpegBase64(sizeBytes: number): string {
  return imageBase64(jpegBase64Cache, JPEG_SIGNATURE, sizeBytes)
}

/**
 * Flip a spare bit inside the final padded sextet. The payload still decodes to
 * the same length, but it is no longer the canonical encoding of those bytes,
 * so nothing may be credited for it.
 */
function withNonCanonicalTailBits(base64: string): string {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  if (padding === 0) throw new Error('fixture expects a padded base64 payload')
  const lastIndex = base64.length - 1 - padding
  const value = BASE64_ALPHABET.indexOf(base64[lastIndex]!)
  if (value < 0) throw new Error('fixture expects a base64 alphabet character')
  const mutated = BASE64_ALPHABET[value | 1]!
  return base64.slice(0, lastIndex) + mutated + base64.slice(lastIndex + 1)
}

function imageAttachment(
  id: string,
  sizeBytes: number,
  mimeType: 'image/png' | 'image/jpeg' = 'image/png'
) {
  const isJpeg = mimeType === 'image/jpeg'
  return {
    id,
    kind: 'image',
    mimeType,
    encoding: 'base64',
    dataBase64: isJpeg ? jpegBase64(sizeBytes) : pngBase64(sizeBytes),
    filename: `${id}.${isJpeg ? 'jpg' : 'png'}`,
  }
}

async function post(path: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

const MESSAGE_PATH = '/api/v1/rpc/hosts/chatllm/messages'

async function postMessage(payload: unknown): Promise<Response> {
  return post(MESSAGE_PATH, JSON.stringify(payload))
}

describe('rpc-proxy chat message body budget', () => {
  it('carries a 10MiB image (the per-image limit) to the auth boundary', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 10 * MIB)],
    })
    // 10MiB of bytes encodes to more than 13MiB, well past the old 6MiB parser.
    expect(Buffer.byteLength(body)).toBeGreaterThan(13 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(401)
  })

  it('carries a 5MiB JPEG to the auth boundary', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 5 * MIB, 'image/jpeg')],
    })
    expect(Buffer.byteLength(body)).toBeGreaterThan(6 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(401)
  })

  it('carries 10MiB PNG + 5MiB JPEG to the auth boundary', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 10 * MIB), imageAttachment('a2', 5 * MIB, 'image/jpeg')],
    })
    expect(Buffer.byteLength(body)).toBeGreaterThan(20 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(401)
  })

  it('carries 10MiB + 5MiB (the 15MiB total limit) to the auth boundary', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 10 * MIB), imageAttachment('a2', 5 * MIB)],
    })
    expect(Buffer.byteLength(body)).toBeGreaterThan(20 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(401)
  })

  it('carries three 5MiB images to the auth boundary', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: [
        imageAttachment('a1', 5 * MIB),
        imageAttachment('a2', 5 * MIB),
        imageAttachment('a3', 5 * MIB),
      ],
    })
    expect(Buffer.byteLength(body)).toBeGreaterThan(20 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(401)
  })

  it('rejects a single image over the 10MiB per-image limit', async () => {
    // Fits the 24MiB body ceiling, so this rejection is the budget gate, not the
    // parser: an uncredited 11MiB image is charged to the 6MiB non-image budget.
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 11 * MIB)],
    })
    expect(Buffer.byteLength(body)).toBeLessThan(24 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(413)
  })

  it('rejects two 10MiB images because together they exceed the 15MiB total', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 10 * MIB), imageAttachment('a2', 10 * MIB)],
    })
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(413)
  })

  it('rejects two 8MiB images on the 15MiB total alone, under the 24MiB ceiling', async () => {
    // Each image is under the 10MiB per-image limit and the body fits the 24MiB
    // ceiling, so the only rule that can reject this pair is the 15MiB total:
    // the over-total image is not credited and lands on the 6MiB non-image budget.
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 8 * MIB), imageAttachment('a2', 8 * MIB)],
    })
    expect(Buffer.byteLength(body)).toBeLessThan(24 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(413)
  })

  it('still rejects text-only content over the 6MiB non-image budget', async () => {
    const response = await postMessage({ content: 'x'.repeat(7 * MIB), attachments: [] })
    expect(response.status).toBe(413)
  })

  it('rejects a body past the 24MiB ceiling', async () => {
    const response = await postMessage({ content: 'x'.repeat(25 * MIB), attachments: [] })
    expect(response.status).toBe(413)
  })

  it('does not credit an attachment that only claims to be an image', async () => {
    // Same byte count as the accepted single-image case, but the payload is not
    // a real PNG, so it must be charged to the non-image budget.
    const body = JSON.stringify({
      content: 'look',
      attachments: [
        {
          id: 'a1',
          kind: 'image',
          mimeType: 'image/png',
          encoding: 'base64',
          dataBase64: Buffer.alloc(5 * MIB, 0x41).toString('base64'),
        },
      ],
    })
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(413)
  })

  it('does not credit base64 whose padding carries non-zero unused bits', async () => {
    const canonical = pngBase64(5 * MIB)
    const nonCanonical = withNonCanonicalTailBits(canonical)
    // Sanity: permissive decoding still yields the same bytes, so the only
    // thing that can reject this payload is the canonical-encoding rule.
    expect(Buffer.from(nonCanonical, 'base64').length).toBe(Buffer.from(canonical, 'base64').length)
    // Without the rule this body would be accepted (base64 ~7MiB minus the
    // credited image leaves ~1MiB of content), so 413 proves no credit.
    const response = await postMessage({
      content: 'x'.repeat(MIB),
      attachments: [
        {
          id: 'a1',
          kind: 'image',
          mimeType: 'image/png',
          encoding: 'base64',
          dataBase64: nonCanonical,
        },
      ],
    })
    expect(response.status).toBe(413)
  })

  it('keeps the 6MiB parser on every other POST route', async () => {
    const response = await post(
      '/api/v1/rpc/hosts/chatllm/wake',
      JSON.stringify({ a: 'x'.repeat(7 * MIB) })
    )
    expect(response.status).toBe(413)
  })

  it('leaves the sandbox-ui view proxy parser-free so its stream is not drained', async () => {
    // A JSON parser on this path would answer 413 for any body over its limit,
    // because parsing has to consume the stream http-proxy needs to forward.
    // The route answers its cookie check first, so the observable proof is a
    // non-413 outcome while the request body is still unread.
    const abortController = new AbortController()
    const chunk = new Uint8Array(64 * 1024).fill(0x41)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 8 * MIB) return // hold the request open; never finish it
        sent += chunk.length
        controller.enqueue(chunk)
      },
    })
    try {
      const response = await fetch(`${baseUrl}/api/v1/sandbox-ui/ns/recipe/view/index.html`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body,
        duplex: 'half',
        signal: abortController.signal,
      } as RequestInit & { duplex: 'half' })
      expect(response.status).not.toBe(413)
      expect(response.status).toBe(401)
    } finally {
      abortController.abort()
    }
  })
})
