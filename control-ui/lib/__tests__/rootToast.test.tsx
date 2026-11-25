import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ToastProvider } from '../../components/Toast'
import { emitRootToast, subscribeRootToast } from '../rootToast'

afterEach(() => {
  cleanup()
})

describe('root toast bridge', () => {
  it('a root toast emitted outside React shows in the mounted ToastProvider', () => {
    render(
      <ToastProvider>
        <div>page</div>
      </ToastProvider>
    )
    act(() => {
      emitRootToast('Saved approvals for agent foo', { tone: 'success' })
    })
    const toast = screen.getByRole('status')
    expect(toast.textContent).toContain('Saved approvals for agent foo')
    expect(toast.className).toContain('cu-toast--success')
  })

  it('after the provider unmounts nothing shows and nothing throws', () => {
    const view = render(
      <ToastProvider>
        <div>page</div>
      </ToastProvider>
    )
    act(() => {
      emitRootToast('first')
    })
    expect(screen.getAllByRole('status')).toHaveLength(1)
    view.unmount()
    expect(() => emitRootToast('second')).not.toThrow()
    expect(screen.queryAllByRole('status')).toHaveLength(0)
  })

  it('unmounting unsubscribes, so no test reset is needed between tests', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeRootToast(listener)
    emitRootToast('one')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    emitRootToast('two')
    expect(listener).toHaveBeenCalledTimes(1)
    // A provider from an earlier test leaves nothing behind: this one shows exactly one toast.
    render(<ToastProvider>{null}</ToastProvider>)
    act(() => {
      emitRootToast('three')
    })
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('every mounted provider shows the toast once', () => {
    render(
      <>
        <ToastProvider>
          <div data-testid="a" />
        </ToastProvider>
        <ToastProvider>
          <div data-testid="b" />
        </ToastProvider>
      </>
    )
    act(() => {
      emitRootToast('hello')
    })
    // One toast per provider, never two inside one provider.
    expect(screen.getAllByRole('status')).toHaveLength(2)
  })
})
