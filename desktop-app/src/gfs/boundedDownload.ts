import { ApiError } from '../httpClient.js'

/** The dependency seam so the bound can be tested with a fabricated response. */
export interface BoundedDownloadDeps {
  fetch: typeof fetch
}

/**
 * Fetch a resource's raw bytes with an OPTIONAL hard ceiling.
 *
 * Without `maxBytes` the whole body is read — the save-to-disk path, which
 * legitimately materializes large files.
 *
 * With `maxBytes` the response is rejected two ways so the ceiling holds even
 * when the server lies about (or omits) the length:
 *   1. up front, when a truthful `Content-Length` already exceeds the ceiling;
 *   2. mid-stream, the moment cumulative bytes cross the ceiling — so an absent
 *      or dishonest `Content-Length` cannot materialize an oversized payload in
 *      memory. The in-flight request is aborted on rejection.
 *
 * A caller must NOT rely on a post-download size assert alone: that runs only
 * after the full buffer is already resident, which is exactly the exhaustion
 * this bound prevents.
 */
export async function fetchBoundedBytes(
  url: string,
  token: string,
  opts?: { maxBytes?: number },
  deps: BoundedDownloadDeps = { fetch }
): Promise<ArrayBuffer> {
  const maxBytes = opts?.maxBytes
  const controller = new AbortController()
  const res = await deps.fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  })
  if (!res.ok) {
    throw new ApiError(`gfs download failed: ${res.status}`, res.status, '')
  }
  if (maxBytes === undefined) {
    return res.arrayBuffer()
  }

  const overLimit = () =>
    new ApiError(`gfs preview download exceeds the ${maxBytes}-byte limit`, 413, '')

  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller.abort()
    throw overLimit()
  }

  const body = res.body
  if (!body) {
    // No readable stream to bound (some platforms/tests). Fall back to a
    // buffered read guarded post-hoc — the length header was already checked.
    const buffer = await res.arrayBuffer()
    if (buffer.byteLength > maxBytes) throw overLimit()
    return buffer
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        controller.abort()
        throw overLimit()
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The reader may already be released after an abort; ignore.
    }
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out.buffer
}
