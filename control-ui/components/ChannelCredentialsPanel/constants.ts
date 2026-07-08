import type { CredentialField } from './types'

/**
 * Credential keys that can be stored on a CommunicationChannel credential
 * Secret. Keys MUST match the values accepted by control-api's per-CC
 * credentials route. Runtime readers currently consume Telegram bot token,
 * Slack Bot User OAuth token, Slack Signing Secret, and email credentials.
 */
export const CHANNEL_CREDENTIAL_FIELDS: CredentialField[] = [
  {
    channelType: 'telegram',
    key: 'telegram-bot-token',
    label: 'Telegram Bot Token',
    placeholder: '123456789:ABCDEF…',
    helpText: 'Token from @BotFather. Leave blank if Telegram is not used.',
  },
  {
    channelType: 'slack',
    key: 'slack-signing-secret',
    label: 'Slack Signing Secret',
    placeholder: 'signing secret',
    helpText: 'Required for Slack Events and Interactivity signature verification.',
  },
  {
    channelType: 'slack',
    key: 'slack-bot-token',
    label: 'Slack Bot User OAuth Token',
    placeholder: 'xoxb-…',
    helpText:
      'Required after the app is installed in the workspace. Used to read and send messages.',
  },
  {
    channelType: 'email',
    key: 'email-username',
    label: 'Email Username',
    placeholder: 'agent@example.com',
    helpText: 'IMAP username for the channel-reader mailbox.',
  },
  {
    channelType: 'email',
    key: 'email-password',
    label: 'Email Password',
    placeholder: 'app-specific password',
    helpText: 'IMAP password (use an app password where possible).',
  },
]
