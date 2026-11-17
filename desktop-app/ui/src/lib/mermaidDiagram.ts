import {
  MERMAID_CACHE_MAX_BYTES,
  MERMAID_MAX_CODE_CHARS,
  MERMAID_RETRY_DELAY_MS,
} from '@constants/mermaid'
import type { DiagramDrawResult } from '../../../src/types'
import type {
  MermaidDiagramClient,
  MermaidDiagramClientDeps,
  MermaidDiagramStyle,
} from './mermaidDiagram.types'

const TOO_LONG: DiagramDrawResult = Object.freeze({
  ok: false,
  reason: `It is longer than ${MERMAID_MAX_CODE_CHARS.toLocaleString('en-US')} characters`,
})
const UNAVAILABLE: DiagramDrawResult = Object.freeze({
  ok: false,
  reason: 'The diagram renderer is not available',
  retryable: true,
})

function cacheKey(code: string, style: MermaidDiagramStyle): string {
  return [style.theme, style.fontFamily, code].join('\u0000')
}

/**
 * The chat's side of diagram drawing. Mermaid runs in the main process's
 * hidden drawing window, never in this renderer; this keeps what it drew,
 * shares one request between identical blocks, asks once more after a
 * failure of the renderer rather than the code, and lets a block that mounts
 * again show its diagram at once.
 */
export function createMermaidDiagramClient(deps: MermaidDiagramClientDeps): MermaidDiagramClient {
  const cache = new Map<string, { result: DiagramDrawResult; bytes: number }>()
  const pending = new Map<string, Promise<DiagramDrawResult>>()
  let cachedBytes = 0

  const remember = (key: string, result: DiagramDrawResult) => {
    const bytes = result.ok ? result.image.src.length : result.reason.length
    if (bytes > deps.cacheMaxBytes) return
    cache.set(key, { result, bytes })
    cachedBytes += bytes
    for (const [oldKey, entry] of cache) {
      if (cachedBytes <= deps.cacheMaxBytes) break
      cache.delete(oldKey)
      cachedBytes -= entry.bytes
    }
  }

  return {
    peek: (code, style) => {
      if (code.length > MERMAID_MAX_CODE_CHARS) return TOO_LONG
      return cache.get(cacheKey(code, style))?.result ?? null
    },
    draw: (code, style, width) => {
      if (code.length > MERMAID_MAX_CODE_CHARS) return Promise.resolve(TOO_LONG)
      const key = cacheKey(code, style)
      const hit = cache.get(key)
      if (hit) {
        // Most recently used last, so the oldest drawing is forgotten first.
        cache.delete(key)
        cache.set(key, hit)
        return Promise.resolve(hit.result)
      }
      const inFlight = pending.get(key)
      if (inFlight) return inFlight
      const request = { code, theme: style.theme, fontFamily: style.fontFamily, width }
      // A missing bridge or a failed call reads as unavailable, never as a throw.
      const attempt = () =>
        Promise.resolve()
          .then(() => deps.draw(request))
          .catch((): DiagramDrawResult => UNAVAILABLE)
      const result = attempt()
        .then(first =>
          first.ok || !first.retryable
            ? first
            : new Promise(resolve => setTimeout(resolve, deps.retryDelayMs)).then(attempt)
        )
        .then(drawn => {
          pending.delete(key)
          if (drawn.ok || !drawn.retryable) remember(key, drawn)
          return drawn
        })
      pending.set(key, result)
      return result
    },
  }
}

export const mermaidDiagrams: MermaidDiagramClient = createMermaidDiagramClient({
  draw: request => window.clerum.diagrams.draw(request),
  cacheMaxBytes: MERMAID_CACHE_MAX_BYTES,
  retryDelayMs: MERMAID_RETRY_DELAY_MS,
})
