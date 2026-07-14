/**
 * Path normalisation for the sandbox-ui `view/*` reverse proxy.
 *
 * Reject `..`, NUL, encoded traversal, prefix-escape with 400. The point
 * is that nothing in the path can escape upward of the recipe's view scope
 * or sneak past the upstream Service's own path resolution.
 *
 * Inputs: the raw path tail captured by the route's `*` parameter — i.e.
 * everything after `/api/v1/sandbox-ui/<ns>/<name>/view/`. The route's
 * `req.params[0]` from Express's wildcard match.
 *
 * Output: a single leading `/` followed by the normalised path, OR null when
 * the input is rejected. Never returns a path that:
 *   - contains a NUL byte
 *   - contains an encoded NUL (%00)
 *   - resolves a `..` segment above the root
 *   - starts with a `/` after normalisation that doesn't belong to the
 *     scope (we always re-prefix with a single `/`, so caller can splice)
 *
 * Query-string handling is the caller's responsibility — pass it untouched
 * to the upstream after `normalizeViewPath` accepts the path.
 */

const NUL_RE = /\x00|%00/i

// WHATWG URL "double-dot path segment" definition (url.spec.whatwg.org §URL
// path state). A second pass after our single decodeURIComponent: input
// like `%252e%252e` decodes once to literal `%2e%2e`, which the `..`-only
// literal check would miss. We treat any of these post-decode segments as
// a parent-directory pop, then the existing root-escape check rejects them.
const DOUBLE_DOT_RE = /^(?:\.\.|\.%2e|%2e\.|%2e%2e)$/i

// "Single-dot path segment" — same idea, kept for parity. `.` or `%2e`
// (case-insensitive) is a no-op segment; we skip it like an empty segment.
const SINGLE_DOT_RE = /^(?:\.|%2e)$/i

export function normalizeViewPath(rawTail: string | undefined): string | null {
  if (rawTail === undefined) return null

  // The wildcard match strips any leading slash; "view/" itself is consumed
  // by the route. So the empty string maps to "/" — the upstream root.
  const tail = String(rawTail)

  // NUL bytes (literal or percent-encoded) are a hard reject — no legitimate
  // sandbox-ui path needs them, and they are a known smuggling vector against
  // upstream filesystems / parsers.
  if (NUL_RE.test(tail)) return null

  // Decode percent-encoding ONCE so we can canonicalise. Anything that is
  // already invalid percent-encoding (e.g. `%2`) is rejected — we won't
  // forward broken encoding upstream.
  let decoded: string
  try {
    decoded = decodeURIComponent(tail)
  } catch {
    return null
  }

  // Re-check for NUL after decoding (catches double-encoded NUL like
  // %2500 → %00, and literal NUL bytes that came in already-decoded).
  if (NUL_RE.test(decoded)) return null

  // Reject backslashes outright. They are not legal path separators in URLs
  // but some upstreams (notably IIS-style) collapse them to forward slashes,
  // letting `..\\` escape past a `..` filter. We refuse the request rather
  // than try to be clever about it.
  if (decoded.indexOf('\\') !== -1) return null

  // Walk the path segment-by-segment. A `..` segment pops the stack; an
  // attempt to pop past the root is a reject.
  const stack: string[] = []
  let segmentStart = 0
  for (let i = 0; i <= decoded.length; i++) {
    const isEnd = i === decoded.length
    const ch = isEnd ? '/' : decoded[i]
    if (ch === '/') {
      const segment = decoded.slice(segmentStart, i)
      segmentStart = i + 1
      if (segment === '' || SINGLE_DOT_RE.test(segment)) continue
      if (DOUBLE_DOT_RE.test(segment)) {
        if (stack.length === 0) return null
        stack.pop()
        continue
      }
      stack.push(segment)
    }
  }

  // Preserve a trailing slash (some upstreams care, e.g. for static-file
  // index resolution). The decoded input ending in `/` produces an empty
  // last segment we already skipped; we re-add the slash here.
  const trailing = decoded.length > 0 && decoded.endsWith('/') ? '/' : ''
  return `/${stack.join('/')}${trailing}`
}
