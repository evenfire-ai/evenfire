import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthClient } from '../src/authClient.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockRequestJson = vi.fn()

vi.mock('../src/httpClient.js', () => ({
  requestJson: (...args: unknown[]) => mockRequestJson(...args),
  ApiError: class ApiError extends Error {
    status: number
    bodyText: string
    constructor(message: string, status: number, bodyText: string) {
      super(message)
      this.status = status
      this.bodyText = bodyText
    }
  },
}))

vi.mock('../src/config.js', () => ({
  config: {
    externalRestApiBaseUrl: 'http://localhost:8091',
    requestTimeoutMs: 5000,
  },
}))

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockRequestJson.mockReset()
  vi.unstubAllGlobals()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AuthClient — health()', () => {
  it('calls GET /health', async () => {
    mockRequestJson.mockResolvedValueOnce({ status: 'ok' })

    const client = new AuthClient()
    const result = await client.health()

    expect(mockRequestJson).toHaveBeenCalledWith('GET', 'http://localhost:8091/health')
    expect(result.status).toBe('ok')
  })
})

describe('AuthClient — googleLogin()', () => {
  it('posts idToken to /api/v1/auth/google', async () => {
    mockRequestJson.mockResolvedValueOnce({ token: 'session-xyz' })

    const client = new AuthClient()
    await client.googleLogin('google-id-token-123')

    expect(mockRequestJson).toHaveBeenCalledWith(
      'POST',
      'http://localhost:8091/api/v1/auth/google',
      expect.objectContaining({ body: { idToken: 'google-id-token-123' } })
    )
  })
})

describe('AuthClient — passwordLogin()', () => {
  it('posts to /api/v1/auth/password-login with email and password', async () => {
    mockRequestJson.mockResolvedValueOnce({ token: 'session-pw' })

    const client = new AuthClient()
    await client.passwordLogin('alice@example.com', 'hunter2pw')

    expect(mockRequestJson).toHaveBeenCalledWith(
      'POST',
      'http://localhost:8091/api/v1/auth/password-login',
      expect.objectContaining({ body: { email: 'alice@example.com', password: 'hunter2pw' } })
    )
  })
})

describe('AuthClient — getMe()', () => {
  it('passes session token as Bearer and hits /api/v1/me', async () => {
    mockRequestJson.mockResolvedValueOnce({ id: 'u1', email: 'alice@example.com' })

    const client = new AuthClient()
    await client.getMe('sess-token-abc')

    expect(mockRequestJson).toHaveBeenCalledWith(
      'GET',
      'http://localhost:8091/api/v1/me',
      expect.objectContaining({ token: 'sess-token-abc' })
    )
  })
})

describe('AuthClient — external channels', () => {
  it('loads authorized targets and connected accounts with the session token', async () => {
    mockRequestJson
      .mockResolvedValueOnce({ items: [{ id: 'telegram:chatllm', medium: 'telegram' }] })
      .mockResolvedValueOnce({ items: [{ id: 'account-1', medium: 'telegram' }] })

    const client = new AuthClient()
    await client.listExternalChannelTargets('sess-token')
    await client.listExternalChannelAccounts('sess-token')

    expect(mockRequestJson).toHaveBeenNthCalledWith(
      1,
      'GET',
      'http://localhost:8091/api/v1/workflow-approval-mediums/targets',
      { token: 'sess-token' }
    )
    expect(mockRequestJson).toHaveBeenNthCalledWith(
      2,
      'GET',
      'http://localhost:8091/api/v1/workflow-approval-mediums',
      { token: 'sess-token' }
    )
  })
})

describe('AuthClient — listTeams()', () => {
  it('returns current team id and items list', async () => {
    const payload = { currentTeamId: 'team-1', items: [{ id: 'team-1', name: 'Alpha' }] }
    mockRequestJson.mockResolvedValueOnce(payload)

    const client = new AuthClient()
    const result = await client.listTeams('sess-token')

    expect(result.currentTeamId).toBe('team-1')
    expect(result.items).toHaveLength(1)
  })
})

describe('AuthClient — switchTeam()', () => {
  it('posts teamId and returns new token', async () => {
    mockRequestJson.mockResolvedValueOnce({ token: 'new-team-token', team: { id: 'team-2' } })

    const client = new AuthClient()
    const result = await client.switchTeam('sess-token', 'team-2')

    expect(mockRequestJson).toHaveBeenCalledWith(
      'POST',
      'http://localhost:8091/api/v1/me/switch-team',
      expect.objectContaining({ body: { teamId: 'team-2' } })
    )
    expect(result.token).toBe('new-team-token')
  })
})

describe('AuthClient — getInitialTeamDirectory()', () => {
  it('uses the readonly initial team directory endpoint', async () => {
    mockRequestJson.mockResolvedValueOnce({ currentTeamId: 'team-1', items: [] })

    const client = new AuthClient()
    const result = await client.getInitialTeamDirectory('sess-token')

    expect(mockRequestJson).toHaveBeenCalledWith(
      'GET',
      'http://localhost:8091/api/v1/me/teams/directory',
      expect.objectContaining({ token: 'sess-token' })
    )
    expect(result).toEqual({ currentTeamId: 'team-1', items: [] })
  })
})

describe('AuthClient — listPendingWorkflowApprovals()', () => {
  it('gets pending approvals through /api/v1/workflow-approvals with limit', async () => {
    mockRequestJson.mockResolvedValueOnce({ items: [{ id: 'approval-1' }] })

    const client = new AuthClient()
    const result = await client.listPendingWorkflowApprovals('sess-token', 12)

    expect(mockRequestJson).toHaveBeenCalledWith(
      'GET',
      'http://localhost:8091/api/v1/workflow-approvals?limit=12',
      expect.objectContaining({ token: 'sess-token' })
    )
    expect(result).toEqual({ items: [{ id: 'approval-1' }] })
  })
})

describe('AuthClient — decideWorkflowApproval()', () => {
  it('posts decision payload to approval decision endpoint', async () => {
    mockRequestJson.mockResolvedValueOnce({ ok: true })

    const client = new AuthClient()
    const result = await client.decideWorkflowApproval(
      'sess-token',
      'approval-1',
      'deny',
      'not allowed'
    )

    expect(mockRequestJson).toHaveBeenCalledWith(
      'POST',
      'http://localhost:8091/api/v1/workflow-approvals/approval-1/decide',
      expect.objectContaining({
        token: 'sess-token',
        body: { decision: 'deny', note: 'not allowed' },
      })
    )
    expect(result).toEqual({ ok: true })
  })
})

describe('AuthClient — workflow triggers', () => {
  it('sends Idempotency-Key as a header instead of embedding it in the body', async () => {
    mockRequestJson.mockResolvedValueOnce({ ok: true })

    const client = new AuthClient()
    await client.triggerWorkflow(
      'sess-token',
      'mcp-server',
      'recipe-a',
      { inputs: { topic: 'alpha' } },
      'idem-123'
    )

    expect(mockRequestJson).toHaveBeenCalledWith(
      'POST',
      'http://localhost:8091/api/v1/workflows/mcp-server/recipe-a/trigger',
      expect.objectContaining({
        token: 'sess-token',
        body: { inputs: { topic: 'alpha' } },
        headers: { 'Idempotency-Key': 'idem-123' },
        retryTransientOnce: true,
      })
    )
  })

  it('does not retry trigger POSTs when no idempotency key is present', async () => {
    mockRequestJson.mockResolvedValueOnce({ ok: true })

    const client = new AuthClient()
    await client.triggerWorkflow('sess-token', 'mcp-server', 'recipe-a', {
      inputs: { topic: 'alpha' },
    })

    expect(mockRequestJson).toHaveBeenCalledWith(
      'POST',
      'http://localhost:8091/api/v1/workflows/mcp-server/recipe-a/trigger',
      expect.objectContaining({
        retryTransientOnce: false,
      })
    )
  })
})

describe('AuthClient — workflow run artifacts', () => {
  it('lists artifacts through the run-scoped workflows route', async () => {
    mockRequestJson.mockResolvedValueOnce({ artifacts: [] })

    const client = new AuthClient()
    await client.listWorkflowRunArtifacts('sess-token', 'sandbox-recipes', 'recipe-a', 'run-1')

    expect(mockRequestJson).toHaveBeenCalledWith(
      'GET',
      'http://localhost:8091/api/v1/workflows/sandbox-recipes/recipe-a/runs/run-1/artifacts',
      expect.objectContaining({ token: 'sess-token', retryTransientOnce: true })
    )
  })

  it('downloads artifacts through the run-scoped workflows route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('artifact-bytes', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = new AuthClient()
    const result = await client.downloadWorkflowRunArtifact(
      'sess-token',
      'sandbox-recipes',
      'recipe-a',
      'run-1',
      'custom-sdk-result.json'
    )

    expect(result.toString()).toBe('artifact-bytes')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8091/api/v1/workflows/sandbox-recipes/recipe-a/runs/run-1/artifacts/custom-sdk-result.json/download',
      expect.objectContaining({
        method: 'GET',
        headers: { authorization: 'Bearer sess-token' },
      })
    )
  })

  it('surfaces failed artifact downloads as typed API errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })))

    const client = new AuthClient()

    await expect(
      client.downloadWorkflowRunArtifact(
        'sess-token',
        'sandbox-recipes',
        'recipe-a',
        'run-1',
        'custom-sdk-result.json'
      )
    ).rejects.toMatchObject({
      status: 403,
      bodyText: 'denied',
    })
  })
})
