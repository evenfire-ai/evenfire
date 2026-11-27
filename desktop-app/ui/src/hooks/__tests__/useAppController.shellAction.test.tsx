// @vitest-environment jsdom
/**
 * The shell card's action reaches the approval route. Every approval surface
 * funnels through the decider `useAppController` binds, which builds the IPC
 * approval call; the action the card chose ("Allow once", "Allow this
 * command", "Always allow shell") must ride on it, or the Host records every
 * answer as once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import {
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import { uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

const AGENT = 'agent-x'

describe('useAppController: shell card actions on the approval route', () => {
  let unmount: (() => void) | undefined

  afterEach(() => {
    cleanup()
    unmount?.()
    unmount = undefined
    vi.restoreAllMocks()
    uninstallMockClerum()
  })

  async function boot() {
    // Reconciliation can deliver a notification; jsdom has no media playback.
    vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    // Approval decisions schedule reconciliation without awaiting it. Observe its
    // terminal event so the real-store reads finish before removing the IPC bridge.
    // This spy calls through: diagnostics remain visible to the test runner.
    const recoveryLog = vi.spyOn(console, 'log')
    const { clerum } = installAppControllerClerum({ agentNames: [AGENT] })
    // Added to the rpc bridge by the harness, so not on the base mock type.
    const approveToolCall = (clerum.rpc as unknown as { approveToolCall: ReturnType<typeof vi.fn> })
      .approveToolCall
    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    const waitForRecovery = () =>
      waitFor(() =>
        expect(recoveryLog).toHaveBeenCalledWith('[telemetry] stream_recovery', {
          reason: 'approval_decided',
          outcome: expect.not.stringMatching(/^error$/),
        })
      )
    return { app, approveToolCall, waitForRecovery }
  }

  it.each(['once', 'command', 'shell'] as const)(
    'sends the card’s %s action with the approval',
    async shellAction => {
      const { app, approveToolCall, waitForRecovery } = await boot()

      await act(async () => {
        await app.result.current.decideApproval({
          agentRef: AGENT,
          chatId: 'chat-1',
          taskId: 'task-1',
          requestId: 'req-1',
          decision: 'approve',
          shellAction,
          source: 'in_chat',
        })
      })

      await waitForRecovery()

      expect(approveToolCall).toHaveBeenCalledTimes(1)
      expect(approveToolCall).toHaveBeenCalledWith(AGENT, 'task-1', 'req-1', [AGENT], {
        teamId: undefined,
        alwaysApprove: false,
        shellAction,
      })
    }
  )

  it('sends no action for an approval that is not a shell card answer', async () => {
    const { app, approveToolCall, waitForRecovery } = await boot()

    await act(async () => {
      await app.result.current.decideApproval({
        agentRef: AGENT,
        chatId: 'chat-1',
        taskId: 'task-1',
        requestId: 'req-1',
        decision: 'approve',
        alwaysApprove: true,
        source: 'in_chat',
      })
    })

    await waitForRecovery()

    expect(approveToolCall).toHaveBeenCalledTimes(1)
    expect(approveToolCall.mock.calls[0]?.[4]).toEqual({ teamId: undefined, alwaysApprove: true })
  })
})
