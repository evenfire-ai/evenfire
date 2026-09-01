import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TablePanelHeader } from '../TablePanelHeader'

const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8')

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
    expect(css).toMatch(/\.cu-table-panel__actions\s*\{[^}]*flex-wrap:\s*wrap/)
    expect(css).toMatch(/\.cu-table-panel__actions\s*\{[^}]*width:\s*100%/)
    expect(css).toMatch(
      /\.cu-table-panel__head\s*>\s*\.eft-data-view-header__main\s*\{[^}]*flex-wrap:\s*wrap/
    )
    expect(css).toMatch(
      /\.cu-table-panel__head\s+\.eft-data-view-header__actions\s*\{[^}]*flex:\s*1\s+1\s+42rem/
    )
    expect(css).toMatch(
      /@media\s*\(max-width:\s*768px\)[\s\S]*\.cu-table-panel__head\s+\.eft-data-view-header__actions\s*\{[^}]*flex:\s*none/
    )
    expect(css).not.toMatch(
      /\.cu-table-panel__actions\s*>\s*\.cu-section-search\s*\{[^}]*flex:\s*1\s+1\s+100%/
    )
    const narrowLayoutStart = css.lastIndexOf('@media (max-width: 768px)')
    const narrowSearchStart = css.indexOf(
      '.cu-table-panel__actions > .cu-section-search {',
      narrowLayoutStart
    )
    expect(narrowSearchStart).toBeGreaterThan(narrowLayoutStart)
    const narrowSearchBlock = css.slice(narrowSearchStart, css.indexOf('}', narrowSearchStart) + 1)
    expect(narrowSearchBlock).toMatch(/flex:\s*0\s+1\s+13rem/)
    expect(narrowSearchBlock).toMatch(/width:\s*min\(13rem,\s*100%\)/)
    expect(css).toMatch(/\.cu-table-panel__actions\s*>\s*select\.cu-input\s*\{[^}]*width:\s*auto/)
  })
})
