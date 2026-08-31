// @vitest-environment jsdom
/**
 * R3-M1 regression — mcp-oauth reactive consent, COLD START.
 *
 * The OAuth "Connect <server>" deep link can return BEFORE the per-chat FSM
 * snapshot is seeded (sessions load async/auth-gated after `rendererReady`). The
 * pre-fix reactive handler resolved the resume targets against the snapshot AS IT
 * WAS when the completion arrived; on a cold start that snapshot is empty, so the
 * completion was dropped and the suspended conversation never auto-resumed (only
 * a second manual click recovered it — the grant already existed).
 *
 * The fix buffers a completion that finds no targets and re-evaluates it when the
 * FSM snapshot next changes (bounded TTL). This test drives the REAL coordinator:
 * the suspended session is seeded through the real `listSessions` → chat-list
 * loader → `seedSessionSnapshots` producer path (T1 — not a hand-built snapshot),
 * and the observable is the real approval RPC the central decider fires (T4).
 *
 * Against the parent commit (no buffer) the completion is dropped, so seeding the
 * session later produces NO resume and `approveToolCall` is never called — the
 * `waitFor` on it fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import type { SessionsListResult } from '../../../../../src/types'
import {
  extendMockClerumForAppController,
  renderAppController,
} from './__fixtures__/appControllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let clerum: MockClerum

beforeEach(() => {
  // jsdom has no real audio pipeline; the notifications controller calls
  // `HTMLAudioElement.play()` (which returns undefined in jsdom and then throws
  // on `.catch`). Stub it so an unrelated notification never crashes the mount.
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  uninstallMockClerum()
})

/** Contention headroom: the default 1s can expire on a cold/loaded machine. */
const SLOW = { timeout: 5000 } as const

/**
 * Drains micro + macro tasks inside `act`, so a "did not happen yet" negative is
 * made after everything that could have run has run.
 */
async function settle() {
  await act(async () => {
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** A single session suspended on `monday` awaiting the OAuth connect grant. */
const SUSPENDED_ON_MONDAY: SessionsListResult = {
  items: [
    {
      agent: 'agent-x',
      chatId: 'chat-connect',
      turnCount: 1,
      lastActivityAt: '2026-05-03T00:00:00Z',
      state: 'awaiting_approval',
      activeTaskId: 'task-connect',
      pendingApproval: {
        requestId: 'req-connect',
        displayName: 'monday tool',
        reason: 'connect_required',
        mcpServerName: 'monday',
      },
    },
  ],
}

const CONNECT_KEY = 'agent-x::chat-connect'
const resumeCalls = (approveToolCall: ReturnType<typeof vi.fn>) =>
  approveToolCall.mock.calls.filter(call => call[2] === 'req-connect')

describe('mcp-oauth reactive consent — cold start (R3-M1)', () => {
  let unmountApp: (() => void) | null = null

  afterEach(() => {
    unmountApp?.()
    unmountApp = null
  })

  it('resumes a suspended conversation when the completion arrives before the snapshot is seeded', async () => {
    // Cold start: the session catalog load is STILL IN FLIGHT — `listSessions`
    // is a pending promise the test releases by hand — so the FSM snapshot is
    // empty when the completion arrives, exactly as on a real cold boot.
    let releaseSessions!: (result: SessionsListResult) => void
    const sessionsInFlight = new Promise<SessionsListResult>(resolve => {
      releaseSessions = resolve
    })
    clerum.rpc.listSessions.mockReturnValue(sessionsInFlight)
    const handle = extendMockClerumForAppController(clerum, { agentNames: ['agent-x'] })
    // `approveToolCall` is added to the rpc bridge by `extendMockClerumForAppController`,
    // so it isn't on the base `RpcMock` type — reach it through a cast.
    const approveToolCall = (clerum.rpc as unknown as { approveToolCall: ReturnType<typeof vi.fn> })
      .approveToolCall

    const app = renderAppController()
    unmountApp = app.unmount

    await waitFor(() => expect(app.result.current.booting).toBe(false), SLOW)
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true), SLOW)
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false), SLOW)
    // The reactive handler must be wired, and the session load must have started
    // (and be blocked), before the completion arrives.
    await waitFor(() => expect(handle.onMcpOauthCompleted).toHaveBeenCalled(), SLOW)
    await waitFor(() => expect(clerum.rpc.listSessions).toHaveBeenCalled(), SLOW)
    // Cold start: the snapshot really is empty when the completion arrives.
    expect(app.result.current.sessionStateByChatKey[CONNECT_KEY]).toBeUndefined()

    // The OAuth deep link returns while the FSM snapshot is still empty.
    act(() => {
      handle.emitMcpOauthCompleted({ mcpServerName: 'monday' })
    })
    await settle()

    // Pre-fix: dropped. Post-fix: buffered, not yet resumed (no session exists).
    expect(approveToolCall).not.toHaveBeenCalled()

    // The in-flight session load now settles with the suspended session — seeded
    // into the store through the real `seedSessionSnapshots` producer path.
    await act(async () => {
      releaseSessions(SUSPENDED_ON_MONDAY)
      await sessionsInFlight
    })

    // The buffered completion re-evaluates on the new snapshot and resumes through
    // the central decider → the approval RPC re-executes the tool. This is the
    // assertion that FAILS against the parent (the resume was lost on cold start).
    await waitFor(
      () =>
        expect(approveToolCall).toHaveBeenCalledWith(
          'agent-x',
          'task-connect',
          'req-connect',
          ['agent-x'],
          { teamId: undefined }
        ),
      SLOW
    )
    // Fired exactly once for the single suspended conversation.
    expect(resumeCalls(approveToolCall)).toHaveLength(1)
  })

  it('does not enter the buffer on the normal path and never double-resumes', async () => {
    // Session is already seeded before the completion arrives (warm path).
    clerum.rpc.listSessions.mockResolvedValue(SUSPENDED_ON_MONDAY)
    const handle = extendMockClerumForAppController(clerum, { agentNames: ['agent-x'] })
    // `approveToolCall` is added to the rpc bridge by `extendMockClerumForAppController`,
    // so it isn't on the base `RpcMock` type — reach it through a cast.
    const approveToolCall = (clerum.rpc as unknown as { approveToolCall: ReturnType<typeof vi.fn> })
      .approveToolCall

    const app = renderAppController()
    unmountApp = app.unmount

    await waitFor(() => expect(app.result.current.booting).toBe(false), SLOW)
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true), SLOW)
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false), SLOW)
    await waitFor(() => expect(handle.onMcpOauthCompleted).toHaveBeenCalled(), SLOW)

    // Boot auto-selected agent-x and seeded the suspended session already.
    await waitFor(
      () =>
        expect(
          app.result.current.sessionStateByChatKey[CONNECT_KEY]?.pendingApproval?.requestId
        ).toBe('req-connect'),
      SLOW
    )

    // Completion arrives with the snapshot already seeded → immediate resume.
    act(() => {
      handle.emitMcpOauthCompleted({ mcpServerName: 'monday' })
    })
    await waitFor(
      () =>
        expect(approveToolCall).toHaveBeenCalledWith(
          'agent-x',
          'task-connect',
          'req-connect',
          ['agent-x'],
          { teamId: undefined }
        ),
      SLOW
    )

    // The optimistic APPROVAL_DECIDED transition is itself a store change; the
    // subscribe fires again with an EMPTY buffer, so nothing re-resumes. Draining
    // everything confirms the warm path left no buffered entry behind.
    await settle()
    expect(resumeCalls(approveToolCall)).toHaveLength(1)
  })
})
