import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockPoolQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (...a: unknown[]) => mockPoolQuery(...a) },
  withTransaction: async <T>(cb: (db: { query: typeof mockPoolQuery }) => Promise<T>) =>
    cb({ query: mockPoolQuery }),
}))

// vi.mock factories are hoisted above regular `const` declarations, so a plain
// `const mockConfig = {...}` referenced directly inside the factory below trips a
// temporal-dead-zone ReferenceError. vi.hoisted() hoists the initializer itself so
// the value exists by the time the factory runs.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    memberRegistrationMode: 'offline' as 'remote' | 'offline',
    inviteAcceptBaseUrl: 'https://p.example',
  },
}))
vi.mock('../src/config.js', () => ({ config: mockConfig }))
vi.mock('../src/services/invitationFlowRegistrationService.js', () => ({
  registerAndSendInvitation: vi.fn().mockResolvedValue(undefined),
  buildInviteAcceptUrl: (t: string) => `https://p.example/invitations/${t}`,
}))

import { createManagedInvitationForUser } from '../src/services/directory/membership.js'

beforeEach(() => {
  mockPoolQuery.mockReset()
  mockConfig.memberRegistrationMode = 'offline'
})

describe('createManagedInvitationForUser offline existing-user guard', () => {
  it('offline: rejects inviting a pre-existing user email', async () => {
    // manager-roles query returns inviter role on the team
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ team_id: 't1', role: 'inviter', team_name: 'T' }] })
    // existing-user probe returns a row
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'existing-user' }] })
    const result = await createManagedInvitationForUser('mgr', 'existing@b.com', [{ teamId: 't1', role: 'member' }], 'Name')
    expect(result).toEqual({ error: 'member_email_exists' })
  })
})
