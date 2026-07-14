import type { CommunicationChannelCRD } from './types'

export function validateCommunicationChannelConfig(channelCRD: CommunicationChannelCRD): void {
  const { spec, name } = channelCRD

  if (spec.telegram) {
    for (let i = 0; i < spec.telegram.length; i++) {
      const group = spec.telegram[i]
      const label = `Telegram group[${i}] in channel "${name}"`

      if (!group.channelId || group.channelId.trim() === '') {
        throw new Error(`Invalid ${label}: channelId cannot be empty.`)
      }
      if (
        group.chatType &&
        group.chatType !== 'private' &&
        group.chatType !== 'group' &&
        group.chatType !== 'supergroup'
      ) {
        throw new Error(`Invalid ${label}: chatType must be private, group, or supergroup.`)
      }
      const emptyUserIds = (group.userIds ?? []).filter(id => !id || id.trim() === '')
      if (emptyUserIds.length > 0) {
        throw new Error(`Invalid ${label}: userIds contains empty values.`)
      }
    }
  }

  if (spec.email) {
    for (let i = 0; i < spec.email.length; i++) {
      const group = spec.email[i]
      const label = `Email group[${i}] in channel "${name}"`

      if (!group.channelId || group.channelId.trim() === '') {
        throw new Error(`Invalid ${label}: channelId cannot be empty.`)
      }
      if (!group.emails || group.emails.length === 0) {
        throw new Error(`Invalid ${label}: emails cannot be empty.`)
      }
      const emptyEmails = group.emails.filter(e => !e || e.trim() === '')
      if (emptyEmails.length > 0) {
        throw new Error(`Invalid ${label}: emails contains empty values.`)
      }
    }
  }

  if (spec.slack) {
    for (let i = 0; i < spec.slack.length; i++) {
      const group = spec.slack[i]
      const label = `Slack group[${i}] in channel "${name}"`

      if (!group.channelId || group.channelId.trim() === '') {
        throw new Error(`Invalid ${label}: channelId cannot be empty.`)
      }
      const userIds = group.userIds ?? []
      const userNames = group.userNames ?? []
      if (userIds.length === 0 && userNames.length === 0) {
        throw new Error(`Invalid ${label}: userIds or userNames cannot be empty.`)
      }
      if (userIds.length > 0) {
        if (!/^[CDG][A-Z0-9]+$/.test(group.channelId.trim())) {
          throw new Error(
            `Invalid ${label}: channelId must be a stable Slack channel ID (C..., D..., or G...) when userIds are configured.`
          )
        }
        if (!group.workspaceId || !/^T[A-Z0-9]+$/.test(group.workspaceId.trim())) {
          throw new Error(
            `Invalid ${label}: workspaceId must be a stable Slack team ID (T...) when userIds are configured.`
          )
        }
      }
      const emptyUserIds = userIds.filter(u => !u || u.trim() === '')
      if (emptyUserIds.length > 0) {
        throw new Error(`Invalid ${label}: userIds contains empty values.`)
      }
      const emptyUserNames = userNames.filter(u => !u || u.trim() === '')
      if (emptyUserNames.length > 0) {
        throw new Error(`Invalid ${label}: userNames contains empty values.`)
      }
    }
  }
}
