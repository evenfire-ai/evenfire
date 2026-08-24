import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { HostGuardrailsSection } from '../HostGuardrailsSection'
import type { HostGuardrails } from '../HostGuardrailsSection/types'
import { ToastProvider } from '../Toast'

const confirmMock = vi.hoisted(() => vi.fn())
vi.mock('../ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: confirmMock, confirmDialog: null }),
}))

const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push }),
}))

// A hook already attached to the agent, plus fields this section must never
// touch on save.
const GUARDRAILS: HostGuardrails = {
  hooks: { preCall: [{ id: 'hook-token-compactor', digest: 'sha256:aaa' }] },
  builtins: [{ type: 'prompt-shaping', order: 0, failMode: 'open' }],
  limits: { maxHooksPerPhase: 8 },
}

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  confirmMock.mockResolvedValue(true)
})

describe('HostGuardrailsSection', () => {
  it('lists one row per referenced hook and phase', async () => {
    render(
      <HostGuardrailsSection
        busy={false}
        canWrite
        initialGuardrails={GUARDRAILS}
        onSave={vi.fn()}
      />
    )

    expect(await screen.findByText('hook-token-compactor')).toBeInTheDocument()
    expect(screen.getByText('Pre-call')).toBeInTheDocument()
    expect(screen.queryByText(/no guardrail hooks on this agent/i)).toBeNull()
  })

  it('Add hook goes to the org marketplace entries list, filtered to hooks', async () => {
    render(
      <HostGuardrailsSection
        busy={false}
        canWrite
        initialGuardrails={GUARDRAILS}
        onSave={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Add hook' }))

    expect(navigation.push).toHaveBeenCalledWith('/marketplace/org/entries?type=llm-hook')
  })

  it('clicking a hook opens its guardrail detail page', async () => {
    render(
      <HostGuardrailsSection
        busy={false}
        canWrite
        initialGuardrails={GUARDRAILS}
        onSave={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'hook-token-compactor' }))

    expect(navigation.push).toHaveBeenCalledWith('/guardrails/hook-token-compactor')
  })

  it('a hook stays clickable for an operator who cannot write', async () => {
    render(
      <HostGuardrailsSection
        busy={false}
        canWrite={false}
        initialGuardrails={GUARDRAILS}
        onSave={vi.fn()}
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'hook-token-compactor' }))

    expect(navigation.push).toHaveBeenCalledWith('/guardrails/hook-token-compactor')
  })

  it('empty state when the agent references no hooks', async () => {
    render(<HostGuardrailsSection busy={false} canWrite initialGuardrails={{}} onSave={vi.fn()} />)

    expect(await screen.findByText(/no guardrail hooks on this agent yet/i)).toBeInTheDocument()
  })

  it('removing the last hook of a phase drops the phase key rather than leaving it empty', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <HostGuardrailsSection busy={false} canWrite initialGuardrails={GUARDRAILS} onSave={onSave} />
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Remove hook hook-token-compactor from Pre-call',
      })
    )

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const saved = onSave.mock.calls[0][0] as HostGuardrails
    expect(saved.hooks).toEqual({})
    expect(saved.builtins).toEqual(GUARDRAILS.builtins)
    expect(saved.limits).toEqual(GUARDRAILS.limits)
  })

  it('a declined confirm leaves the hook in place', async () => {
    confirmMock.mockResolvedValue(false)
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(
      <HostGuardrailsSection busy={false} canWrite initialGuardrails={GUARDRAILS} onSave={onSave} />
    )

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Remove hook hook-token-compactor from Pre-call',
      })
    )

    await waitFor(() => expect(confirmMock).toHaveBeenCalled())
    expect(onSave).not.toHaveBeenCalled()
  })

  it('offers no write controls when the operator cannot write', async () => {
    render(
      <HostGuardrailsSection
        busy={false}
        canWrite={false}
        initialGuardrails={GUARDRAILS}
        onSave={vi.fn()}
      />
    )

    expect(await screen.findByText('hook-token-compactor')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add hook' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Remove hook/ })).toBeNull()
  })

  it('no longer exposes built-in guardrail editing', async () => {
    render(
      <HostGuardrailsSection
        busy={false}
        canWrite
        initialGuardrails={GUARDRAILS}
        onSave={vi.fn()}
      />
    )

    await screen.findByText('hook-token-compactor')
    expect(screen.queryByText(/built-in/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})
