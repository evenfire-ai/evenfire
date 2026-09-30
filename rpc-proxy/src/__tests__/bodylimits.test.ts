/**
 * Body-budget tests for the rpc-proxy JSON parser.
 *
 * Proves on a real listening `createApp()` socket:
 *  - `POST /api/v1/rpc/hosts/:hostRef/messages` carries the documented image
 *    payloads (a 10MiB image, a 5MiB JPEG, 10MiB + 5MiB, and three 5MiB images) to the auth
 *    boundary instead of being rejected as too large.
 *  - Qualifying `kind:'file'` attachments have their own credited quota
 *    (11MiB decoded per file, 16MiB of base64 in total, issue #678).
 *  - The larger ceiling is NOT a general text allowance: non-image bytes stay
 *    capped at 6MiB, and every other route keeps its 10mb parser.
 *  - The sandbox-ui view proxy stays parser-free. A finished application/json
 *    body larger than the 24MiB chat ceiling is still 401, so neither the
 *    10mb parser nor the chat parser is mounted.
 *
 * Auth is deliberately NOT mocked. A 401 is the proof that the body crossed the
 * parser and only the auth boundary stopped it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { createRequire } from 'node:module'
import { createApp } from '../app.js'

const authTokenMock = vi.hoisted(() => ({
  verifyRpcToken: vi.fn(),
}))

const serviceMock = vi.hoisted(() => ({
  resolveHostConnectionForUser: vi.fn(),
  resolveServerConnectionForUser: vi.fn(),
  forwardHostMessageToHost: vi.fn(),
  validateRpcRequest: vi.fn(),
  forwardRpcToServer: vi.fn(),
}))

vi.mock('../authToken.js', () => authTokenMock)
vi.mock('../services/mcpProxyService.js', () => serviceMock)

const VALID_CLAIMS = {
  sub: 'user-uuid-abc',
  typ: 'user' as const,
  accessScope: 'team' as const,
  teamId: 'team-1',
  scopes: ['host:message:invoke', 'mcp:server:invoke'],
  hostRefs: ['chatllm'],
  jti: 'j1',
  iat: 1,
  exp: 9999999999,
}

const { declaredHeaderPngOfSize, jpegOfSize } = createRequire(import.meta.url)(
  '../../../packages/llm-provider-attempt-contract/testImageFixtures.cjs'
) as {
  declaredHeaderPngOfSize: (targetBytes: number) => Buffer
  jpegOfSize: (targetBytes: number, width?: number, height?: number) => Buffer
}

const MIB = 1024 * 1024
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

let baseUrl: string
let server: Server

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise<void>(resolve => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(() => {
  vi.clearAllMocks()
  authTokenMock.verifyRpcToken.mockReturnValue(VALID_CLAIMS)
  serviceMock.resolveHostConnectionForUser.mockResolvedValue({
    name: 'chatllm',
    url: 'http://chatllm:8080',
    headers: {},
  })
  serviceMock.forwardHostMessageToHost.mockResolvedValue({ success: true, status: 'completed' })
  serviceMock.resolveServerConnectionForUser.mockResolvedValue({
    name: 'demo',
    url: 'http://demo:8080',
    headers: {},
  })
  serviceMock.validateRpcRequest.mockReturnValue({ method: 'ping' })
  serviceMock.forwardRpcToServer.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} })
})

afterAll(async () => {
  // Drop any socket still open so a listener left behind here cannot surface
  // as a parse error in whichever sibling test file ran next.
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
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

/**
 * Replace the final padded sextet with `sextet`. With '/' (63) every unused
 * low bit is set, so the payload decodes to the same length but is not the
 * canonical encoding of its bytes.
 */
function withFinalSextet(base64: string, sextet: string): string {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  if (padding === 0) throw new Error('fixture expects a padded base64 payload')
  const lastIndex = base64.length - 1 - padding
  return base64.slice(0, lastIndex) + sextet + base64.slice(lastIndex + 1)
}

/** The same bytes in the URL-safe alphabet (RFC 4648 §5): '-' for '+', '_' for '/'. */
function toUrlSafeBase64(base64: string): string {
  return base64.replace(/\+/g, '-').replace(/\//g, '_')
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
    headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
    body,
  })
}

const MESSAGE_PATH = '/api/v1/rpc/hosts/chatllm/messages'

async function postMessage(payload: unknown): Promise<Response> {
  return post(MESSAGE_PATH, JSON.stringify(payload))
}

describe('rpc-proxy chat message body budget', () => {
  it('carries a 12MiB image (exceptional, above 10MiB) to the auth boundary', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 12 * MIB)],
    })
    expect(Buffer.byteLength(body)).toBeGreaterThan(16 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(200)
  })

  it('carries a 10MiB image (the former per-image limit) to the auth boundary', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 10 * MIB)],
    })
    // 10MiB of bytes encodes to more than 13MiB, well past the old 6MiB parser.
    expect(Buffer.byteLength(body)).toBeGreaterThan(13 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(200)
  })

  it('carries a 5MiB JPEG to the auth boundary', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 5 * MIB, 'image/jpeg')],
    })
    expect(Buffer.byteLength(body)).toBeGreaterThan(6 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(200)
  })

  it('carries 10MiB PNG + 5MiB JPEG to the auth boundary', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 10 * MIB), imageAttachment('a2', 5 * MIB, 'image/jpeg')],
    })
    expect(Buffer.byteLength(body)).toBeGreaterThan(20 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(200)
  })

  it('carries 10MiB + 5MiB (the 15MiB total limit) to the auth boundary', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 10 * MIB), imageAttachment('a2', 5 * MIB)],
    })
    expect(Buffer.byteLength(body)).toBeGreaterThan(20 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(200)
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
    expect(response.status).toBe(200)
  })

  it('credits twenty small images instead of charging them as text', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: Array.from({ length: 20 }, (_, index) =>
        imageAttachment(`a${index + 1}`, 64 * 1024)
      ),
    })
    expect(Buffer.byteLength(body)).toBeLessThan(6 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(200)
  })

  it('rejects a 21st qualifying image instead of charging it as text', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: Array.from({ length: 21 }, (_, index) =>
        imageAttachment(`a${index + 1}`, 64 * 1024)
      ),
    })
    expect(Buffer.byteLength(body)).toBeLessThan(6 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(413)
  })

  it('rejects a single image over the 16MiB per-image limit', async () => {
    // Fits the 24MiB body ceiling, so this rejection is the budget gate, not the
    // parser: an uncredited 17MiB image is charged to the 6MiB non-image budget.
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 17 * MIB)],
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

  it('carries two 8MiB images that sit on the 16MiB total', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 8 * MIB), imageAttachment('a2', 8 * MIB)],
    })
    expect(Buffer.byteLength(body)).toBeLessThan(24 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(200)
  })

  it('rejects 9MiB + 8MiB on the 16MiB total alone, under the 24MiB ceiling', async () => {
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', 9 * MIB), imageAttachment('a2', 8 * MIB)],
    })
    expect(Buffer.byteLength(body)).toBeLessThan(24 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(413)
  })

  it.each([
    { label: '15MiB then 2MiB', sizes: [15 * MIB, 2 * MIB] as const },
    { label: '2MiB then 15MiB', sizes: [2 * MIB, 15 * MIB] as const },
  ])('rejects $label on the 16MiB decoded total regardless of order', async ({ sizes }) => {
    const body = JSON.stringify({
      content: 'look',
      attachments: [imageAttachment('a1', sizes[0]), imageAttachment('a2', sizes[1])],
    })
    expect(Buffer.byteLength(body)).toBeLessThan(24 * MIB)
    const response = await post(MESSAGE_PATH, body)
    expect(response.status).toBe(413)
  })

  it('still rejects text-only content over the 6MiB non-image budget', async () => {
    const response = await postMessage({ content: 'x'.repeat(7 * MIB), attachments: [] })
    expect(response.status).toBe(413)
  })

  describe('kind:file attachments (issue #666)', () => {
    const NON_IMAGE_BUDGET = 6 * MIB
    const KIB = 1024

    function fileAttachment(dataBase64: string) {
      return {
        id: 'f1',
        kind: 'file',
        mimeType: 'text/plain',
        detectedMediaType: 'text/plain',
        encoding: 'base64',
        dataBase64,
        filename: 'notes.txt',
        sizeBytes: 0,
        digest: { algorithm: 'sha256', hex: '0'.repeat(64) },
      }
    }

    /** A message whose serialized body is exactly `targetBytes`, almost all of it file base64. */
    function fileMessageOfBodySize(targetBytes: number) {
      const overhead = Buffer.byteLength(
        JSON.stringify({ content: 'look', attachments: [fileAttachment('')] })
      )
      const fill = targetBytes - overhead
      const payload = {
        content: `look${'x'.repeat(fill % 4)}`,
        attachments: [fileAttachment('A'.repeat(fill - (fill % 4)))],
      }
      expect(Buffer.byteLength(JSON.stringify(payload))).toBe(targetBytes)
      return payload
    }

    function forwardedBody(): { attachments?: unknown[] } {
      expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
      return serviceMock.forwardHostMessageToHost.mock.calls[0]![1] as { attachments?: unknown[] }
    }

    it('forwards a complete kind:file attachment without dropping a field', async () => {
      const attachment = {
        ...fileAttachment(Buffer.from('# notes\n').toString('base64')),
        mimeType: 'text/markdown',
        detectedMediaType: 'text/markdown',
        filename: 'notes.md',
        sizeBytes: 8,
        digest: { algorithm: 'sha256', hex: 'ab'.repeat(32) },
      }
      const response = await postMessage({ content: 'look', attachments: [attachment] })
      expect(response.status).toBe(200)
      expect(forwardedBody().attachments).toEqual([attachment])
    })

    it('carries a file body 1KiB under the non-image budget', async () => {
      const payload = fileMessageOfBodySize(NON_IMAGE_BUDGET - KIB)
      const response = await postMessage(payload)
      expect(response.status).toBe(200)
      expect(forwardedBody().attachments).toEqual(payload.attachments)
    })

    it('charges a file body without a digest to the non-image budget', async () => {
      // A file without the composer's sha256 digest is never credited to the
      // file quota, so its base64 counts against the 6MiB share.
      const withoutDigest = (targetBytes: number) => {
        const payload = fileMessageOfBodySize(targetBytes)
        const { digest: _digest, ...attachment } = payload.attachments[0]!
        return { ...payload, attachments: [attachment] }
      }
      // Control: the same construction under the budget is forwarded.
      expect((await postMessage(withoutDigest(NON_IMAGE_BUDGET - KIB))).status).toBe(200)
      expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
      vi.clearAllMocks()
      const response = await postMessage(withoutDigest(NON_IMAGE_BUDGET + KIB))
      expect(response.status).toBe(413)
      expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
    })
  })

  describe('kind:file attachments have their own credited quota (issue #678)', () => {
    const FILE_MAX_BYTES = 11 * MIB
    const FILE_QUOTA_BASE64 = 16 * MIB
    const NON_IMAGE_BUDGET = 6 * MIB
    const KIB = 1024
    const fileBase64Cache = new Map<number, string>()

    /** Canonical base64 of `sizeBytes` bytes of ASCII text. */
    function textFileBase64(sizeBytes: number): string {
      return cachedBase64(fileBase64Cache, Buffer.alloc(sizeBytes, 0x61), sizeBytes)
    }

    function textFile(id: string, sizeBytes: number) {
      return {
        id,
        kind: 'file',
        mimeType: 'text/plain',
        detectedMediaType: 'text/plain',
        encoding: 'base64',
        dataBase64: textFileBase64(sizeBytes),
        filename: `${id}.txt`,
        sizeBytes,
        digest: { algorithm: 'sha256', hex: 'ab'.repeat(32) },
      }
    }

    /**
     * A message whose body minus the base64 of `attachments` is exactly
     * `shareBytes`: the bytes the 6MiB share is charged when every file is
     * credited.
     */
    function messageWithShare(attachments: Array<{ dataBase64: string }>, shareBytes: number) {
      const base64Bytes = attachments.reduce((total, item) => total + item.dataBase64.length, 0)
      const overhead = Buffer.byteLength(JSON.stringify({ content: '', attachments })) - base64Bytes
      const payload = { content: 'x'.repeat(shareBytes - overhead), attachments }
      expect(Buffer.byteLength(JSON.stringify(payload)) - base64Bytes).toBe(shareBytes)
      return payload
    }

    function forwardedAttachmentIds(): unknown[] {
      expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
      const body = serviceMock.forwardHostMessageToHost.mock.calls[0]![1] as {
        attachments?: Array<{ id: unknown }>
      }
      return (body.attachments ?? []).map(item => item.id)
    }

    it('carries an 11MiB file beside a text share 1KiB under 6MiB', async () => {
      const payload = messageWithShare([textFile('f1', FILE_MAX_BYTES)], NON_IMAGE_BUDGET - KIB)
      // The whole body is far past the 6MiB share: only the file credit lets it through.
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(20 * MIB)
      const response = await postMessage(payload)
      expect(response.status).toBe(200)
      expect(forwardedAttachmentIds()).toEqual(['f1'])
    })

    it('rejects an 11MiB file when the text share is 1KiB over 6MiB', async () => {
      const file = textFile('f1', FILE_MAX_BYTES)
      expect((await postMessage(messageWithShare([file], NON_IMAGE_BUDGET - KIB))).status).toBe(200)
      expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
      vi.clearAllMocks()
      const response = await postMessage(messageWithShare([file], NON_IMAGE_BUDGET + KIB))
      expect(response.status).toBe(413)
      expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
    })

    it('decides the 11MiB limit by decoded bytes, not by base64 length', async () => {
      const atLimit = textFile('f1', FILE_MAX_BYTES)
      const overLimit = textFile('f1', FILE_MAX_BYTES + 1)
      // Both encode to the same number of characters; only the padding differs.
      expect(overLimit.dataBase64.length).toBe(atLimit.dataBase64.length)
      expect((await postMessage(messageWithShare([atLimit], KIB))).status).toBe(200)
      expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
      vi.clearAllMocks()
      const response = await postMessage(messageWithShare([overLimit], KIB))
      expect(response.status).toBe(413)
      expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
    })

    it('does not credit file base64 whose padding carries non-zero unused bits', async () => {
      const canonical = textFile('f1', FILE_MAX_BYTES)
      const nonCanonical = {
        ...canonical,
        dataBase64: withNonCanonicalTailBits(canonical.dataBase64),
      }
      expect((await postMessage(messageWithShare([canonical], KIB))).status).toBe(200)
      expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
      vi.clearAllMocks()
      const response = await postMessage(messageWithShare([nonCanonical], KIB))
      expect(response.status).toBe(413)
      expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
    })

    it('does not credit an 11MiB file whose base64 uses the URL-safe alphabet', async () => {
      const bytes = Buffer.alloc(FILE_MAX_BYTES, 0x61)
      // 0xfbefbe encodes as '++++' and 0xffffff as '////'.
      bytes.set([0xfb, 0xef, 0xbe, 0xff, 0xff, 0xff], 0)
      const standard = { ...textFile('f1', FILE_MAX_BYTES), dataBase64: bytes.toString('base64') }
      const urlSafe = { ...standard, dataBase64: toUrlSafeBase64(standard.dataBase64) }
      expect(standard.dataBase64.startsWith('++++////')).toBe(true)
      expect(urlSafe.dataBase64.startsWith('----____')).toBe(true)
      // Sanity: Node's permissive decoder reads both alphabets to the same bytes,
      // so only the alphabet rule can refuse the credit.
      expect(Buffer.from(urlSafe.dataBase64, 'base64').equals(bytes)).toBe(true)
      expect((await postMessage(messageWithShare([standard], KIB))).status).toBe(200)
      expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
      vi.clearAllMocks()
      // Uncredited, the ~14.7MiB of base64 is charged to the 6MiB share.
      const response = await postMessage(messageWithShare([urlSafe], KIB))
      expect(response.status).toBe(413)
      expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
    })

    it.each([
      { label: 'no digest', mutate: ({ digest: _d, ...rest }: Record<string, unknown>) => rest },
      {
        label: 'a sha1 digest',
        mutate: (item: Record<string, unknown>) => ({
          ...item,
          digest: { algorithm: 'sha1', hex: 'ab'.repeat(32) },
        }),
      },
      {
        label: 'an uppercase digest',
        mutate: (item: Record<string, unknown>) => ({
          ...item,
          digest: { algorithm: 'sha256', hex: 'AB'.repeat(32) },
        }),
      },
      {
        label: 'a raw encoding',
        mutate: (item: Record<string, unknown>) => ({ ...item, encoding: 'raw' }),
      },
      {
        label: 'an empty file name',
        mutate: (item: Record<string, unknown>) => ({ ...item, filename: '' }),
      },
      {
        label: 'no file name',
        mutate: ({ filename: _f, ...rest }: Record<string, unknown>) => rest,
      },
    ])('charges a 5MiB file with $label to the non-image budget', async ({ mutate }) => {
      // 5MiB encodes to about 6.7MiB: credited it fits, charged as text it does not.
      const complete = textFile('f1', 5 * MIB)
      expect((await postMessage(messageWithShare([complete], KIB))).status).toBe(200)
      expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
      vi.clearAllMocks()
      const response = await postMessage({ content: 'look', attachments: [mutate(complete)] })
      expect(response.status).toBe(413)
      expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
    })

    it('carries files that sit exactly on the 16MiB base64 quota and rejects one byte past it', async () => {
      const large = textFile('f1', FILE_MAX_BYTES)
      const fitting = textFile('f2', MIB - 1)
      const overflowing = textFile('f2', MIB)
      expect(large.dataBase64.length + fitting.dataBase64.length).toBe(FILE_QUOTA_BASE64)
      expect(large.dataBase64.length + overflowing.dataBase64.length).toBeGreaterThan(
        FILE_QUOTA_BASE64
      )
      const ok = await postMessage(messageWithShare([large, fitting], KIB))
      expect(ok.status).toBe(200)
      expect(forwardedAttachmentIds()).toEqual(['f1', 'f2'])
      vi.clearAllMocks()
      const response = await postMessage(messageWithShare([large, overflowing], KIB))
      expect(response.status).toBe(413)
      expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
    })

    it('credits PNG bytes sent as kind:file to the file quota, up to 11MiB', async () => {
      const pngAsFile = (sizeBytes: number) => ({
        ...textFile('f1', 1),
        dataBase64: pngBase64(sizeBytes),
        mimeType: 'image/png',
        detectedMediaType: 'image/png',
        filename: 'photo.png',
        sizeBytes,
      })
      const small = await postMessage({ content: 'look', attachments: [pngAsFile(7 * MIB)] })
      expect(small.status).toBe(200)
      expect(forwardedAttachmentIds()).toEqual(['f1'])
      vi.clearAllMocks()
      // The same 12MiB bytes are credited as an image (16MiB limit)…
      const asImage = await postMessage({
        content: 'look',
        attachments: [imageAttachment('a1', 12 * MIB)],
      })
      expect(asImage.status).toBe(200)
      expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
      vi.clearAllMocks()
      // …but not as a file, whose limit is 11MiB.
      const asFile = await postMessage({ content: 'look', attachments: [pngAsFile(12 * MIB)] })
      expect(asFile.status).toBe(413)
      expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
    })

    it('carries an 11MiB file beside a 5MiB image and rejects the pair past 24MiB', async () => {
      const file = textFile('f1', FILE_MAX_BYTES)
      const fits = { content: 'look', attachments: [file, imageAttachment('a1', 5 * MIB)] }
      expect(Buffer.byteLength(JSON.stringify(fits))).toBeLessThan(24 * MIB)
      expect((await postMessage(fits)).status).toBe(200)
      expect(forwardedAttachmentIds()).toEqual(['f1', 'a1'])
      vi.clearAllMocks()
      const tooBig = { content: 'look', attachments: [file, imageAttachment('a1', 8 * MIB)] }
      expect(Buffer.byteLength(JSON.stringify(tooBig))).toBeGreaterThan(24 * MIB)
      const response = await postMessage(tooBig)
      expect(response.status).toBe(413)
      expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
    })

    it('credits twenty files and rejects a twenty-first instead of charging it as text', async () => {
      const files = (count: number) =>
        Array.from({ length: count }, (_, index) => textFile(`f${index + 1}`, KIB))
      const twenty = await postMessage({ content: 'look', attachments: files(20) })
      expect(twenty.status).toBe(200)
      expect(forwardedAttachmentIds()).toHaveLength(20)
      vi.clearAllMocks()
      const body = { content: 'look', attachments: files(21) }
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(NON_IMAGE_BUDGET)
      const response = await postMessage(body)
      expect(response.status).toBe(413)
      expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
    })
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

  it("does not credit base64 whose final padded sextet is '/'", async () => {
    const canonical = pngBase64(5 * MIB)
    const slashTail = withFinalSextet(canonical, '/')
    expect(slashTail).not.toBe(canonical)
    // Sanity: permissive decoding still yields the same length, so the only
    // thing that can reject this payload is the canonical-encoding rule.
    expect(Buffer.from(slashTail, 'base64').length).toBe(Buffer.from(canonical, 'base64').length)
    const withImage = (dataBase64: string) => ({
      content: 'x'.repeat(MIB),
      attachments: [
        { id: 'a1', kind: 'image', mimeType: 'image/png', encoding: 'base64', dataBase64 },
      ],
    })
    expect((await postMessage(withImage(canonical))).status).toBe(200)
    expect(serviceMock.forwardHostMessageToHost).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()
    const response = await postMessage(withImage(slashTail))
    expect(response.status).toBe(413)
    expect(serviceMock.forwardHostMessageToHost).not.toHaveBeenCalled()
  })

  it('keeps the 10mb parser on authenticated non-chat JSON routes', async () => {
    const response = await post('/api/v1/rpc/demo', JSON.stringify({ a: 'x'.repeat(11 * MIB) }))
    expect(response.status).toBe(413)
  })

  it('leaves the sandbox-ui view proxy parser-free so its stream is not drained', async () => {
    // application/json larger than both the 10mb route parser and the 24MiB
    // chat parser. A mounted parser answers 413. The route answers its cookie
    // check first, so this body is 401.
    const response = await fetch(`${baseUrl}/api/v1/sandbox-ui/ns/recipe/view/index.html`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blob: 'A'.repeat(25 * MIB) }),
    })
    expect(response.status).toBe(401)
  })
})
