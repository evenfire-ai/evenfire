// @vitest-environment jsdom
/**
 * A real team switch (`handleEnsureTeamContext` → `switchTeamForWorkspace`)
 * must not show the previous team's remote rows in the new team's "Latest
 * sessions" list, where a Host of the same name exists. Every committed
 * `latestChatSessions` is recorded with the team it belongs to, so the window
 * between the confirmed switch and the new team's catalog page is checked
 * commit by commit rather than only at its end.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import type { ChatIndex, SessionsListResult } from '../../../../src/types'
import {
  type AppControllerClerumHandle,
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import {
  deferred,
  localIndex,
  serverSessions,
} from '../domain/__tests__/__fixtures__/catalogFixtures'
import { type MockClerum, uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HOST_A = 'agent-a'
const SHARED_CHAT = 'shared-chat'
const TEAM_1_TITLE = 'Team 1 title'
const TEAM_2_TITLE = 'Team 2 title'

type Row = { id: string; agentRef: string; title: string; remote: boolean }
type Commit = { teamId: string; rows: Row[] }
type ListSessionsQuery = { agent?: string; limit?: number; cursor?: string }

const isTeam1Row = (row: Row) => row.id === SHARED_CHAT && row.title === TEAM_1_TITLE
const staleCommits = (commits: Commit[]) => commits.filter(c => c.rows.some(isTeam1Row))

/**
 * Team-aware chat doubles. `team` flips to team-2 inside `team.switch`, so every
 * read issued after the main process confirmed the switch is a team-2 read.
 * Team-2's local index and catalog page are held until the test releases them.
 */
function installTeamAwareChat(clerum: MockClerum, handle: AppControllerClerumHandle) {
  let team: 'team-1' | 'team-2' = 'team-1'
  const team2Index = deferred<ChatIndex>()
  const team2Page = deferred<SessionsListResult>()
  let team2IndexResolved = false
  let team2PageResolved = false
  const reads = { team1Page: 0, team2Index: 0, team2Page: 0 }

  clerum.chat.getIndex.mockImplementation(async () => {
    if (team === 'team-1') return localIndex([])
    reads.team2Index += 1
    return team2Index.promise
  })
  clerum.rpc.listSessions.mockImplementation(
    async (hostRef: string, _teamId: string | undefined, query?: ListSessionsQuery) => {
      if (hostRef !== HOST_A || query?.limit === 1) return serverSessions([])
      if (team === 'team-1') {
        reads.team1Page += 1
        return serverSessions([{ agent: HOST_A, chatId: SHARED_CHAT, title: TEAM_1_TITLE }])
      }
      reads.team2Page += 1
      return team2Page.promise
    }
  )
  const originalSwitch = handle.switchTeam.getMockImplementation() as (
    teamId: string
  ) => Promise<unknown>
  handle.switchTeam.mockImplementation(async (teamId: string) => {
    team = teamId === 'team-2' ? 'team-2' : 'team-1'
    return originalSwitch(teamId)
  })

  return {
    reads,
    resolveTeam2Index: () => {
      team2IndexResolved = true
      team2Index.resolve(localIndex([]))
    },
    resolveTeam2Page: () => {
      team2PageResolved = true
      team2Page.resolve(
        serverSessions([{ agent: HOST_A, chatId: SHARED_CHAT, title: TEAM_2_TITLE }])
      )
    },
    team2IndexResolved: () => team2IndexResolved,
    team2PageResolved: () => team2PageResolved,
  }
}

function observe() {
  const commits: Commit[] = []
  const app = renderAppController({
    onCommit: vm =>
      commits.push({
        teamId: vm.currentTeamId,
        rows: vm.latestChatSessions.map(row => ({
          id: row.id,
          agentRef: row.agentRef,
          title: row.title,
          remote: row.remote === true,
        })),
      }),
  })
  return { app, commits }
}

describe('useAppController — remote rows across a team switch', () => {
  let unmount: (() => void) | null = null

  afterEach(() => {
    unmount?.()
    unmount = null
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  it("T-R1H1-1: no commit after a confirmed switch shows the previous team's remote row", async () => {
    const { clerum, handle } = installAppControllerClerum({ agentNames: [HOST_A] })
    const chat = installTeamAwareChat(clerum, handle)
    const { app, commits } = observe()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() =>
      expect(app.result.current.latestChatSessions.map(r => [r.id, r.title, r.remote])).toEqual([
        [SHARED_CHAT, TEAM_1_TITLE, true],
      ])
    )
    expect(app.result.current.currentTeamId).toBe('team-1')
    expect(chat.reads.team1Page).toBeGreaterThan(0)

    const firstCommitOfSwitch = commits.length
    await act(async () => {
      await app.result.current.handleEnsureTeamContext({ teamId: 'team-2' })
    })

    // (a) Liveness witness: the switch was confirmed, the new team is active,
    // and the team-2 local index read is in flight (held).
    expect(handle.switchTeam).toHaveBeenCalledWith('team-2')
    await waitFor(() => expect(app.result.current.currentTeamId).toBe('team-2'))
    await waitFor(() => expect(chat.reads.team2Index).toBeGreaterThan(0))
    expect(chat.team2IndexResolved()).toBe(false)
    expect(chat.reads.team2Page).toBe(0)

    // (b) Window W1: confirmed switch → team-2 index still pending. The commit
    // that makes team-2 current must already be free of team-1's remote row.
    const w1 = commits.slice(firstCommitOfSwitch).filter(c => c.teamId === 'team-2')
    expect(w1.length).toBeGreaterThan(0)
    expect(staleCommits(w1)).toEqual([])
    expect(app.result.current.latestChatSessions).toEqual([])

    // Window W2: team-2 index resolved → team-2 page still pending.
    const firstCommitOfW2 = commits.length
    await act(async () => {
      chat.resolveTeam2Index()
    })
    await waitFor(() => expect(chat.reads.team2Page).toBeGreaterThan(0))
    expect(chat.team2PageResolved()).toBe(false)
    // The carry of the new scope's first publication has no team-1 row to carry.
    expect(staleCommits(commits.slice(firstCommitOfW2))).toEqual([])

    // (c) Window W3: team-2 page resolved; the merge shows team-2's row only.
    const firstCommitOfW3 = commits.length
    await act(async () => {
      chat.resolveTeam2Page()
    })
    await waitFor(() =>
      expect(app.result.current.latestChatSessions.map(r => [r.id, r.title, r.remote])).toEqual([
        [SHARED_CHAT, TEAM_2_TITLE, true],
      ])
    )
    expect(staleCommits(commits.slice(firstCommitOfW3))).toEqual([])
    expect(staleCommits(commits.filter(c => c.teamId === 'team-2'))).toEqual([])
  })

  it('T-R1H1-2: a switch before the post-paint menu data loads never shows a previous-team remote row', async () => {
    const { clerum, handle } = installAppControllerClerum({
      agentNames: [HOST_A],
      delayAuthenticatedLoad: true,
    })
    const chat = installTeamAwareChat(clerum, handle)
    const workflowsList = (
      window.clerum as unknown as { workflows: { list: ReturnType<typeof vi.fn> } }
    ).workflows.list
    const { app, commits } = observe()
    unmount = app.unmount

    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
    await waitFor(() => expect(handle.refreshCatalog).toHaveBeenCalled())
    // Witness that the login post-paint callback has NOT fired (loadMenuData is
    // false): it is the only caller of workflows.list on the initial load.
    expect(workflowsList).not.toHaveBeenCalled()
    expect(chat.reads.team1Page).toBe(0)
    const beforeSwitch = commits.slice()
    expect(beforeSwitch.length).toBeGreaterThan(0)
    expect(beforeSwitch.filter(c => c.rows.length)).toEqual([])

    const firstCommitOfSwitch = commits.length
    let switchDone = false
    await act(async () => {
      void app.result.current.handleEnsureTeamContext({ teamId: 'team-2' }).then(() => {
        switchDone = true
      })
    })
    expect(handle.switchTeam).toHaveBeenCalledWith('team-2')
    await waitFor(() => expect(app.result.current.currentTeamId).toBe('team-2'))
    // The switch's own refresh is held behind the same catalog deferred.
    expect(switchDone).toBe(false)
    expect(staleCommits(commits.slice(firstCommitOfSwitch))).toEqual([])

    await act(async () => {
      handle.resolveAuthenticatedLoad()
    })
    await waitFor(() => expect(switchDone).toBe(true))
    await waitFor(() => expect(chat.reads.team2Index).toBeGreaterThan(0))
    await act(async () => {
      chat.resolveTeam2Index()
    })
    await waitFor(() => expect(chat.reads.team2Page).toBeGreaterThan(0))
    await act(async () => {
      chat.resolveTeam2Page()
    })
    await waitFor(() =>
      expect(app.result.current.latestChatSessions.map(r => [r.id, r.title, r.remote])).toEqual([
        [SHARED_CHAT, TEAM_2_TITLE, true],
      ])
    )
    expect(chat.reads.team1Page).toBe(0)
    expect(staleCommits(commits)).toEqual([])
  })
})
