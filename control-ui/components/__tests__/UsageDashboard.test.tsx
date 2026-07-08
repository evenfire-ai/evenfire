import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UsageDashboard } from '../UsageDashboard'

const mockFetchSeries = vi.fn()
const mockFetchTotals = vi.fn()

vi.mock('@lib/api', () => ({
  fetchUsageSeries: (...args: unknown[]) => mockFetchSeries(...args),
  fetchUsageTotals: (...args: unknown[]) => mockFetchTotals(...args),
  getAdminTeams: vi.fn().mockResolvedValue({ items: [] }),
  getAdminUsers: vi.fn().mockResolvedValue({ items: [] }),
}))

vi.mock('recharts', () => ({
  Area: () => null,
  AreaChart: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}))

beforeEach(() => {
  mockFetchSeries.mockReset()
  mockFetchSeries.mockResolvedValue({
    from: '',
    to: '',
    interval: '5min',
    groupBy: 'source_kind',
    rows: [],
  })
  mockFetchTotals.mockReset()
  mockFetchTotals.mockResolvedValue({
    from: '',
    to: '',
    interval: '5min',
    groupBy: 'team_id',
    rows: [],
  })
})

afterEach(() => {
  cleanup()
})

describe('UsageDashboard', () => {
  it('issues an initial fetch with interval=5min for the default 24h range', async () => {
    render(<UsageDashboard />)
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(1))
    const call = mockFetchSeries.mock.calls[0][0]
    expect(call.interval).toBe('5min')
    // No breakdown is the default — the series fetch falls back to a cheap
    // dimension (host_ref) since the API requires one, but the chart sums
    // across it to render plain input/output stacks.
    expect(call.groupBy).toBe('host_ref')
  })

  it('does not call fetchUsageTotals when no breakdown is selected', async () => {
    render(<UsageDashboard />)
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(1))
    expect(mockFetchTotals).not.toHaveBeenCalled()
  })

  it('refetches series with the selected dimension when a breakdown is picked', async () => {
    render(<UsageDashboard />)
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Break down by'), { target: { value: 'recipe_name' } })
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(2))
    expect(mockFetchSeries.mock.calls[1][0].groupBy).toBe('recipe_name')
    expect(mockFetchSeries.mock.calls[1][0].filters).toEqual({
      source_kind: ['workflow'],
    })
    // Totals are fetched only when a breakdown is chosen.
    await waitFor(() => expect(mockFetchTotals).toHaveBeenCalledTimes(1))
    expect(mockFetchTotals.mock.calls[0][0].groupBy).toBe('recipe_name')
    expect(mockFetchTotals.mock.calls[0][0].filters).toEqual({
      source_kind: ['workflow'],
    })
  })

  it('returns to no-breakdown mode when the user re-selects (no breakdown)', async () => {
    render(<UsageDashboard />)
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(1))
    const dropdown = screen.getByLabelText('Break down by') as HTMLSelectElement
    fireEvent.change(dropdown, { target: { value: 'team_id' } })
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(2))
    fireEvent.change(dropdown, { target: { value: '' } })
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(3))
    expect(mockFetchSeries.mock.calls[2][0].groupBy).toBe('host_ref')
    expect(mockFetchSeries.mock.calls[2][0].filters).toBeUndefined()
  })

  it('switches the interval to hour when range=7d is selected', async () => {
    render(<UsageDashboard />)
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Range'), { target: { value: '7d' } })
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(2))
    expect(mockFetchSeries.mock.calls[1][0].interval).toBe('hour')
  })

  it('refetches totals with the new dimension when the user picks one then switches', async () => {
    render(<UsageDashboard />)
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(1))
    expect(mockFetchTotals).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Break down by'), { target: { value: 'team_id' } })
    await waitFor(() => expect(mockFetchTotals).toHaveBeenCalledTimes(1))
    expect(mockFetchTotals.mock.calls[0][0].groupBy).toBe('team_id')
    fireEvent.change(screen.getByLabelText('Break down by'), { target: { value: 'recipe_name' } })
    await waitFor(() => expect(mockFetchTotals).toHaveBeenCalledTimes(2))
    expect(mockFetchTotals.mock.calls[1][0].groupBy).toBe('recipe_name')
  })

  it('limits agent breakdown to non-workflow host refs', async () => {
    render(<UsageDashboard />)
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Break down by'), { target: { value: 'host_ref' } })
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(2))
    expect(mockFetchSeries.mock.calls[1][0].groupBy).toBe('host_ref')
    expect(mockFetchSeries.mock.calls[1][0].filters).toEqual({
      source_kind: ['channel', 'desktop', 'cron', 'unknown'],
    })
    expect(mockFetchTotals.mock.calls[0][0].filters).toEqual({
      source_kind: ['channel', 'desktop', 'cron', 'unknown'],
    })
  })

  it('limits user breakdown to desktop usage per attribution spec', async () => {
    render(<UsageDashboard />)
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Break down by'), { target: { value: 'user_id' } })
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(2))
    expect(mockFetchSeries.mock.calls[1][0].groupBy).toBe('user_id')
    expect(mockFetchSeries.mock.calls[1][0].filters).toEqual({
      source_kind: ['desktop'],
    })
    expect(mockFetchTotals.mock.calls[0][0].groupBy).toBe('user_id')
    expect(mockFetchTotals.mock.calls[0][0].filters).toEqual({
      source_kind: ['desktop'],
    })
  })

  it('renders the (none) label for null group rows once a breakdown is selected', async () => {
    mockFetchTotals.mockResolvedValueOnce({
      from: '',
      to: '',
      interval: '5min',
      groupBy: 'team_id',
      rows: [
        { group: null, input_tokens: 50, output_tokens: 50, total_tokens: 100, request_count: 1 },
      ],
    })
    render(<UsageDashboard />)
    fireEvent.change(screen.getByLabelText('Break down by'), { target: { value: 'team_id' } })
    expect(await screen.findByText('(none)')).toBeTruthy()
  })

  it('renders the control-plane admin usage bucket as a system team label', async () => {
    mockFetchTotals.mockResolvedValueOnce({
      from: '',
      to: '',
      interval: '5min',
      groupBy: 'team_id',
      rows: [
        {
          group: 'control-plane-admin-ui',
          input_tokens: 50,
          output_tokens: 50,
          total_tokens: 100,
          request_count: 1,
        },
      ],
    })
    render(<UsageDashboard />)
    fireEvent.change(screen.getByLabelText('Break down by'), { target: { value: 'team_id' } })
    expect(await screen.findByText('Admin UI / Control Plane')).toBeTruthy()
  })

  it('shows the error banner when an API call rejects', async () => {
    mockFetchSeries.mockRejectedValueOnce(new Error('boom'))
    render(<UsageDashboard />)
    await waitFor(() => {
      expect(screen.queryByText('boom')).toBeTruthy()
    })
  })

  it('renders a refresh button that retriggers fetches', async () => {
    render(<UsageDashboard />)
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => expect(mockFetchSeries).toHaveBeenCalledTimes(2))
  })
})
