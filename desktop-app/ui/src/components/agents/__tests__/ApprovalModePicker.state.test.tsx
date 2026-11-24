// @vitest-environment jsdom
/**
 * Approval-mode picker local state (spec "Approval-mode picker local state",
 * A4 invariants S1-S4, L1, L2, F1, C1). A fast-check command model drives the
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
  approvalModeForFirstSend,
  beginApprovalModeFirstSend,
  hostApprovalModeEpoch,
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

const RANK: Record<ApprovalMode, number> = { manual: 0, auto: 1, allow_all: 2 }

function lower(a: ApprovalMode, b: ApprovalMode): ApprovalMode {
  return RANK[a] <= RANK[b] ? a : b
}

/** The fake Host's ceiling. Desktop chats have channel cap allow_all. */
const host = { ceiling: 'allow_all' as ApprovalMode }

function sessionApproval(mode: ApprovalMode, ceiling: ApprovalMode = host.ceiling) {
  return {
    approvalMode: mode,
    modeCeiling: ceiling,
    channelCap: 'allow_all' as ApprovalMode,
    effectiveApprovalMode: lower(mode, ceiling),
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
const listSessions = vi.fn()

function resetWorld(): void {
  setApprovalMode.mockReset()
  loadSessionMessages.mockReset()
  listSessions.mockReset()
  host.ceiling = 'allow_all'
  loadSessionMessages.mockImplementation(async (_agent: string, _host: string, chatId: string) => {
    const stored = server[chatId]
    if (!stored) throw new Error(`fake Host has no session ${chatId}`)
    return sessionApproval(stored)
  })
  // The catalog page the picker reads the Host ceiling from (SessionsListResult).
  listSessions.mockImplementation(async () => ({
    items: Object.keys(server).map(chatId => ({
      agent: 'agent-x',
      chatId,
      turnCount: 1,
      ...sessionApproval(server[chatId] ?? 'manual'),
    })),
  }))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: { rpc: { setApprovalMode, loadSessionMessages, listSessions } },
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

describe('ApprovalModePicker state — save errors (A3 rows)', () => {
  it('R4: A→B→A with A’s save still in flight shows A’s failed save on A', async () => {
    const write = deferred<ApprovalModeResult>()
    setApprovalMode.mockReturnValueOnce(write.promise)
    const utils = renderPicker('chat-1')
    pickAuto(utils)
    utils.rerender(<ApprovalModePicker agentRef="agent-x" chatId="chat-2" />)
    utils.rerender(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)

    write.reject(patchFailure(500))
    await flush()

    expect(utils.getByTestId('approval-mode-picker').textContent).toBe('Manual')
    expect(utils.queryByTestId('approval-mode-write-error')?.textContent).toBe(SAVE_ERROR)
  })

  it('R5: a save that fails while another chat is on screen shows only when its chat returns', async () => {
    const write = deferred<ApprovalModeResult>()
    setApprovalMode.mockReturnValueOnce(write.promise)
    const utils = renderPicker('chat-1')
    pickAuto(utils)
    utils.rerender(<ApprovalModePicker agentRef="agent-x" chatId="chat-2" />)

    write.reject(patchFailure(500))
    await flush()
    expect(utils.queryByTestId('approval-mode-write-error')).toBeNull()

    utils.rerender(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)
    expect(utils.queryByTestId('approval-mode-write-error')?.textContent).toBe(SAVE_ERROR)
  })

  it('R6: no second save for the chat starts while its first is in flight, so that save decides the outcome', async () => {
    const older = deferred<ApprovalModeResult>()
    setApprovalMode.mockReturnValueOnce(older.promise)
    const utils = renderPicker('chat-1')
    pickAuto(utils)
    fireEvent.click(utils.getByTestId('approval-mode-picker'))
    expect(utils.queryByTestId('approval-mode-option-manual')).toBeNull()
    expect(setApprovalMode).toHaveBeenCalledTimes(1)

    older.reject(patchFailure(500))
    await flush()

    expect(utils.queryByTestId('approval-mode-write-error')?.textContent).toBe(SAVE_ERROR)
  })

  it('R9: a save that fails while the chat is unmounted shows when the chat mounts again', async () => {
    const write = deferred<ApprovalModeResult>()
    setApprovalMode.mockReturnValueOnce(write.promise)
    const first = renderPicker('chat-1')
    pickAuto(first)
    first.unmount()

    write.reject(patchFailure(500))
    await flush()

    const again = renderPicker('chat-1')
    expect(again.queryByTestId('approval-mode-write-error')?.textContent).toBe(SAVE_ERROR)
  })

  it('R7: opening the menu after a failed save clears the error for good', async () => {
    setApprovalMode.mockRejectedValueOnce(patchFailure(500))
    const utils = renderPicker('chat-1')
    pickAuto(utils)
    await flush()
    expect(utils.queryByTestId('approval-mode-write-error')).not.toBeNull()

    fireEvent.click(utils.getByTestId('approval-mode-picker'))
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(utils.queryByTestId('approval-mode-option-manual')).toBeNull()
    expect(utils.queryByTestId('approval-mode-write-error')).toBeNull()
  })

  it('R14: the menu cannot open while the save is in flight, so its failure shows at once', async () => {
    const write = deferred<ApprovalModeResult>()
    setApprovalMode.mockReturnValueOnce(write.promise)
    const utils = renderPicker('chat-1')
    pickAuto(utils)
    fireEvent.click(utils.getByTestId('approval-mode-picker'))
    expect(utils.getByTestId('approval-mode-picker').getAttribute('aria-expanded')).toBe('false')

    write.reject(patchFailure(500))
    await flush()
    expect(utils.queryByTestId('approval-mode-write-error')?.textContent).toBe(SAVE_ERROR)

    // Only an opening click clears it.
    fireEvent.click(utils.getByTestId('approval-mode-picker'))
    expect(utils.queryByTestId('approval-mode-option-manual')).not.toBeNull()
    expect(utils.queryByTestId('approval-mode-write-error')).toBeNull()
  })

  it('R16: a failed response for a save the Host did commit shows no error', async () => {
    const write = deferred<ApprovalModeResult>()
    setApprovalMode.mockReturnValueOnce(write.promise)
    const utils = renderPicker('chat-1')
    pickAuto(utils)

    server['chat-1'] = 'auto'
    write.reject(patchFailure(502))
    await flush()

    expect(utils.getByTestId('approval-mode-picker').textContent).toBe('Auto-approve')
    expect(utils.queryByTestId('approval-mode-write-error')).toBeNull()
  })

  it('R17: a later session read that shows the requested mode clears the error', async () => {
    setApprovalMode.mockRejectedValueOnce(patchFailure(500))
    const utils = renderPicker('chat-1')
    pickAuto(utils)
    await flush()
    expect(utils.queryByTestId('approval-mode-write-error')).not.toBeNull()

    act(() => {
      noteHostApprovalModeFromSession('agent-x', 'chat-1', sessionApproval('auto'))
    })

    expect(utils.queryByTestId('approval-mode-write-error')).toBeNull()
  })

  it('R17: once a read proves the save, a later change elsewhere does not bring the error back', async () => {
    setApprovalMode.mockRejectedValueOnce(patchFailure(401))
    const utils = renderPicker('chat-1')
    pickAuto(utils)
    await flush()
    expect(utils.queryByTestId('approval-mode-write-error')).not.toBeNull()

    act(() => {
      noteHostApprovalModeFromSession('agent-x', 'chat-1', sessionApproval('auto'))
    })
    act(() => {
      // Another client sets the chat back to manual.
      noteHostApprovalModeFromSession('agent-x', 'chat-1', sessionApproval('manual'))
    })

    expect(utils.getByTestId('approval-mode-picker').textContent).toBe('Manual')
    expect(utils.queryByTestId('approval-mode-write-error')).toBeNull()
  })

  it('R18: a store scope reset drops the error from a picker that stays mounted', async () => {
    setApprovalMode.mockRejectedValueOnce(patchFailure(500))
    const utils = renderPicker('chat-1')
    pickAuto(utils)
    await flush()
    expect(utils.queryByTestId('approval-mode-write-error')).not.toBeNull()

    act(() => {
      resetHostApprovalModeStore()
    })
    // The parent re-renders on the scope change; the same ids now name another scope's chat.
    utils.rerender(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)

    expect(utils.queryByTestId('approval-mode-write-error')).toBeNull()
  })

  it('R18: a save in flight across a store scope reset cannot raise an error in the new scope', async () => {
    const write = deferred<ApprovalModeResult>()
    setApprovalMode.mockReturnValueOnce(write.promise)
    const utils = renderPicker('chat-1')
    pickAuto(utils)

    act(() => {
      resetHostApprovalModeStore()
    })
    utils.rerender(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)
    write.reject(patchFailure(500))
    await flush()

    expect(utils.queryByTestId('approval-mode-write-error')).toBeNull()
  })

  it('R25: a failed re-pick of the mode already stored shows no error', async () => {
    setApprovalMode.mockRejectedValueOnce(patchFailure(401))
    const utils = renderPicker('chat-1')
    fireEvent.click(utils.getByTestId('approval-mode-picker'))
    fireEvent.click(utils.getByTestId('approval-mode-option-manual'))
    await flush()

    expect(setApprovalMode).toHaveBeenCalledWith('agent-x', 'agent-x', 'chat-1', 'manual')
    expect(utils.getByTestId('approval-mode-picker').textContent).toBe('Manual')
    expect(utils.queryByTestId('approval-mode-write-error')).toBeNull()
  })
})

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

    expect(committed.some(entry => entry.chatId === 'chat-2')).toBe(true)
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
      await vi.waitFor(() => expect(chip()?.textContent).toBe('Manual'))

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
      const menu = () => container.querySelector('[data-testid="approval-mode-option-manual"]')
      await vi.waitFor(() => expect(chip().textContent).toBe('Auto-approve'))
      // With a passive reset effect pending, the click is undone and the menu
      // never appears; with the render-phase reset it opens and stays open.
      await vi.waitFor(() => expect(menu()).not.toBeNull())
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(menu()).not.toBeNull()
    } finally {
      root.unmount()
      container.remove()
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    }
  })
})

describe('ApprovalModePicker state — focus (F1)', () => {
  function openConfirmation() {
    const utils = renderPicker('chat-1')
    fireEvent.click(utils.getByTestId('approval-mode-picker'))
    fireEvent.click(utils.getByTestId('approval-mode-option-allow-all'))
    return utils
  }

  it('R11: focuses Cancel when the Allow-all confirmation opens', () => {
    const { getByTestId } = openConfirmation()
    expect(document.activeElement).toBe(getByTestId('approval-mode-cancel-allow-all'))
  })

  it('R12: Tab and Shift+Tab stay inside the confirmation', () => {
    const { getByTestId } = openConfirmation()
    const cancel = getByTestId('approval-mode-cancel-allow-all')
    const confirm = getByTestId('approval-mode-confirm-allow-all')

    confirm.focus()
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(document.activeElement).toBe(cancel)

    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm)
  })

  it('R19: focus left on the confirmation itself still cannot Tab out of it', () => {
    const { getByRole, getByTestId } = openConfirmation()
    const dialog = getByRole('dialog', { name: 'Confirm allow all' })
    // A mousedown on the text moves focus to the nearest focusable ancestor.
    expect(dialog.getAttribute('tabindex')).toBe('-1')

    dialog.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(getByTestId('approval-mode-cancel-allow-all'))

    dialog.focus()
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(getByTestId('approval-mode-confirm-allow-all'))
  })

  it('R13: Cancel returns focus to the chip', () => {
    const { getByTestId } = openConfirmation()
    fireEvent.click(getByTestId('approval-mode-cancel-allow-all'))
    expect(document.activeElement).toBe(getByTestId('approval-mode-picker'))
  })

  it('R13: Escape closes the confirmation and returns focus to the chip', () => {
    const { getByTestId, queryByTestId } = openConfirmation()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(queryByTestId('approval-mode-confirm-allow-all')).toBeNull()
    expect(document.activeElement).toBe(getByTestId('approval-mode-picker'))
  })

  it('R13: Confirm returns focus to the chip', async () => {
    setApprovalMode.mockResolvedValueOnce(patchSuccess('allow_all'))
    const { getByTestId } = openConfirmation()
    await act(async () => {
      fireEvent.click(getByTestId('approval-mode-confirm-allow-all'))
    })
    expect(document.activeElement).toBe(getByTestId('approval-mode-picker'))
    expect(setApprovalMode).toHaveBeenCalledWith('agent-x', 'agent-x', 'chat-1', 'allow_all')
  })

  it('R21: picking a mode from the menu returns focus to the chip', async () => {
    setApprovalMode.mockResolvedValueOnce(patchSuccess('auto'))
    const utils = renderPicker('chat-1')
    fireEvent.click(utils.getByTestId('approval-mode-picker'))
    const row = utils.getByTestId('approval-mode-option-auto')
    row.focus()
    await act(async () => {
      fireEvent.click(row)
    })
    expect(document.activeElement).toBe(utils.getByTestId('approval-mode-picker'))
  })
})

describe('ApprovalModePicker state — Allow all under a limit that drops (D3)', () => {
  /** A catalog page whose one session carries the Host's ceiling (SessionsListResult). */
  function catalogPage(ceiling: ApprovalMode) {
    return {
      items: [
        { agent: 'agent-x', chatId: 'chat-1', turnCount: 1, ...sessionApproval('manual', ceiling) },
      ],
    }
  }

  /**
   * A blank chat on a Host Desktop has not read yet: the limit is unknown, so
   * the menu offers Allow all while the opening's refresh is still out.
   */
  function openConfirmationWhileTheLimitIsUnknown() {
    act(() => {
      resetHostApprovalModeStore()
    })
    const catalog = deferred<ReturnType<typeof catalogPage>>()
    listSessions.mockReturnValueOnce(catalog.promise)
    const utils = renderPicker('')
    fireEvent.click(utils.getByTestId('approval-mode-picker'))
    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(utils.getByTestId('approval-mode-option-allow-all').getAttribute('aria-disabled')).toBe(
      null
    )
    fireEvent.click(utils.getByTestId('approval-mode-option-allow-all'))
    expect(utils.queryByTestId('approval-mode-confirm-allow-all')).not.toBeNull()
    return { utils, catalog }
  }

  it('returns to the menu when the refresh lowers the limit under an open confirmation, and holds nothing', async () => {
    const { utils, catalog } = openConfirmationWhileTheLimitIsUnknown()

    catalog.resolve(catalogPage('auto'))
    await flush()

    expect(utils.queryByTestId('approval-mode-confirm-allow-all')).toBeNull()
    const allowAll = utils.getByTestId('approval-mode-option-allow-all')
    expect(allowAll.getAttribute('aria-disabled')).toBe('true')
    expect(utils.getByTestId('approval-mode-limit-note').textContent).toBe(
      'This Host limits this chat to Auto-approve.'
    )
    // Focus goes back to the row that opened the confirmation; the note describes it.
    expect(document.activeElement).toBe(allowAll)
    expect(approvalModeForFirstSend('agent-x', null)).toBeNull()
    expect(utils.getByTestId('approval-mode-picker').textContent).toBe('Manual')
  })

  it('still confirms Allow all when the refresh shows the Host allows it', async () => {
    const { utils, catalog } = openConfirmationWhileTheLimitIsUnknown()

    catalog.resolve(catalogPage('allow_all'))
    await flush()
    fireEvent.click(utils.getByTestId('approval-mode-confirm-allow-all'))

    expect(approvalModeForFirstSend('agent-x', null)).toBe('allow_all')
    expect(utils.getByTestId('approval-mode-picker').textContent).toBe('Allow all')
  })

  it.each([
    ['auto', false],
    ['allow_all', true],
  ] as const)(
    'Confirm checks the limit the store holds at the click (a read with ceiling %s lands first)',
    async (ceiling, stores) => {
      setApprovalMode.mockResolvedValue(patchSuccess('allow_all'))
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const find = (testId: string) =>
        container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
      try {
        root.render(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)
        await vi.waitFor(() => expect(find('approval-mode-picker')?.textContent).toBe('Manual'))
        find('approval-mode-picker')!.click()
        // The opening's own refresh lands before the confirmation opens.
        await vi.waitFor(() => expect(loadSessionMessages).toHaveBeenCalledTimes(1))
        await new Promise(resolve => setTimeout(resolve, 0))
        await vi.waitFor(() => expect(find('approval-mode-option-allow-all')).not.toBeNull())
        find('approval-mode-option-allow-all')!.click()
        await vi.waitFor(() => expect(find('approval-mode-confirm-allow-all')).not.toBeNull())
        const confirm = find('approval-mode-confirm-allow-all')!

        // A read of the chat lands, and the click arrives before React renders it.
        noteHostApprovalModeFromSession('agent-x', 'chat-1', sessionApproval('manual', ceiling))
        confirm.click()
        await new Promise(resolve => setTimeout(resolve, 0))

        if (stores) {
          expect(setApprovalMode).toHaveBeenCalledWith('agent-x', 'agent-x', 'chat-1', 'allow_all')
          await vi.waitFor(() =>
            expect(find('approval-mode-picker')?.textContent).toBe('Allow all')
          )
        } else {
          expect(setApprovalMode).not.toHaveBeenCalled()
          // The read reached the picker: the confirmation is gone and the row is not offered.
          await vi.waitFor(() => expect(find('approval-mode-confirm-allow-all')).toBeNull())
          expect(find('approval-mode-option-allow-all')?.getAttribute('aria-disabled')).toBe('true')
        }
      } finally {
        root.unmount()
        container.remove()
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
      }
    }
  )
})

// ---------------------------------------------------------------------------
// A6 — independent oracle: a trivial reference model of the A4 invariants.
// ---------------------------------------------------------------------------

/**
 * ok: saved. fail: not saved. dropped: saved by the Host, response lost.
 * gone: mcp-host answers 404 for a chat the store has seen (C5): not saved.
 */
type Outcome = 'ok' | 'fail' | 'dropped' | 'gone'
/** A chat with a session row, or the blank chat (no chat id: picks are held). */
type Screen = ChatKey | 'blank'
const SCREENS: readonly Screen[] = [...CHATS, 'blank']
const NAMES: Record<ApprovalMode, string> = {
  manual: 'Manual',
  auto: 'Auto-approve',
  allow_all: 'Allow all',
}
const OPTION_IDS: Record<ApprovalMode, string> = {
  manual: 'approval-mode-option-manual',
  auto: 'approval-mode-option-auto',
  allow_all: 'approval-mode-option-allow-all',
}

interface ModelWrite {
  id: number
  chat: ChatKey
  mode: ApprovalMode
  outcome: Outcome
  settled: boolean
  /** `requestSeq` when its PATCH started. */
  startedAt: number
}
interface Model {
  screen: Screen
  menuOpen: boolean
  confirming: boolean
  writes: ModelWrite[]
  stored: Record<ChatKey, ApprovalMode>
  /** L1: the latest write's requested mode while it failed and the stored mode has not equalled it since. */
  failedRequest: Record<ChatKey, ApprovalMode | null>
  expectedCalls: ChatKey[]
  /** The fake Host's ceiling now. */
  ceiling: ApprovalMode
  /** Ceiling in the last snapshot Desktop applied for each chat (D1: its limit). */
  limit: Record<ChatKey, ApprovalMode>
  /** Desktop's Host-wide ceiling (D2), the blank chat's limit. Null: unknown. */
  hostCeiling: ApprovalMode | null
  /** Bumps as each request that answers with the ceiling starts: a refresh, a PATCH, a re-read. */
  requestSeq: number
  /** `requestSeq` of the request whose answer set `hostCeiling`; 0 for the seeds' passive fill. */
  hostCeilingSeq: number
  /** The blank chat's held pick. */
  held: ApprovalMode
}
interface Real {
  scheduler: fc.Scheduler
  utils: ReturnType<typeof render>
  pendingOutcomes: Outcome[]
  settledIds: number[]
  nextWriteId: number
}

function pickerChatId(screen: Screen): string {
  return screen === 'blank' ? '' : screen
}

function closeMenu(model: Model): void {
  model.menuOpen = false
  model.confirming = false
}

function startWrite(model: Model, chat: ChatKey, mode: ApprovalMode, outcome: Outcome, real: Real) {
  model.requestSeq += 1
  model.writes.push({
    id: model.writes.length + 1,
    chat,
    mode,
    outcome,
    settled: false,
    startedAt: model.requestSeq,
  })
  model.expectedCalls.push(chat)
  real.pendingOutcomes.push(outcome)
}

/** A save for this chat is unanswered (PATCH not settled). */
function saveInFlight(model: Readonly<Model>, screen: Screen): boolean {
  return model.writes.some(write => write.chat === screen && !write.settled)
}

/** D1: the highest mode the chat on screen can run, or null while unknown. */
function limitOf(model: Readonly<Model>, screen: Screen): ApprovalMode | null {
  return screen === 'blank' ? model.hostCeiling : model.limit[screen]
}

function storedOf(model: Readonly<Model>, screen: Screen): ApprovalMode {
  return screen === 'blank' ? model.held : model.stored[screen]
}

/** D1: the chip shows the mode the Host runs: the stored pick under the limit. */
function effectiveOf(model: Readonly<Model>, screen: Screen): ApprovalMode {
  const limit = limitOf(model, screen)
  const stored = storedOf(model, screen)
  return limit === null ? stored : lower(stored, limit)
}

function offered(model: Readonly<Model>, mode: ApprovalMode): boolean {
  const limit = limitOf(model, model.screen)
  return limit === null || RANK[mode] <= RANK[limit]
}

/** D3: the menu note names the limit, and what the chat was set to above it. */
function expectedNote(model: Readonly<Model>): string | null {
  const stored = storedOf(model, model.screen)
  const effective = effectiveOf(model, model.screen)
  const limit = limitOf(model, model.screen)
  if (stored !== effective) {
    return `Set to ${NAMES[stored]}; this Host limits this chat to ${NAMES[effective]}.`
  }
  if (limit !== null && limit !== 'allow_all')
    return `This Host limits this chat to ${NAMES[limit]}.`
  return null
}

/**
 * D3: once the limit on screen drops below Allow all, an open confirmation
 * goes back to the menu; nothing above the limit can be confirmed.
 */
function dropConfirmationAboveLimit(model: Model): void {
  if (model.menuOpen && model.confirming && !offered(model, 'allow_all')) {
    model.confirming = false
  }
}

/**
 * Desktop applied a fresh answer for `chat` taken now, from a request that
 * started at `requestSeq`. The chat's limit moves. The Host ceiling moves
 * unless a request that started later already answered (D2).
 */
function freshSnapshot(model: Model, chat: ChatKey, requestSeq: number): void {
  model.limit[chat] = model.ceiling
  freshHostCeiling(model, requestSeq)
}

function freshHostCeiling(model: Model, requestSeq: number): void {
  if (model.hostCeilingSeq > requestSeq) return
  model.hostCeiling = model.ceiling
  model.hostCeilingSeq = requestSeq
}

function assertInvariants(model: Model, real: Real): void {
  const { getByTestId, queryByTestId } = real.utils
  // S4: one save in flight per chat; the chip of that chat is busy meanwhile.
  for (const chat of CHATS) {
    expect(
      model.writes.filter(write => write.chat === chat && !write.settled).length
    ).toBeLessThanOrEqual(1)
  }
  expect(getByTestId('approval-mode-picker').getAttribute('aria-busy') === 'true').toBe(
    saveInFlight(model, model.screen)
  )
  // D1: the chip shows the mode the Host runs.
  expect(getByTestId('approval-mode-picker').textContent).toBe(
    NAMES[effectiveOf(model, model.screen)]
  )
  // L2 + menu shape
  expect(queryByTestId('approval-mode-option-manual') !== null).toBe(
    model.menuOpen && !model.confirming
  )
  expect(queryByTestId('approval-mode-confirm-allow-all') !== null).toBe(
    model.menuOpen && model.confirming
  )
  // D3: rows above the limit are shown but not offered; the note names the limit.
  if (model.menuOpen && !model.confirming) {
    for (const mode of ['manual', 'auto', 'allow_all'] as const) {
      expect(getByTestId(OPTION_IDS[mode]).getAttribute('aria-disabled') === 'true').toBe(
        !offered(model, mode)
      )
    }
    expect(queryByTestId('approval-mode-limit-note')?.textContent ?? null).toBe(expectedNote(model))
  }
  // S2 + L1: the error shows exactly for the chat on screen with the menu closed.
  const failed = model.screen === 'blank' ? null : model.failedRequest[model.screen]
  expect(queryByTestId('approval-mode-write-error') !== null).toBe(
    failed !== null && !model.menuOpen
  )
  // S1 + C1: every PATCH targeted the chat on screen at the click.
  expect(setApprovalMode.mock.calls.map(call => call[2])).toEqual(model.expectedCalls)
}

class SwitchChat implements fc.AsyncCommand<Model, Real> {
  constructor(readonly target: Screen) {}
  check(model: Readonly<Model>) {
    return model.screen !== this.target
  }
  async run(model: Model, real: Real) {
    model.screen = this.target
    closeMenu(model)
    real.utils.rerender(
      <ApprovalModePicker agentRef="agent-x" chatId={pickerChatId(this.target)} />
    )
    assertInvariants(model, real)
  }
  toString() {
    return `SwitchChat(${this.target})`
  }
}

class Remount implements fc.AsyncCommand<Model, Real> {
  check() {
    return true
  }
  async run(model: Model, real: Real) {
    closeMenu(model)
    real.utils.unmount()
    real.utils = render(
      <ApprovalModePicker agentRef="agent-x" chatId={pickerChatId(model.screen)} />
    )
    assertInvariants(model, real)
  }
  toString() {
    return 'Remount'
  }
}

class ToggleMenu implements fc.AsyncCommand<Model, Real> {
  check() {
    return true
  }
  async run(model: Model, real: Real) {
    if (model.menuOpen) {
      closeMenu(model)
    } else if (!saveInFlight(model, model.screen)) {
      model.menuOpen = true
      // D4: opening re-reads the limit: the chat's own session, or for the
      // blank chat the Host ceiling from the catalog.
      model.requestSeq += 1
      if (model.screen === 'blank') {
        freshHostCeiling(model, model.requestSeq)
      } else {
        model.failedRequest[model.screen] = null
        freshSnapshot(model, model.screen, model.requestSeq)
      }
    }
    // A busy chip ignores the click: the menu stays closed and the error stays.
    fireEvent.click(real.utils.getByTestId('approval-mode-picker'))
    await flush()
    assertInvariants(model, real)
  }
  toString() {
    return 'ToggleMenu'
  }
}

class Pick implements fc.AsyncCommand<Model, Real> {
  constructor(
    readonly mode: 'manual' | 'auto',
    readonly outcome: Outcome
  ) {}
  check(model: Readonly<Model>) {
    return model.menuOpen && !model.confirming
  }
  async run(model: Model, real: Real) {
    // D3: a row above the limit does nothing, and the menu stays open.
    if (offered(model, this.mode)) {
      closeMenu(model)
      if (model.screen === 'blank') model.held = this.mode
      else startWrite(model, model.screen, this.mode, this.outcome, real)
    }
    fireEvent.click(real.utils.getByTestId(OPTION_IDS[this.mode]))
    await flush()
    assertInvariants(model, real)
  }
  toString() {
    return `Pick(${this.mode}, ${this.outcome})`
  }
}

class PickAllowAll implements fc.AsyncCommand<Model, Real> {
  check(model: Readonly<Model>) {
    return model.menuOpen && !model.confirming
  }
  async run(model: Model, real: Real) {
    if (offered(model, 'allow_all')) model.confirming = true
    fireEvent.click(real.utils.getByTestId(OPTION_IDS.allow_all))
    assertInvariants(model, real)
  }
  toString() {
    return 'PickAllowAll'
  }
}

class Confirm implements fc.AsyncCommand<Model, Real> {
  constructor(readonly outcome: Outcome) {}
  check(model: Readonly<Model>) {
    return model.menuOpen && model.confirming
  }
  async run(model: Model, real: Real) {
    // A confirmation open here is always under the limit: PassiveRead and
    // Settle drop it as they lower the limit (dropConfirmationAboveLimit),
    // and SetCeiling moves no limit. So the model pins D3's close during
    // render, but never clicks Confirm above the limit. Confirm's own check
    // of the store's limit at the click, for a read the picker has not
    // rendered yet, is pinned by the scenario test "Confirm checks the limit
    // the store holds at the click".
    closeMenu(model)
    if (model.screen === 'blank') model.held = 'allow_all'
    else startWrite(model, model.screen, 'allow_all', this.outcome, real)
    fireEvent.click(real.utils.getByTestId('approval-mode-confirm-allow-all'))
    await flush()
    assertInvariants(model, real)
  }
  toString() {
    return `Confirm(${this.outcome})`
  }
}

class Dismiss implements fc.AsyncCommand<Model, Real> {
  constructor(readonly how: 'cancel' | 'escape' | 'outside') {}
  check(model: Readonly<Model>) {
    if (!model.menuOpen) return false
    return this.how !== 'cancel' || model.confirming
  }
  async run(model: Model, real: Real) {
    closeMenu(model)
    if (this.how === 'cancel') {
      fireEvent.click(real.utils.getByTestId('approval-mode-cancel-allow-all'))
    } else if (this.how === 'escape') {
      fireEvent.keyDown(window, { key: 'Escape' })
    } else {
      fireEvent.mouseDown(document.body)
    }
    assertInvariants(model, real)
  }
  toString() {
    return `Dismiss(${this.how})`
  }
}

/** An admin changes the Host ceiling. Desktop learns it only from its next read. */
class SetCeiling implements fc.AsyncCommand<Model, Real> {
  constructor(readonly ceiling: ApprovalMode) {}
  check(model: Readonly<Model>) {
    return model.ceiling !== this.ceiling
  }
  async run(model: Model, real: Real) {
    model.ceiling = this.ceiling
    host.ceiling = this.ceiling
    assertInvariants(model, real)
  }
  toString() {
    return `SetCeiling(${this.ceiling})`
  }
}

/**
 * A read of `chat` made outside the picker (chat open, reconcile, chat list),
 * answered now. It moves that chat's own limit, but not a Host ceiling that
 * Desktop already knows (D2), and not a chat whose save is in flight.
 */
class PassiveRead implements fc.AsyncCommand<Model, Real> {
  constructor(readonly chat: ChatKey) {}
  check() {
    return true
  }
  async run(model: Model, real: Real) {
    if (!saveInFlight(model, this.chat)) model.limit[this.chat] = model.ceiling
    dropConfirmationAboveLimit(model)
    const epoch = hostApprovalModeEpoch()
    act(() => {
      noteHostApprovalModeFromSession(
        'agent-x',
        this.chat,
        sessionApproval(server[this.chat] ?? 'manual'),
        epoch
      )
    })
    assertInvariants(model, real)
  }
  toString() {
    return `PassiveRead(${this.chat})`
  }
}

class Settle implements fc.AsyncCommand<Model, Real> {
  check(model: Readonly<Model>) {
    return model.writes.some(write => !write.settled)
  }
  async run(model: Model, real: Real) {
    const before = real.settledIds.length
    await act(async () => {
      await real.scheduler.waitOne()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    const write = model.writes.find(entry => entry.id === real.settledIds[before])
    if (!write) throw new Error(`settled unknown write ${real.settledIds[before]}`)
    write.settled = true
    if (write.outcome === 'ok' || write.outcome === 'dropped') model.stored[write.chat] = write.mode
    // The PATCH answer (ok) or the re-read after a failure carries the Host's
    // ceiling now. The answer's request started with the PATCH; the re-read
    // starts now. A 404 for a seen chat carries nothing.
    if (write.outcome === 'ok') {
      freshSnapshot(model, write.chat, write.startedAt)
    } else if (write.outcome !== 'gone') {
      model.requestSeq += 1
      freshSnapshot(model, write.chat, model.requestSeq)
    }
    // The Host ceiling is the blank chat's limit, so its confirmation can close here.
    dropConfirmationAboveLimit(model)
    // S3: only the latest write for its chat decides that chat's error.
    const latest = [...model.writes].reverse().find(entry => entry.chat === write.chat)
    if (latest?.id === write.id) {
      model.failedRequest[write.chat] = write.outcome === 'ok' ? null : write.mode
    }
    // L1: once the stored mode equals the failed request, the error is gone for
    // good, whichever write or read brought the stored mode there.
    if (model.failedRequest[write.chat] === model.stored[write.chat]) {
      model.failedRequest[write.chat] = null
    }
    assertInvariants(model, real)
  }
  toString() {
    return 'Settle'
  }
}

const outcomes = fc.constantFrom<Outcome>('ok', 'fail', 'dropped', 'gone')
const switchChat = fc.constantFrom(...SCREENS).map(target => new SwitchChat(target))
const toggleMenu = fc.constant(new ToggleMenu())
const pick = fc
  .tuple(fc.constantFrom('manual' as const, 'auto' as const), outcomes)
  .map(([mode, outcome]) => new Pick(mode, outcome))
const settle = fc.constant(new Settle())
const setCeiling = fc
  .constantFrom<ApprovalMode>('manual', 'auto', 'allow_all')
  .map(ceiling => new SetCeiling(ceiling))
// Weighted by repetition: the interleavings that matter (A3 R3-R9, R14, R16)
// need open → pick → switch/remount → settle chains.
const commandArbitraries = [
  switchChat,
  switchChat,
  fc.constant(new Remount()),
  toggleMenu,
  toggleMenu,
  toggleMenu,
  pick,
  pick,
  pick,
  fc.constant(new PickAllowAll()),
  outcomes.map(outcome => new Confirm(outcome)),
  fc
    .constantFrom('cancel' as const, 'escape' as const, 'outside' as const)
    .map(how => new Dismiss(how)),
  setCeiling,
  fc.constantFrom(...CHATS).map(chat => new PassiveRead(chat)),
  settle,
  settle,
  settle,
]

describe('ApprovalModePicker state — A6 command model', () => {
  it('keeps S1–S4, L1, L2, C1 and D1–D4 for any event order and settlement order', async () => {
    // Run before the random mix, which rarely reaches it: a read lowers the
    // limit while the Allow-all confirmation is open (D3).
    const examples: [fc.Scheduler, fc.AsyncCommand<Model, Real>[]][] = [
      [
        fc.schedulerFor([]),
        [new ToggleMenu(), new PickAllowAll(), new SetCeiling('manual'), new PassiveRead('chat-1')],
      ],
    ]
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands(commandArbitraries, { maxCommands: 24 }),
        async (scheduler, commands) => {
          cleanup()
          resetWorld()
          const real: Real = {
            scheduler,
            utils: undefined as unknown as Real['utils'],
            pendingOutcomes: [],
            settledIds: [],
            nextWriteId: 1,
          }
          setApprovalMode.mockImplementation(
            (_agent: string, _host: string, chatId: string, mode: ApprovalMode) => {
              const id = real.nextWriteId++
              const outcome = real.pendingOutcomes.shift()
              return scheduler.schedule(Promise.resolve(id), `write-${id}`).then(() => {
                real.settledIds.push(id)
                if (outcome === 'ok' || outcome === 'dropped') server[chatId] = mode
                if (outcome === 'gone') throw patchFailure(404)
                if (outcome !== 'ok') throw patchFailure(500)
                return patchSuccess(mode)
              })
            }
          )
          real.utils = render(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)
          const model: Model = {
            screen: 'chat-1',
            menuOpen: false,
            confirming: false,
            writes: [],
            stored: { 'chat-1': 'manual', 'chat-2': 'manual' },
            failedRequest: { 'chat-1': null, 'chat-2': null },
            expectedCalls: [],
            ceiling: 'allow_all',
            // The seeds were read under ceiling allow_all; the first filled the Host ceiling.
            limit: { 'chat-1': 'allow_all', 'chat-2': 'allow_all' },
            hostCeiling: 'allow_all',
            requestSeq: 0,
            hostCeilingSeq: 0,
            held: 'manual',
          }
          await fc.asyncModelRun(() => ({ model, real }), commands)
          // Quiescence: settle everything still pending, then re-check.
          while (model.writes.some(write => !write.settled)) await new Settle().run(model, real)
          assertInvariants(model, real)
        }
      ),
      { numRuns: Number(process.env.PICKER_MODEL_RUNS ?? 500), examples }
    )
  })
})
