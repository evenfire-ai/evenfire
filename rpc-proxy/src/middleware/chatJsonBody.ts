import express, { type NextFunction, type Request, type Response } from 'express'

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
 *
 * Mount `chatJsonBody` on `POST /rpc/hosts/:hostRef/messages` right after
 * authentication so unauthenticated callers never trigger this parser.
 */
const MAX_CHAT_BODY_BYTES = 24 * 1024 * 1024
const MAX_NON_IMAGE_BODY_BYTES = 6 * 1024 * 1024
const MAX_CHAT_IMAGES = 20
const MAX_IMAGE_DECODED_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_DECODED_BYTES_TOTAL = 16 * 1024 * 1024
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])

type ChatRequest = Request & { rawBodyBytes?: number }

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
 * decoded each within a 20-image / 16MiB total budget. A 21st qualifying
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

const chatJsonParser = express.json({
  limit: MAX_CHAT_BODY_BYTES,
  verify: (req, _res, buffer) => {
    ;(req as ChatRequest).rawBodyBytes = buffer.length
  },
})

export function chatJsonBody(req: Request, res: Response, next: NextFunction): void {
  chatJsonParser(req, res, error => {
    if (error) {
      next(error)
      return
    }
    const rawBodyBytes = (req as ChatRequest).rawBodyBytes
    if (rawBodyBytes !== undefined && chatBodyExceedsNonImageBudget(rawBodyBytes, req.body)) {
      res.status(413).json({ error: 'Payload Too Large' })
      return
    }
    next()
  })
}
