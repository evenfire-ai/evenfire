import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { HostAdvancedTab } from '../HostAdvancedTab'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('../HostEnvTable', () => ({ HostEnvTable: () => <div>Environment variables</div> }))
vi.mock('../HostGuardrailsSection', () => ({ HostGuardrailsSection: () => <div>Hooks</div> }))

function renderHeaderMode(initialLoading = false) {
  function HeaderMode() {
    const [actions, setActions] = React.useState<React.ReactNode>(null)
    return (
      <>
        <div aria-label="Header actions">{actions}</div>
        <HostAdvancedTab
          busy={false}
          hostName="foo"
          initialGuardrails={undefined}
          initialLoading={initialLoading}
          onActionsChange={setActions}
          onSaveGuardrails={vi.fn()}
        />
      </>
    )
  }

  return render(<HeaderMode />)
}

describe('HostAdvancedTab title actions', () => {
  it('registers Add hook only for the loaded Hooks subtab', () => {
    renderHeaderMode()

    expect(screen.getByRole('button', { name: 'Add hook' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Env vars' }))
    expect(screen.queryByRole('button', { name: 'Add hook' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Hooks' }))
    expect(screen.getByRole('button', { name: 'Add hook' })).toBeInTheDocument()
  })

  it('does not register Add hook while hooks are initially loading', () => {
    renderHeaderMode(true)

    expect(screen.queryByRole('button', { name: 'Add hook' })).toBeNull()
    expect(screen.getByRole('status', { name: 'Loading guardrail hooks' })).toBeInTheDocument()
  })
})

describe('HostAdvancedTab sub-tabs', () => {
  it('Advanced shows Hooks, Env vars and the pointer link', () => {
    renderHeaderMode()

    expect(screen.getByRole('tab', { name: 'Hooks' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Env vars' })).toBeInTheDocument()
    expect(screen.getByText(/Per-tool approval moved to the/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Approvals tab' })).toHaveAttribute(
      'href',
      '/agents/foo/approval-settings'
    )
  })

  it('Advanced renders no Per-tool approval sub-tab', () => {
    renderHeaderMode()

    expect(screen.queryByRole('tab', { name: 'Per-tool approval' })).toBeNull()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  })
})
