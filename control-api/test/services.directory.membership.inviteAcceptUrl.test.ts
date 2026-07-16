import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createInvitationForTeams } from '../src/services/directory/membership.js'

const mockPoolQuery = vi.fn()
const mockDbQuery = vi.fn()
vi.mock('../src/db.js', () => ({
  pool: { query: (...a: unknown[]) => mockPoolQuery(...a) },
  withTransaction: async <T>(cb: (db: { query: typeof mockDbQuery }) => Promise<T>) =>
    cb({ query: mockDbQuery }),
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

const draftRow = {
  id: 'row-1',
  team_id: null,
  invitee_name: 'N',
  email: 'a@b.com',
  role: 'member',
  token: 'tok-xyz',
  status: 'draft',
  purpose: 'member_invitation',
  created_at: new Date(),
  expires_at: new Date(Date.now() + 3600_000),
  accepted_at: null,
  accepted_user_id: null,
  team_name: null,
}
const pendingRow = { ...draftRow, status: 'pending' }

beforeEach(() => {
  mockPoolQuery.mockReset()
  mockDbQuery.mockReset()
  mockConfig.memberRegistrationMode = 'offline'
  // cleanupStaleDraftInvitations() fire-and-forget DELETE
  mockPoolQuery.mockResolvedValue({ rows: [] })
  // withTransaction → insertInvitationForTeams: INSERT ... RETURNING (draft), then team inserts/loads
  mockDbQuery.mockResolvedValue({ rows: [] })
  mockDbQuery.mockResolvedValueOnce({ rows: [draftRow] }) // INSERT ... RETURNING
})

describe('createInvitationForTeamsRecord inviteAcceptUrl', () => {
  it('offline: returns pending invitation carrying inviteAcceptUrl', async () => {
    // activation UPDATE ... RETURNING pending
    mockPoolQuery.mockReset()
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }) // cleanup DELETE
    mockPoolQuery.mockResolvedValueOnce({ rows: [pendingRow] }) // activate UPDATE RETURNING

    const result = await createInvitationForTeams({
      inviteeName: 'N',
      email: 'a@b.com',
      purpose: 'member_invitation',
      teamAssignments: [],
      fallbackRole: 'member',
    })
    expect((result as { inviteAcceptUrl?: string }).inviteAcceptUrl).toBe(
      'https://p.example/invitations/tok-xyz'
    )
    expect((result as { status: string }).status).toBe('pending')
  })
})
