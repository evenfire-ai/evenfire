// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import {
  noteHostApprovalModeFromSession,
  resetHostApprovalModeStore,
} from '../../../lib/hostApprovalModeStore'
import type { ApprovalMode } from '../../../lib/hostApprovalModeStore'
import { ApprovalModePicker } from '../ApprovalModePicker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const setApprovalMode = vi.fn()

function seed(chatId: string, mode: ApprovalMode, shellClassifierAvailable = true): void {
  noteHostApprovalModeFromSession('agent-x', chatId, {
    approvalMode: mode,
    modeCeiling: 'allow_all',
    channelCap: 'allow_all',
    effectiveApprovalMode: mode,
    shellClassifierAvailable,
  })
}

beforeEach(() => {
  setApprovalMode.mockReset()
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: { rpc: { setApprovalMode, loadSessionMessages: vi.fn() } },
  })
})

afterEach(() => {
  cleanup()
  resetHostApprovalModeStore()
})

describe('ApprovalModePicker — model selector look', () => {
  it('renders one chip with the label once and a caret, like the model selector', () => {
    seed('chat-1', 'allow_all')
    const { container, getByTestId } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )

    const root = container.firstElementChild as HTMLElement
    expect(root.classList.contains('model-selector')).toBe(true)
    expect(root.classList.contains('model-selector--up')).toBe(true)
    const chip = getByTestId('approval-mode-picker')
    expect(chip.classList.contains('model-selector-chip')).toBe(true)
    expect(chip.querySelector('.model-selector-chip-glyph')).not.toBeNull()
    expect(chip.querySelector('.model-selector-chip-caret')).not.toBeNull()
    expect(getByTestId('approval-mode-label').closest('[data-testid="approval-mode-picker"]')).toBe(
      chip
    )
    // The label is drawn once: no second copy outside the chip.
    expect(root.textContent).toBe('Allow all')
  })

  it('shows Manual on the chip with no label test id while the mode is manual', () => {
    seed('chat-1', 'manual')
    const { getByTestId, queryByTestId } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )

    expect(getByTestId('approval-mode-picker').textContent).toBe('Manual')
    expect(queryByTestId('approval-mode-label')).toBeNull()
  })

  it('opens an upward popover with one radio row per mode and a check on the active one', () => {
    seed('chat-1', 'auto')
    const { container, getByTestId } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )

    fireEvent.click(getByTestId('approval-mode-picker'))

    const popover = container.querySelector('.model-selector-popover')
    expect(popover?.getAttribute('role')).toBe('menu')
    const rows = Array.from(popover?.querySelectorAll('[role="menuitemradio"]') ?? [])
    expect(rows.map(row => row.textContent)).toEqual(['Manual', 'Auto-approve', 'Allow all'])
    const auto = getByTestId('approval-mode-option-auto')
    expect(auto.getAttribute('aria-checked')).toBe('true')
    expect(auto.classList.contains('model-selector-item--active')).toBe(true)
    expect(auto.querySelector('.model-selector-item-check')).not.toBeNull()
    const manual = getByTestId('approval-mode-option-manual')
    expect(manual.getAttribute('aria-checked')).toBe('false')
    expect(manual.querySelector('.model-selector-item-check')).toBeNull()
  })

  it('closes the menu on an outside click and on Escape', () => {
    seed('chat-1', 'manual')
    const { getByTestId, queryByTestId } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )

    fireEvent.click(getByTestId('approval-mode-picker'))
    expect(queryByTestId('approval-mode-option-manual')).not.toBeNull()
    fireEvent.mouseDown(document.body)
    expect(queryByTestId('approval-mode-option-manual')).toBeNull()

    fireEvent.click(getByTestId('approval-mode-picker'))
    expect(queryByTestId('approval-mode-option-manual')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(queryByTestId('approval-mode-option-manual')).toBeNull()
  })

  it('confirms Allow all inside the popover as a named dialog', () => {
    seed('chat-1', 'manual')
    const { container, getByTestId, getByRole } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )

    fireEvent.click(getByTestId('approval-mode-picker'))
    fireEvent.click(getByTestId('approval-mode-option-allow-all'))

    const dialog = getByRole('dialog', { name: 'Confirm allow all' })
    expect(dialog.classList.contains('model-selector-popover')).toBe(true)
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(dialog.contains(getByTestId('approval-mode-confirm-allow-all'))).toBe(true)
    expect(dialog.contains(getByTestId('approval-mode-cancel-allow-all'))).toBe(true)
    expect(setApprovalMode).not.toHaveBeenCalled()
  })

  it('describes the Allow all dialog with what Allow all does', () => {
    seed('chat-1', 'manual')
    const { getByTestId, getByRole } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )

    fireEvent.click(getByTestId('approval-mode-picker'))
    fireEvent.click(getByTestId('approval-mode-option-allow-all'))

    // Cancel takes focus on open, so the text is only read out as the
    // dialog's description.
    const dialog = getByRole('dialog', { name: 'Confirm allow all' })
    const descriptionId = dialog.getAttribute('aria-describedby')
    expect(descriptionId).toBeTruthy()
    const description = document.getElementById(descriptionId as string)
    expect(description?.textContent).toBe(
      'Allow all runs tools in this chat without asking, except scheduled tasks. Continue?'
    )
    expect(dialog.contains(description)).toBe(true)
  })

  it('does not confirm Allow all on the second click of a double-click on its row', async () => {
    setApprovalMode.mockResolvedValue({
      approvalMode: 'allow_all',
      modeCeiling: 'allow_all',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'allow_all',
    })
    seed('chat-1', 'manual')
    const { getByTestId } = render(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)

    fireEvent.click(getByTestId('approval-mode-picker'))
    // The confirmation opens where the menu was, with Allow all under the right
    // end of the row. A double-click's second click (detail 2) lands on it.
    fireEvent.click(getByTestId('approval-mode-option-allow-all'), { detail: 1 })
    await act(async () => {
      fireEvent.click(getByTestId('approval-mode-confirm-allow-all'), { detail: 2 })
    })
    expect(setApprovalMode).not.toHaveBeenCalled()
    expect(getByTestId('approval-mode-confirm-allow-all')).not.toBeNull()

    // A single click still confirms.
    await act(async () => {
      fireEvent.click(getByTestId('approval-mode-confirm-allow-all'), { detail: 1 })
    })
    expect(setApprovalMode).toHaveBeenCalledWith('agent-x', 'agent-x', 'chat-1', 'allow_all')
    expect(getByTestId('approval-mode-label').textContent).toBe('Allow all')
  })

  it('keeps the classifier note off the composer row: tooltip, screen-reader text and a warning tint', () => {
    seed('chat-1', 'auto', false)
    const { getByTestId } = render(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)

    const chip = getByTestId('approval-mode-picker')
    const note = getByTestId('approval-mode-classifier-note')
    expect(note.textContent).toBe('shell always asks on this model')
    expect(note.classList.contains('visually-hidden')).toBe(true)
    expect(chip.getAttribute('aria-describedby')).toBe(note.id)
    expect(chip.getAttribute('title')).toBe('Auto-approve: shell always asks on this model')
    expect(chip.classList.contains('ui-pill--warning')).toBe(true)

    fireEvent.click(chip)
    const menuNote = getByTestId('approval-mode-classifier-menu-note')
    expect(menuNote.classList.contains('model-selector-notice')).toBe(true)
    expect(menuNote.textContent).toBe('Shell always asks on this model.')
  })

  it('floats the save error above the chip and clears it when the menu opens', async () => {
    setApprovalMode.mockRejectedValue(new Error('Set approval mode failed (500)'))
    seed('chat-1', 'manual')
    const { getByTestId, queryByTestId } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )

    fireEvent.click(getByTestId('approval-mode-picker'))
    await act(async () => {
      fireEvent.click(getByTestId('approval-mode-option-auto'))
    })

    const error = getByTestId('approval-mode-write-error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.classList.contains('approval-mode-picker-error')).toBe(true)
    expect(setApprovalMode).toHaveBeenCalledWith('agent-x', 'agent-x', 'chat-1', 'auto')

    fireEvent.click(getByTestId('approval-mode-picker'))
    expect(queryByTestId('approval-mode-write-error')).toBeNull()
  })
})

describe('ApprovalModePicker — Host limit', () => {
  type Snapshot = {
    approvalMode: ApprovalMode
    modeCeiling: ApprovalMode
    channelCap: ApprovalMode
    effectiveApprovalMode: ApprovalMode
    shellClassifierAvailable: boolean
  }
  const RANK: Record<ApprovalMode, number> = { manual: 0, auto: 1, allow_all: 2 }
  /** What mcp-host reports for a Desktop chat: the effective mode is the stored one under the ceiling. */
  function hostSnapshot(stored: ApprovalMode, ceiling: ApprovalMode): Snapshot {
    return {
      approvalMode: stored,
      modeCeiling: ceiling,
      channelCap: 'allow_all',
      effectiveApprovalMode: RANK[stored] <= RANK[ceiling] ? stored : ceiling,
      shellClassifierAvailable: true,
    }
  }
  /** The fake Host behind the IPC: a ceiling, and the stored mode of each chat. */
  const fakeHost = { ceiling: 'manual' as ApprovalMode, stored: {} as Record<string, ApprovalMode> }
  const loadSessionMessages = vi.fn()
  const listSessions = vi.fn()

  beforeEach(() => {
    fakeHost.ceiling = 'manual'
    fakeHost.stored = {}
    loadSessionMessages.mockReset()
    loadSessionMessages.mockImplementation(async (_host: string, _agent: string, chatId: string) =>
      hostSnapshot(fakeHost.stored[chatId] ?? 'manual', fakeHost.ceiling)
    )
    listSessions.mockReset()
    listSessions.mockImplementation(async () => ({
      items: Object.keys(fakeHost.stored).map(chatId => ({
        agent: 'agent-x',
        chatId,
        turnCount: 1,
        ...hostSnapshot(fakeHost.stored[chatId] ?? 'manual', fakeHost.ceiling),
      })),
    }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      writable: true,
      value: { rpc: { setApprovalMode, loadSessionMessages, listSessions } },
    })
  })

  /** A chat the Host has answered for, read under the current ceiling. */
  function seedOnHost(chatId: string, stored: ApprovalMode): void {
    fakeHost.stored[chatId] = stored
    noteHostApprovalModeFromSession('agent-x', chatId, hostSnapshot(stored, fakeHost.ceiling))
  }

  async function openMenu(chip: HTMLElement): Promise<void> {
    await act(async () => {
      fireEvent.click(chip)
    })
  }

  it('shows modes above the Host’s limit as not offered, with the limit as their description', async () => {
    seedOnHost('chat-1', 'manual')
    const { getByTestId, queryByTestId } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )
    await openMenu(getByTestId('approval-mode-picker'))

    const note = getByTestId('approval-mode-limit-note')
    expect(note.textContent).toBe('This Host limits this chat to Manual.')
    expect(note.classList.contains('model-selector-notice')).toBe(true)
    expect(getByTestId('approval-mode-option-manual').getAttribute('aria-disabled')).toBeNull()
    for (const testId of ['approval-mode-option-auto', 'approval-mode-option-allow-all']) {
      const row = getByTestId(testId)
      expect(row.getAttribute('role')).toBe('menuitemradio')
      expect(row.getAttribute('aria-disabled')).toBe('true')
      expect(row.getAttribute('aria-describedby')).toBe(note.id)
    }

    fireEvent.click(getByTestId('approval-mode-option-auto'))
    fireEvent.click(getByTestId('approval-mode-option-allow-all'))
    expect(setApprovalMode).not.toHaveBeenCalled()
    expect(queryByTestId('approval-mode-confirm-allow-all')).toBeNull()
    // The menu stays open on a row that is not offered.
    expect(getByTestId('approval-mode-option-manual')).not.toBeNull()
  })

  it('offers every mode while no session of the Host has been read', async () => {
    const { getByTestId, queryByTestId } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="" />
    )
    await openMenu(getByTestId('approval-mode-picker'))

    // The Host has no session to read the ceiling from.
    expect(listSessions).toHaveBeenCalledWith('agent-x', undefined, { agent: 'agent-x', limit: 1 })
    for (const testId of [
      'approval-mode-option-manual',
      'approval-mode-option-auto',
      'approval-mode-option-allow-all',
    ]) {
      expect(getByTestId(testId).getAttribute('aria-disabled')).toBeNull()
    }
    expect(queryByTestId('approval-mode-limit-note')).toBeNull()

    fireEvent.click(getByTestId('approval-mode-option-allow-all'))
    await act(async () => {
      fireEvent.click(getByTestId('approval-mode-confirm-allow-all'))
    })
    expect(getByTestId('approval-mode-picker').textContent).toBe('Allow all')
  })

  it('re-reads the ceiling as a blank chat’s menu opens, and offers the modes a raised ceiling allows', async () => {
    seedOnHost('chat-1', 'manual')
    const { getByTestId } = render(<ApprovalModePicker agentRef="agent-x" chatId="" />)
    // An admin raises the ceiling; nothing on this Desktop has read it yet.
    fakeHost.ceiling = 'auto'

    await openMenu(getByTestId('approval-mode-picker'))

    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(getByTestId('approval-mode-option-auto').getAttribute('aria-disabled')).toBeNull()
    expect(getByTestId('approval-mode-option-allow-all').getAttribute('aria-disabled')).toBe('true')
    expect(getByTestId('approval-mode-limit-note').textContent).toBe(
      'This Host limits this chat to Auto-approve.'
    )
    await act(async () => {
      fireEvent.click(getByTestId('approval-mode-option-auto'))
    })
    expect(getByTestId('approval-mode-picker').textContent).toBe('Auto-approve')
    expect(setApprovalMode).not.toHaveBeenCalled()
  })

  it('re-reads a chat’s own session as its menu opens, and offers the modes a raised ceiling allows', async () => {
    seedOnHost('chat-1', 'manual')
    const { getByTestId } = render(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)
    fakeHost.ceiling = 'allow_all'

    await openMenu(getByTestId('approval-mode-picker'))

    expect(loadSessionMessages).toHaveBeenCalledWith('agent-x', 'agent-x', 'chat-1', ['agent-x'], {
      limit: 1,
    })
    for (const testId of ['approval-mode-option-auto', 'approval-mode-option-allow-all']) {
      expect(getByTestId(testId).getAttribute('aria-disabled')).toBeNull()
    }
  })

  it('shows what the chat is set to when the Host runs a lower mode', async () => {
    // A chat set to Allow all before the ceiling went down to Manual.
    seedOnHost('chat-1', 'allow_all')
    const { getByTestId } = render(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)
    expect(getByTestId('approval-mode-picker').textContent).toBe('Manual')

    await openMenu(getByTestId('approval-mode-picker'))

    expect(getByTestId('approval-mode-limit-note').textContent).toBe(
      'Set to Allow all; this Host limits this chat to Manual.'
    )
    expect(getByTestId('approval-mode-option-manual').getAttribute('aria-checked')).toBe('true')
    expect(getByTestId('approval-mode-option-allow-all').getAttribute('aria-checked')).toBe('false')
  })

  it('announces a saved pick in a polite live region', async () => {
    fakeHost.ceiling = 'allow_all'
    seedOnHost('chat-1', 'manual')
    setApprovalMode.mockImplementation(
      async (_host: string, _agent: string, chatId: string, mode: ApprovalMode) => {
        fakeHost.stored[chatId] = mode
        const { shellClassifierAvailable: _ignored, ...answer } = hostSnapshot(
          mode,
          fakeHost.ceiling
        )
        return answer
      }
    )
    const { getByTestId } = render(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)
    const status = getByTestId('approval-mode-status')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.textContent).toBe('')

    await openMenu(getByTestId('approval-mode-picker'))
    await act(async () => {
      fireEvent.click(getByTestId('approval-mode-option-auto'))
    })

    expect(status.classList.contains('visually-hidden')).toBe(true)
    expect(status.textContent).toBe('Approval mode set to Auto-approve.')
  })

  it('announces the limit when the Host stores a pick it does not run', async () => {
    fakeHost.ceiling = 'allow_all'
    seedOnHost('chat-1', 'manual')
    const { getByTestId } = render(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)
    await openMenu(getByTestId('approval-mode-picker'))
    // The ceiling went down after the menu opened: the Host stores Auto and runs Manual.
    setApprovalMode.mockResolvedValueOnce({
      approvalMode: 'auto',
      modeCeiling: 'manual',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'manual',
    })
    await act(async () => {
      fireEvent.click(getByTestId('approval-mode-option-auto'))
    })

    expect(getByTestId('approval-mode-picker').textContent).toBe('Manual')
    expect(getByTestId('approval-mode-status').textContent).toBe(
      'Approval mode set to Auto-approve; this Host limits this chat to Manual.'
    )
  })

  it('does not announce a save for a chat that is no longer on screen, and clears the region on a switch', async () => {
    fakeHost.ceiling = 'allow_all'
    seedOnHost('chat-1', 'manual')
    seedOnHost('chat-2', 'manual')
    let answer!: (value: unknown) => void
    setApprovalMode.mockReturnValueOnce(
      new Promise(resolve => {
        answer = resolve
      })
    )
    setApprovalMode.mockResolvedValueOnce({
      approvalMode: 'auto',
      modeCeiling: 'allow_all',
      channelCap: 'allow_all',
      effectiveApprovalMode: 'auto',
    })
    const { getByTestId, rerender } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )
    await openMenu(getByTestId('approval-mode-picker'))
    fireEvent.click(getByTestId('approval-mode-option-auto'))
    rerender(<ApprovalModePicker agentRef="agent-x" chatId="chat-2" />)

    await act(async () => {
      answer({
        approvalMode: 'auto',
        modeCeiling: 'allow_all',
        channelCap: 'allow_all',
        effectiveApprovalMode: 'auto',
      })
    })
    expect(getByTestId('approval-mode-status').textContent).toBe('')

    // A save on the chat on screen is announced; switching away clears it.
    await openMenu(getByTestId('approval-mode-picker'))
    await act(async () => {
      fireEvent.click(getByTestId('approval-mode-option-auto'))
    })
    expect(getByTestId('approval-mode-status').textContent).toBe(
      'Approval mode set to Auto-approve.'
    )
    rerender(<ApprovalModePicker agentRef="agent-x" chatId="chat-1" />)
    expect(getByTestId('approval-mode-status').textContent).toBe('')
  })
})

describe('ApprovalModePicker — one save in flight', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }

  it('keeps the chip busy while a save is in flight, so a second pick cannot start', async () => {
    const save = deferred<unknown>()
    setApprovalMode.mockReturnValueOnce(save.promise)
    seed('chat-1', 'manual')
    const { getByTestId, queryByTestId } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )
    fireEvent.click(getByTestId('approval-mode-picker'))
    fireEvent.click(getByTestId('approval-mode-option-auto'))

    const chip = getByTestId('approval-mode-picker')
    expect(chip.getAttribute('aria-busy')).toBe('true')
    expect(chip.getAttribute('aria-disabled')).toBe('true')
    expect(chip.getAttribute('title')).toBe('Saving the approval mode…')
    // The pick handed focus back to the chip; a busy chip keeps it.
    expect(chip.getAttribute('tabindex')).toBe('0')
    expect(document.activeElement).toBe(chip)
    fireEvent.click(chip)
    fireEvent.keyDown(chip, { key: 'Enter' })
    expect(chip.getAttribute('aria-expanded')).toBe('false')
    expect(queryByTestId('approval-mode-option-manual')).toBeNull()
    expect(setApprovalMode).toHaveBeenCalledTimes(1)

    await act(async () => {
      save.resolve({
        approvalMode: 'auto',
        modeCeiling: 'allow_all',
        channelCap: 'allow_all',
        effectiveApprovalMode: 'auto',
      })
    })
    expect(chip.getAttribute('aria-busy')).toBeNull()
    expect(chip.getAttribute('aria-disabled')).toBeNull()
    expect(chip.textContent).toBe('Auto-approve')
    fireEvent.click(chip)
    expect(queryByTestId('approval-mode-option-manual')).not.toBeNull()
  })

  it('shows a failed save at once, and not while the next save is in flight', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    setApprovalMode.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    seed('chat-1', 'manual')
    const { getByTestId, queryByTestId } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )
    fireEvent.click(getByTestId('approval-mode-picker'))
    fireEvent.click(getByTestId('approval-mode-option-auto'))
    // A click while the save is in flight opens nothing.
    fireEvent.click(getByTestId('approval-mode-picker'))

    await act(async () => {
      first.reject(new Error('Set approval mode failed (500)'))
    })
    expect(getByTestId('approval-mode-write-error').textContent).toBe(
      'The approval mode could not be saved.'
    )

    fireEvent.click(getByTestId('approval-mode-picker'))
    expect(queryByTestId('approval-mode-write-error')).toBeNull()
    fireEvent.click(getByTestId('approval-mode-option-manual'))
    expect(setApprovalMode).toHaveBeenCalledTimes(2)
    expect(getByTestId('approval-mode-picker').getAttribute('aria-busy')).toBe('true')
    expect(queryByTestId('approval-mode-write-error')).toBeNull()

    await act(async () => {
      second.resolve({
        approvalMode: 'manual',
        modeCeiling: 'allow_all',
        channelCap: 'allow_all',
        effectiveApprovalMode: 'manual',
      })
    })
    expect(queryByTestId('approval-mode-write-error')).toBeNull()
  })
})

describe('ApprovalModePicker — chat switch', () => {
  // The composer mounts the picker un-keyed, so a chat or tab switch only
  // changes its props. Nothing opened for one chat may act on the next.
  it('drops an open Allow all confirmation when the chat changes', () => {
    seed('chat-1', 'manual')
    seed('chat-2', 'manual')
    const { getByTestId, queryByTestId, rerender } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )
    fireEvent.click(getByTestId('approval-mode-picker'))
    fireEvent.click(getByTestId('approval-mode-option-allow-all'))
    expect(getByTestId('approval-mode-confirm-allow-all')).not.toBeNull()

    rerender(<ApprovalModePicker agentRef="agent-x" chatId="chat-2" />)

    expect(getByTestId('approval-mode-picker').getAttribute('aria-expanded')).toBe('false')
    expect(queryByTestId('approval-mode-confirm-allow-all')).toBeNull()
    expect(queryByTestId('approval-mode-option-manual')).toBeNull()
    expect(setApprovalMode).not.toHaveBeenCalled()
  })

  it('does not carry a save error over to another chat', async () => {
    setApprovalMode.mockRejectedValue(new Error('Set approval mode failed (500)'))
    seed('chat-1', 'manual')
    seed('chat-2', 'manual')
    const { getByTestId, queryByTestId, rerender } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )
    fireEvent.click(getByTestId('approval-mode-picker'))
    await act(async () => {
      fireEvent.click(getByTestId('approval-mode-option-auto'))
    })
    expect(getByTestId('approval-mode-write-error')).not.toBeNull()

    rerender(<ApprovalModePicker agentRef="agent-x" chatId="chat-2" />)

    expect(queryByTestId('approval-mode-write-error')).toBeNull()
  })

  it('does not show a save error from the previous chat that fails after the switch', async () => {
    let rejectWrite!: (error: Error) => void
    setApprovalMode.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectWrite = reject
      })
    )
    seed('chat-1', 'manual')
    seed('chat-2', 'manual')
    const { getByTestId, queryByTestId, rerender } = render(
      <ApprovalModePicker agentRef="agent-x" chatId="chat-1" />
    )
    fireEvent.click(getByTestId('approval-mode-picker'))
    fireEvent.click(getByTestId('approval-mode-option-auto'))
    expect(setApprovalMode).toHaveBeenCalledWith('agent-x', 'agent-x', 'chat-1', 'auto')

    rerender(<ApprovalModePicker agentRef="agent-x" chatId="chat-2" />)
    await act(async () => {
      rejectWrite(new Error('Set approval mode failed (500)'))
    })

    expect(queryByTestId('approval-mode-write-error')).toBeNull()
  })
})
