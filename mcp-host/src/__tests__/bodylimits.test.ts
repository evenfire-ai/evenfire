/**
 * Body-budget tests for the mcp-host runtime JSON parser.
 *
 * Proves on a real listening `RPCServer` socket:
 *  - `POST /v1/runtime/messages` carries the documented image payloads (a 10MiB
 *    image, a 5MiB JPEG, 10MiB + 5MiB, and three 5MiB images) to the message handler instead
 *    of being rejected as too large.
 *  - The attachments arrive byte-identical: nothing is dropped, truncated or
 *    re-encoded on the way through the parser.
 *  - The larger ceiling is NOT a general text allowance: non-image bytes stay
 *    capped at 6MiB, and every other route keeps its 6MiB parser.
 *
 * The auth boundary is exercised in its documented "auth disabled" test mode
 * (`CLERUM_ENABLE_AUTH=false`), matching server.attachments.test.ts; the edge
 * identity headers are the same ones rpc-proxy injects.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'net'
import { createRequire } from 'node:module'
import type { IncomingMessage } from '../server/types'

const { declaredHeaderPngOfSize, jpegOfSize } = createRequire(__filename)(
  '../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs'
) as {
  declaredHeaderPngOfSize: (targetBytes: number) => Buffer
  jpegOfSize: (targetBytes: number, width?: number, height?: number) => Buffer
}

const MIB = 1024 * 1024
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

let baseUrl: string
let server: { start(): Promise<void>; stop(): Promise<void> }
let captured: IncomingMessage[] = []

beforeAll(async () => {
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'chatllm'
  vi.resetModules()
  // config reads auth settings at module load, so import after the test env is set.
  const { RPCServer } = await import('../server')
  const rpcServer = new RPCServer(0)
  rpcServer.onMessage(async (message: IncomingMessage) => {
    captured.push(message)
    return { success: true, status: 'completed', response: 'ok' }
  })
  await rpcServer.start()
  server = rpcServer
  const address = (rpcServer as unknown as { server: { address(): AddressInfo } }).server.address()
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await server.stop()
})

const pngBase64Cache = new Map<number, string>()
const jpegBase64Cache = new Map<number, string>()

function cachedBase64(cache: Map<number, string>, bytes: Buffer, sizeBytes: number): string {
  const cached = cache.get(sizeBytes)
  if (cached !== undefined) return cached
  const encoded = bytes.toString('base64')
  cache.set(sizeBytes, encoded)
  return encoded
}

/** Canonical base64 of a contract-framed PNG of exactly `sizeBytes`. */
function pngBase64(sizeBytes: number): string {
  return cachedBase64(pngBase64Cache, declaredHeaderPngOfSize(sizeBytes), sizeBytes)
}

/** Canonical base64 of a contract-framed JPEG of exactly `sizeBytes`. */
function jpegBase64(sizeBytes: number): string {
  return cachedBase64(jpegBase64Cache, jpegOfSize(sizeBytes), sizeBytes)
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
    kind: 'image' as const,
    mimeType,
    encoding: 'base64' as const,
    dataBase64: isJpeg ? jpegBase64(sizeBytes) : pngBase64(sizeBytes),
    filename: `${id}.${isJpeg ? 'jpg' : 'png'}`,
  }
}

function rpcProxyEdgeHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-clerum-edge-caller': 'rpc-proxy',
    'x-clerum-edge-host-ref': 'chatllm',
    'x-clerum-edge-user-id': 'user-1',
  }
}

function messagePayload(attachments: unknown) {
  return {
    content: 'look',
    channelType: 'rpc',
    channelId: 'c1',
    sender: 'user-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    messageId: 'm-1',
    hostRef: 'chatllm',
    attachments,
  }
}

async function postMessage(payload: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/runtime/messages`, {
    method: 'POST',
    headers: rpcProxyEdgeHeaders(),
    body: JSON.stringify(payload),
  })
}

describe('mcp-host runtime message body budget', () => {
  it('delivers a 12MiB image (exceptional, above 10MiB) byte-identical', async () => {
    captured = []
    const attachment = imageAttachment('a1', 12 * MIB)
    const response = await postMessage(messagePayload([attachment]))
    expect(response.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].attachments).toEqual([attachment])
  })

  it('delivers a single 10MiB image (the former per-image limit) byte-identical', async () => {
    captured = []
    const attachment = imageAttachment('a1', 10 * MIB)
    const response = await postMessage(messagePayload([attachment]))
    expect(response.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].attachments).toEqual([attachment])
  })

  it('delivers a 5MiB JPEG byte-identical', async () => {
    captured = []
    const attachment = imageAttachment('a1', 5 * MIB, 'image/jpeg')
    const response = await postMessage(messagePayload([attachment]))
    expect(response.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].attachments).toEqual([attachment])
  })

  it('delivers 10MiB + 5MiB (the 15MiB total limit) in order', async () => {
    captured = []
    const attachments = [imageAttachment('a1', 10 * MIB), imageAttachment('a2', 5 * MIB)]
    const response = await postMessage(messagePayload(attachments))
    expect(response.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].attachments?.map(item => item.dataBase64)).toEqual(
      attachments.map(item => item.dataBase64)
    )
  })

  it('delivers 10MiB PNG + 5MiB JPEG in order', async () => {
    captured = []
    const attachments = [
      imageAttachment('a1', 10 * MIB),
      imageAttachment('a2', 5 * MIB, 'image/jpeg'),
    ]
    const response = await postMessage(messagePayload(attachments))
    expect(response.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].attachments).toEqual(attachments)
  })

  it('delivers three 5MiB images in order', async () => {
    captured = []
    const attachments = [
      imageAttachment('a1', 5 * MIB),
      imageAttachment('a2', 5 * MIB),
      imageAttachment('a3', 5 * MIB),
    ]
    const response = await postMessage(messagePayload(attachments))
    expect(response.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].attachments?.map(item => item.id)).toEqual(['a1', 'a2', 'a3'])
    expect(captured[0].attachments?.map(item => item.dataBase64)).toEqual(
      attachments.map(item => item.dataBase64)
    )
  })

  it('delivers twenty small images in order', async () => {
    captured = []
    const attachments = Array.from({ length: 20 }, (_, index) =>
      imageAttachment(`a${index + 1}`, 64 * 1024)
    )
    const response = await postMessage(messagePayload(attachments))
    expect(response.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].attachments?.map(item => item.id)).toEqual(attachments.map(item => item.id))
  })

  it('rejects a 21st qualifying image instead of charging it as text', async () => {
    captured = []
    const attachments = Array.from({ length: 21 }, (_, index) =>
      imageAttachment(`a${index + 1}`, 64 * 1024)
    )
    const response = await postMessage(messagePayload(attachments))
    expect(response.status).toBe(413)
    expect(captured).toHaveLength(0)
  })

  it('rejects a single image over the 16MiB per-image limit', async () => {
    captured = []
    const response = await postMessage(messagePayload([imageAttachment('a1', 17 * MIB)]))
    expect(response.status).toBe(413)
    expect(captured).toHaveLength(0)
  })

  it('rejects two 10MiB images because together they exceed the 15MiB total', async () => {
    captured = []
    const response = await postMessage(
      messagePayload([imageAttachment('a1', 10 * MIB), imageAttachment('a2', 10 * MIB)])
    )
    expect(response.status).toBe(413)
    expect(captured).toHaveLength(0)
  })

  it('delivers two 8MiB images that sit on the 16MiB total', async () => {
    captured = []
    const attachments = [imageAttachment('a1', 8 * MIB), imageAttachment('a2', 8 * MIB)]
    const response = await postMessage(messagePayload(attachments))
    expect(response.status).toBe(200)
    expect(captured).toHaveLength(1)
    expect(captured[0].attachments).toEqual(attachments)
  })

  it('rejects 9MiB + 8MiB on the 16MiB total alone, under the 24MiB ceiling', async () => {
    captured = []
    const response = await postMessage(
      messagePayload([imageAttachment('a1', 9 * MIB), imageAttachment('a2', 8 * MIB)])
    )
    expect(response.status).toBe(413)
    expect(captured).toHaveLength(0)
  })

  it('still rejects text-only content over the 6MiB non-image budget', async () => {
    captured = []
    const response = await postMessage({
      ...messagePayload(undefined),
      content: 'x'.repeat(7 * MIB),
    })
    expect(response.status).toBe(413)
    expect(captured).toHaveLength(0)
  })

  it('rejects a body past the 24MiB ceiling', async () => {
    captured = []
    const response = await postMessage({
      ...messagePayload(undefined),
      content: 'x'.repeat(25 * MIB),
    })
    expect(response.status).toBe(413)
    expect(captured).toHaveLength(0)
  })

  it('does not credit an attachment that only claims to be an image', async () => {
    captured = []
    const response = await postMessage(
      messagePayload([
        {
          id: 'a1',
          kind: 'image',
          mimeType: 'image/png',
          encoding: 'base64',
          dataBase64: Buffer.alloc(5 * MIB, 0x41).toString('base64'),
        },
      ])
    )
    expect(response.status).toBe(413)
    expect(captured).toHaveLength(0)
  })

  it('does not credit base64 whose padding carries non-zero unused bits', async () => {
    captured = []
    const canonical = pngBase64(5 * MIB)
    const nonCanonical = withNonCanonicalTailBits(canonical)
    // Sanity: permissive decoding still yields the same bytes, so the only
    // thing that can reject this payload is the canonical-encoding rule.
    expect(Buffer.from(nonCanonical, 'base64').length).toBe(Buffer.from(canonical, 'base64').length)
    const response = await postMessage(
      messagePayload([
        {
          id: 'a1',
          kind: 'image',
          mimeType: 'image/png',
          encoding: 'base64',
          dataBase64: nonCanonical,
        },
      ])
    )
    expect(response.status).toBe(413)
    expect(captured).toHaveLength(0)
  })

  it('keeps the 6MiB parser on every other POST route', async () => {
    const response = await fetch(`${baseUrl}/v1/runtime/model`, {
      method: 'POST',
      headers: rpcProxyEdgeHeaders(),
      body: JSON.stringify({ model: 'x'.repeat(7 * MIB) }),
    })
    expect(response.status).toBe(413)
  })
})
