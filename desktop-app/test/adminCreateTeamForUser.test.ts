import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminCreateTeamForUser } from './e2e-playwright/workflow-approval-quadrants/recipes'

const TEAM_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'

function stubAdminApi(memberStatus: number) {
  const requests: Array<{ path: string; body: unknown; authorization: string | null }> = []
  const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input)
    requests.push({
      path: url.pathname,
      body: JSON.parse(String(init.body)),
      authorization: new Headers(init.headers).get('authorization'),
    })
    if (url.pathname === '/api/v1/admin/auth/login') {
      return new Response(JSON.stringify({ token: 'synthetic-admin-token' }), { status: 200 })
    }
    if (url.pathname === '/api/v1/admin/teams') {
      return new Response(JSON.stringify({ id: TEAM_ID }), { status: 200 })
    }
    if (url.pathname === `/api/v1/admin/teams/${TEAM_ID}/members`) {
      return new Response(JSON.stringify({ teamId: TEAM_ID }), { status: memberStatus })
    }
    throw new Error(`unexpected admin request: ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return requests
}

describe('adminCreateTeamForUser', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates the team, then makes the user a member of it', async () => {
    const requests = stubAdminApi(200)

    await expect(adminCreateTeamForUser('e2e team', USER_ID)).resolves.toBe(TEAM_ID)

    expect(requests.map(request => request.path)).toEqual([
      '/api/v1/admin/auth/login',
      '/api/v1/admin/teams',
      `/api/v1/admin/teams/${TEAM_ID}/members`,
    ])
    expect(requests[1]).toMatchObject({
      body: { name: 'e2e team' },
      authorization: 'Bearer synthetic-admin-token',
    })
    expect(requests[2]).toMatchObject({
      body: { userId: USER_ID, role: 'admin' },
      authorization: 'Bearer synthetic-admin-token',
    })
  })

  it('rejects when the membership call fails', async () => {
    const requests = stubAdminApi(500)

    await expect(adminCreateTeamForUser('e2e team', USER_ID)).rejects.toThrow()

    // Witness: the team call succeeded and the failure came from the second call.
    expect(requests.at(-1)?.path).toBe(`/api/v1/admin/teams/${TEAM_ID}/members`)
  })
})
