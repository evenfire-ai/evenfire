import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TablePanelHeader } from '../TablePanelHeader'

function ComponentTitle() {
  return <span>Component-only title</span>
}

function AgentsIcon() {
  return <svg aria-label="Agents icon" />
}

describe('TablePanelHeader title semantics', () => {
  it('keeps a single component title in the visible title text', () => {
    render(<TablePanelHeader title={<ComponentTitle />} />)

    const title = screen.getByText('Component-only title')
    expect(title.closest('.cu-table-panel__title-text')).not.toBeNull()
    expect(document.querySelector('.cu-table-panel__title-icon')).toBeNull()
  })

  it('still separates an icon from the remaining title text', () => {
    render(
      <TablePanelHeader
        title={
          <>
            <AgentsIcon />
            Agents
          </>
        }
      />
    )

    expect(
      screen.getByLabelText('Agents icon').closest('.cu-table-panel__title-icon')
    ).not.toBeNull()
    expect(screen.getByText('Agents').closest('.cu-table-panel__title-text')).not.toBeNull()
  })
})
