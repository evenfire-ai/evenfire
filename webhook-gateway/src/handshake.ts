import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { URL } from 'node:url'
import type { SetupHandshakeConfig } from './types'

export type HandshakeOutcome =
  | { kind: 'no_match' }
  | { kind: 'matched'; status: number; contentType: string; body: string }
  | { kind: 'misconfigured'; detail: string }

/**
 * Pre-verify handshake check. Strategies whose request shape is unsigned
 * (currently only `meta-hub-challenge`) match here, before the body
 * verifier runs. A matched handshake is responded to inline; the verifier
 * + forwarder are both skipped.
 *
 * Strategies whose request shape IS signed (`slack-url-verification`)
 * return `no_match` here and are picked up by `handleHandshakePostVerify`.
 */
export function handleHandshakePreVerify(
  cfg: SetupHandshakeConfig,
  req: IncomingMessage,
): HandshakeOutcome {
  switch (cfg.strategy) {
    case 'meta-hub-challenge':
      return matchMetaHubChallenge(cfg, req)
    case 'slack-url-verification':
      return { kind: 'no_match' }
    case 'stripe-verify':
      return { kind: 'misconfigured', detail: 'stripe-verify strategy not implemented' }
  }
}

/**
 * Post-verify handshake check. Runs only after body-signature verification
 * has passed. Strategies whose payload IS signed by the main scheme
 * (Slack URL verification) are answered inline here instead of being
 * forwarded to the handler workload.
 */
export function handleHandshakePostVerify(
  cfg: SetupHandshakeConfig,
  req: IncomingMessage,
  body: Buffer,
): HandshakeOutcome {
  switch (cfg.strategy) {
    case 'meta-hub-challenge':
      return { kind: 'no_match' }
    case 'slack-url-verification':
      return matchSlackUrlVerification(req, body)
    case 'stripe-verify':
      return { kind: 'no_match' }
  }
}

function matchMetaHubChallenge(
  cfg: SetupHandshakeConfig,
  req: IncomingMessage,
): HandshakeOutcome {
  if ((req.method || '').toUpperCase() !== 'GET') return { kind: 'no_match' }
  if (!cfg.secretPath) {
    return { kind: 'misconfigured', detail: 'meta-hub-challenge requires secretPath' }
  }

  const url = new URL(req.url || '/', 'http://localhost')
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')
  if (mode !== 'subscribe' || token === null || challenge === null) {
    return { kind: 'no_match' }
  }

  let expected: Buffer
  try {
    expected = readSecretFromPath(cfg.secretPath)
  } catch (err) {
    return {
      kind: 'misconfigured',
      detail: `cannot read secretPath ${cfg.secretPath}: ${(err as Error).message}`,
    }
  }

  if (!constantTimeEqual(Buffer.from(token, 'utf8'), expected)) {
    // Token mismatch: fall through to the verifier so the response is
    // indistinguishable from a missing-signature 401. The verifier will
    // see an unsigned GET and return invalid_signature.
    return { kind: 'no_match' }
  }

  return {
    kind: 'matched',
    status: 200,
    contentType: 'text/plain; charset=utf-8',
    body: challenge,
  }
}

function matchSlackUrlVerification(req: IncomingMessage, body: Buffer): HandshakeOutcome {
  if ((req.method || '').toUpperCase() !== 'POST') return { kind: 'no_match' }
  const ct = headerString(req.headers['content-type']).toLowerCase()
  if (!ct.includes('application/json')) return { kind: 'no_match' }

  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return { kind: 'no_match' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'no_match' }
  const obj = parsed as Record<string, unknown>
  if (obj.type !== 'url_verification' || typeof obj.challenge !== 'string') {
    return { kind: 'no_match' }
  }

  return {
    kind: 'matched',
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ challenge: obj.challenge }),
  }
}

function readSecretFromPath(path: string): Buffer {
  const raw = readFileSync(path)
  if (raw.length > 0 && raw[raw.length - 1] === 0x0a) {
    return raw.subarray(0, raw.length - 1)
  }
  return raw
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function headerString(value: string | string[] | undefined): string {
  if (!value) return ''
  if (Array.isArray(value)) return value[0] || ''
  return value
}
