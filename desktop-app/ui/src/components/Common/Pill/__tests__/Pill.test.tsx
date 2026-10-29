// @vitest-environment jsdom
// TASK-172 — the interactive pill elements used across the chat view (model
// selector chip, context-window indicator, …) are `<span role="button">`, so
// the stylesheet must give them a pointer cursor like any other control.
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Pill } from '../index'

const styles = readFileSync(resolve(__dirname, '../../../../styles.css'), 'utf8')

function injectStyles() {
  const style = document.createElement('style')
  style.textContent = styles
  document.head.appendChild(style)
  return style
}

afterEach(() => {
  cleanup()
  document.head.querySelectorAll('style').forEach(style => style.remove())
})

describe('Pill', () => {
  it('shows the pointer cursor on interactive pills', () => {
    injectStyles()
    render(
      <Pill interactive onClick={() => undefined}>
        glm-5.3-flash
      </Pill>
    )

    const pill = screen.getByRole('button', { name: 'glm-5.3-flash' })
    expect(pill.className).toContain('ui-pill--interactive')
    expect(getComputedStyle(pill).cursor).toBe('pointer')
  })

  it('keeps static pills cursor-neutral and non-button semantics', () => {
    injectStyles()
    render(<Pill tone="success">Running</Pill>)

    const pill = screen.getByText('Running')
    expect(pill.className).not.toContain('ui-pill--interactive')
    expect(pill.getAttribute('role')).toBeNull()
    expect(getComputedStyle(pill).cursor).not.toBe('pointer')
  })
})
