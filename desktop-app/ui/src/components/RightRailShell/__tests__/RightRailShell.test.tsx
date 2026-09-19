// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { RightRailShell } from '..'

afterEach(() => cleanup())

describe('RightRailShell', () => {
  it('renders nothing when no occupant holds the rail', () => {
    const { container } = render(
      <RightRailShell occupant={null} width={420}>
        <div data-testid="occupant" />
      </RightRailShell>
    )
    expect(container.querySelector('.right-rail-shell')).toBeNull()
    expect(container.querySelector('[data-testid="occupant"]')).toBeNull()
  })

  it('hosts exactly the single named occupant and publishes the rail width', () => {
    const { container } = render(
      <RightRailShell occupant="chat-drawer" width={512}>
        <div data-testid="occupant">chat</div>
      </RightRailShell>
    )
    const rail = container.querySelector('.right-rail-shell') as HTMLElement
    expect(rail).not.toBeNull()
    // Single-occupancy: exactly one occupant is named, and it is the only child.
    expect(rail.getAttribute('data-occupant')).toBe('chat-drawer')
    expect(rail.children.length).toBe(1)
    expect(rail.querySelector('[data-testid="occupant"]')).not.toBeNull()
    expect(rail.style.getPropertyValue('--rail-width')).toBe('512px')
  })

  it('publishes the measured rail top when given one', () => {
    const { container } = render(
      <RightRailShell occupant="chat-drawer" width={420} top={140}>
        <div />
      </RightRailShell>
    )
    const rail = container.querySelector('.right-rail-shell') as HTMLElement
    expect(rail.style.getPropertyValue('--rail-top')).toBe('140px')
  })

  it('omits the rail top (CSS fallback) when top is null — no embed to align to', () => {
    const { container } = render(
      <RightRailShell occupant="chat-drawer" width={420} top={null}>
        <div />
      </RightRailShell>
    )
    const rail = container.querySelector('.right-rail-shell') as HTMLElement
    expect(rail.style.getPropertyValue('--rail-top')).toBe('')
  })

  it('publishes a rail top of 0 (a legitimate measured top, not "unmeasured")', () => {
    const { container } = render(
      <RightRailShell occupant="chat-drawer" width={420} top={0}>
        <div />
      </RightRailShell>
    )
    const rail = container.querySelector('.right-rail-shell') as HTMLElement
    expect(rail.style.getPropertyValue('--rail-top')).toBe('0px')
  })
})
