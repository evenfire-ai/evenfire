import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
      release: vi.fn(),
    })),
  },
}))

vi.mock('../src/services/directory/index.js', () => ({
  TeamNameConflictError: class TeamNameConflictError extends Error {},
  activateDeferredInvitation: vi.fn(),
  createDeferredInvitationForTeams: vi.fn(),
  createTeam: vi.fn(),
  setTeamAgents: vi.fn(),
  setTeamContexts: vi.fn(),
}))

vi.mock('../src/services/invitationFlowRegistrationService.js', () => ({
  registerAndSendInvitations: vi.fn(),
}))

vi.mock('../src/services/identityProviders/service.js', () => ({
  loadMicrosoftDirectory: vi.fn(),
}))

vi.mock('../src/services/identityProviders/setup.js', () => ({
  getIdentityProviderSetupById: vi.fn(),
  updateIdentityProviderSetup: vi.fn(),
}))

const { pool } = await import('../src/db.js')
const { activateDeferredInvitation, createDeferredInvitationForTeams } =
  await import('../src/services/directory/index.js')
const { registerAndSendInvitations } =
  await import('../src/services/invitationFlowRegistrationService.js')
const { loadMicrosoftDirectory } = await import('../src/services/identityProviders/service.js')
const { getIdentityProviderSetupById } = await import('../src/services/identityProviders/setup.js')
const { executeMicrosoftImport, renewMicrosoftImportLease } =
  await import('../src/services/identityProviders/importExecution.js')

describe('executeMicrosoftImport existing-member identity safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not link a Microsoft subject to an existing member based on email alone', async () => {
    vi.mocked(loadMicrosoftDirectory).mockResolvedValue({
      teams: [],
      users: [
        {
          id: 'microsoft-user-1',
          displayName: 'Existing Member',
          email: 'member@example.test',
          userPrincipalName: 'member@example.test',
          accountEnabled: true,
          imported: false,
          invitationPending: false,
          microsoftTeamIds: [],
          existingMemberId: 'existing-user-1',
          existingMemberName: 'Existing Member',
        },
      ],
    })
    vi.mocked(getIdentityProviderSetupById).mockResolvedValue({
      id: 'setup-1',
      provider: 'microsoft',
      status: 'importing',
      currentStep: 9,
      hasClientSecret: true,
      connectionId: 'connection-1',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      draft: {
        teams: [],
        members: [
          {
            externalSubject: 'microsoft-user-1',
            selected: true,
            displayName: 'Existing Member',
            email: 'client-edited@example.test',
            userPrincipalName: 'client-edited@example.test',
            teamRefs: [],
          },
        ],
        options: {
          createMembers: true,
          createTeams: true,
          sendInvitations: false,
          allowMemberLogin: true,
        },
      },
      execution: {
        stage: 'members',
        teamIds: {},
        createdTeamIds: [],
        processedMemberSubjects: [],
        createdMembers: 0,
        existingMembers: 0,
        invitationsSent: 0,
      },
    })

    vi.mocked(pool.query).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT user_id') && sql.includes('identity_provider_identities')) {
        return { rows: [], rowCount: 0 } as never
      }
      if (sql.includes('SELECT id FROM users WHERE LOWER(email)')) {
        return { rows: [{ id: 'existing-user-1' }], rowCount: 1 } as never
      }
      if (sql.includes('UPDATE users')) {
        return { rows: [{ id: 'existing-user-1' }], rowCount: 1 } as never
      }
      if (sql.includes('INSERT INTO identity_provider_identities')) {
        throw new Error('identity link must not be written for an email-only match')
      }
      return { rows: [], rowCount: 1 } as never
    })

    await expect(
      executeMicrosoftImport({
        setupId: 'setup-1',
        allowedAgentNames: new Set(),
        allowedContextIds: new Set(),
        operatorSub: 'admin-1',
      })
    ).resolves.toMatchObject({ complete: true, existingMembers: 1 })

    expect(loadMicrosoftDirectory).toHaveBeenCalledTimes(1)
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id FROM users WHERE LOWER(email)'),
      ['member@example.test']
    )
    expect(
      vi
        .mocked(pool.query)
        .mock.calls.some(([sql]) =>
          String(sql).includes('INSERT INTO identity_provider_identities')
        )
    ).toBe(false)
  })

  it('sends an invitation-backed linking flow for an existing unlinked member', async () => {
    vi.mocked(loadMicrosoftDirectory).mockResolvedValue({
      teams: [],
      users: [
        {
          id: 'microsoft-user-1',
          displayName: 'Existing Member',
          email: 'member@example.test',
          userPrincipalName: 'member@example.test',
          accountEnabled: true,
          imported: false,
          invitationPending: false,
          microsoftTeamIds: [],
          existingMemberId: 'existing-user-1',
          existingMemberName: 'Existing Member',
        },
      ],
    })
    vi.mocked(getIdentityProviderSetupById).mockResolvedValue({
      id: 'setup-1',
      provider: 'microsoft',
      status: 'importing',
      currentStep: 9,
      hasClientSecret: true,
      connectionId: 'connection-1',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      draft: {
        teams: [],
        members: [
          {
            externalSubject: 'microsoft-user-1',
            selected: true,
            displayName: 'Existing Member',
            email: 'member@example.test',
            userPrincipalName: 'member@example.test',
            teamRefs: [],
          },
        ],
        options: {
          createMembers: true,
          createTeams: true,
          sendInvitations: true,
          allowMemberLogin: true,
        },
      },
      execution: {
        stage: 'members',
        teamIds: {},
        createdTeamIds: [],
        processedMemberSubjects: [],
        createdMembers: 0,
        existingMembers: 0,
        invitationsSent: 0,
      },
    })
    const createdAt = new Date('2026-07-16T00:00:00.000Z')
    const expiresAt = new Date('2026-07-18T00:00:00.000Z')
    vi.mocked(createDeferredInvitationForTeams).mockResolvedValue({
      id: 'invitation-1',
      token: 'invitation-token',
      email: 'member@example.test',
      status: 'draft',
      created_at: createdAt,
      expires_at: expiresAt,
      teams: [],
    } as never)
    vi.mocked(registerAndSendInvitations).mockResolvedValue({
      results: [{ invitationUuid: 'invitation-token', sent: true }],
    } as never)
    vi.mocked(activateDeferredInvitation).mockResolvedValue(true)
    vi.mocked(pool.query).mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM users WHERE LOWER(email)')) {
        return { rows: [{ id: 'existing-user-1' }], rowCount: 1 } as never
      }
      if (sql.includes('FROM identity_provider_identities')) {
        return { rows: [], rowCount: 0 } as never
      }
      if (sql.includes('FROM invitations i')) {
        return { rows: [], rowCount: 0 } as never
      }
      return { rows: [], rowCount: 1 } as never
    })

    await expect(
      executeMicrosoftImport({
        setupId: 'setup-1',
        allowedAgentNames: new Set(),
        allowedContextIds: new Set(),
        operatorSub: 'admin-1',
      })
    ).resolves.toMatchObject({
      complete: true,
      existingMembers: 1,
      createdMembers: 0,
      invitationsSent: 1,
    })

    expect(createDeferredInvitationForTeams).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'member@example.test',
        identityProvider: expect.objectContaining({
          connectionId: 'connection-1',
          subject: 'microsoft-user-1',
        }),
      })
    )
    expect(registerAndSendInvitations).toHaveBeenCalledTimes(1)
    expect(activateDeferredInvitation).toHaveBeenCalledWith('invitation-1')
  })

  it('rejects a concurrent import without reserving a pool client', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    await expect(
      executeMicrosoftImport({
        setupId: 'setup-1',
        allowedAgentNames: new Set(),
        allowedContextIds: new Set(),
        operatorSub: 'admin-1',
      })
    ).rejects.toMatchObject({ status: 409, message: 'Microsoft import is already running' })

    expect(pool.connect).not.toHaveBeenCalled()
    expect(getIdentityProviderSetupById).not.toHaveBeenCalled()
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('configuring', 'importing')"),
      expect.any(Array)
    )
  })
})

describe('renewMicrosoftImportLease', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('treats a transient database error as unknown and permits a later renewal', async () => {
    vi.mocked(pool.query)
      .mockRejectedValueOnce(new Error('temporary database interruption'))
      .mockResolvedValueOnce({ rows: [{ id: 'setup-1' }], rowCount: 1 } as never)

    await expect(renewMicrosoftImportLease('setup-1', 'lock-1')).resolves.toBe('unknown')
    await expect(renewMicrosoftImportLease('setup-1', 'lock-1')).resolves.toBe('renewed')
  })

  it('reports loss only when the token-scoped update matches no row', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    await expect(renewMicrosoftImportLease('setup-1', 'lock-1')).resolves.toBe('lost')
  })
})
