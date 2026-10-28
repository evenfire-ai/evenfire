// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { installAntdDomEnvironment } from '../../../test/antdDomEnvironment'
import { AgentTitleSelector } from '../AgentTitleSelector'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('AgentTitleSelector nested Ant Design menu', () => {
  it('keeps route actions available after the host window resizes', async () => {
    installAntdDomEnvironment()
    const onSelectAgent = vi.fn()
    const onOpenRoute = vi.fn()
    render(
      <AgentTitleSelector
        ariaLabel="Switch chat agent"
        emptyLabel="No agents"
        options={[
          { id: 'alpha', label: 'Alpha' },
          { id: 'beta', label: 'Beta' },
        ]}
        selectedId="alpha"
        selectedLabel="Alpha"
        onSelectAgent={onSelectAgent}
        onOpenRoute={onOpenRoute}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Switch chat agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open Beta sections' }))
    fireEvent(window, new Event('resize'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Connectors' }))

    expect(onOpenRoute).toHaveBeenCalledWith('beta', 'mcp-servers')
    expect(onSelectAgent).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Switch chat agent' }).getAttribute('aria-expanded')
      ).toBe('false')
    })
  })
})
