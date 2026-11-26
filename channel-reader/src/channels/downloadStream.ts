/**
 * Bounded HTTP response reader shared by provider attachment downloaders.
 * Enforces an explicit byte ceiling without buffering unbounded payloads in memory.
 */
export async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number
): Promise<
  | { ok: true; bytes: Buffer }
  | { ok: false; code: 'file_too_large'; message: string; retryable: false }
> {
  const contentLengthHeader = response.headers?.get?.('content-length')
  if (contentLengthHeader) {
    const declaredLength = Number(contentLengthHeader)
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      try {
        await response.body?.cancel?.()
      } catch {
        // Ignore cancel failures on already-closed streams.
      }
      return {
        ok: false,
        code: 'file_too_large',
        message: `Attachment exceeds maximum allowed size (${maxBytes} bytes).`,
        retryable: false,
      }
    }
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let totalBytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue
        totalBytes += value.byteLength
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel()
          } catch {
            // Ignore stream cancel errors.
          }
          return {
            ok: false,
            code: 'file_too_large',
            message: `Attachment exceeds maximum allowed size (${maxBytes} bytes).`,
            retryable: false,
          }
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
      }
    } finally {
      reader.releaseLock?.()
    }
    return { ok: true, bytes: Buffer.concat(chunks, totalBytes) }
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > maxBytes) {
    return {
      ok: false,
      code: 'file_too_large',
      message: `Attachment exceeds maximum allowed size (${maxBytes} bytes).`,
      retryable: false,
    }
  }
  return { ok: true, bytes: buffer }
}
