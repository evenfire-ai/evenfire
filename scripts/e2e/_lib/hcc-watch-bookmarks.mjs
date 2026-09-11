// Development-only observation of verified upstream watch bytes, never bodies
// in an artifact. Forwarding remains the proxy's independent streaming pipe.
export function createBookmarkObservation({
  maxFrameBytes = 65536,
  maxStreams = 32,
  now = Date.now,
} = {}) {
  if (
    !Number.isInteger(maxFrameBytes) ||
    maxFrameBytes < 64 ||
    maxFrameBytes > 65536 ||
    !Number.isInteger(maxStreams) ||
    maxStreams < 1 ||
    maxStreams > 32
  )
    throw new Error('invalid-observation-bounds')
  const startedAtMs = now()
  const active = new Set()
  let endedAtMs = null
  const kinds = Object.fromEntries(
    ['McpServer', 'Context'].map(kind => [
      kind,
      {
        watchResponses: 0,
        observedBookmarks: 0,
        firstWatchAtMs: null,
        reasons: new Set(),
      },
    ])
  )
  const noop = { write() {}, end() {}, close() {} }
  const unknown = (state, reason) => state.reasons.add(reason)
  function open(kind, headers, statusCode) {
    if (endedAtMs !== null || !kinds[kind]) return noop
    const state = kinds[kind]
    state.watchResponses++
    state.firstWatchAtMs ??= now()
    if (
      statusCode !== 200 ||
      !/^application\/json(?:;|$)/i.test(headers['content-type'] ?? '') ||
      (headers['content-encoding'] && headers['content-encoding'] !== 'identity')
    ) {
      unknown(state, 'unsupported-response')
      return noop
    }
    if (active.size >= maxStreams) {
      unknown(state, 'observer-limit')
      return noop
    }
    let pending = Buffer.alloc(0)
    let oversized = false
    let closed = false
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const frame = bytes => {
      try {
        const text = decoder.decode(bytes).trim()
        if (!text) return
        const event = JSON.parse(text)
        if (
          !['ADDED', 'MODIFIED', 'DELETED', 'ERROR', 'BOOKMARK'].includes(event?.type) ||
          !event.object ||
          typeof event.object !== 'object'
        )
          throw new Error('invalid-frame')
        if (event.type === 'BOOKMARK') {
          if (
            typeof event.object.metadata?.resourceVersion !== 'string' ||
            !event.object.metadata.resourceVersion
          ) {
            throw new Error('invalid-bookmark')
          }
          state.observedBookmarks++
        }
      } catch {
        unknown(state, 'malformed-frame')
      }
    }
    const observer = {
      write(chunk) {
        if (closed || endedAtMs !== null) return
        let offset = 0
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset)
          const end = newline < 0 ? chunk.length : newline
          if (!oversized) {
            if (pending.length + end - offset > maxFrameBytes) {
              unknown(state, 'oversized-frame')
              pending = Buffer.alloc(0)
              oversized = true
            } else pending = Buffer.concat([pending, chunk.subarray(offset, end)])
          }
          if (newline < 0) break
          if (!oversized) frame(pending)
          pending = Buffer.alloc(0)
          oversized = false
          offset = newline + 1
        }
      },
      end() {
        if (closed) return
        if (pending.length && !oversized) frame(pending)
        pending = Buffer.alloc(0)
        closed = true
        active.delete(observer)
      },
      close() {
        if (closed) return
        if (pending.length || oversized) unknown(state, 'partial-frame')
        pending = Buffer.alloc(0)
        closed = true
        active.delete(observer)
      },
    }
    active.add(observer)
    return observer
  }
  function finish() {
    if (endedAtMs === null) {
      endedAtMs = now()
      for (const observer of active) observer.close()
    }
    return {
      boundary: 'verified-upstream-watch-response',
      startedAtMs,
      endedAtMs,
      limits: { maxFrameBytes, maxStreams },
      byWatch: Object.fromEntries(
        Object.entries(kinds).map(([kind, state]) => {
          const complete = state.watchResponses > 0 && state.reasons.size === 0
          return [
            kind,
            {
              watchResponses: state.watchResponses,
              firstWatchAtMs: state.firstWatchAtMs,
              observedBookmarks: state.observedBookmarks,
              bookmarks: complete ? state.observedBookmarks : null,
              coverage: complete ? 'complete' : 'unknown',
              reasons: state.watchResponses ? [...state.reasons].sort() : ['no-watch-response'],
              receipt:
                state.observedBookmarks > 0 ? 'observed' : complete ? 'not-observed' : 'unknown',
              disconnectBenefit: 'NO_DEMOSTRADO',
            },
          ]
        })
      ),
    }
  }
  return { open, finish }
}
