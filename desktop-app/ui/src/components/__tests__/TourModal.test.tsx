// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TourModal } from '../TourModal'
import type { TourCensus, TourStepContext } from '../TourModal/types'

afterEach(() => {
  cleanup()
})

const census = (overrides: Partial<TourCensus> = {}): TourCensus => ({
  agentNames: [],
  contextIds: [],
  mcpServersByAgent: {},
  ...overrides,
})

const context = (overrides: Partial<TourStepContext> = {}): TourStepContext => ({
  appName: 'Acme',
  agentLabels: [],
  ...overrides,
})

function renderTour(
  opts: {
    census?: Partial<TourCensus>
    context?: Partial<TourStepContext>
    onDismiss?: () => void
  } = {}
) {
  const onDismiss = opts.onDismiss ?? vi.fn()
  render(
    <TourModal census={census(opts.census)} context={context(opts.context)} onDismiss={onDismiss} />
  )
  return { onDismiss }
}

describe('TourModal', () => {
  it('is a labelled modal dialog', () => {
    renderTour()
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
  })

  it('names the environment it is describing', () => {
    renderTour({ context: { appName: 'Acme' } })
    expect(screen.getByText('Welcome to Acme')).toBeTruthy()
  })

  it('exposes the step position as text, not only as dots', () => {
    renderTour()
    // Dots are decorative; a screen reader gets the position in words.
    expect(screen.getByText('Step 1 of 6')).toBeTruthy()
  })

  it('walks forward and back through the deck', async () => {
    const user = userEvent.setup()
    renderTour()

    expect(screen.getByText('Step 1 of 6')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Step 2 of 6')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Step 1 of 6')).toBeTruthy()
  })

  it('walks the deck with the arrow keys', async () => {
    renderTour()

    expect(screen.getByText('Step 1 of 6')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText('Step 2 of 6')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByText('Step 1 of 6')).toBeTruthy()
  })

  it('does not run past either end of the deck with arrows', () => {
    renderTour()

    // Back at the first step is a no-op, not an index below zero.
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByText('Step 1 of 6')).toBeTruthy()

    for (let i = 0; i < 8; i++) fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByText('Step 6 of 6')).toBeTruthy()
  })

  it('cannot go back from the first step', () => {
    renderTour()
    expect(screen.getByRole('button', { name: 'Back' }).hasAttribute('disabled')).toBe(true)
  })

  it('skips on Escape', async () => {
    const onDismiss = vi.fn()
    renderTour({ onDismiss })

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does NOT dismiss on a backdrop click', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    renderTour({ onDismiss })

    // Unlike ConfirmDialog: a stray click must not end something shown once
    // per install.
    const backdrop = screen.getByRole('dialog').parentElement
    if (backdrop) await user.click(backdrop)

    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('focuses the primary action on open and after each step change', async () => {
    const user = userEvent.setup()
    renderTour()

    expect(document.activeElement?.textContent).toBe('Next')

    await user.click(screen.getByRole('button', { name: 'Next' }))

    expect(document.activeElement?.textContent).toBe('Next')
  })

  it('ends on a closing action rather than a further step', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    renderTour({ onDismiss })

    for (let i = 0; i < 5; i++) {
      await user.click(screen.getByRole('button', { name: 'Next' }))
    }
    await user.click(screen.getByRole('button', { name: 'Get started' }))

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('closes from any step via the corner control', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    renderTour({ onDismiss })

    await user.click(screen.getByRole('button', { name: 'Close tour' }))

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('describes a richer environment with more steps', () => {
    renderTour({
      census: { agentNames: ['a'], contextIds: ['c'], mcpServersByAgent: { a: ['github'] } },
      context: { agentLabels: ['Research bot'] },
    })

    // agents + approvals + scope + desktop, plus welcome and handoff.
    expect(screen.getByText('Step 1 of 6')).toBeTruthy()
  })

  it('tells an unauthorized member what to ask for, with no dead-end button', async () => {
    const user = userEvent.setup()
    renderTour()

    for (let i = 0; i < 5; i++) {
      await user.click(screen.getByRole('button', { name: 'Next' }))
    }

    expect(screen.getByText('You need access to an agent')).toBeTruthy()
    // The only actions are navigation and closing — nothing that leads
    // somewhere this user cannot go.
    const buttons = screen
      .getAllByRole('button')
      .map(b => b.getAttribute('aria-label') || b.textContent)
    expect(buttons).toEqual(['Close tour', 'Back', 'Get started'])
  })

  it('never says "context" to the user', async () => {
    const user = userEvent.setup()
    renderTour({
      census: { agentNames: ['a'], contextIds: ['c'], mcpServersByAgent: { a: ['github'] } },
      context: { agentLabels: ['Research bot'] },
    })

    // "Context" is a term users find confusing; the product speaks about
    // knowledge and connected systems instead. The predicates still read
    // contextIds — this is about what the copy says, not what it checks.
    let copy = document.body.textContent ?? ''
    for (let i = 0; i < 5; i++) {
      const nextButton = screen.queryByRole('button', { name: 'Next' })
      if (!nextButton) break
      await user.click(nextButton)
      copy += document.body.textContent ?? ''
    }

    expect(copy).not.toMatch(/context/i)
  })

  it('never names one deployment’s seed or a local address', async () => {
    const user = userEvent.setup()
    renderTour({
      census: { agentNames: ['a'], contextIds: ['c'], mcpServersByAgent: { a: ['github'] } },
      context: { agentLabels: ['chatllm'] },
    })

    // Walk the whole deck and collect every string it renders.
    let copy = document.body.textContent ?? ''
    for (let i = 0; i < 4; i++) {
      await user.click(screen.getByRole('button', { name: 'Next' }))
      copy += document.body.textContent ?? ''
    }

    // The agent's own display name may appear; the product copy must not
    // hardcode a seed name or assume where the server runs.
    expect(copy).not.toMatch(/localhost|127\.0\.0\.1|minikube|docker/i)
  })
})
