import { describe, expect, it } from 'vitest'
import { type CronJobRecord, validateCronRecord } from '../cronJobs'

const CREATED_AT = 1_764_050_000

function target(): NonNullable<NonNullable<CronJobRecord['provider']>['providerTarget']> {
  return {
    hostRef: 'host-1',
    communicationChannelNamespace: 'channels',
    communicationChannelName: 'general',
    providerBotId: null,
    providerBotUsername: null,
  }
}

function record(overrides: Partial<CronJobRecord> & Pick<CronJobRecord, 'id'>): CronJobRecord {
  return {
    name: 'job',
    schedule: '0 8 * * *',
    task: 'check the channel',
    enabled: true,
    nextRunAt: CREATED_AT + 3600,
    lastRunAt: null,
    createdAt: CREATED_AT,
    createdBy: 'task-9',
    origin: null,
    provider: null,
    ...overrides,
  }
}

describe('validateCronRecord', () => {
  it('rejects a row whose provider_user_id differs from origin_sender', () => {
    const result = validateCronRecord(
      record({
        id: 'user-mismatch',
        origin: {
          channelType: 'slack',
          channelId: 'C123',
          sender: 'U123',
          threadId: null,
        },
        provider: {
          medium: 'slack',
          providerUserId: 'U999',
          providerWorkspaceId: 'T123',
          providerChannelId: 'C123',
          providerChannelType: null,
          providerTarget: target(),
        },
      })
    )

    expect(result.valid).toBe(false)
    expect(result.job.origin).toEqual({
      channelType: 'slack',
      channelId: 'C123',
      sender: 'U123',
    })
    expect(result.job.providerIdentity).toBeUndefined()
    expect(result.job.enabled).toBe(true)
  })

  it('rejects a telegram provider_channel_type of channel', () => {
    const result = validateCronRecord(
      record({
        id: 'telegram-channel',
        origin: {
          channelType: 'telegram',
          channelId: '424242',
          sender: '123456',
          threadId: null,
        },
        provider: {
          medium: 'telegram',
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: '424242',
          providerChannelType: 'channel',
          providerTarget: target(),
        },
      })
    )

    expect(result.valid).toBe(false)
    expect(result.job.origin?.channelType).toBe('telegram')
    expect(result.job.providerIdentity).toBeUndefined()
  })

  it('accepts telegram supergroup when the target triple is set', () => {
    const result = validateCronRecord(
      record({
        id: 'telegram-supergroup',
        origin: {
          channelType: 'telegram',
          channelId: '424242',
          sender: '123456',
          threadId: '77',
        },
        provider: {
          medium: 'telegram',
          providerUserId: '123456',
          providerWorkspaceId: null,
          providerChannelId: '424242',
          providerChannelType: 'supergroup',
          providerTarget: target(),
        },
      })
    )

    expect(result.valid).toBe(true)
    expect(result.job.origin).toEqual({
      channelType: 'telegram',
      channelId: '424242',
      sender: '123456',
      threadId: '77',
    })
    expect(result.job.providerIdentity).toEqual({
      medium: 'telegram',
      providerUserId: '123456',
      providerWorkspaceId: null,
      providerChannelId: '424242',
      providerChannelType: 'supergroup',
      providerTarget: target(),
    })
    expect(result.job.providerIdentity).not.toHaveProperty('providerEventId')
    expect(result.job.nextRun?.getTime()).toBe((CREATED_AT + 3600) * 1000)
    expect(result.job.createdAt.getTime()).toBe(CREATED_AT * 1000)
  })

  it('rejects slack with a null target and omits providerIdentity', () => {
    const result = validateCronRecord(
      record({
        id: 'slack-null-target',
        origin: {
          channelType: 'slack',
          channelId: 'C123',
          sender: 'U123',
          threadId: null,
        },
        provider: {
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'C123',
          providerChannelType: null,
          providerTarget: null,
        },
      })
    )

    expect(result.valid).toBe(false)
    expect(result.job.origin).toEqual({
      channelType: 'slack',
      channelId: 'C123',
      sender: 'U123',
    })
    expect(result.job.providerIdentity).toBeUndefined()
  })

  it('keeps both teams channel ids when the workspace is set', () => {
    const result = validateCronRecord(
      record({
        id: 'teams-1',
        name: 'standup',
        origin: {
          channelType: 'teams',
          channelId: '19:conversation',
          sender: 'user-1',
          threadId: 'reply-1',
        },
        provider: {
          medium: 'teams',
          providerUserId: 'user-1',
          providerWorkspaceId: 'workspace-1',
          providerChannelId: '19:channel',
          providerChannelType: null,
          providerTarget: target(),
        },
      })
    )

    expect(result.valid).toBe(true)
    expect(result.job.origin).toEqual({
      channelType: 'teams',
      channelId: '19:conversation',
      sender: 'user-1',
      threadId: 'reply-1',
    })
    expect(result.job.providerIdentity).toEqual({
      medium: 'teams',
      providerUserId: 'user-1',
      providerWorkspaceId: 'workspace-1',
      providerChannelId: '19:channel',
      providerChannelType: null,
      providerTarget: target(),
    })
    expect(result.job.providerIdentity).not.toHaveProperty('providerEventId')
  })
})
