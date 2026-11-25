import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ToastProvider } from '../../components/Toast'
import {
  emitRootToast,
  __rootToastListenerCountForTests as listenerCount,
  subscribeRootToast,
} from '../rootToast'

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

  it('a manual unsubscribe stops delivery to that listener only', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeRootToast(listener)
    emitRootToast('one')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    emitRootToast('two')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listenerCount()).toBe(0)
  })

  it('a provider subscribes while mounted and unsubscribes on unmount', () => {
    expect(listenerCount()).toBe(0)
    const view = render(<ToastProvider>{null}</ToastProvider>)
    expect(listenerCount()).toBe(1)
    view.unmount()
    expect(listenerCount()).toBe(0)
  })

  it('two providers subscribe twice and both unsubscribe on unmount', () => {
    const view = render(
      <>
        <ToastProvider>{null}</ToastProvider>
        <ToastProvider>{null}</ToastProvider>
      </>
    )
    expect(listenerCount()).toBe(2)
    view.unmount()
    expect(listenerCount()).toBe(0)
  })

  it('a provider under StrictMode ends with one subscription and none after unmount', () => {
    const view = render(
      <React.StrictMode>
        <ToastProvider>{null}</ToastProvider>
      </React.StrictMode>
    )
    expect(listenerCount()).toBe(1)
    view.unmount()
    expect(listenerCount()).toBe(0)
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
