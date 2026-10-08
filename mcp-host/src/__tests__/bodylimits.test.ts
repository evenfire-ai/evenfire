/**
 * Body-budget tests for the mcp-host runtime JSON parser.
 *
 * Proves on a real listening `RPCServer` socket:
 *  - `POST /v1/runtime/messages` carries the documented image payloads (a 10MiB
 *    image, a 5MiB JPEG, 10MiB + 5MiB, and three 5MiB images) to the message handler instead
 *    of being rejected as too large.
 *  - The attachments arrive byte-identical: nothing is dropped, truncated or
 *    re-encoded on the way through the parser.
 *  - Qualifying `kind:'file'` attachments have their own credited quota
 *    (11MiB decoded per file, 16MiB of base64 in total, issue #678).
 *  - The larger ceiling is NOT a general text allowance: non-image bytes stay
 *    capped at 6MiB. Every other Host route keeps the 10mb ordinary JSON
 *    parser, matching rpc-proxy `jsonBody`.
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

  it.each([
    { label: '15MiB then 2MiB', sizes: [15 * MIB, 2 * MIB] as const },
    { label: '2MiB then 15MiB', sizes: [2 * MIB, 15 * MIB] as const },
  ])('rejects $label on the 16MiB decoded total regardless of order', async ({ sizes }) => {
    captured = []
    const response = await postMessage(
      messagePayload([imageAttachment('a1', sizes[0]), imageAttachment('a2', sizes[1])])
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

  describe('kind:file attachments without the composer wire shape (issue #666)', () => {
    const NON_IMAGE_BUDGET = 6 * MIB
    const KIB = 1024

    function fileAttachment(dataBase64: string) {
      return {
        id: 'f1',
        kind: 'file' as const,
        mimeType: 'text/plain',
        detectedMediaType: 'text/plain',
        encoding: 'base64' as const,
        dataBase64,
        filename: 'notes.txt',
        sizeBytes: 0,
        digest: { algorithm: 'sha256' as const, hex: '0'.repeat(64) },
      }
    }

    /** A message whose serialized body is exactly `targetBytes`, almost all of it file base64. */
    function fileMessageOfBodySize(targetBytes: number) {
      const overhead = Buffer.byteLength(JSON.stringify(messagePayload([fileAttachment('')])))
      const fill = targetBytes - overhead
      const dataBase64 = 'A'.repeat(fill - (fill % 4))
      const payload = {
        ...messagePayload([fileAttachment(dataBase64)]),
        content: `look${'x'.repeat(fill % 4)}`,
      }
      expect(Buffer.byteLength(JSON.stringify(payload))).toBe(targetBytes)
      return { payload, dataBase64 }
    }

    it('delivers a file body 1KiB under the budget', async () => {
      captured = []
      const { payload, dataBase64 } = fileMessageOfBodySize(NON_IMAGE_BUDGET - KIB)
      const response = await postMessage(payload)
      expect(response.status).toBe(200)
      expect(captured).toHaveLength(1)
      expect(captured[0]!.attachments?.[0]?.dataBase64.length).toBe(dataBase64.length)
    })

    it('charges a file body without a digest to the non-image budget', async () => {
      // A file without the composer's sha256 digest is never credited to the
      // file quota, so its base64 counts against the 6MiB share.
      const withoutDigest = (targetBytes: number) => {
        const { payload, dataBase64 } = fileMessageOfBodySize(targetBytes)
        const { digest: _digest, ...attachment } = fileAttachment(dataBase64)
        return { ...payload, attachments: [attachment] }
      }
      captured = []
      // Control: the same construction under the budget is delivered.
      expect((await postMessage(withoutDigest(NON_IMAGE_BUDGET - KIB))).status).toBe(200)
      expect(captured).toHaveLength(1)
      captured = []
      const response = await postMessage(withoutDigest(NON_IMAGE_BUDGET + KIB))
      expect(response.status).toBe(413)
      expect(captured).toHaveLength(0)
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
        kind: 'file' as const,
        mimeType: 'text/plain',
        detectedMediaType: 'text/plain',
        encoding: 'base64' as const,
        dataBase64: textFileBase64(sizeBytes),
        filename: `${id}.txt`,
        sizeBytes,
        digest: { algorithm: 'sha256' as const, hex: 'ab'.repeat(32) },
      }
    }

    /**
     * A message whose body minus the base64 of `attachments` is exactly
     * `shareBytes`: the bytes the 6MiB share is charged when every file is
     * credited.
     */
    function messageWithShare(attachments: Array<{ dataBase64: string }>, shareBytes: number) {
      const base64Bytes = attachments.reduce((total, item) => total + item.dataBase64.length, 0)
      const empty = { ...messagePayload(attachments), content: '' }
      const overhead = Buffer.byteLength(JSON.stringify(empty)) - base64Bytes
      const payload = { ...empty, content: 'x'.repeat(shareBytes - overhead) }
      expect(Buffer.byteLength(JSON.stringify(payload)) - base64Bytes).toBe(shareBytes)
      return payload
    }

    function deliveredAttachmentIds(): unknown[] {
      expect(captured).toHaveLength(1)
      return (captured[0]!.attachments ?? []).map(item => item.id)
    }

    it('delivers an 11MiB file beside a text share 1KiB under 6MiB byte-identical', async () => {
      captured = []
      const file = textFile('f1', FILE_MAX_BYTES)
      const payload = messageWithShare([file], NON_IMAGE_BUDGET - KIB)
      // The whole body is far past the 6MiB share: only the file credit lets it through.
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(20 * MIB)
      const response = await postMessage(payload)
      expect(response.status).toBe(200)
      expect(deliveredAttachmentIds()).toEqual(['f1'])
      expect(captured[0]!.attachments?.[0]?.dataBase64).toBe(file.dataBase64)
    })

    it('rejects an 11MiB file when the text share is 1KiB over 6MiB', async () => {
      const file = textFile('f1', FILE_MAX_BYTES)
      captured = []
      expect((await postMessage(messageWithShare([file], NON_IMAGE_BUDGET - KIB))).status).toBe(200)
      expect(captured).toHaveLength(1)
      captured = []
      const response = await postMessage(messageWithShare([file], NON_IMAGE_BUDGET + KIB))
      expect(response.status).toBe(413)
      expect(captured).toHaveLength(0)
    })

    it('decides the 11MiB limit by decoded bytes, not by base64 length', async () => {
      const atLimit = textFile('f1', FILE_MAX_BYTES)
      const overLimit = textFile('f1', FILE_MAX_BYTES + 1)
      // Both encode to the same number of characters; only the padding differs.
      expect(overLimit.dataBase64.length).toBe(atLimit.dataBase64.length)
      captured = []
      expect((await postMessage(messageWithShare([atLimit], KIB))).status).toBe(200)
      expect(captured).toHaveLength(1)
      captured = []
      const response = await postMessage(messageWithShare([overLimit], KIB))
      expect(response.status).toBe(413)
      expect(captured).toHaveLength(0)
    })

    it('does not credit file base64 whose padding carries non-zero unused bits', async () => {
      const canonical = textFile('f1', FILE_MAX_BYTES)
      const nonCanonical = {
        ...canonical,
        dataBase64: withNonCanonicalTailBits(canonical.dataBase64),
      }
      captured = []
      expect((await postMessage(messageWithShare([canonical], KIB))).status).toBe(200)
      expect(captured).toHaveLength(1)
      captured = []
      const response = await postMessage(messageWithShare([nonCanonical], KIB))
      expect(response.status).toBe(413)
      expect(captured).toHaveLength(0)
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
      captured = []
      expect((await postMessage(messageWithShare([standard], KIB))).status).toBe(200)
      expect(captured).toHaveLength(1)
      captured = []
      // Uncredited, the ~14.7MiB of base64 is charged to the 6MiB share.
      const response = await postMessage(messageWithShare([urlSafe], KIB))
      expect(response.status).toBe(413)
      expect(captured).toHaveLength(0)
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
      captured = []
      expect((await postMessage(messageWithShare([complete], KIB))).status).toBe(200)
      expect(captured).toHaveLength(1)
      captured = []
      const response = await postMessage(messagePayload([mutate(complete)]))
      expect(response.status).toBe(413)
      expect(captured).toHaveLength(0)
    })

    it('delivers files that sit exactly on the 16MiB base64 quota and rejects one byte past it', async () => {
      const large = textFile('f1', FILE_MAX_BYTES)
      const fitting = textFile('f2', MIB - 1)
      const overflowing = textFile('f2', MIB)
      expect(large.dataBase64.length + fitting.dataBase64.length).toBe(FILE_QUOTA_BASE64)
      expect(large.dataBase64.length + overflowing.dataBase64.length).toBeGreaterThan(
        FILE_QUOTA_BASE64
      )
      captured = []
      const ok = await postMessage(messageWithShare([large, fitting], KIB))
      expect(ok.status).toBe(200)
      expect(deliveredAttachmentIds()).toEqual(['f1', 'f2'])
      captured = []
      const response = await postMessage(messageWithShare([large, overflowing], KIB))
      expect(response.status).toBe(413)
      expect(captured).toHaveLength(0)
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
      captured = []
      const small = await postMessage(messagePayload([pngAsFile(7 * MIB)]))
      expect(small.status).toBe(200)
      expect(deliveredAttachmentIds()).toEqual(['f1'])
      captured = []
      // The same 12MiB bytes are credited as an image (16MiB limit)…
      const asImage = await postMessage(messagePayload([imageAttachment('a1', 12 * MIB)]))
      expect(asImage.status).toBe(200)
      expect(captured).toHaveLength(1)
      captured = []
      // …but not as a file, whose limit is 11MiB.
      const asFile = await postMessage(messagePayload([pngAsFile(12 * MIB)]))
      expect(asFile.status).toBe(413)
      expect(captured).toHaveLength(0)
    })

    it('delivers an 11MiB file beside a 5MiB image and rejects the pair past 24MiB', async () => {
      const file = textFile('f1', FILE_MAX_BYTES)
      const fits = messagePayload([file, imageAttachment('a1', 5 * MIB)])
      expect(Buffer.byteLength(JSON.stringify(fits))).toBeLessThan(24 * MIB)
      captured = []
      expect((await postMessage(fits)).status).toBe(200)
      expect(deliveredAttachmentIds()).toEqual(['f1', 'a1'])
      captured = []
      const tooBig = messagePayload([file, imageAttachment('a1', 8 * MIB)])
      expect(Buffer.byteLength(JSON.stringify(tooBig))).toBeGreaterThan(24 * MIB)
      const response = await postMessage(tooBig)
      expect(response.status).toBe(413)
      expect(captured).toHaveLength(0)
    })

    it('credits twenty files and rejects a twenty-first instead of charging it as text', async () => {
      const files = (count: number) =>
        Array.from({ length: count }, (_, index) => textFile(`f${index + 1}`, KIB))
      captured = []
      const twenty = await postMessage(messagePayload(files(20)))
      expect(twenty.status).toBe(200)
      expect(deliveredAttachmentIds()).toHaveLength(20)
      captured = []
      const body = messagePayload(files(21))
      expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(NON_IMAGE_BUDGET)
      const response = await postMessage(body)
      expect(response.status).toBe(413)
      expect(captured).toHaveLength(0)
    })
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

  it("does not credit base64 whose final padded sextet is '/'", async () => {
    const canonical = pngBase64(5 * MIB)
    const slashTail = withFinalSextet(canonical, '/')
    expect(slashTail).not.toBe(canonical)
    // Sanity: permissive decoding still yields the same length, so the only
    // thing that can reject this payload is the canonical-encoding rule.
    expect(Buffer.from(slashTail, 'base64').length).toBe(Buffer.from(canonical, 'base64').length)
    const withImage = (dataBase64: string) =>
      messagePayload([
        { id: 'a1', kind: 'image', mimeType: 'image/png', encoding: 'base64', dataBase64 },
      ])
    captured = []
    expect((await postMessage(withImage(canonical))).status).toBe(200)
    expect(captured).toHaveLength(1)
    captured = []
    const response = await postMessage(withImage(slashTail))
    expect(response.status).toBe(413)
    expect(captured).toHaveLength(0)
  })

  it('keeps the 10mb parser on every other POST route', async () => {
    const over = await fetch(`${baseUrl}/v1/runtime/model`, {
      method: 'POST',
      headers: rpcProxyEdgeHeaders(),
      body: JSON.stringify({ model: 'x'.repeat(11 * MIB) }),
    })
    expect(over.status).toBe(413)

    const under = await fetch(`${baseUrl}/v1/runtime/model`, {
      method: 'POST',
      headers: rpcProxyEdgeHeaders(),
      body: JSON.stringify({ model: 'x'.repeat(7 * MIB) }),
    })
    expect(under.status).not.toBe(413)
  })
})
