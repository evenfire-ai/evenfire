type ValidationIssue = { field: string; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function validateCommunicationChannelSpec(spec: Record<string, unknown>): ValidationIssue[] {
  const errors: ValidationIssue[] = []
  const access = isRecord(spec.access) ? spec.access : null
  if (access) {
    for (const key of ['users', 'teams'] as const) {
      const values = Array.isArray(access[key]) ? access[key] : []
      values.forEach((value, index) => {
        if (typeof value !== 'string' || !value.trim()) {
          errors.push({
            field: `spec.access.${key}[${index}]`,
            message: `${key} cannot contain empty values`,
          })
        }
      })
    }
  }
  const telegramSettings = isRecord(spec.telegramSettings) ? spec.telegramSettings : null
  if (telegramSettings?.botHandle !== undefined) {
    const botHandle =
      typeof telegramSettings.botHandle === 'string' ? telegramSettings.botHandle.trim() : ''
    if (!/^@?[A-Za-z0-9_]{5,32}$/.test(botHandle)) {
      errors.push({
        field: 'spec.telegramSettings.botHandle',
        message: 'botHandle must be a valid Telegram bot handle',
      })
    }
  }
  const slackSettings = isRecord(spec.slackSettings) ? spec.slackSettings : null
  if (slackSettings?.workspaceId !== undefined) {
    const workspaceId =
      typeof slackSettings.workspaceId === 'string' ? slackSettings.workspaceId.trim() : ''
    if (!/^T[A-Z0-9]+$/.test(workspaceId)) {
      errors.push({
        field: 'spec.slackSettings.workspaceId',
        message: 'workspaceId must be a valid Slack workspace/team ID',
      })
    }
  }
  if (slackSettings?.botHandle !== undefined) {
    const botHandle =
      typeof slackSettings.botHandle === 'string' ? slackSettings.botHandle.trim() : ''
    if (!botHandle || botHandle.length > 80) {
      errors.push({
        field: 'spec.slackSettings.botHandle',
        message: 'botHandle must be a non-empty Slack App Name',
      })
    }
  }
  if (
    slackSettings?.replyInThreads !== undefined &&
    typeof slackSettings.replyInThreads !== 'boolean'
  ) {
    errors.push({
      field: 'spec.slackSettings.replyInThreads',
      message: 'replyInThreads must be a boolean',
    })
  }
  const telegram = spec.telegram
  const slack = spec.slack

  if (Array.isArray(telegram))
    telegram.forEach((entry, index) => {
      const group = isRecord(entry) ? entry : {}
      const field = `spec.telegram[${index}]`
      const channelId = typeof group.channelId === 'string' ? group.channelId.trim() : ''
      if (!channelId) {
        errors.push({ field: `${field}.channelId`, message: 'channelId is required' })
      }
      const chatType = typeof group.chatType === 'string' ? group.chatType.trim() : ''
      if (!chatType) {
        errors.push({ field: `${field}.chatType`, message: 'chatType is required' })
      } else if (chatType !== 'private' && chatType !== 'group' && chatType !== 'supergroup') {
        errors.push({
          field: `${field}.chatType`,
          message: 'chatType must be private, group, or supergroup',
        })
      }
      const userIds = Array.isArray(group.userIds) ? group.userIds : []
      userIds.forEach((userId, userIndex) => {
        if (typeof userId !== 'string' || !userId.trim()) {
          errors.push({
            field: `${field}.userIds[${userIndex}]`,
            message: 'userIds cannot contain empty values',
          })
        }
      })
      for (const key of ['title', 'handle', 'confirmedByUserId', 'confirmedAt'] as const) {
        const value = group[key]
        if (value !== undefined && value !== null && typeof value !== 'string') {
          errors.push({
            field: `${field}.${key}`,
            message: `${key} must be a string`,
          })
        }
      }
    })
  if (Array.isArray(slack)) {
    slack.forEach((entry, index) => {
      const group = isRecord(entry) ? entry : {}
      const field = `spec.slack[${index}]`
      const channelId = typeof group.channelId === 'string' ? group.channelId.trim() : ''
      if (!channelId) {
        errors.push({ field: `${field}.channelId`, message: 'channelId is required' })
      }
      const userIds = Array.isArray(group.userIds) ? group.userIds : []
      const userNames = Array.isArray(group.userNames) ? group.userNames : []
      const workspaceId = typeof group.workspaceId === 'string' ? group.workspaceId.trim() : ''
      if (!workspaceId && (userIds.length > 0 || userNames.length === 0)) {
        errors.push({ field: `${field}.workspaceId`, message: 'workspaceId is required' })
      } else if (workspaceId && !/^T[A-Z0-9]+$/.test(workspaceId)) {
        errors.push({
          field: `${field}.workspaceId`,
          message: 'workspaceId must be a valid Slack workspace/team ID',
        })
      }
      userIds.forEach((userId, userIndex) => {
        if (typeof userId !== 'string' || !userId.trim()) {
          errors.push({
            field: `${field}.userIds[${userIndex}]`,
            message: 'userIds cannot contain empty values',
          })
        }
      })
      for (const key of ['confirmedByUserId', 'confirmedAt'] as const) {
        const value = group[key]
        if (value !== undefined && value !== null && typeof value !== 'string') {
          errors.push({
            field: `${field}.${key}`,
            message: `${key} must be a string`,
          })
        }
      }
    })
  }
  return errors
}
