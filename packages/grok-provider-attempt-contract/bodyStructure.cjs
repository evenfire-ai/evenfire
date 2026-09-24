'use strict'

/**
 * Structural bounds on a raw JSON body, checked before JSON.parse.
 *
 * JSON.parse allocates one heap object per container, so a body of `[],`
 * repeated costs far more heap than its byte count suggests: one 36 MB body
 * of that shape aborts a proxy running with --max-old-space-size=384, and
 * three 8 MiB ones at once do the same. A byte limit alone cannot prevent
 * this. This scan runs as the body-parser `verify` hook, after the body is
 * read and before it is parsed, and refuses a body whose structure could
 * not belong to a request the contract accepts:
 *
 * - structural bytes: every byte outside string contents that is not JSON
 *   whitespace, both quotes of each string included. A compact body minus its
 *   string contents is never larger than its non-image share, so a bound of
 *   `maxRequestBodyBytes + ENVELOPE_ALLOWANCE_BYTES` refuses no acceptable
 *   request, visual or not. Image data is string content and never counts.
 * - containers: every `{` and `[`, bounded by the contract's
 *   `maxRequestContainers` plus the envelope's own containers.
 * - depth: container nesting, bounded by the request depth plus the one
 *   envelope level around it.
 *
 * Only UTF-8 is scanned. In UTF-16 or UTF-32 a quote or backslash byte can
 * be half of another character, so the scan would lose track of strings; any
 * other declared charset is refused.
 *
 * This file is byte-identical in @clerum/grok-provider-attempt-contract and
 * @clerum/llm-provider-attempt-contract. Each package's index.test.cjs
 * compares the two files, so neither package imports the other.
 */

class BodyStructureError extends Error {
  constructor(status, type, message) {
    super(message)
    this.name = 'BodyStructureError'
    this.status = status
    this.type = type
  }
}

// Index of the quote that closes a string whose contents start at `from`, or
// `buf.length` when the string is unterminated (JSON.parse then refuses the
// body). A quote is escaped when an odd run of backslashes precedes it; the
// run cannot extend past the opening quote, so each byte is read at most
// twice. 0x22 and 0x5c never occur inside a multi-byte UTF-8 sequence.
function closingQuote(buf, from) {
  let quote = buf.indexOf(0x22, from)
  while (quote !== -1) {
    let backslashes = 0
    for (let j = quote - 1; j >= from && buf[j] === 0x5c; j--) backslashes++
    if (backslashes % 2 === 0) return quote
    quote = buf.indexOf(0x22, quote + 1)
  }
  return buf.length
}

function tooDense(limits) {
  return new BodyStructureError(
    413,
    'body.structure.too.dense',
    `request body exceeds ${limits.maxStructuralBytes} structural bytes`
  )
}

/**
 * Scans `buf` (a Buffer holding UTF-8 JSON) and throws a BodyStructureError
 * on the first bound it crosses. Returns the counts it measured. It does not
 * validate JSON syntax; JSON.parse still does that.
 */
function scanJsonStructure(buf, limits) {
  const { maxStructuralBytes, maxContainers, maxDepth } = limits
  const length = buf.length
  let structuralBytes = 0
  let containers = 0
  let depth = 0
  let deepest = 0
  let i = 0
  while (i < length) {
    const byte = buf[i]
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      i++
      continue
    }
    structuralBytes++
    if (structuralBytes > maxStructuralBytes) throw tooDense(limits)
    if (byte === 0x22) {
      i = closingQuote(buf, i + 1)
      if (i < length) {
        structuralBytes++
        if (structuralBytes > maxStructuralBytes) throw tooDense(limits)
      }
    } else if (byte === 0x7b || byte === 0x5b) {
      containers++
      if (containers > maxContainers) {
        throw new BodyStructureError(
          413,
          'body.structure.too.many.containers',
          `request body exceeds ${maxContainers} containers`
        )
      }
      depth++
      if (depth > maxDepth) {
        throw new BodyStructureError(
          400,
          'body.structure.too.deep',
          `request body exceeds nesting depth ${maxDepth}`
        )
      }
      if (depth > deepest) deepest = depth
    } else if (byte === 0x7d || byte === 0x5d) {
      depth--
    }
    i++
  }
  return { structuralBytes, containers, deepest }
}

/**
 * A body-parser `verify(req, res, buf, encoding)` hook. body-parser passes the
 * declared charset, lower-cased and defaulting to utf-8. A thrown error
 * reaches the error handler with its own `status` and `type`, and with the raw
 * body attached as `err.body`, so a handler must never log the error object.
 */
function createBodyStructureVerify(limits) {
  const bounds = Object.freeze({
    maxStructuralBytes: limits.maxStructuralBytes,
    maxContainers: limits.maxContainers,
    maxDepth: limits.maxDepth,
  })
  return function verifyBodyStructure(_req, _res, buf, encoding) {
    if (encoding !== 'utf-8') {
      throw new BodyStructureError(415, 'charset.unsupported', 'request body must be UTF-8')
    }
    scanJsonStructure(buf, bounds)
  }
}

module.exports = {
  scanJsonStructure,
  createBodyStructureVerify,
}
