/**
 * Workflow run cancel from the main process: AppService runs it in the team that
 * owns the recipe (the same team hop the trigger takes), and the real AuthClient
 * POSTs the External REST cancel route with the session bearer. Errors from that
 * route reject as ApiError with the status and the error code in the message, which
 * is the text that crosses IPC to the renderer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import {
  testLoginResult,
  testSessionMe,
  testTeamSwitchResult,
} from '../../testSupport/authTestFixtures.js'

const NS = 'sandbox-recipes'
const NAME = 'two-step'
const RUN_ID = 'run-1'
const CANCEL_PATH = `/api/v1/workflows/${NS}/${NAME}/runs/${RUN_ID}/cancel`

type FetchCall = { url: string; method: string; authorization: string | null }

afterEach(async () => {
  vi.unstubAllGlobals()
  await cleanupNativeCommitTestHarness()
})

async function loggedInServiceOwningRecipeInTeamB() {
  const { service, restA } = await createNativeCommitTestHarness()
  const meA = testSessionMe()
  const meB = testSessionMe({ teamId: 'team-b', teamName: 'Team B' })
  const app = service as unknown as {
    authClient: {
      googleLogin: (...args: unknown[]) => Promise<unknown>
      switchTeam: (...args: unknown[]) => Promise<unknown>
      getMe: (...args: unknown[]) => Promise<unknown>
    }
    workflowTeamByKey: Map<string, string>
    workflowKey(ns: string, name: string): string
    cancelWorkflowRun(ns: string, name: string, runId: string): Promise<unknown>
    sessionToken: string | null
  }
  let currentTeamId = 'team-a'
  // Only login and the team switch are faked; cancelWorkflowRun stays the real
  // AuthClient request so the HTTP layer below sees what it sends.
  vi.spyOn(app.authClient, 'googleLogin').mockResolvedValue(
    testLoginResult('synthetic-session-a', meA)
  )
  const switchTeam = vi
    .spyOn(app.authClient, 'switchTeam')
    .mockImplementation(async (_token: unknown, teamId: unknown) => {
      currentTeamId = String(teamId)
      return testTeamSwitchResult(String(teamId))
    })
  vi.spyOn(app.authClient, 'getMe').mockImplementation(async () =>
    currentTeamId === 'team-a' ? meA : meB
  )
  await service.googleLogin('synthetic-google-token')
  app.workflowTeamByKey.set(app.workflowKey(NS, NAME), 'team-b')
  return { app, restA, switchTeam }
}

function stubRestApi(restA: string, response: () => Response): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({
        url,
        method: String(init?.method ?? 'GET'),
        authorization: headers.authorization ?? null,
      })
      if (url === `${restA}${CANCEL_PATH}`) return response()
      return new Response(JSON.stringify({ error: 'unexpected_request_in_test' }), {
        status: 599,
        statusText: 'Unexpected',
      })
    })
  )
  return calls
}

describe('AppService.cancelWorkflowRun', () => {
  it('POSTs the cancel route once, with the bearer of the team that owns the recipe', async () => {
    const { app, restA, switchTeam } = await loggedInServiceOwningRecipeInTeamB()
    const run = { id: RUN_ID, phase: 'Running', cancelRequestedAt: '2026-11-26T10:00:05Z' }
    const calls = stubRestApi(
      restA,
      () => new Response(JSON.stringify({ run }), { status: 200, statusText: 'OK' })
    )

    await expect(app.cancelWorkflowRun(NS, NAME, RUN_ID)).resolves.toEqual({ run })

    const cancelCalls = calls.filter(call => call.url === `${restA}${CANCEL_PATH}`)
    expect(cancelCalls).toEqual([
      { url: `${restA}${CANCEL_PATH}`, method: 'POST', authorization: 'Bearer session-team-b' },
    ])
    // The hop into the recipe's team and the way back, as the trigger does.
    expect(switchTeam.mock.calls.map(call => call[1])).toEqual(['team-b', 'team-a'])
    expect(app.sessionToken).toBe('session-team-a')
  })

  it.each([
    [403, 'Forbidden', 'forbidden'],
    [404, 'Not Found', 'workflow_run_not_found'],
    [409, 'Conflict', 'workflow_run_not_cancellable'],
  ])(
    'rejects a %i from the route as ApiError with the status and code in the message',
    async (status, statusText, code) => {
      const { app, restA, switchTeam } = await loggedInServiceOwningRecipeInTeamB()
      const calls = stubRestApi(
        restA,
        () => new Response(JSON.stringify({ error: code }), { status, statusText })
      )
      const { ApiError } = await import('../httpClient.js')

      const rejection = await app.cancelWorkflowRun(NS, NAME, RUN_ID).then(
        () => {
          throw new Error('cancelWorkflowRun resolved on an error response')
        },
        (error: unknown) => error
      )

      expect(rejection).toBeInstanceOf(ApiError)
      expect(rejection).toMatchObject({ status, message: `${status} ${statusText}: ${code}` })
      // Liveness witness: the request reached the route exactly once.
      expect(calls.filter(call => call.url === `${restA}${CANCEL_PATH}`)).toHaveLength(1)
      // The session is back in the caller's team after the failed request.
      expect(switchTeam.mock.calls.map(call => call[1])).toEqual(['team-b', 'team-a'])
      expect(app.sessionToken).toBe('session-team-a')
    }
  )
})
