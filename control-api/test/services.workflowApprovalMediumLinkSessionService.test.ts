import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, withTransaction } from '../src/db.js'
import {
  confirmMediumLinkSessionFromReader,
  createMediumLinkSession,
} from '../src/services/workflowApprovalMediumLinkSessionService.js'

vi.mock('../src/config.js', () => ({
  config: {
    approvalMediumChallengeTtlSec: 900,
  },
}))

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(),
  },
  withTransaction: vi.fn(),
}))

const mockedPoolQuery = vi.mocked(pool.query) as ReturnType<typeof vi.fn>
const mockedWithTransaction = vi.mocked(withTransaction)

describe('workflowApprovalMediumLinkSessionService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedPoolQuery.mockReset()
    mockedWithTransaction.mockReset()
  })

  it('rejects Telegram reader-driven link sessions before storing a nonce', async () => {
    await expect(
      createMediumLinkSession({
        userId: 'user-1',
        medium: 'telegram',
      })
    ).rejects.toThrow('telegram_target_required')

    expect(mockedPoolQuery).not.toHaveBeenCalled()
  })

  it('creates Slack reader-driven link sessions scoped to a workspace', async () => {
    mockedPoolQuery.mockResolvedValueOnce({
      rows: [{ id: 'session-1', expiresAt: '2026-06-16T12:00:00.000Z' }],
    })

    await expect(
      createMediumLinkSession({
        userId: 'user-1',
        medium: 'slack',
        providerWorkspaceId: 'T123',
      })
    ).resolves.toMatchObject({
      id: 'session-1',
      nonce: expect.stringMatching(/^\d{6}$/),
      expiresAt: '2026-06-16T12:00:00.000Z',
      deepLinkUrl: null,
    })

    expect(mockedPoolQuery).toHaveBeenCalledWith(expect.any(String), [
      'user-1',
      'slack',
      '__reader_link__',
      'T123',
      null,
      expect.stringMatching(/^reader-link-sha256:/),
      120,
    ])
  })

  it('creates Slack reader-driven link sessions before the workspace is detected', async () => {
    mockedPoolQuery.mockResolvedValueOnce({
      rows: [{ id: 'session-1', expiresAt: '2026-06-16T12:00:00.000Z' }],
    })

    await expect(
      createMediumLinkSession({
        userId: 'user-1',
        medium: 'slack',
      })
    ).resolves.toMatchObject({
      id: 'session-1',
      nonce: expect.stringMatching(/^\d{6}$/),
      expiresAt: '2026-06-16T12:00:00.000Z',
      deepLinkUrl: null,
    })

    expect(mockedPoolQuery).toHaveBeenCalledWith(expect.any(String), [
      'user-1',
      'slack',
      '__reader_link__',
      null,
      null,
      expect.stringMatching(/^reader-link-sha256:/),
      120,
    ])
  })

  it('rejects Telegram link-session confirmations before reading the nonce', async () => {
    await expect(
      confirmMediumLinkSessionFromReader({
        nonce: '123456',
        identity: {
          medium: 'telegram',
          providerUserId: '123',
          providerChannelId: '456',
          communicationChannelRef: 'channels/cc-a',
        },
      })
    ).resolves.toEqual({ ok: false, error: 'telegram_target_required' })

    expect(mockedWithTransaction).not.toHaveBeenCalled()
  })

  it('requires a channel-scoped Slack target before reading the nonce', async () => {
    await expect(
      confirmMediumLinkSessionFromReader({
        nonce: '123456',
        identity: {
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'D123',
        },
      })
    ).resolves.toEqual({ ok: false, error: 'communication_channel_ref_required' })

    expect(mockedWithTransaction).not.toHaveBeenCalled()
  })

  it('requires a Slack workspace before reading the nonce', async () => {
    await expect(
      confirmMediumLinkSessionFromReader({
        nonce: '123456',
        identity: {
          medium: 'slack',
          providerUserId: 'U123',
          providerChannelId: 'D123',
          communicationChannelRef: 'channels/slack-a',
        },
      })
    ).resolves.toEqual({ ok: false, error: 'slack_workspace_id_required' })

    expect(mockedWithTransaction).not.toHaveBeenCalled()
  })

  it('rejects Slack link-session confirmations when the nonce workspace does not match', async () => {
    const db = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [
          {
            id: 'session-1',
            userId: 'user-1',
            providerWorkspaceId: 'T999',
            isExpired: false,
            consumedAt: null,
          },
        ],
      }),
    }
    mockedWithTransaction.mockImplementation(async callback => callback(db as never))

    await expect(
      confirmMediumLinkSessionFromReader({
        nonce: '123456',
        identity: {
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'D123',
          communicationChannelRef: 'channels/slack-a',
        },
      })
    ).resolves.toEqual({ ok: false, error: 'link_session_workspace_mismatch' })

    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('confirms Slack link sessions into channel-scoped verified accounts', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'session-1',
              userId: 'user-1',
              providerWorkspaceId: 'T123',
              isExpired: false,
              consumedAt: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'account-1',
              userId: 'user-1',
              medium: 'slack',
              providerUserId: 'U123',
              providerWorkspaceId: 'T123',
              providerChannelId: 'D123',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
    }
    mockedWithTransaction.mockImplementation(async callback => callback(db as never))

    await expect(
      confirmMediumLinkSessionFromReader({
        nonce: '123456',
        identity: {
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'D123',
          communicationChannelRef: 'channels/slack-a',
        },
      })
    ).resolves.toEqual({
      ok: true,
      account: {
        id: 'account-1',
        userId: 'user-1',
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'D123',
      },
    })

    expect(db.query.mock.calls[2]?.[1]).toEqual([
      'user-1',
      'slack',
      'U123',
      'T123',
      'D123',
      'channels/slack-a',
    ])
    expect(db.query.mock.calls[3]?.[1]).toEqual(['session-1'])
  })

  it('confirms Slack link sessions when the nonce was created before workspace detection', async () => {
    const db = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'session-1',
              userId: 'user-1',
              providerWorkspaceId: null,
              isExpired: false,
              consumedAt: null,
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'account-1',
              userId: 'user-1',
              medium: 'slack',
              providerUserId: 'U123',
              providerWorkspaceId: 'T123',
              providerChannelId: 'D123',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] }),
    }
    mockedWithTransaction.mockImplementation(async callback => callback(db as never))

    await expect(
      confirmMediumLinkSessionFromReader({
        nonce: '123456',
        identity: {
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
          providerChannelId: 'D123',
          communicationChannelRef: 'channels/slack-a',
        },
      })
    ).resolves.toEqual({
      ok: true,
      account: {
        id: 'account-1',
        userId: 'user-1',
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'D123',
      },
    })

    expect(db.query.mock.calls[2]?.[1]).toEqual([
      'user-1',
      'slack',
      'U123',
      'T123',
      'D123',
      'channels/slack-a',
    ])
    expect(db.query.mock.calls[3]?.[1]).toEqual(['session-1'])
  })
})
