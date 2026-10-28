import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { type GfsUserHome, type GfsUserHomeInventory, getGfsUserHomes } from '@lib/api'
import GfsUserHomesPage from '../../app/gfs/user-homes/page'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('@lib/api', () => ({ getGfsUserHomes: vi.fn() }))

const userId = '11111111-1111-4111-8111-111111111111'
const retired: GfsUserHome = {
  userId,
  email: null,
  name: null,
  state: 'retired',
  drive: 'main',
  storageUsername: 'former-member',
  path: '/Users/former-member',
  resourceId: 'resource-1',
  conflictCode: null,
  lastError: null,
  attempts: 1,
  lastAttemptAt: null,
  updatedAt: '2026-10-27T00:00:00.000Z',
}
const inventory: GfsUserHomeInventory = {
  items: [retired],
  nextCursor: 'next-page',
  counts: { pending: 3, ready: 5, conflict: 2, retired: 1 },
}

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe('Home folder inventory', () => {
  it('shows whole-table counts and the retained path for a deleted user', async () => {
    vi.mocked(getGfsUserHomes).mockResolvedValue(inventory)
    render(<GfsUserHomesPage />)
    const table = await screen.findByRole('table', { name: 'Home folders' })
    const link = await within(table).findByRole('link', { name: userId })
    expect(link).toHaveAttribute('href', `/users-and-teams/users/${userId}`)
    const row = link.closest('tr')!
    expect(within(row).getByText('/Users/former-member')).toBeVisible()
    expect(within(row).getByText('Deleted user')).toBeVisible()
    expect(within(row).getByText('main')).toBeVisible()
    const counts = screen.getByRole('region', { name: 'Home folder counts' })
    expect(within(counts).getByText('5')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
  })

  it('requests the selected state and resets pagination while retaining full counts', async () => {
    vi.mocked(getGfsUserHomes).mockResolvedValue(inventory)
    render(<GfsUserHomesPage />)
    await screen.findByRole('link', { name: userId })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() =>
      expect(getGfsUserHomes).toHaveBeenCalledWith(
        { state: undefined, cursor: 'next-page' },
        expect.any(AbortSignal)
      )
    )
    fireEvent.change(screen.getByLabelText('Home state'), { target: { value: 'conflict' } })
    await waitFor(() =>
      expect(getGfsUserHomes).toHaveBeenCalledWith(
        { state: 'conflict', cursor: undefined },
        expect.any(AbortSignal)
      )
    )
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    expect(
      within(screen.getByRole('region', { name: 'Home folder counts' })).getByText('5')
    ).toBeVisible()
  })

  it('shows request errors without presenting stale rows and can refresh successfully', async () => {
    vi.mocked(getGfsUserHomes)
      .mockRejectedValueOnce(new Error('Request failed'))
      .mockResolvedValueOnce(inventory)
    render(<GfsUserHomesPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed')
    expect(screen.queryByRole('link', { name: userId })).not.toBeInTheDocument()
    expect(screen.getByRole('table', { name: 'Home folders' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByRole('link', { name: userId })).toBeVisible()
  })
})
