/**
 * Configuration settings loaded from environment variables.
 */
import { CommunicationChannelSpec } from './types'

export interface Config {
  // Dev mode - if true, reads channel config from CLERUM_CHANNEL env var instead of K8s
  devMode: boolean

  // Channel config for dev mode (parsed from CLERUM_CHANNEL)
  devChannelConfig?: CommunicationChannelSpec

  // Host reference - filter CommunicationChannels by this hostRef
  hostRef: string

  // Kubernetes namespace to watch (empty = all namespaces)
  namespace: string

  // MCP Host URL for RPC communication
  mcpHostUrl: string

  // Workflow approval delivery queue polling is mediated by mcp-host.
  // channel-reader must not carry control-api service credentials.
  notificationDeliveryPollLimit: number

  /** Optional. When set, the unresolved-sender notice links here. */
  profileUiUrl?: string

  // Telegram Bot API root. Defaults to Telegram's public API; E2E may point
  // this at a provider-boundary mock without adding an HTTP ingress to
  // channel-reader.
  telegramApiRoot?: string
  telegramStartupStabilityMs: number
  telegramShutdownGraceMs: number

  // Email (IMAP host/port retained — those are infrastructure, not credentials)
  emailImapHost?: string
  emailImapPort: number

  // Email (SMTP for sending)
  emailSmtpHost?: string
  emailSmtpPort: number

  // Polling
  pollIntervalSeconds: number

  // Attachment delivery
  enableResponseAttachments: boolean
  attachmentMaxCount: number
  attachmentMaxBytes: number

  // Internal handoff endpoint used by workflow-approval-request-reader after
  // provider signature verification. Empty token disables the listener.
  channelReaderHandoffPort: number
  channelReaderHandoffToken: string
}

function getEnv(key: string, defaultValue?: string): string | undefined {
  return process.env[key] ?? defaultValue
}

const RFC1123_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

function resolveDefaultMcpHostUrl(hostRef: string, devMode: boolean): string {
  if (devMode) return 'http://localhost:8080'
  const safeHostRef = hostRef.trim() || 'mcp-host'
  if (!RFC1123_LABEL_RE.test(safeHostRef)) {
    throw new Error(
      `[Config] Invalid CLERUM_HOST_REF: "${safeHostRef}" is not a valid RFC1123 DNS label`
    )
  }
  return `http://${safeHostRef}.mcp-host.svc.cluster.local:8080`
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key]
  if (!value) return defaultValue
  return value.toLowerCase() === 'true' || value === '1'
}

function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key]
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  return isNaN(parsed) ? defaultValue : parsed
}

/**
 * Parse CLERUM_CHANNEL JSON for dev mode.
 */
function parseDevChannelConfig(): CommunicationChannelSpec | undefined {
  const channelJson = process.env.CLERUM_CHANNEL
  if (!channelJson) {
    return undefined
  }

  try {
    const parsed = JSON.parse(channelJson) as CommunicationChannelSpec
    console.log('[Config] Parsed dev channel config:')
    console.log('[Config]   hostRef:', parsed.hostRef)
    console.log('[Config]   telegram:', parsed.telegram ? 'configured' : 'not set')
    console.log('[Config]   email:', parsed.email ? 'configured' : 'not set')
    console.log('[Config]   slack:', parsed.slack ? 'configured' : 'not set')
    return parsed
  } catch (error) {
    console.error(
      '[Config] Failed to parse CLERUM_CHANNEL:',
      error instanceof Error ? error.message : error
    )
    console.error('[Config] Raw value (first 50 chars):', channelJson.substring(0, 50))
    return undefined
  }
}

const devMode = getEnvBool('CLERUM_DEV_MODE', false)

export const config: Config = {
  // Dev mode
  devMode,
  devChannelConfig: devMode ? parseDevChannelConfig() : undefined,

  // Host reference (required in production, optional in dev mode)
  hostRef:
    process.env.CLERUM_HOST_REF ||
    (devMode
      ? 'dev'
      : (() => {
          throw new Error('Missing required environment variable: CLERUM_HOST_REF')
        })()),

  // Kubernetes namespace (empty = all namespaces)
  namespace: getEnv('CLERUM_NAMESPACE', '')!,

  // MCP Host URL (defaults to hostRef-specific service in production)
  mcpHostUrl: getEnv(
    'CLERUM_MCP_HOST_URL',
    resolveDefaultMcpHostUrl(process.env.CLERUM_HOST_REF || (devMode ? 'dev' : 'mcp-host'), devMode)
  )!,

  notificationDeliveryPollLimit: getEnvInt('CLERUM_NOTIFICATION_DELIVERY_POLL_LIMIT', 10),

  /** Optional. When set, the unresolved-sender notice links here. */
  profileUiUrl: getEnv('CLERUM_PROFILE_UI_URL'),

  telegramApiRoot: getEnv('CLERUM_TELEGRAM_API_ROOT'),
  telegramStartupStabilityMs: getEnvInt('CLERUM_TELEGRAM_STARTUP_STABILITY_MS', 1000),
  telegramShutdownGraceMs: getEnvInt('CLERUM_TELEGRAM_SHUTDOWN_GRACE_MS', 750),

  // Email (IMAP for receiving)
  emailImapHost: getEnv('CLERUM_EMAIL_IMAP_HOST'),
  emailImapPort: getEnvInt('CLERUM_EMAIL_IMAP_PORT', 993),

  // Email (SMTP for sending - defaults to IMAP host if not set)
  emailSmtpHost: getEnv('CLERUM_EMAIL_SMTP_HOST') || getEnv('CLERUM_EMAIL_IMAP_HOST'),
  emailSmtpPort: getEnvInt('CLERUM_EMAIL_SMTP_PORT', 587),

  // Polling
  // 2s default: grammY/Slack push messages into an in-memory queue near-instantly
  // via their long-polling/websocket transports, so pollCycle's job for those
  // channels is just to drain a local queue. The legacy 30s default added up to
  // 30s of pure dead time between user send and mcp-host dispatch. Email still
  // makes a real IMAP SEARCH per cycle; 2s is well within typical IMAP server
  // tolerance for `SEARCH UNSEEN`.
  pollIntervalSeconds: getEnvInt('CLERUM_POLL_INTERVAL_SECONDS', 2),

  // Attachment delivery
  enableResponseAttachments: getEnvBool('CLERUM_ENABLE_RESPONSE_ATTACHMENTS', true),
  attachmentMaxCount: getEnvInt('CLERUM_ATTACHMENT_MAX_COUNT', 3),
  attachmentMaxBytes: getEnvInt('CLERUM_ATTACHMENT_MAX_BYTES', 52_428_800),
  channelReaderHandoffPort: getEnvInt('CLERUM_CHANNEL_READER_HANDOFF_PORT', 8099),
  channelReaderHandoffToken: getEnv('CLERUM_CHANNEL_READER_HANDOFF_TOKEN', '')!,
}
