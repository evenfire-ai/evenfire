import type { K8sGateway } from '../k8s.js'

// Figure D multi-bot delivery: resolve the per-CommunicationChannel bot
// credential for a verified account's `communication_channel_ref` ("ns/name").
//
// This mirrors `channel-reader/src/credentials.ts` (Figure C reads the same
// per-channel Secret), but is intentionally NOT shared as a package: the two
// have divergent lifecycles (channel-reader resolves once at adapter init from a
// CRD object; this worker resolves per delivery from a ref string), and sharing
// would force a build-pipeline rewrite of channel-reader for ~40 lines. Keep the
// two in sync by hand. See `.ralph/plans/figure-d-multibot-pr1.md` (Option C).

/** Bot credentials the delivery worker needs (Telegram + Slack; no email). */
export interface ResolvedChannelCredentials {
  telegramBotToken?: string
  slackBotToken?: string
}

/** Minimal gateway surface: only what the resolver actually calls. */
export type ChannelCredentialsGateway = Pick<K8sGateway, 'getResource' | 'getSecret'>

type CommunicationChannelLike = {
  spec?: { credentialsSecretRef?: { name?: string } | null } | null
}

type SecretLike = { data?: Record<string, string> | null }

/** Extract an HTTP status code from a @kubernetes/client-node error shape. */
function httpStatus(err: unknown): number | undefined {
  const e = err as
    | { code?: number; statusCode?: number; response?: { statusCode?: number } }
    | null
    | undefined
  return e?.code ?? e?.statusCode ?? e?.response?.statusCode
}

function decode(b64: string | undefined): string | undefined {
  if (!b64) return undefined
  return Buffer.from(b64, 'base64').toString('utf-8')
}

/** Parse a `communication_channel_ref` of the form "namespace/name". */
function parseRef(ref: string): { namespace: string; name: string } | null {
  const trimmed = ref.trim()
  const idx = trimmed.indexOf('/')
  // Require a non-empty namespace AND name on either side of a single slash.
  if (idx <= 0 || idx >= trimmed.length - 1) return null
  return { namespace: trimmed.slice(0, idx), name: trimmed.slice(idx + 1) }
}

export class CommunicationChannelCredentialsResolver {
  constructor(private readonly gateway: ChannelCredentialsGateway) {}

  /**
   * Resolve the bot credentials for a channel ref ("namespace/name").
   *
   * - CommunicationChannel or Secret absent (404) → `{}` (worker maps to
   *   `no_bot`; delivery is skipped, never retried forever).
   * - Any other error (RBAC 403, 503, timeout) on either the CC or the Secret
   *   read → PROPAGATES (worker maps to `transient_failure`; delivery retries).
   * - Malformed ref → throws (data corruption; we always write "ns/name").
   *
   * The namespace is taken from the ref itself, so `getSecret` always receives
   * an explicit namespace (the channel's own, e.g. `channels`) — never the
   * gateway's default Secret namespace.
   */
  async resolve(ref: string): Promise<ResolvedChannelCredentials> {
    const parsed = parseRef(ref)
    if (!parsed) {
      throw new Error(`Invalid communication_channel_ref "${ref}" (expected "namespace/name")`)
    }

    let channel: CommunicationChannelLike
    try {
      channel = (await this.gateway.getResource(
        'communicationchannels',
        parsed.name,
        parsed.namespace
      )) as CommunicationChannelLike
    } catch (err) {
      if (httpStatus(err) === 404) return {}
      throw err
    }

    const secretName = channel.spec?.credentialsSecretRef?.name
    if (!secretName) return {}

    let secret: SecretLike
    try {
      secret = (await this.gateway.getSecret(secretName, parsed.namespace)) as SecretLike
    } catch (err) {
      if (httpStatus(err) === 404) return {}
      throw err
    }

    const data = (secret.data ?? {}) as Record<string, string>
    return {
      telegramBotToken: decode(data['telegram-bot-token']),
      slackBotToken: decode(data['slack-bot-token']),
    }
  }
}
