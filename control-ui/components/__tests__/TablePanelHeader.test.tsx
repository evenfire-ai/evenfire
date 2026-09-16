import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TablePanelHeader } from '../TablePanelHeader'

const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8')

function AgentsIcon() {
  return <svg aria-label="Agents icon" />
}

describe('TablePanelHeader', () => {
  it('applies the common action-toolbar layout to every header', () => {
    render(
      <TablePanelHeader
        actionsClassName="custom-toolbar"
        primaryAction={<button type="button">Create agent</button>}
        refreshAction={<button type="button">Refresh agents</button>}
        search={<input aria-label="Search agents" type="search" />}
        secondaryActions={<button type="button">Import agents</button>}
        title="Agents"
      />
    )

    expect(screen.getByRole('button', { name: 'Create agent' }).parentElement).toHaveClass(
      'cu-table-panel__actions',
      'custom-toolbar'
    )
  })

  it('keeps a section icon aligned and separate from the truncatable title text', () => {
    render(
      <TablePanelHeader
        title={
          <>
            <AgentsIcon />
            Agents (8)
          </>
        }
      />
    )

    expect(screen.getByLabelText('Agents icon').parentElement).toHaveClass(
      'cu-table-panel__title-icon'
    )
    expect(screen.getByText('Agents (8)')).toHaveClass('cu-table-panel__title-text')
  })

  it('does not treat an ordinary leading title element as an icon', () => {
    render(<TablePanelHeader title={<span>Agents</span>} />)

    expect(screen.getByText('Agents').closest('.cu-table-panel__title-text')).not.toBeNull()
    expect(document.querySelector('.cu-table-panel__title-icon')).toBeNull()
  })

  it('renders secondary actions, search, refresh, and the primary action in focus order', () => {
    render(
      <TablePanelHeader
        search={<input aria-label="Search agents" type="search" />}
        refreshAction={<button type="button">Refresh agents</button>}
        primaryAction={<button type="button">Create agent</button>}
        secondaryActions={<button type="button">Import agents</button>}
        title="Agents"
      />
    )

    const toolbar = screen.getByRole('button', { name: 'Create agent' }).parentElement
    expect(toolbar).not.toBeNull()
    expect(
      Array.from((toolbar as HTMLElement).querySelectorAll('button, input[type="search"]')).map(
        control => control.getAttribute('aria-label') || control.textContent
      )
    ).toEqual(['Import agents', 'Search agents', 'Refresh agents', 'Create agent'])
    expect(css).not.toMatch(/\.cu-table-panel__actions[^{}]*\{[^}]*\border\s*:/)
    expect(css).toMatch(/\.cu-table-panel__actions\s*\{[^}]*flex-wrap:\s*nowrap/)
    expect(css).toMatch(/\.cu-table-panel__actions\s*\{[^}]*width:\s*auto/)
    expect(css).toMatch(
      /\.cu-table-panel__head\s*>\s*\.eft-data-view-header__main\s*\{[^}]*flex-wrap:\s*nowrap/
    )
    expect(css).toMatch(
      /\.cu-table-panel__head\s+\.eft-data-view-header__actions\s*\{[^}]*flex:\s*0\s+0\s+auto/
    )
    expect(css).toMatch(/\.cu-table-panel__title-text\s*\{[^}]*text-overflow:\s*ellipsis/)
    expect(css).toMatch(/\.cu-table-panel__title-icon\s*\{[^}]*align-items:\s*center/)
    expect(css).toMatch(/\.cu-table-panel__description-value\s*\{[^}]*-webkit-line-clamp:\s*2/)
    expect(css).toMatch(/\.cu-table-panel__description-tooltip\s*\{[^}]*inset-inline:\s*0/)
    expect(css).not.toMatch(
      /\.cu-table-panel__actions\s*>\s*\.cu-section-search\s*\{[^}]*flex:\s*1\s+1\s+100%/
    )
    expect(css).toMatch(/\.cu-table-panel__actions\s*>\s*select\.cu-input\s*\{[^}]*width:\s*auto/)
  })

  it('makes a two-line-clamped description available in a full-width tooltip', () => {
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function () {
        return this.classList.contains('cu-table-panel__description-value') ? 48 : 0
      })
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function () {
        return this.classList.contains('cu-table-panel__description-value') ? 32 : 0
      })

    try {
      render(
        <TablePanelHeader
          subtitle="A longer description that cannot fit within two lines."
          title="Agents"
        />
      )

      const description = document.querySelector('.cu-table-panel__description')
      expect(description).toHaveAttribute('tabindex', '0')
      expect(description).toHaveAttribute('aria-describedby')
      expect(
        document.getElementById(description?.getAttribute('aria-describedby') || '')
      ).toHaveTextContent('A longer description that cannot fit within two lines.')
      expect(document.querySelector('.cu-table-panel__description-tooltip')).toHaveTextContent(
        'A longer description that cannot fit within two lines.'
      )
    } finally {
      scrollHeight.mockRestore()
      clientHeight.mockRestore()
    }
  })
})
