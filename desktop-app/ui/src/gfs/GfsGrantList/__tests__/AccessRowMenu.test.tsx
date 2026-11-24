// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AccessRowMenu } from '../AccessRowMenu'

const rect = (left: number, top: number, width: number, height: number) =>
  ({
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => undefined,
  }) as DOMRect

describe('AccessRowMenu', () => {
  afterEach(() => cleanup())

  it('mounts at document.body by default', async () => {
    render(<AccessRowMenu label="chatllm" onRemove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Actions for chatllm' }))
    const menu = await screen.findByRole('menu', { name: 'Actions for chatllm' })
    expect(menu.parentElement).toBe(document.body)
  })

  it('mounts in the given container, keeping outside-click, Escape and Remove', async () => {
    const onRemove = vi.fn()
    const container = document.createElement('section')
    document.body.append(container)
    try {
      render(<AccessRowMenu label="chatllm" onRemove={onRemove} portalContainer={container} />)
      const trigger = screen.getByRole('button', { name: 'Actions for chatllm' })

      fireEvent.click(trigger)
      const menu = await screen.findByRole('menu', { name: 'Actions for chatllm' })
      expect(menu.parentElement).toBe(container)
      fireEvent.mouseDown(menu)
      expect(screen.queryByRole('menu')).not.toBeNull()

      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
      expect(document.activeElement).toBe(trigger)

      fireEvent.click(trigger)
      await screen.findByRole('menu')
      fireEvent.mouseDown(container)
      expect(screen.queryByRole('menu')).toBeNull()

      fireEvent.click(trigger)
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove access' }))
      expect(onRemove).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      container.remove()
    }
  })

  it('places a container menu in viewport terms when its fixed containing block is offset', async () => {
    // A scrolled, backdrop-filtered modal: fixed descendants are drawn relative
    // to its scrolled content box, not the viewport.
    const origin = { left: 30, top: -150 }
    const container = document.createElement('section')
    document.body.append(container)
    const geometry = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute('role') === 'menu') {
          return rect(
            (parseFloat(this.style.left) || 0) + origin.left,
            (parseFloat(this.style.top) || 0) + origin.top,
            184,
            52
          )
        }
        if (this.getAttribute('aria-haspopup') === 'menu') return rect(400, 108, 32, 32)
        return rect(0, 0, 0, 0)
      })
    try {
      render(<AccessRowMenu label="chatllm" onRemove={vi.fn()} portalContainer={container} />)
      fireEvent.click(screen.getByRole('button', { name: 'Actions for chatllm' }))
      const menu = await screen.findByRole('menu', { name: 'Actions for chatllm' })
      // Viewport target: below the trigger (bottom 140 + gap 6), right-aligned
      // with it (right 432 - width 184).
      await waitFor(() => expect(menu.getBoundingClientRect().top).toBe(146))
      expect(menu.getBoundingClientRect().left).toBe(248)

      fireEvent.scroll(window)
      expect(menu.getBoundingClientRect().top).toBe(146)

      origin.top = -200
      fireEvent.scroll(window)
      expect(menu.getBoundingClientRect().top).toBe(146)
      expect(menu.getBoundingClientRect().left).toBe(248)
    } finally {
      geometry.mockRestore()
      container.remove()
    }
  })
})
