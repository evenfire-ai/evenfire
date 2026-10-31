// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
  vi.useRealTimers()
})

describe('GfsRecentFilesCard overview limit', () => {
  it('shows only the five newest rows without a load-more control', () => {
    renderCard()
    expect(rows().map(row => row.getAttribute('aria-label'))).toEqual(
      many.slice(0, 5).map(item => `Open ${item.name}`)
    )
    expect(screen.queryByRole('button', { name: 'Open file-5.txt' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('shows all rows when fewer than five files exist', () => {
    renderCard({ files: many.slice(0, 3) })
    expect(rows()).toHaveLength(3)
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('updates the five visible files when a refetch reorders the list', () => {
    const { rerender, onOpen } = renderCard()
    expect(rows()).toHaveLength(5)

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

    expect(rows()).toHaveLength(5)
    // Witness: the new first row is on screen, so the refetch really landed.
    expect(rows()[0]?.getAttribute('aria-label')).toBe('Open file-24.txt')
  })

  it('reveals five more at a time only in the dedicated view', () => {
    renderCard({ expandable: true, files: many.slice(0, 12) })
    expect(rows()).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(rows()).toHaveLength(10)
    expect(document.activeElement).toBe(rows()[5])
    expect(screen.getByRole('status').textContent).toBe('10 recent files shown.')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(rows()).toHaveLength(12)
    expect(document.activeElement).toBe(rows()[10])
    expect(screen.getByRole('status').textContent).toBe('12 recent files shown.')
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('restores the count supplied by the owning tab and reports further expansion', () => {
    const onVisibleCountChange = vi.fn()
    renderCard({ expandable: true, visibleCount: 10, onVisibleCountChange })
    expect(rows()).toHaveLength(10)
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(onVisibleCountChange).toHaveBeenCalledWith(15)
  })

  it('moves focus to the new rows when the owning tab controls the count', () => {
    function ControlledCard() {
      const [count, setCount] = useState(5)
      return (
        <GfsRecentFilesCard
          files={many}
          expandable
          visibleCount={count}
          onVisibleCountChange={setCount}
          failure={null}
          fetching={false}
          loading={false}
          onOpen={vi.fn()}
          onRetry={vi.fn()}
        />
      )
    }
    render(<ControlledCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(rows()).toHaveLength(10)
    expect(document.activeElement).toBe(rows()[5])
  })
})

describe('GfsRecentFilesCard row contract (D17)', () => {
  it('reuses the listing grid and opens rows by keyboard', async () => {
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
    expect(first?.tagName).toBe('BUTTON')
    expect(first?.className).toContain('da-grid__row--clickable')

    const user = userEvent.setup()
    first!.focus()
    await user.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'file-0.txt' }))
    second!.focus()
    await user.keyboard(' ')
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'file-1.txt' }))
    expect(onOpen).toHaveBeenCalledTimes(2)

    // No actions lane and no row menu (D3-D8).
    expect(within(region).queryByRole('button', { name: /^Share / })).toBeNull()
    expect(within(region).queryByRole('button', { name: /^Download / })).toBeNull()
    expect(within(region).queryByRole('button', { name: /^Rename / })).toBeNull()
    expect(within(region).queryByRole('button', { name: /^Options for / })).toBeNull()
  })

  it('shows the local time today and the date and time for another day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 30, 16, 0))
    const today = new Date(2026, 9, 30, 10, 15)
    const yesterday = new Date(2026, 9, 29, 18, 45)
    renderCard({
      files: [
        file(0, { lastActivityAt: today.toISOString() }),
        file(1, { lastActivityAt: yesterday.toISOString() }),
      ],
    })
    const region = screen.getByRole('region', { name: 'Recent files' })
    const times = region.querySelectorAll('time')
    expect(times[0]?.getAttribute('datetime')).toBe(today.toISOString())
    expect(times[0]?.textContent).toBe(
      today.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    )
    expect(times[1]?.getAttribute('datetime')).toBe(yesterday.toISOString())
    expect(times[1]?.textContent).toBe(
      yesterday.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
    )
    const row = screen.getByRole('button', { name: 'Open file-0.txt' })
    const descriptionId = row.getAttribute('aria-describedby')
    expect(descriptionId).toBeTruthy()
    expect(document.getElementById(descriptionId!)?.textContent).toContain('Last activity')
    expect(within(row).queryByRole('button')).toBeNull()
  })

  it('adds the date after the local day changes while the view stays open', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 30, 23, 59))
    const activity = new Date(2026, 9, 30, 20, 15)
    renderCard({ files: [file(0, { lastActivityAt: activity.toISOString() })] })
    const time = screen.getByRole('region', { name: 'Recent files' }).querySelector('time')
    expect(time?.textContent).toBe(
      activity.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    )
    act(() => vi.advanceTimersByTime(60_001))
    expect(time?.textContent).toBe(
      activity.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
    )
  })

  it('opens once from either the activity cell or the file name', () => {
    const { onOpen } = renderCard({ files: [many[0]!] })
    const row = screen.getByRole('button', { name: 'Open file-0.txt' })
    const time = row.querySelector('time')
    expect(time).toBeTruthy()
    fireEvent.click(time!)
    expect(onOpen).toHaveBeenCalledTimes(1)
    fireEvent.click(within(row).getByText('file-0.txt'))
    expect(onOpen).toHaveBeenCalledTimes(2)
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

  it('keeps authorized rows visible when a refresh fails', () => {
    const { onRetry } = renderCard({
      files: [many[0]!],
      failure: { kind: 'failed', message: 'boom', retryAvailableAt: null },
    })
    expect(screen.getByRole('button', { name: 'Open file-0.txt' })).toBeTruthy()
    expect(screen.getByText('Could not refresh your files')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})
