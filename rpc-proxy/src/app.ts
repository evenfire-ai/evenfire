import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import { config } from './config.js'
import { createDesktopRouter } from './routes/desktopProxy.js'
import { createHealthRouter } from './routes/health.js'
import { createMcpOauthRouter } from './routes/mcpOauth.js'
import { createRpcRouter } from './routes/rpc.js'
import { createRpcHostActivityStreamRouter } from './routes/rpcHostActivityStream.js'
import { createRpcHostProgressStreamRouter } from './routes/rpcHostProgressStream.js'
import { createRpcHostStatusStreamRouter } from './routes/rpcHostStatusStream.js'
import { createSandboxUiSessionRouter } from './routes/sandboxUi.js'
import { isUpstreamTimeoutError } from './services/wakeAndHold.js'

/**
 * Body budgets for chat payloads carrying base64 image attachments.
 *
 * Usual product target is 5MiB / 9MiB / 14MiB at 2048 px. Hard hop credit is
 * 16MiB per image and 16MiB total so a poorly compressed 2048 PNG may exceed
 * 10MiB. mcp-host holds its own copy: the two services share no package, so
 * both edits must land together.
 *
 * Two ceilings are enforced here:
 *   - MAX_CHAT_BODY_BYTES stays 24MiB so 16MiB decoded (~21.3MiB base64) plus
 *     the 1MiB non-image share still fits.
 *   - MAX_NON_IMAGE_BODY_BYTES bounds the same body MINUS credited image
 *     base64. Without that subtraction the attachment budget would become a
 *     general 24MiB text budget.
 */
const MAX_CHAT_BODY_BYTES = 24 * 1024 * 1024
const MAX_NON_IMAGE_BODY_BYTES = 6 * 1024 * 1024
const MAX_CHAT_IMAGES = 10
const MAX_IMAGE_DECODED_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_DECODED_BYTES_TOTAL = 16 * 1024 * 1024
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])

/** Base64 alphabet value of one character, or null when it is not a base64 char. */
function base64SextetValue(char: string): number | null {
  const code = char.charCodeAt(0)
  if (code >= 0x41 && code <= 0x5a) return code - 0x41
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52
  if (code === 0x2b) return 62
  if (code === 0x2f) return 63
  return null
}

/**
 * Decoded byte length of a base64 payload, or null when it is not canonical.
 *
 * '=' padding makes the final group carry fewer bits than it encodes, so the
 * unused low bits of that group's last sextet must be zero (RFC 4648 §3.5). A
 * payload padding a non-zero tail still decodes in a permissive decoder, but it
 * is not the canonical encoding of its bytes: accepting it would let a caller
 * park arbitrary unused bytes inside the base64 length that the body budget is
 * asked to credit.
 */
function decodedBase64Bytes(dataBase64: string): number | null {
  if (dataBase64.length === 0 || dataBase64.length % 4 !== 0) return null
  if (!BASE64_RE.test(dataBase64)) return null
  const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0
  if (padding > 0) {
    const lastSextet = base64SextetValue(dataBase64[dataBase64.length - 1 - padding] ?? '')
    if (lastSextet === null) return null
    if (padding === 1 && (lastSextet & 0b11) !== 0) return null
    if (padding === 2 && (lastSextet & 0b1111) !== 0) return null
  }
  // A 4-char group decodes to 3 bytes, the pad chars each drop one byte.
  return (dataBase64.length / 4) * 3 - padding
}

/**
 * Byte length of the base64 that counts against the documented image budget.
 * Only attachments with the exact wire shape the composer produces qualify:
 * `kind: 'image'`, `encoding: 'base64'`, a PNG/JPEG MIME type, canonical
 * base64 whose leading bytes are that image's signature, and at most 16MiB
 * decoded each within a 10-image / 16MiB total budget. An 11th qualifying
 * image is fail-loud rather than charged as text. Anything else is charged
 * to the non-image budget, so a claim cannot be smuggled through by mislabelling
 * a payload.
 */
function inspectChatImageBudget(body: unknown): {
  creditedBase64: number
  tooManyImages: boolean
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { creditedBase64: 0, tooManyImages: false }
  }
  const attachments = (body as { attachments?: unknown }).attachments
  if (!Array.isArray(attachments)) return { creditedBase64: 0, tooManyImages: false }

  let credited = 0
  let decodedTotal = 0
  let counted = 0
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object') continue
    const candidate = attachment as {
      kind?: unknown
      encoding?: unknown
      mimeType?: unknown
      dataBase64?: unknown
    }
    if (candidate.kind !== 'image' || candidate.encoding !== 'base64') continue
    const mimeType = typeof candidate.mimeType === 'string' ? candidate.mimeType : ''
    if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') continue
    const dataBase64 = typeof candidate.dataBase64 === 'string' ? candidate.dataBase64 : ''
    const decoded = decodedBase64Bytes(dataBase64)
    if (decoded === null || decoded <= 0 || decoded > MAX_IMAGE_DECODED_BYTES) continue
    if (decodedTotal + decoded > MAX_IMAGE_DECODED_BYTES_TOTAL) continue
    const signature = Buffer.from(dataBase64.slice(0, 16), 'base64')
    const matchesSignature =
      mimeType === 'image/png'
        ? signature.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
        : signature.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)
    if (!matchesSignature) continue
    if (counted >= MAX_CHAT_IMAGES) {
      return { creditedBase64: credited, tooManyImages: true }
    }
    credited += dataBase64.length
    decodedTotal += decoded
    counted += 1
  }
  return { creditedBase64: credited, tooManyImages: false }
}

function chatBodyExceedsNonImageBudget(rawBodyBytes: number, body: unknown): boolean {
  const budget = inspectChatImageBudget(body)
  if (budget.tooManyImages) return true
  return rawBodyBytes - budget.creditedBase64 > MAX_NON_IMAGE_BODY_BYTES
}

/**
 * body-parser flags a request whose declared/streamed body crossed the parser's
 * `limit` with `type: 'entity.too.large'`. The terminal error handler below
 * would otherwise report it as a 500, which reads like a server fault for what
 * is a client-sized payload; mcp-host answers the same condition with 413.
 */
function isEntityTooLargeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { type?: unknown }).type === 'entity.too.large'
  )
}

export function createApp() {
  const app = express()

  app.use(
    cors({
      origin: config.corsOrigin === '*' ? true : config.corsOrigin,
      credentials: true,
    })
  )
  // Allow chat payloads with base64 image attachments from desktop composer.
  // The sandbox-ui view proxy streams the raw request body straight to the
  // recipe's upstream via http-proxy — running body-parser there would drain
  // the stream, so the proxied request hangs waiting for a body that never
  // arrives. Skip JSON parsing for that path; every other route still needs it.
  //
  // `POST /api/v1/rpc/hosts/:hostRef/messages` is the one route that carries
  // image attachments, so it alone gets the larger byte ceiling; the rest keep
  // the original 6MiB. The larger ceiling is not a general text allowance: the
  // verifier below subtracts only the base64 of images that validly count
  // against the documented attachment budget.
  const CHAT_MESSAGE_POST_PATH = /^\/api\/v1\/rpc\/hosts\/[^/]+\/messages\/?$/
  const jsonParser = express.json({ limit: '6mb' })
  const chatJsonParser = express.json({
    limit: MAX_CHAT_BODY_BYTES,
    verify: (req, _res, buffer) => {
      ;(req as Request & { rawBodyBytes?: number }).rawBodyBytes = buffer.length
    },
  })
  const VIEW_PROXY_PATH = /^\/api\/v1\/sandbox-ui\/[^/]+\/[^/]+\/view\//
  app.use((req, res, next) => {
    if (VIEW_PROXY_PATH.test(req.path)) return next()
    const isChatMessagePost = req.method === 'POST' && CHAT_MESSAGE_POST_PATH.test(req.path)
    const parser = isChatMessagePost ? chatJsonParser : jsonParser
    parser(req, res, error => {
      if (error || !isChatMessagePost) return next(error)
      const rawBodyBytes = (req as Request & { rawBodyBytes?: number }).rawBodyBytes
      if (rawBodyBytes !== undefined && chatBodyExceedsNonImageBudget(rawBodyBytes, req.body)) {
        res.status(413).json({ error: 'Payload Too Large' })
        return
      }
      next()
    })
  })

  app.use(createHealthRouter())

  const api = express.Router()
  api.use(createRpcRouter())
  api.use(createRpcHostStatusStreamRouter())
  api.use(createRpcHostActivityStreamRouter())
  api.use(createRpcHostProgressStreamRouter())
  api.use(createDesktopRouter())
  api.use(createSandboxUiSessionRouter())
  api.use(createMcpOauthRouter())
  app.use('/api/v1', api)

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' })
  })

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isUpstreamTimeoutError(err)) {
      res.status(504).json({ error: 'Gateway Timeout' })
      return
    }

    if (isEntityTooLargeError(err)) {
      res.status(413).json({ error: 'Payload Too Large' })
      return
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: err instanceof Error ? err.message : 'Unknown error',
    })
  })

  return app
}
