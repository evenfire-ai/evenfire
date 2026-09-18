import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { ClampedDescription } from '../TablePanelHeader/ClampedDescription'

type ObserverRecord = {
  callback: ResizeObserverCallback
  observe: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

function createObserverMock(records: ObserverRecord[]) {
  return class MockResizeObserver {
    observe = vi.fn()
    disconnect = vi.fn()

    constructor(private readonly callback: ResizeObserverCallback) {
      records.push({
        callback,
        observe: this.observe,
        disconnect: this.disconnect,
      })
    }
  }
}

describe('ClampedDescription measurement lifecycle', () => {
  it('keeps the resize observer when child identity changes but text does not', () => {
    const observers: ObserverRecord[] = []
    vi.stubGlobal('ResizeObserver', createObserverMock(observers))
    const { rerender, unmount } = render(
      <ClampedDescription>
        <span>Stable description</span>
      </ClampedDescription>
    )

    try {
      expect(observers).toHaveLength(1)
      rerender(
        <ClampedDescription>
          <em>Stable description</em>
        </ClampedDescription>
      )
      expect(observers).toHaveLength(1)
      expect(observers[0].disconnect).not.toHaveBeenCalled()
    } finally {
      unmount()
      vi.unstubAllGlobals()
    }
  })

  it('still responds to resize and changed description text', () => {
    const observers: ObserverRecord[] = []
    let truncated = false
    vi.stubGlobal('ResizeObserver', createObserverMock(observers))
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function () {
        return this.classList.contains('cu-table-panel__description-value') && truncated ? 48 : 32
      })
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function () {
        return this.classList.contains('cu-table-panel__description-value') ? 32 : 0
      })
    const { rerender, unmount } = render(<ClampedDescription>First description</ClampedDescription>)

    try {
      const description = document.querySelector('.cu-table-panel__description')
      expect(description).not.toHaveAttribute('aria-describedby')

      truncated = true
      act(() => observers[0].callback([], {} as ResizeObserver))

      const descriptionId = description?.getAttribute('aria-describedby')
      expect(descriptionId).not.toBeNull()
      expect(document.getElementById(descriptionId || '')).toHaveTextContent('First description')

      rerender(<ClampedDescription>Replacement description</ClampedDescription>)
      const replacementId = description?.getAttribute('aria-describedby')
      expect(document.getElementById(replacementId || '')).toHaveTextContent(
        'Replacement description'
      )
    } finally {
      scrollHeight.mockRestore()
      clientHeight.mockRestore()
      unmount()
      vi.unstubAllGlobals()
    }
  })
})
