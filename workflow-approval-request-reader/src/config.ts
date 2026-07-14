import { parseMcpHostTargets } from './mcpHostTargets.js'

export type McpHostTarget = {
  hostRef: string
  baseUrl: string
}

export type ReaderConfig = {
  port: number
  mcpHostBaseUrl: string
  mcpHostRef: string
  mcpHostTargets: McpHostTarget[]
  mcpHostTargetsFile?: string
  enabledMedia: Set<string>
  mcpHostTimeoutMs: number
  mcpHostMessageTimeoutMs: number
  rateLimitWindowMs: number
  rateLimitMaxRequests: number
  telegramWebhookSecret?: string
  slackSigningSecret?: string
  // Figure D: control-api consulta endpoint (spec step 6). When both are set,
  // the reader validates can-approve before forwarding provider decisions and
  // resolves CommunicationChannel refs before confirming enrollment link
  // sessions. Empty token/baseUrl disables control-api calls; enrollment then
  // fails closed at mcp-host because no channel ref can be resolved.
  controlApiBaseUrl: string
  controlApiToken: string
  controlApiTimeoutMs: number
  channelReaderUrlTemplate: string
  channelReaderHandoffToken: string
  channelReaderHandoffTimeoutMs: number
}

function csvSet(value: string): Set<string> {
  const media = new Set(
    value
      .split(',')
      .map(item => item.trim().toLowerCase())
      .filter(Boolean)
  )
  for (const medium of media) {
    if (medium !== 'telegram' && medium !== 'slack') {
      throw new Error(`WORKFLOW_APPROVAL_READER_ENABLED_MEDIA unsupported medium: ${medium}`)
    }
  }
  return media
}

function intFromEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (!raw) return defaultValue
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

const primaryMcpHostBaseUrl =
  process.env.WORKFLOW_APPROVAL_READER_MCP_HOST_BASE_URL ||
  process.env.MCP_HOST_BASE_URL ||
  ''

const primaryMcpHostRef =
  process.env.WORKFLOW_APPROVAL_READER_MCP_HOST_REF ||
  process.env.MCP_HOST_REF ||
  ''

export const config: ReaderConfig = {
  port: Number(process.env.WORKFLOW_APPROVAL_READER_PORT || 8098),
  mcpHostBaseUrl: primaryMcpHostBaseUrl,
  mcpHostRef: primaryMcpHostRef,
  mcpHostTargets: parseMcpHostTargets(process.env.WORKFLOW_APPROVAL_READER_MCP_HOST_TARGETS, {
    hostRef: primaryMcpHostRef,
    baseUrl: primaryMcpHostBaseUrl,
  }),
  mcpHostTargetsFile: process.env.WORKFLOW_APPROVAL_READER_MCP_HOST_TARGETS_FILE,
  enabledMedia: csvSet(process.env.WORKFLOW_APPROVAL_READER_ENABLED_MEDIA || 'telegram,slack'),
  mcpHostTimeoutMs: intFromEnv('WORKFLOW_APPROVAL_READER_MCP_HOST_TIMEOUT_MS', 5000),
  mcpHostMessageTimeoutMs: intFromEnv(
    'WORKFLOW_APPROVAL_READER_MCP_HOST_MESSAGE_TIMEOUT_MS',
    120_000
  ),
  rateLimitWindowMs: intFromEnv('WORKFLOW_APPROVAL_READER_RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMaxRequests: intFromEnv('WORKFLOW_APPROVAL_READER_RATE_LIMIT_MAX_REQUESTS', 120),
  telegramWebhookSecret: process.env.WORKFLOW_APPROVAL_READER_TELEGRAM_SECRET,
  slackSigningSecret: process.env.WORKFLOW_APPROVAL_READER_SLACK_SIGNING_SECRET,
  controlApiBaseUrl: process.env.WORKFLOW_APPROVAL_READER_CONTROL_API_BASE_URL || '',
  controlApiToken: process.env.WORKFLOW_APPROVAL_READER_CONTROL_API_TOKEN || '',
  controlApiTimeoutMs: intFromEnv('WORKFLOW_APPROVAL_READER_CONTROL_API_TIMEOUT_MS', 4000),
  channelReaderUrlTemplate:
    process.env.WORKFLOW_APPROVAL_READER_CHANNEL_READER_URL_TEMPLATE ||
    'http://channel-reader-{host}:8099',
  channelReaderHandoffToken:
    process.env.WORKFLOW_APPROVAL_READER_CHANNEL_READER_HANDOFF_TOKEN || '',
  channelReaderHandoffTimeoutMs: intFromEnv(
    'WORKFLOW_APPROVAL_READER_CHANNEL_READER_HANDOFF_TIMEOUT_MS',
    5000
  ),
}
