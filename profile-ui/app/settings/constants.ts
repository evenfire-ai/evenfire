import type { ProfileChannelSection, SocialChannelTab } from './types'

export const APPROVAL_ACCOUNT_DISPLAY_NAME_MAX_LENGTH = 120

export const EMAIL_CHANNEL_SECTION: ProfileChannelSection = {
  key: 'emails',
  title: 'Contact emails',
  description: 'Alternate email addresses for profile contact.',
  placeholder: 'name@example.com',
  addLabel: 'Add email',
}

const TELEGRAM_CHANNEL_SECTIONS: ProfileChannelSection[] = []

const SLACK_CHANNEL_SECTIONS: ProfileChannelSection[] = [
  {
    key: 'slackUserNames',
    title: 'Slack users',
    description: 'Slack handles or user IDs associated with this profile.',
    placeholder: '@name or U123456789',
    addLabel: 'Add Slack user',
  },
]

export const PROFILE_SOCIAL_CHANNEL_TABS: SocialChannelTab[] = [
  {
    key: 'telegram',
    label: 'Telegram',
    description: 'Connect a Telegram profile and verify workflow approval access per bot target.',
    sections: TELEGRAM_CHANNEL_SECTIONS,
    status: 'active',
  },
  {
    key: 'slack',
    label: 'Slack',
    description: 'Connect Slack conversations for agent chat and workflow approvals.',
    sections: SLACK_CHANNEL_SECTIONS,
    status: 'active',
  },
  {
    key: 'teams',
    label: 'Teams',
    description: 'Connect Microsoft Teams conversations for agent chat and workflow approvals.',
    sections: [],
    status: 'active',
  },
]
