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

  it('R6: a newer save for the same chat wins over an older failure that settles later', async () => {
    const older = deferred<ApprovalModeResult>()
    const newer = deferred<ApprovalModeResult>()
    setApprovalMode.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const utils = renderPicker('chat-1')
    pickAuto(utils)
    fireEvent.click(utils.getByTestId('approval-mode-picker'))
    fireEvent.click(utils.getByTestId('approval-mode-option-manual'))
    expect(setApprovalMode).toHaveBeenCalledTimes(2)

    newer.resolve(patchSuccess('manual'))
    await flush()
    older.reject(patchFailure(500))
    await flush()

    expect(utils.queryByTestId('approval-mode-write-error')).toBeNull()
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

  it('R14: an error that arrives while the menu is open shows once the chip closes the menu', async () => {
    const write = deferred<ApprovalModeResult>()
    setApprovalMode.mockReturnValueOnce(write.promise)
    const utils = renderPicker('chat-1')
    pickAuto(utils)
    fireEvent.click(utils.getByTestId('approval-mode-picker'))

    write.reject(patchFailure(500))
    await flush()
    expect(utils.queryByTestId('approval-mode-write-error')).toBeNull()

    fireEvent.click(utils.getByTestId('approval-mode-picker'))
    expect(utils.queryByTestId('approval-mode-write-error')?.textContent).toBe(SAVE_ERROR)
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

// ---------------------------------------------------------------------------
// A6 — independent oracle: a trivial reference model of the A4 invariants.
// ---------------------------------------------------------------------------

/** ok: saved. fail: not saved. dropped: saved by the Host, response lost. */
type Outcome = 'ok' | 'fail' | 'dropped'
interface ModelWrite {
  id: number
  chat: ChatKey
  mode: ApprovalMode
  outcome: Outcome
  settled: boolean
}
interface Model {
  screen: ChatKey
  menuOpen: boolean
  confirming: boolean
  writes: ModelWrite[]
  stored: Record<ChatKey, ApprovalMode>
  /** L1: the latest write's requested mode while it failed and the stored mode has not equalled it since. */
  failedRequest: Record<ChatKey, ApprovalMode | null>
  expectedCalls: ChatKey[]
}
interface Real {
  scheduler: fc.Scheduler
  utils: ReturnType<typeof render>
  pendingOutcomes: Outcome[]
  settledIds: number[]
  nextWriteId: number
}

function closeMenu(model: Model): void {
  model.menuOpen = false
  model.confirming = false
}

function startWrite(model: Model, mode: ApprovalMode, outcome: Outcome, real: Real): void {
  model.writes.push({
    id: model.writes.length + 1,
    chat: model.screen,
    mode,
    outcome,
    settled: false,
  })
  model.expectedCalls.push(model.screen)
  real.pendingOutcomes.push(outcome)
}

function assertInvariants(model: Model, real: Real): void {
  const { queryByTestId } = real.utils
  // L2 + menu shape
  expect(queryByTestId('approval-mode-option-manual') !== null).toBe(
    model.menuOpen && !model.confirming
  )
  expect(queryByTestId('approval-mode-confirm-allow-all') !== null).toBe(
    model.menuOpen && model.confirming
  )
  // S2 + L1: the error shows exactly for the chat on screen with the menu closed.
  expect(queryByTestId('approval-mode-write-error') !== null).toBe(
    model.failedRequest[model.screen] !== null && !model.menuOpen
  )
  // S1 + C1: every PATCH targeted the chat on screen at the click.
  expect(setApprovalMode.mock.calls.map(call => call[2])).toEqual(model.expectedCalls)
}

class SwitchChat implements fc.AsyncCommand<Model, Real> {
  constructor(readonly target: ChatKey) {}
  check(model: Readonly<Model>) {
    return model.screen !== this.target
  }
  async run(model: Model, real: Real) {
    model.screen = this.target
    closeMenu(model)
    real.utils.rerender(<ApprovalModePicker agentRef="agent-x" chatId={this.target} />)
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
    real.utils = render(<ApprovalModePicker agentRef="agent-x" chatId={model.screen} />)
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
    } else {
      model.menuOpen = true
      model.failedRequest[model.screen] = null
    }
    fireEvent.click(real.utils.getByTestId('approval-mode-picker'))
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
    closeMenu(model)
    startWrite(model, this.mode, this.outcome, real)
    fireEvent.click(real.utils.getByTestId(`approval-mode-option-${this.mode}`))
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
    model.confirming = true
    fireEvent.click(real.utils.getByTestId('approval-mode-option-allow-all'))
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
    closeMenu(model)
    startWrite(model, 'allow_all', this.outcome, real)
    fireEvent.click(real.utils.getByTestId('approval-mode-confirm-allow-all'))
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
    if (write.outcome !== 'fail') model.stored[write.chat] = write.mode
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

const outcomes = fc.constantFrom<Outcome>('ok', 'fail', 'dropped')
const switchChat = fc.constantFrom(...CHATS).map(target => new SwitchChat(target))
const toggleMenu = fc.constant(new ToggleMenu())
const pick = fc
  .tuple(fc.constantFrom('manual' as const, 'auto' as const), outcomes)
  .map(([mode, outcome]) => new Pick(mode, outcome))
const settle = fc.constant(new Settle())
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
  settle,
  settle,
  settle,
]

describe('ApprovalModePicker state — A6 command model', () => {
  it('keeps S1–S3, L1, L2 and C1 for any event order and settlement order', async () => {
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
                if (outcome !== 'fail') server[chatId] = mode
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
          }
          await fc.asyncModelRun(() => ({ model, real }), commands)
          // Quiescence: settle everything still pending, then re-check.
          while (model.writes.some(write => !write.settled)) await new Settle().run(model, real)
          assertInvariants(model, real)
        }
      ),
      { numRuns: Number(process.env.PICKER_MODEL_RUNS ?? 500) }
    )
  })
})
