// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { GFS_LISTING_GRID_COLUMNS } from '@lib/gfsListingGrid'
import { GfsRecentFilesCard } from '../index'
import type { GfsRecentFileRow } from '../types'

function file(index: number, over: Partial<GfsRecentFileRow> = {}): GfsRecentFileRow {
  const id = `0000000${index % 10}-0000-4000-8000-00000000000${index % 10}`
  return {
    resourceId: `${id}-${index}`,
    gfsUri: `gfs://main/${String(index).padStart(4, '0')}`,
    drive: 'main',
    name: `file-${index}.txt`,
    version: 1,
    bytes: 12,
    lastActivityAt: new Date(Date.UTC(2026, 9, 30, 10, 0, index)).toISOString(),
    ...over,
  }
}

const many = Array.from({ length: 25 }, (_, index) => file(index))

function renderCard(over: Partial<Parameters<typeof GfsRecentFilesCard>[0]> = {}) {
  const onOpen = vi.fn()
  const onRetry = vi.fn()
  const result = render(
    <GfsRecentFilesCard
      failure={null}
      fetching={false}
      files={many}
      loading={false}
      onOpen={onOpen}
      onRetry={onRetry}
      {...over}
    />
  )
  return { ...result, onOpen, onRetry }
}

const rows = () => screen.getAllByRole('button', { name: /^Open / })
const queryRows = () => screen.queryAllByRole('button', { name: /^Open / })

afterEach(() => {
  cleanup()
})

describe('GfsRecentFilesCard paging (D20)', () => {
  it('reveals ten rows at a time and hides the control once everything is shown', () => {
    renderCard()
    expect(rows()).toHaveLength(10)
    expect(rows()[0]?.getAttribute('aria-label')).toBe('Open file-0.txt')

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(rows()).toHaveLength(20)
    expect(rows()[19]?.getAttribute('aria-label')).toBe('Open file-19.txt')

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    // Witness: all 25 rows are on screen, which is why the control is gone.
    expect(rows()).toHaveLength(25)
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('shows no control when the list already fits on the first page', () => {
    renderCard({ files: many.slice(0, 10) })
    // Witness: ten rows rendered, so the absent control is a decision.
    expect(rows()).toHaveLength(10)
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('keeps the revealed count across a refetch that reorders the list', () => {
    const { rerender, onOpen } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(rows()).toHaveLength(20)

    const reordered = [file(24), ...many.slice(0, 24)]
    rerender(
      <GfsRecentFilesCard
        failure={null}
        fetching={false}
        files={reordered}
        loading={false}
        onOpen={onOpen}
        onRetry={vi.fn()}
      />
    )

    expect(rows()).toHaveLength(20)
    // Witness: the new first row is on screen, so the refetch really landed.
    expect(rows()[0]?.getAttribute('aria-label')).toBe('Open file-24.txt')
  })
})

describe('GfsRecentFilesCard row contract (D17)', () => {
  it('reuses the listing grid, its columns, and its row behaviour', () => {
    const { onOpen } = renderCard({ files: many.slice(0, 2) })
    const region = screen.getByRole('region', { name: 'Recent files' })

    const grids = region.querySelectorAll('.da-grid.da-gfs-drive__grid')
    expect(grids).toHaveLength(1)
    expect((grids[0] as HTMLElement).style.getPropertyValue('--da-grid-cols')).toBe(
      GFS_LISTING_GRID_COLUMNS
    )

    const head = region.querySelector('.da-grid__head')
    expect(head?.textContent).toContain('Name')
    expect(head?.textContent).toContain('Size')
    expect(head?.textContent).toContain('Your activity')

    const [first, second] = rows()
    expect(first?.getAttribute('role')).toBe('button')
    expect(first?.getAttribute('tabindex')).toBe('0')
    expect(first?.className).toContain('da-grid__row--clickable')

    fireEvent.keyDown(first!, { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'file-0.txt' }))
    fireEvent.keyDown(second!, { key: ' ' })
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'file-1.txt' }))
    expect(onOpen).toHaveBeenCalledTimes(2)

    // No actions lane and no row menu (D3-D8).
    expect(within(region).queryByRole('button', { name: /^Share / })).toBeNull()
    expect(within(region).queryByRole('button', { name: /^Download / })).toBeNull()
    expect(within(region).queryByRole('button', { name: /^Rename / })).toBeNull()
    expect(within(region).queryByRole('button', { name: /^Options for / })).toBeNull()
  })

  it('prints the activity time with a machine-readable date and a readable label', () => {
    renderCard({ files: [many[0]!] })
    const region = screen.getByRole('region', { name: 'Recent files' })
    const time = region.querySelector('time')
    expect(time?.getAttribute('datetime')).toBe(many[0]!.lastActivityAt)
    expect(time?.textContent?.length).toBeGreaterThan(0)
  })
})

describe('GfsRecentFilesCard states', () => {
  it('is busy while a refetch runs and idle after it', () => {
    const { rerender, onOpen } = renderCard({ files: [] })
    const region = () => screen.getByRole('region', { name: 'Recent files' })
    expect(region().getAttribute('aria-busy')).toBe('false')

    rerender(
      <GfsRecentFilesCard
        failure={null}
        fetching
        files={[]}
        loading={false}
        onOpen={onOpen}
        onRetry={vi.fn()}
      />
    )
    expect(region().getAttribute('aria-busy')).toBe('true')
  })

  it('shows the loading block while the first request is in flight', () => {
    renderCard({ files: [], loading: true })
    expect(screen.getByRole('status', { name: 'Loading recent files' })).toBeTruthy()
  })

  it('shows the empty state when the user has no activity', () => {
    renderCard({ files: [] })
    expect(screen.getByText('No recent files')).toBeTruthy()
    expect(queryRows()).toHaveLength(0)
  })

  it('shows the shared failure card and retries through it', () => {
    const { onRetry } = renderCard({
      files: [],
      failure: {
        kind: 'failed',
        message: 'boom',
        retryAvailableAt: null,
      },
    })
    // Witness: the rows are absent because the request failed.
    expect(queryRows()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
