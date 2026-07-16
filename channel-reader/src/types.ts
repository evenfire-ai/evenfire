/**
 * Shared types for the channel reader.
 */

/**
 * Telegram channel configuration.
 */
export interface TelegramConfig {
  channelId: string
  /**
   * Explicit Telegram chat type for this operational channel. Missing legacy
   * values are not inferred from numeric IDs and are skipped by channel-reader.
   */
  chatType?: TelegramProviderChatType
  userIds?: string[]
  /** User id of the member who verified this Telegram conversation for approvals. */
  confirmedByUserId?: string
  confirmedAt?: string
  title?: string
  handle?: string
  /** When true, groups require @mention or reply-to-bot; private chats unchanged. */
  replyOnlyWhenMentioned?: boolean
}

export type TelegramProviderChatType = 'private' | 'group' | 'supergroup' | 'channel'

/**
 * Email channel configuration.
 */
export interface EmailConfig {
  channelId: string
  emails: string[]
}

/**
 * Slack channel configuration.
 */
export interface SlackConfig {
  channelId: string
  /**
   * Stable Slack user IDs allowed for this channel group.
   * Use Slack IDs such as U0123456789, not display names.
   */
  userIds?: string[]
  /**
   * Legacy display-name allowlist kept for non-workflow chat compatibility.
   * Workflow approval decisions require userIds plus workspaceId.
   */
  userNames?: string[]
  /** Stable Slack workspace/team ID, for example T0123456789. */
  workspaceId?: string
  /** Slack conversation type captured at setup, such as channel, private_channel, im, or mpim. */
  conversationType?: string
  /** Slack conversation display name captured at setup. */
  title?: string
  /** User id of the member who verified this Slack conversation for approvals. */
  confirmedByUserId?: string
  confirmedAt?: string
  /** When true, require Slack app mention <@BOT_USER_ID> in the message text. */
  replyOnlyWhenMentioned?: boolean
}

/**
 * Microsoft Teams conversation configuration.
 */
export interface TeamsConfig {
  channelId: string
  tenantId?: string
  serviceUrl?: string
  conversationType?: string
  teamId?: string
  teamsChannelId?: string
  userIds?: string[]
  confirmedByUserId?: string
  confirmedAt?: string
  title?: string
  replyOnlyWhenMentioned?: boolean
  /** Defaults to true. False posts bot responses at the conversation root. */
  replyInThreads?: boolean
}

/**
 * Communication channel configuration (matches CRD spec).
 * Each channel type is an array of groups, where each group
 * has its own channelId and allowed users.
 */
export interface CommunicationChannelSpec {
  hostRef: string
  credentialsSecretRef?: { name: string }
  telegramSettings?: {
    replyOnlyWhenMentioned?: boolean
  }
  telegram?: TelegramConfig[]
  email?: EmailConfig[]
  slackSettings?: {
    /** Stable Slack workspace/team ID used while conversations are being confirmed. */
    workspaceId?: string
    /** Slack App name shown to users during Profile UI setup. */
    botHandle?: string
    replyOnlyWhenMentioned?: boolean
    replyInThreads?: boolean
  }
  slack?: SlackConfig[]
  teamsSettings?: {
    appName?: string
    appId?: string
    tenantId?: string
    replyOnlyWhenMentioned?: boolean
  }
  teams?: TeamsConfig[]
}

/**
 * Represents a CommunicationChannel CRD.
 */
export interface CommunicationChannelCRD {
  name: string
  namespace: string
  spec: CommunicationChannelSpec
}

/** Optional flags for polling / draining messages from an adapter. */
export interface FetchMessagesOptions {
  replyOnlyWhenMentioned?: boolean
  providerWorkspaceId?: string
  telegramChatType?: TelegramProviderChatType
  allowUnlistedSender?: boolean
  providerTarget?: ProviderTargetIdentity
  scanSlackConversations?: boolean
  slackVerificationOnly?: boolean
}

export interface ProviderTargetIdentity {
  hostRef: string
  communicationChannelNamespace: string
  communicationChannelName: string
  providerBotId?: string | null
  providerBotUsername?: string | null
}

export interface ProviderIdentity {
  medium: 'telegram' | 'slack' | 'teams'
  providerUserId: string
  providerWorkspaceId?: string | null
  providerChannelId: string
  providerChannelType?: string | null
  providerEventId: string
  providerTarget?: ProviderTargetIdentity
}

/**
 * Represents a message from any channel.
 */
export interface Message {
  channelType: 'telegram' | 'email' | 'slack' | 'teams'
  channelId: string
  sender: string
  content: string
  timestamp: Date
  messageId: string
  threadId?: string
  providerIdentity?: ProviderIdentity
  rawData?: Record<string, unknown>
}

export interface TelegramInlineKeyboardButton {
  text: string
  callbackData: string
}

export type SlackTextObject =
  | {
      type: 'plain_text'
      text: string
      emoji?: boolean
    }
  | {
      type: 'mrkdwn'
      text: string
      verbatim?: boolean
    }

export interface SlackButtonElement {
  type: 'button'
  action_id: string
  text: {
    type: 'plain_text'
    text: string
    emoji?: boolean
  }
  value: string
  style?: 'primary' | 'danger'
}

export type SlackBlock =
  | {
      type: 'section'
      text: SlackTextObject
      block_id?: string
    }
  | {
      type: 'actions'
      block_id?: string
      elements: SlackButtonElement[]
    }

export interface Attachment {
  id: string
  kind: 'image' | 'file'
  mimeType: string
  encoding: 'base64'
  dataBase64: string
  filename?: string
  caption?: string
  width?: number
  height?: number
  sourceTool?: string
  lane?: 'workflow_result' | 'internal_generated_artifact' | 'tool_image'
  artifactFormat?: string
  artifactName?: string
  sizeBytes?: number
  redactionState?: 'applied' | 'scanned' | 'skipped:binary'
  producer?: string
}

export interface SendMessageOptions {
  parseMode?: 'telegram-html'
  telegramInlineKeyboard?: TelegramInlineKeyboardButton[][]
  slackBlocks?: SlackBlock[]
  teamsActions?: Array<{
    title: string
    value: string
    style?: 'positive' | 'destructive'
  }>
}

/**
 * Channel adapter interface.
 */
export interface ChannelAdapter {
  readonly channelType: 'telegram' | 'email' | 'slack' | 'teams'

  connect(credentials?: AdapterCredentials): Promise<void>
  disconnect(): Promise<void>

  fetchMessages(
    channelId: string,
    allowedSenders: Set<string>,
    options?: FetchMessagesOptions
  ): Promise<Message[]>

  /**
   * Send a reply message to the channel.
   * @param channelId The channel to send to
   * @param content The message content
   * @param replyToMessageId Optional message ID to reply to
   */
  sendMessage(
    channelId: string,
    content: string,
    replyToMessageId?: string,
    attachments?: Attachment[],
    options?: SendMessageOptions
  ): Promise<string | undefined>

  editMessage(
    channelId: string,
    messageId: string,
    content: string,
    options?: SendMessageOptions
  ): Promise<void>
}

export interface AdapterCredentials {
  telegramBotToken?: string
  slackBotToken?: string
  teamsAppId?: string
  teamsAppPassword?: string
  teamsTenantId?: string
  teamsServiceUrlsByConversationId?: Map<string, string>
  emailUsername?: string
  emailPassword?: string
  providerTarget?: ProviderTargetIdentity
  providerTargets?: ProviderTargetIdentity[]
}

export interface ProgressStep {
  toolCallId: string
  toolName: string
  displayName: string
  intentSummary: string
  iteration: number
  stepIndex: number
  totalSteps: number
  state: 'running' | 'completed' | 'error'
  durationMs?: number
  errorSummary?: string
}
