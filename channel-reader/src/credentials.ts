/**
 * Resolves per-CC bot credentials from K8s Secrets in the `channels` namespace.
 *
 * Each CommunicationChannel may declare `spec.credentialsSecretRef.name`
 * pointing at an Opaque Secret. This module reads it once at adapter init
 * time and decodes the well-known keys by channel type. HCC owns the
 * "react to Secret content change" path via Deployment annotation rolls;
 * channel-reader itself only needs `secrets: get` RBAC.
 */
import type { CoreV1Api, V1Secret } from '@kubernetes/client-node'
import type { CommunicationChannelCRD } from './types'

export interface ResolvedCredentials {
  telegramBotToken?: string
  slackBotToken?: string
  emailUsername?: string
  emailPassword?: string
}

function getErrorCode(err: unknown): number | undefined {
  const e = err as { code?: number; response?: { statusCode?: number } }
  return e.code ?? e.response?.statusCode
}

function decode(b64: string | undefined): string | undefined {
  if (!b64) return undefined
  return Buffer.from(b64, 'base64').toString('utf8')
}

// Mirror: control-api has an equivalent per-channel Secret reader at
// `control-api/src/services/communicationChannelCredentialsResolver.ts` (Figure
// D delivery worker). Intentionally NOT shared as a package — divergent
// lifecycles. Keep the two in sync by hand. See Figure D PR1 plan (Option C).
export class CredentialsResolver {
  constructor(
    private readonly coreApi: Pick<CoreV1Api, 'readNamespacedSecret'>,
    private readonly namespace: string
  ) {}

  async resolve(cc: CommunicationChannelCRD): Promise<ResolvedCredentials> {
    const ref = cc.spec.credentialsSecretRef
    if (!ref?.name) return {}

    let secret: V1Secret
    try {
      secret = (await this.coreApi.readNamespacedSecret({
        name: ref.name,
        namespace: this.namespace,
      })) as V1Secret
    } catch (err) {
      if (getErrorCode(err) === 404) {
        console.warn(
          `[Credentials] CC ${cc.name} references missing Secret ${ref.name} in ns=${this.namespace}`
        )
        return {}
      }
      throw err
    }

    const data = (secret.data ?? {}) as Record<string, string>
    return {
      telegramBotToken: decode(data['telegram-bot-token']),
      slackBotToken: decode(data['slack-bot-token']),
      emailUsername: decode(data['email-username']),
      emailPassword: decode(data['email-password']),
    }
  }
}

/**
 * Dev-mode resolver. Reads bot credentials from process.env directly
 * (CLERUM_TELEGRAM_BOT_TOKEN etc.) and returns the same values for every
 * CC. Used when CLERUM_DEV_MODE=true so local iteration can drive a
 * Telegram/Slack/Email bot without needing K8s Secrets.
 *
 * Production paths use the K8s-backed CredentialsResolver above.
 */
export class DevCredentialsResolver {
  async resolve(_cc: CommunicationChannelCRD): Promise<ResolvedCredentials> {
    return {
      telegramBotToken: process.env.CLERUM_TELEGRAM_BOT_TOKEN,
      slackBotToken: process.env.CLERUM_SLACK_BOT_TOKEN,
      emailUsername: process.env.CLERUM_EMAIL_USERNAME,
      emailPassword: process.env.CLERUM_EMAIL_PASSWORD,
    }
  }
}
