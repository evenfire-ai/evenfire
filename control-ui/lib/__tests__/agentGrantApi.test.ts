import { afterEach, describe, expect, it, vi } from 'vitest'
import { updateAdminTeamAgents, updateAdminUserAgents } from '../api'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('agent grant replacement API helpers', () => {
  it('sends the complete observed active and deleted set for user replacement', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        userId: 'user-1',
        agentNames: ['active-agent'],
        deletedAgentNames: ['deleted-agent'],
        deletedHistoryLimit: 200,
      })
    )

    await updateAdminUserAgents('user-1', ['active-agent'], ['active-agent', 'deleted-agent'])

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/users/user-1/agents')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({
      agentNames: ['active-agent'],
      expectedCurrentAgentNames: ['active-agent', 'deleted-agent'],
    })
  })

  it('sends an explicit empty observed set for a new team replacement', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        teamId: 'team-1',
        agentNames: ['active-agent'],
        deletedAgentNames: [],
        deletedHistoryLimit: 200,
      })
    )

    await updateAdminTeamAgents('team-1', ['active-agent'], [])

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/admin/teams/team-1/agents')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({
      agentNames: ['active-agent'],
      expectedCurrentAgentNames: [],
    })
  })
})
