import type { CredentialField } from './types'

/**
 * Credential keys that can be stored on a CommunicationChannel credential
 * Secret. Keys MUST match the values accepted by control-api's per-CC
 * credentials route. Runtime readers currently consume Telegram bot token,
 * Slack Bot User OAuth token, Slack Signing Secret, Teams bot password, and
 * email credentials.
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
    // The one value operators cannot find. Slack never shows it during install,
    // so the dialog that hands over the bot token looks complete when it is not.
    // Naming the page beats describing what the secret does.
    helpText:
      'In your Slack app: Basic Information → App Credentials → Signing Secret, then Show. It is not in the dialog shown after you install the app — that one only carries the bot token. Used to verify that Events and Interactivity requests really came from Slack.',
  },
  {
    channelType: 'slack',
    key: 'slack-bot-token',
    label: 'Slack Bot User OAuth Token',
    placeholder: 'xoxb-…',
    helpText:
      'In your Slack app: OAuth & Permissions → Bot User OAuth Token, and it only exists once you have installed the app to the workspace. Starts xoxb-, not xapp-. Used to read and send messages.',
  },
  {
    channelType: 'teams',
    key: 'teams-app-password',
    label: 'CLIENT_SECRET',
    placeholder: 'CLIENT_SECRET',
    helpText:
      'Use the CLIENT_SECRET value from the generated .env file, not a Microsoft secret ID.',
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
