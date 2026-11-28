import { OIDC_START_FORM_MAX_BYTES } from '../../constants/oidc'

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'

/**
 * The body as text, or undefined once it passes `maxBytes`. Reading stops there, so a body
 * longer than its declared Content-Length is never buffered past the cap either.
 */
async function readCappedText(
  body: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<string | undefined> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maxBytes) {
      await reader.cancel()
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * The fields of an unauthenticated OIDC start form (`/api/oidc/start`, `/api/oidc/desktop-start`).
 * Only a urlencoded POST that declares a Content-Length of at most `OIDC_START_FORM_MAX_BYTES`,
 * and carries no more bytes than that, yields fields. Any other body is not read and yields
 * undefined. A body whose stream fails mid-read rejects; each caller decides what that means.
 */
export async function readStartForm(request: Request): Promise<URLSearchParams | undefined> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (contentType !== FORM_CONTENT_TYPE || !request.body) return undefined
  const declaredLength = request.headers.get('content-length')?.trim() ?? ''
  if (!/^\d{1,5}$/.test(declaredLength) || Number(declaredLength) > OIDC_START_FORM_MAX_BYTES) {
    return undefined
  }
  const text = await readCappedText(request.body, OIDC_START_FORM_MAX_BYTES)
  return text === undefined ? undefined : new URLSearchParams(text)
}
