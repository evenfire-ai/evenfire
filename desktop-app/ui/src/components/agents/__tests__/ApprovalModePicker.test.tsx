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
