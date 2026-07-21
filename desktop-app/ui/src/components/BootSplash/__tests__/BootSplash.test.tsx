// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { BOOT_SPLASH_EXIT_MS, BOOT_SPLASH_MIN_DISPLAY_MS } from '@constants/bootSplash'
import { BootSplash } from '..'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BootSplash', () => {
  it('stays visible until the experience is ready, then exits behind an opaque backdrop', async () => {
    vi.useFakeTimers()
    const view = render(<BootSplash loading />)

    expect(screen.getByRole('status').textContent).toContain('Loading session')

    await act(() => vi.advanceTimersByTimeAsync(BOOT_SPLASH_MIN_DISPLAY_MS * 2))
    expect(screen.getByRole('status')).toBeTruthy()
    expect(view.container.querySelector('.boot-overlay--leaving')).toBeNull()

    view.rerender(<BootSplash loading={false} />)
    await act(() => vi.advanceTimersByTimeAsync(BOOT_SPLASH_EXIT_MS - 1))

    const overlay = view.container.querySelector('.boot-overlay')
    expect(overlay).toBeTruthy()
    expect(overlay?.classList.contains('boot-overlay--leaving')).toBe(true)

    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(view.container.querySelector('.boot-overlay')).toBeNull()
  })
})
