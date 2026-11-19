// @vitest-environment jsdom
/**
 * Approval-mode picker local state (spec "Approval-mode picker local state",
 * A4 invariants S1-S3, L1, L2, F1, C1). A fast-check command model drives the
 * real picker and the real approval-mode store; only the IPC boundary is
 * mocked, backed by a small fake server. Scenario tests pin the A3 rows.
 */
import { startTransition, useLayoutEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import fc from 'fast-check'
import { createRoot } from 'react-dom/client'
import type { ApprovalModeResult } from '../../../../../src/types'
import {
  beginApprovalModeFirstSend,
  noteHostApprovalModeFromSession,
  resetHostApprovalModeStore,
} from '../../../lib/hostApprovalModeStore'
import type { ApprovalMode } from '../../../lib/hostApprovalModeStore'
import { ApprovalModePicker } from '../ApprovalModePicker'

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

type ChatKey = 'chat-1' | 'chat-2'
const CHATS: readonly ChatKey[] = ['chat-1', 'chat-2']
const SAVE_ERROR = 'The approval mode could not be saved.'

/** Same message the main-process client throws for a non-2xx PATCH (rpcProxyClient.ts). */
function patchFailure(status: number): Error {
  return new Error(`Set approval mode failed (${status})`)
}

function sessionApproval(mode: ApprovalMode) {
  return {
    approvalMode: mode,
    modeCeiling: 'allow_all' as ApprovalMode,
    channelCap: 'allow_all' as ApprovalMode,
    effectiveApprovalMode: mode,
    shellClassifierAvailable: true,
  }
}

function patchSuccess(mode: ApprovalMode): ApprovalModeResult {
  const { shellClassifierAvailable: _ignored, ...result } = sessionApproval(mode)
  return result
}

/** The fake Host: what a session read returns for each chat. Shape: `ApprovalModeResult` (src/types.ts). */
const server: Record<string, ApprovalMode> = {}

function seed(chatId: string, mode: ApprovalMode = 'manual'): void {
  server[chatId] = mode
  noteHostApprovalModeFromSession('agent-x', chatId, sessionApproval(mode))
}

const setApprovalMode = vi.fn()
const loadSessionMessages = vi.fn()

function resetWorld(): void {
  setApprovalMode.mockReset()
  loadSessionMessages.mockReset()
  loadSessionMessages.mockImplementation(async (_agent: string, _host: string, chatId: string) => {
    const stored = server[chatId]
    if (!stored) throw new Error(`fake Host has no session ${chatId}`)
    return sessionApproval(stored)
  })
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: { rpc: { setApprovalMode, loadSessionMessages } },
  })
  resetHostApprovalModeStore()
  for (const key of Object.keys(server)) delete server[key]
  for (const chat of CHATS) seed(chat)
}

beforeEach(resetWorld)

afterEach(() => {
  cleanup()
  resetHostApprovalModeStore()
})

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function renderPicker(chatId: string) {
  return render(<ApprovalModePicker agentRef="agent-x" chatId={chatId} />)
}

function pickAuto(utils: ReturnType<typeof render>): void {
  fireEvent.click(utils.getByTestId('approval-mode-picker'))
  fireEvent.click(utils.getByTestId('approval-mode-option-auto'))
}

describe('ApprovalModePicker state — chat switch (C1)', () => {
  it('R1: never commits the previous chat’s confirmation under the next chat', () => {
    const committed: Array<{ chatId: string; confirmInDom: boolean }> = []
    function Probe({ chatId }: { chatId: string }) {
      // Layout effects run after the DOM commit and before passive effects:
      // the window a stale confirmation could be clicked in.
      useLayoutEffect(() => {
        committed.push({
          chatId,
          confirmInDom:
            document.querySelector('[data-testid="approval-mode-confirm-allow-all"]') !== null,
        })
      })
      return null
    }
    function Harness({ chatId }: { chatId: string }) {
      return (
        <>
          <ApprovalModePicker agentRef="agent-x" chatId={chatId} />
          <Probe chatId={chatId} />
        </>
      )
    }
    const { getByTestId, rerender } = render(<Harness chatId="chat-1" />)
    fireEvent.click(getByTestId('approval-mode-picker'))
    fireEvent.click(getByTestId('approval-mode-option-allow-all'))
    expect(getByTestId('approval-mode-confirm-allow-all')).not.toBeNull()

    rerender(<Harness chatId="chat-2" />)

    expect(committed.filter(entry => entry.chatId === 'chat-2' && entry.confirmInDom)).toEqual([])
    expect(setApprovalMode).not.toHaveBeenCalled()
  })

  it('L2: returning to the first chat does not reopen its menu', () => {
    const utils = renderPicker('chat-1')
    fireEvent.click(utils.getByTestId('approval-mode-picker'))
    expect(utils.queryByTestId('approval-mode-option-manual')).not.toBeNull()

    utils.rerender(<ApprovalModePicker agentRef="agent-x" chatId="chat-2" />)
    utils.rerender(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)

    expect(utils.queryByTestId('approval-mode-option-manual')).toBeNull()
    expect(utils.getByTestId('approval-mode-picker').getAttribute('aria-expanded')).toBe('false')
  })

  it('R23: a menu closed by the first-send lock stays closed after the lock releases', () => {
    const utils = renderPicker('chat-new')
    fireEvent.click(utils.getByTestId('approval-mode-picker'))
    expect(utils.queryByTestId('approval-mode-option-manual')).not.toBeNull()

    let send!: ReturnType<typeof beginApprovalModeFirstSend>
    act(() => {
      send = beginApprovalModeFirstSend('agent-x', 'chat-new')
    })
    expect(utils.queryByTestId('approval-mode-option-manual')).toBeNull()
    act(() => {
      send.release()
    })

    expect(utils.queryByTestId('approval-mode-option-manual')).toBeNull()
    expect(utils.getByTestId('approval-mode-picker').getAttribute('aria-expanded')).toBe('false')
  })

  it('R23: the lock edge is tracked per render across chats (A locked → B unlocked → B locks)', () => {
    const lockA = beginApprovalModeFirstSend('agent-x', 'chat-a')
    const utils = renderPicker('chat-a')
    expect(utils.getByTestId('approval-mode-picker').getAttribute('aria-disabled')).toBe('true')

    utils.rerender(<ApprovalModePicker agentRef="agent-x" chatId="chat-b" />)
    fireEvent.click(utils.getByTestId('approval-mode-picker'))
    expect(utils.queryByTestId('approval-mode-option-manual')).not.toBeNull()

    let lockB!: ReturnType<typeof beginApprovalModeFirstSend>
    act(() => {
      lockB = beginApprovalModeFirstSend('agent-x', 'chat-b')
    })
    act(() => {
      lockB.release()
    })

    expect(utils.queryByTestId('approval-mode-option-manual')).toBeNull()
    lockA.release()
  })

  it('R22: a chip click right after a non-discrete chat change opens the menu', async () => {
    seed('chat-2', 'auto')
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const chip = () =>
      container.querySelector('[data-testid="approval-mode-picker"]') as HTMLElement
    try {
      root.render(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(chip().textContent).toBe('Manual')

      // Click in the first microtask after the transition's DOM commit, before
      // the scheduler gets to run passive effects.
      const clickedAfterCommit = new Promise<void>(resolve => {
        const observer = new MutationObserver(() => {
          observer.disconnect()
          chip().click()
          resolve()
        })
        observer.observe(container, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        })
      })
      startTransition(() => {
        root.render(<ApprovalModePicker agentRef="agent-x" chatId="chat-2" />)
      })
      await clickedAfterCommit
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(chip().textContent).toBe('Auto-approve')
      expect(container.querySelector('[data-testid="approval-mode-option-manual"]')).not.toBeNull()
    } finally {
      root.unmount()
      container.remove()
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    }
  })
})
