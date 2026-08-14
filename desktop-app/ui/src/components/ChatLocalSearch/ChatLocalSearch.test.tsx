// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { chatMessageDomId } from '@lib/chatLocalSearch'
import { ChatLocalSearch } from '.'

describe('ChatLocalSearch', () => {
  const loadSessionMessages = vi.fn()
  const loadMessages = vi.fn()

  beforeEach(() => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { rpc: { loadSessionMessages }, chat: { loadMessages } },
    })
    HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    delete (window as Partial<typeof window>).clerum
  })

  it('navigates and wraps loaded matches without fetching history or mutating chat state', () => {
    const first = document.createElement('article')
    first.id = chatMessageDomId('one')
    document.body.append(first)
    const second = document.createElement('article')
    second.id = chatMessageDomId('two')
    document.body.append(second)
    const onClose = vi.fn()
    const onSearchStateChange = vi.fn()
    render(
      <ChatLocalSearch
        messages={[
          { id: 'one', role: 'user', content: 'Needle once', timestamp: 1 },
          { id: 'two', role: 'assistant', content: 'needle twice needle', timestamp: 2 },
        ]}
        onClose={onClose}
        onSearchStateChange={onSearchStateChange}
      />
    )
    const input = screen.getByRole('textbox', { name: 'Find in current chat' })
    fireEvent.change(input, { target: { value: 'NEEDLE' } })
    expect(screen.getByRole('status').textContent).toBe('1/3')
    expect(onSearchStateChange).toHaveBeenLastCalledWith('NEEDLE', {
      messageId: 'one',
      occurrence: 0,
    })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('status').textContent).toBe('2/3')
    expect(onSearchStateChange).toHaveBeenLastCalledWith('NEEDLE', {
      messageId: 'two',
      occurrence: 0,
    })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('status').textContent).toBe('1/3')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(screen.getByRole('status').textContent).toBe('3/3')
    expect(onSearchStateChange).toHaveBeenLastCalledWith('NEEDLE', {
      messageId: 'two',
      occurrence: 1,
    })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    expect(loadSessionMessages).not.toHaveBeenCalled()
    expect(loadMessages).not.toHaveBeenCalled()
    first.remove()
    second.remove()
  })
})
