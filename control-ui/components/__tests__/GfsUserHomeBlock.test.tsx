import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { GfsUserHomeDetail } from '@lib/api'
import { getGfsUserHome, restoreGfsUserHomeOwner, retryGfsUserHome } from '@lib/api'
import { GfsUserHomeBlock } from '../GfsUserHomeBlock'

vi.mock('@lib/api', () => ({
  getGfsUserHome: vi.fn(),
  restoreGfsUserHomeOwner: vi.fn(),
  retryGfsUserHome: vi.fn(),
}))

const baseHome: GfsUserHomeDetail = {
  userId: '11111111-1111-4111-8111-111111111111',
  email: 'member@example.test',
  name: 'Member',
  state: 'ready',
  drive: 'main',
  storageUsername: 'member',
  path: '/Users/member',
  resourceId: 'resource-1',
  conflictCode: null,
  lastError: null,
  attempts: 1,
  lastAttemptAt: null,
  updatedAt: '2026-10-27T00:00:00.000Z',
  driveMismatch: false,
  conflictDetail: null,
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Home folder block', () => {
  it.each(['ready', 'pending', 'retired'] as const)(
    'renders the %s state with the server path and drive',
    async state => {
      vi.mocked(getGfsUserHome).mockResolvedValue({
        home: { ...baseHome, state, drive: 'archive', path: '/Users/member', driveMismatch: true },
      })
      render(<GfsUserHomeBlock userId={baseHome.userId} />)
      const region = await screen.findByRole('region', { name: 'Home folder' })
      expect(await within(region).findByText(state, { exact: true })).toBeVisible()
      expect(within(region).getByText('/Users/member')).toBeVisible()
      expect(within(region).getByText('archive')).toBeVisible()
      expect(within(region).getByText('This home is on a different drive.')).toBeVisible()
      expect(within(region).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
      expect(
        within(region).queryByRole('button', { name: 'Restore owner access' })
      ).not.toBeInTheDocument()
    }
  )

  it.each([
    ['path_conflict', 'Another item already exists at the reserved home path.'],
    [
      'ancestor_grant_conflict',
      'An inherited grant or share on the drive root or Users folder exposes home folders.',
    ],
  ] as const)('offers Retry with the reserved name for %s', async (conflictCode, message) => {
    const conflict: GfsUserHomeDetail = {
      ...baseHome,
      state: 'conflict',
      conflictCode,
      conflictDetail:
        conflictCode === 'path_conflict'
          ? { code: 'path_conflict', resource: null, access: [] }
          : { code: 'ancestor_grant_conflict', entries: [] },
    }
    vi.mocked(getGfsUserHome).mockResolvedValue({ home: conflict })
    vi.mocked(retryGfsUserHome).mockResolvedValue({
      home: { ...conflict, state: 'pending', conflictCode: null },
    })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    const name = screen.getByLabelText('Folder name')
    expect(name).toHaveValue('member')
    expect(screen.queryByRole('button', { name: 'Restore owner access' })).not.toBeInTheDocument()
    fireEvent.change(name, { target: { value: 'member-new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('pending', { exact: true })).toBeVisible()
    expect(retryGfsUserHome).toHaveBeenCalledWith(baseHome.userId, 'member-new')
  })

  it('shows a validation error without leaving conflict and then accepts a valid name', async () => {
    const conflict: GfsUserHomeDetail = {
      ...baseHome,
      state: 'conflict',
      conflictCode: 'path_conflict',
      conflictDetail: { code: 'path_conflict', resource: null, access: [] },
    }
    vi.mocked(getGfsUserHome).mockResolvedValue({ home: conflict })
    vi.mocked(retryGfsUserHome)
      .mockRejectedValueOnce(
        Object.assign(new Error('invalid_name'), { code: 'invalid_name', status: 422 })
      )
      .mockResolvedValueOnce({ home: { ...conflict, state: 'pending', conflictCode: null } })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    const name = await screen.findByLabelText('Folder name')
    fireEvent.change(name, { target: { value: '..' } })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText(/Enter a valid folder name/)).toBeVisible()
    expect(screen.getByText('conflict', { exact: true })).toBeVisible()
    fireEvent.change(name, { target: { value: 'member-new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('pending', { exact: true })).toBeVisible()
  })

  it('restores an ownership conflict without offering Retry', async () => {
    vi.mocked(getGfsUserHome).mockResolvedValue({
      home: {
        ...baseHome,
        state: 'conflict',
        conflictCode: 'ownership_conflict',
        conflictDetail: { code: 'ownership_conflict', ownerGrant: null },
      },
    })
    vi.mocked(restoreGfsUserHomeOwner).mockResolvedValue({ home: baseHome })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    const restore = await screen.findByRole('button', { name: 'Restore owner access' })
    expect(screen.getByRole('alert')).toHaveTextContent('The owner’s access was removed or reduced')
    expect(screen.getByText('The owner grant is missing.')).toBeVisible()
    expect(
      screen.getByText('Missing permissions: read, write, delete, share, manage_acl.')
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    fireEvent.click(restore)
    expect(await screen.findByText('ready', { exact: true })).toBeVisible()
    expect(restoreGfsUserHomeOwner).toHaveBeenCalledWith(baseHome.userId)
    expect(screen.queryByRole('button', { name: 'Restore owner access' })).not.toBeInTheDocument()
  })

  it('shows the conflicting resource and the grants and shares on it', async () => {
    vi.mocked(getGfsUserHome).mockResolvedValue({
      home: {
        ...baseHome,
        state: 'conflict',
        conflictCode: 'path_conflict',
        conflictDetail: {
          code: 'path_conflict',
          resource: {
            resourceId: 'foreign-id',
            path: '/Users/member',
            kind: 'directory',
            createdAt: '2026-10-27T00:00:00Z',
          },
          access: [
            {
              relation: 'grant',
              subjectType: 'user',
              subjectId: 'person-id',
              subjectLabel: 'Alice',
              permissions: ['read', 'write'],
              inherit: true,
            },
            {
              relation: 'share',
              subjectType: 'team',
              subjectId: 'team-id',
              subjectLabel: null,
              permissions: ['read'],
              inherit: false,
            },
          ],
        },
      },
    })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    const details = await screen.findByRole('region', { name: 'Path conflict details' })
    expect(within(details).getByText('/Users/member')).toBeVisible()
    expect(within(details).getByText('foreign-id')).toBeVisible()
    expect(within(details).getByText('directory')).toBeVisible()
    expect(within(details).getByText('2026-10-27T00:00:00Z')).toBeVisible()
    expect(
      within(details).getByText(
        /Grant — user: Alice \(person-id\); Permissions: read, write; Includes contents: yes/
      )
    ).toBeVisible()
    expect(
      within(details).getByText(
        /Share — team \(team-id\); Permissions: read; Includes contents: no/
      )
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  it('shows every conflicting ancestor and the subject and scope of its access', async () => {
    vi.mocked(getGfsUserHome).mockResolvedValue({
      home: {
        ...baseHome,
        state: 'conflict',
        conflictCode: 'ancestor_grant_conflict',
        conflictDetail: {
          code: 'ancestor_grant_conflict',
          entries: [
            {
              relation: 'share',
              resourceId: 'ancestor-1',
              path: '/Users',
              subjectType: 'team',
              subjectId: 'team-1',
              subjectLabel: 'Platform',
              permissions: ['read'],
              inherit: true,
            },
            {
              relation: 'grant',
              resourceId: 'ancestor-2',
              path: '/',
              subjectType: 'user',
              subjectId: 'user-2',
              subjectLabel: null,
              permissions: ['read', 'share'],
              inherit: true,
            },
          ],
        },
      },
    })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    const details = await screen.findByRole('region', { name: 'Ancestor access conflict details' })
    expect(within(details).getByText('Path: /Users; resource ID: ancestor-1')).toBeVisible()
    expect(within(details).getByText('Path: /; resource ID: ancestor-2')).toBeVisible()
    expect(within(details).getByText(/Share — team: Platform \(team-1\)/)).toBeVisible()
    expect(within(details).getByText(/Grant — user \(user-2\)/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  it('explains the missing permissions and inheritance in a narrowed owner grant', async () => {
    vi.mocked(getGfsUserHome).mockResolvedValue({
      home: {
        ...baseHome,
        state: 'conflict',
        conflictCode: 'ownership_conflict',
        conflictDetail: {
          code: 'ownership_conflict',
          ownerGrant: { permissions: ['read', 'write'], inherit: false },
        },
      },
    })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    const details = await screen.findByRole('region', { name: 'Owner access conflict details' })
    expect(
      within(details).getByText('Current permissions: read, write. Includes contents: no.')
    ).toBeVisible()
    expect(
      within(details).getByText('Missing permissions: delete, share, manage_acl.')
    ).toBeVisible()
    expect(within(details).getByText('Access does not include the folder contents.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Restore owner access' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('does not invent conflict facts when the detail is missing', async () => {
    vi.mocked(getGfsUserHome).mockResolvedValue({
      home: { ...baseHome, state: 'conflict', conflictCode: 'path_conflict', conflictDetail: null },
    })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    expect(
      await screen.findByText('Conflict details are unavailable. Refresh the page to check again.')
    ).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Path conflict details' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  it('stops polling after 60 seconds, then Refresh reveals a ready home', async () => {
    const conflict: GfsUserHomeDetail = {
      ...baseHome,
      state: 'conflict',
      conflictCode: 'path_conflict',
      conflictDetail: { code: 'path_conflict', resource: null, access: [] },
    }
    const pending: GfsUserHomeDetail = { ...baseHome, state: 'pending', conflictCode: null }
    vi.mocked(getGfsUserHome)
      .mockResolvedValueOnce({ home: conflict })
      .mockResolvedValue({ home: pending })
    vi.mocked(retryGfsUserHome).mockResolvedValue({ home: pending })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    await screen.findByRole('button', { name: 'Retry' })
    vi.useFakeTimers()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
    expect(screen.getByText('pending', { exact: true })).toBeVisible()
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(screen.getByText('Still pending')).toBeVisible()
    const callsAtDeadline = vi.mocked(getGfsUserHome).mock.calls.length
    expect(callsAtDeadline).toBeGreaterThan(1)
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(getGfsUserHome).toHaveBeenCalledTimes(callsAtDeadline)
    vi.mocked(getGfsUserHome).mockResolvedValueOnce({ home: baseHome })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })))
    expect(screen.getByText('ready', { exact: true })).toBeVisible()
    expect(screen.queryByText('Still pending')).not.toBeInTheDocument()
  })

  it('updates from pending to ready during the polling window', async () => {
    const conflict: GfsUserHomeDetail = {
      ...baseHome,
      state: 'conflict',
      conflictCode: 'path_conflict',
      conflictDetail: { code: 'path_conflict', resource: null, access: [] },
    }
    vi.mocked(getGfsUserHome)
      .mockResolvedValueOnce({ home: conflict })
      .mockResolvedValueOnce({ home: baseHome })
    vi.mocked(retryGfsUserHome).mockResolvedValue({ home: { ...baseHome, state: 'pending' } })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    await screen.findByRole('button', { name: 'Retry' })
    vi.useFakeTimers()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(screen.getByText('ready', { exact: true })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })
})
