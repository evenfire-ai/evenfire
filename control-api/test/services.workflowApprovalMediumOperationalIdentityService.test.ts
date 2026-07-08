import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { findVerifiedOperationalMediumAccount } from '../src/services/workflowApprovalMediumOperationalIdentityService.js'

type FakeDb = { query: ReturnType<typeof vi.fn> }

function fakeDb(rows: unknown[] = []): FakeDb {
  return { query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) }
}

const telegramTarget = (namespace: string, name: string) => ({
  hostRef: 'chatllm',
  communicationChannelNamespace: namespace,
  communicationChannelName: name,
})

describe('findVerifiedOperationalMediumAccount — cross-bot channel binding', () => {
  it('filters by communication_channel_ref derived from providerTarget', async () => {
    const db = fakeDb([{ id: 'acc-1', userId: 'u1', medium: 'telegram' }])

    await findVerifiedOperationalMediumAccount(
      {
        medium: 'telegram',
        providerUserId: '123',
        providerChannelId: '-1001',
        providerChannelType: 'group',
        providerTarget: telegramTarget('channels', 'cc-a'),
      },
      db as never
    )

    expect(db.query).toHaveBeenCalledTimes(1)
    const [sql, params] = db.query.mock.calls[0]!
    expect(sql).toContain('communication_channel_ref = $5')
    // params: [medium, providerUserId, workspace(null), private channel(null for group), channelRef]
    expect(params).toEqual(['telegram', '123', null, null, 'channels/cc-a'])
  })

  it('passes the REQUEST channel ref, so a cc-b request never matches a cc-a account', async () => {
    // Account exists only for cc-a; a request bound to cc-b must query with the
    // cc-b ref → the SQL filter excludes the cc-a row (real exclusion proven in
    // the E2E gate; here we assert the correct ref is threaded to the query).
    const db = fakeDb([])

    const account = await findVerifiedOperationalMediumAccount(
      {
        medium: 'telegram',
        providerUserId: '123',
        providerChannelId: '-2002',
        providerChannelType: 'group',
        providerTarget: telegramTarget('channels', 'cc-b'),
      },
      db as never
    )

    const [, params] = db.query.mock.calls[0]!
    expect(params[4]).toBe('channels/cc-b')
    expect(account).toBeNull()
  })

  it('STRICT telegram binding: no channel ref (private DM without target) matches no account', async () => {
    // Owner decision: every telegram approval must carry a channel. The filter is
    // unconditional `communication_channel_ref = $3`; with a null ref the SQL
    // `col = NULL` matches nothing → returns null → caller rejects (403).
    const db = fakeDb([])
    const account = await findVerifiedOperationalMediumAccount(
      {
        medium: 'telegram',
        providerUserId: '123',
        providerChannelId: '999',
        providerChannelType: 'private',
      },
      db as never
    )
    const [sql, params] = db.query.mock.calls[0]!
    expect(sql).toContain('communication_channel_ref = $5')
    expect(sql).not.toContain('IS NULL OR communication_channel_ref')
    expect(params[4]).toBeNull()
    expect(account).toBeNull()
  })

  it('identity-only mode (workflow-access resolve): no channel-ref filter, matches by provider identity', async () => {
    // Regression for the workflow-access bug: PR #547's STRICT
    // `communication_channel_ref = $3` broke POST /workflow-approval-mediums/resolve,
    // which carries NO channel ref (mcp-host sends no providerTarget). With the
    // STRICT filter, `col = NULL` matched nothing -> 404 -> "Could not verify
    // this Telegram conversation for workflow access" for a fully verified user.
    // identity-only mode must drop the ref filter and do a single query (no alias
    // resolution) so the verified account resolves.
    const db = fakeDb([{ id: 'acc-1', userId: 'u1', medium: 'telegram' }])
    const account = await findVerifiedOperationalMediumAccount(
      {
        medium: 'telegram',
        providerUserId: '721954225',
        providerChannelId: '721954225',
        providerChannelType: 'private',
      },
      db as never,
      { channelBinding: 'identity-only' }
    )
    expect(db.query).toHaveBeenCalledTimes(1)
    const [sql, params] = db.query.mock.calls[0]!
    expect(sql).toContain('communication_channel_ref AS "communicationChannelRef"')
    expect(sql).not.toContain('communication_channel_ref =')
    expect(params).toEqual(['telegram', '721954225', null, '721954225'])
    expect(account).not.toBeNull()
  })

  it('Figure D alias: resolves channelAlias → channelRef before the STRICT filter', async () => {
    // The reader path carries a signed channelAlias (sha256 of the ref, 8 hex)
    // instead of ns/name. resolveChannelRefByAlias scans the user's accounts and
    // matches the hash, then passes the resolved ref to the STRICT filter.
    const ref = 'channels/cc-a'
    const alias = createHash('sha256').update(ref).digest('hex').slice(0, 16)
    const db = { query: vi.fn() }
    // 1st call: alias resolution → returns the account with matching ref
    db.query.mockResolvedValueOnce({
      rows: [{ communicationChannelRef: ref }],
      rowCount: 1,
    })
    // 2nd call: main STRICT filter → returns the matched account
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'acc-1', userId: 'u1', medium: 'telegram' }],
      rowCount: 1,
    })

    const account = await findVerifiedOperationalMediumAccount(
      {
        medium: 'telegram',
        providerUserId: '123',
        providerChannelId: '123',
        providerChannelType: 'private',
        providerTarget: { communicationChannelAlias: alias },
      },
      db as never
    )

    // Two queries: alias resolution + main filter
    expect(db.query).toHaveBeenCalledTimes(2)
    // Main filter used the resolved ref, not the raw alias
    const [, mainParams] = db.query.mock.calls[1]!
    expect(mainParams[4]).toBe(ref)
    expect(account).not.toBeNull()
  })

  it('Figure D alias mismatch: alias that matches no account ref → null (cross-bot blocked)', async () => {
    // The callback carries an alias from bot B, but the user only has a verified
    // account on bot A. The alias resolution finds no matching hash → channelRef
    // stays null → STRICT filter with null ref matches nothing → null.
    const refA = 'channels/cc-a'
    const aliasB = createHash('sha256').update('channels/cc-b').digest('hex').slice(0, 16)
    const db = { query: vi.fn() }
    // 1st call: alias resolution → returns the cc-a account, but its hash ≠ aliasB
    db.query.mockResolvedValueOnce({
      rows: [{ communicationChannelRef: refA }],
      rowCount: 1,
    })
    // 2nd call: main filter with null ref (alias didn't resolve) → no match
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 })

    const account = await findVerifiedOperationalMediumAccount(
      {
        medium: 'telegram',
        providerUserId: '123',
        providerChannelId: '123',
        providerChannelType: 'private',
        providerTarget: { communicationChannelAlias: aliasB },
      },
      db as never
    )

    expect(db.query).toHaveBeenCalledTimes(2)
    const [, mainParams] = db.query.mock.calls[1]!
    expect(mainParams[4]).toBeNull()
    expect(account).toBeNull()
  })

  it('Slack alias: resolves channelAlias and filters by workspace, DM channel, and channel ref', async () => {
    const ref = 'channels/slack-a'
    const alias = createHash('sha256').update(ref).digest('hex').slice(0, 16)
    const db = { query: vi.fn() }
    db.query.mockResolvedValueOnce({
      rows: [{ communicationChannelRef: ref }],
      rowCount: 1,
    })
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'acc-slack-1', userId: 'u1', medium: 'slack' }],
      rowCount: 1,
    })

    const account = await findVerifiedOperationalMediumAccount(
      {
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'D123',
        providerTarget: { communicationChannelAlias: alias },
      },
      db as never
    )

    expect(db.query).toHaveBeenCalledTimes(2)
    const [, aliasParams] = db.query.mock.calls[0]!
    expect(aliasParams).toEqual(['slack', 'U123', 'T123', 'D123'])
    const [, mainParams] = db.query.mock.calls[1]!
    expect(mainParams).toEqual(['slack', 'U123', 'T123', 'D123', ref])
    expect(account).not.toBeNull()
  })

  it('Slack strict binding: no channelAlias matches no account', async () => {
    const db = fakeDb([])
    const account = await findVerifiedOperationalMediumAccount(
      {
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
        providerChannelId: 'D123',
      },
      db as never
    )

    const [sql, params] = db.query.mock.calls[0]!
    expect(sql).toContain('communication_channel_ref = $5')
    expect(params).toEqual(['slack', 'U123', 'T123', 'D123', null])
    expect(account).toBeNull()
  })
})
