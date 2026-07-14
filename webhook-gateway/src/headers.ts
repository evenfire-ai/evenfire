import type { IncomingHttpHeaders } from 'node:http'
import type { WebhookConfigEntry } from './types'

/**
 * Headers we never forward, regardless of scheme:
 *   - Authorization: gateway is the only source of trust for upstream auth
 *   - Cookie: webhooks are system-to-system; cookies are irrelevant
 *   - Host: rewrite to upstream host
 *   - Connection / Transfer-Encoding / Content-Length: hop-by-hop or
 *     re-derived by the http client we use to forward.
 */
const HARD_STRIP_HEADERS = new Set<string>([
  'authorization',
  'cookie',
  'host',
  'connection',
  'transfer-encoding',
  'content-length',
])

/**
 * Strip + inject for the gateway's outbound forward. Steps mirror
 * spec §10.3:
 *   1. Drop hard-strip headers (Authorization/Cookie/Host/...).
 *   2. Drop the verification scheme's `signatureHeader` and
 *      `replay.timestampHeader` (already validated; no need to forward).
 *   3. Drop EVERY header matching `^x-clerum-` (case-insensitive). The
 *      gateway is the sole source of truth for the X-Clerum-* namespace
 *      — a provider cannot smuggle identity / verification metadata.
 *   4. Inject our own X-Clerum-Webhook-* headers.
 */
export function buildForwardHeaders(
  entry: WebhookConfigEntry,
  inbound: IncomingHttpHeaders,
  recipeNamespace: string,
  recipeName: string
): Record<string, string> {
  const v = entry.verification
  // Only HMAC schemes carry their signature in a per-recipe header. JWT
  // and static-bearer use the Authorization header, which is already in
  // HARD_STRIP_HEADERS.
  const schemeSigHeader =
    v.scheme === 'hmac-sha256-body' || v.scheme === 'hmac-sha256-timestamp-body'
      ? v.signatureHeader
      : undefined
  const replayHeader = entry.replay?.timestampHeader

  const out: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(inbound)) {
    if (rawValue === undefined) continue
    const key = rawKey.toLowerCase()
    if (HARD_STRIP_HEADERS.has(key)) continue
    if (schemeSigHeader && key === schemeSigHeader) continue
    if (replayHeader && key === replayHeader) continue
    if (key.startsWith('x-clerum-')) continue
    // Multi-value headers: collapse to the comma-joined form Node uses
    // when emitting via http.request — providers don't legitimately send
    // multi-value Idempotency-Key etc., so this is not lossy in practice.
    out[key] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue)
  }
  out['x-clerum-webhook-id'] = entry.id
  out['x-clerum-webhook-recipe'] = `${recipeNamespace}/${recipeName}`
  out['x-clerum-webhook-verified-at'] = new Date().toISOString()
  return out
}
