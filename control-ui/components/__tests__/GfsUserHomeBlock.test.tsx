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
  conflictDetail: null,
}

function homeField() {
  return screen.getByRole('region', { name: 'Home folder' })
}

function homeNotFound() {
  return Object.assign(new Error('404 Not Found - home_not_found'), {
    code: 'home_not_found',
    status: 404,
  })
}

function renameDialog() {
  return screen.getByRole('dialog', { name: 'Retry with another name' })
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Home folder field', () => {
  it('silently polls an initially pending home without replacing the field content', async () => {
    const pending = { ...baseHome, state: 'pending' as const }
    let finishPoll!: (value: { home: GfsUserHomeDetail }) => void
    const poll = new Promise<{ home: GfsUserHomeDetail }>(resolve => {
      finishPoll = resolve
    })
    vi.mocked(getGfsUserHome)
      .mockResolvedValueOnce({ home: pending })
      .mockReturnValueOnce(poll)
      .mockResolvedValueOnce({ home: baseHome })
    vi.useFakeTimers()
    await act(async () => {
      render(<GfsUserHomeBlock userId={baseHome.userId} />)
    })

    const field = homeField()
    // One steady status line for the whole polling window, not one per request.
    const line = screen.getByText('Being created…')
    field.scrollTop = 100

    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(getGfsUserHome).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Being created…')).toBe(line)
    expect(field.scrollTop).toBe(100)
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()

    await act(async () => finishPoll({ home: { ...pending } }))
    expect(screen.getByText('Being created…')).toBe(line)
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(screen.getByText('/Users/member')).toBe(line)
    expect(homeField()).toBe(field)
    expect(field.scrollTop).toBe(100)
  })

  it.each([
    ['ready', '/Users/member'],
    ['pending', 'Being created…'],
    ['retired', 'Retired — files kept for operators'],
  ] as const)(
    'shows the %s state as one line, without drive or resource id',
    async (state, line) => {
      vi.mocked(getGfsUserHome).mockResolvedValue({ home: { ...baseHome, state } })
      render(<GfsUserHomeBlock userId={baseHome.userId} />)
      const field = await screen.findByRole('region', { name: 'Home folder' })
      expect(await within(field).findByText(line)).toBeVisible()
      expect(within(field).queryByText('main')).not.toBeInTheDocument()
      expect(within(field).queryByText(/resource-1/)).not.toBeInTheDocument()
      expect(within(field).queryByText(/Drive|Resource ID/)).not.toBeInTheDocument()
      expect(within(field).queryByRole('status')).not.toBeInTheDocument()
    }
  )

  it('shows a member without a home row as not having a home yet, not as an error', async () => {
    vi.mocked(getGfsUserHome)
      .mockRejectedValueOnce(
        Object.assign(new Error('404 Not Found - home_not_found'), {
          code: 'home_not_found',
          status: 404,
        })
      )
      .mockResolvedValueOnce({ home: { ...baseHome, state: 'pending' } })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    expect(await screen.findByText('No home folder yet')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText(/home_not_found/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('Being created…')).toBeVisible()
    expect(getGfsUserHome).toHaveBeenCalledTimes(2)
  })

  it('explains both recovery choices for an unbound path conflict and retries a new name', async () => {
    const conflict: GfsUserHomeDetail = {
      ...baseHome,
      state: 'conflict',
      path: null,
      resourceId: null,
      conflictCode: 'path_conflict',
      conflictDetail: {
        code: 'path_conflict',
        resource: {
          resourceId: 'foreign-id',
          path: '/Users/member',
          kind: 'directory',
          createdAt: '2026-10-27T00:00:00Z',
        },
        access: [],
      },
    }
    vi.mocked(getGfsUserHome).mockResolvedValue({ home: conflict })
    vi.mocked(retryGfsUserHome).mockResolvedValue({
      home: { ...conflict, state: 'pending', conflictCode: null },
    })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    const guidance = await screen.findByRole('region', { name: 'Path conflict recovery' })
    expect(within(guidance).getByText('Another item occupies /Users/member.')).toBeVisible()
    expect(within(guidance).getByText(/rename or move it in EvenDrive.*Retry/i)).toBeVisible()
    expect(within(guidance).getByText(/Retry with another name/)).toBeVisible()
    expect(within(homeField()).getByText('Not created')).toBeVisible()
    // The name is an action parameter edited in a dialog, never inline on the read surface.
    expect(screen.queryByLabelText('Folder name')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry with another name…' }))
    const name = within(renameDialog()).getByLabelText('Folder name')
    expect(name).toHaveValue('member')
    fireEvent.change(name, { target: { value: 'member-new' } })
    fireEvent.click(within(renameDialog()).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Being created…')).toBeVisible()
    expect(retryGfsUserHome).toHaveBeenCalledWith(baseHome.userId, 'member-new')
    expect(screen.queryByRole('dialog', { name: 'Retry with another name' })).toBeNull()
  })

  it('retries an unbound path conflict with its reserved name from the Retry button', async () => {
    const conflict: GfsUserHomeDetail = {
      ...baseHome,
      state: 'conflict',
      path: null,
      resourceId: null,
      conflictCode: 'path_conflict',
      conflictDetail: { code: 'path_conflict', resource: null, access: [] },
    }
    vi.mocked(getGfsUserHome).mockResolvedValue({ home: conflict })
    vi.mocked(retryGfsUserHome).mockResolvedValue({
      home: { ...conflict, state: 'pending', conflictCode: null },
    })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Being created…')).toBeVisible()
    expect(retryGfsUserHome).toHaveBeenCalledWith(baseHome.userId, 'member')
  })

  it('explains a moved bound home and retries without a new name', async () => {
    const conflict: GfsUserHomeDetail = {
      ...baseHome,
      state: 'conflict',
      path: '/Moved/member',
      conflictCode: 'path_conflict',
      conflictDetail: { code: 'path_conflict', resource: null, access: [] },
    }
    vi.mocked(getGfsUserHome).mockResolvedValue({ home: conflict })
    vi.mocked(retryGfsUserHome).mockResolvedValue({
      home: { ...conflict, state: 'pending', conflictCode: null },
    })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)

    const guidance = await screen.findByRole('region', { name: 'Path conflict recovery' })
    expect(within(guidance).getByText('Home moved')).toBeVisible()
    expect(within(guidance).getByText('Current home path: /Moved/member')).toBeVisible()
    expect(within(guidance).getByText('Reserved home path: /Users/member')).toBeVisible()
    expect(
      within(guidance).getByText(/cannot be moved or renamed.*database correction.*cluster access/i)
    ).toBeVisible()
    expect(within(guidance).getByText(/in EvenDrive.*press Retry/i)).toBeVisible()
    expect(screen.getByText('The home is not at its reserved path.')).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Retry with another name…' })
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Folder name')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Being created…')).toBeVisible()
    expect(retryGfsUserHome).toHaveBeenCalledWith(baseHome.userId, undefined)
  })

  it('shows Not available for a moved home without a current path', async () => {
    vi.mocked(getGfsUserHome).mockResolvedValue({
      home: {
        ...baseHome,
        state: 'conflict',
        path: null,
        conflictCode: 'path_conflict',
        conflictDetail: { code: 'path_conflict', resource: null, access: [] },
      },
    })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    const guidance = await screen.findByRole('region', { name: 'Path conflict recovery' })
    expect(within(guidance).getByText('Current home path: Not available')).toBeVisible()
    expect(within(guidance).getByText('Reserved home path: /Users/member')).toBeVisible()
    expect(within(homeField()).getByText('Not available')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('shows bound-home recovery guidance for a 409 retry and accepts a later retry', async () => {
    const conflict: GfsUserHomeDetail = {
      ...baseHome,
      state: 'conflict',
      path: '/Moved/member',
      conflictCode: 'path_conflict',
      conflictDetail: { code: 'path_conflict', resource: null, access: [] },
    }
    vi.mocked(getGfsUserHome).mockResolvedValue({ home: conflict })
    vi.mocked(retryGfsUserHome)
      .mockRejectedValueOnce(
        Object.assign(new Error('409 Conflict - home_not_retryable'), {
          code: 'home_not_retryable',
          status: 409,
        })
      )
      .mockResolvedValueOnce({ home: { ...conflict, state: 'pending', conflictCode: null } })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    const retry = await screen.findByRole('button', { name: 'Retry' })
    fireEvent.click(retry)
    const error = await screen.findByRole('alert')
    expect(error).toHaveTextContent(/This home could not be retried/)
    expect(error).toHaveTextContent(/cannot be moved or renamed.*database correction/i)
    expect(error).toHaveTextContent(/in EvenDrive.*press Retry/i)
    expect(error).not.toHaveTextContent('home_not_retryable')
    expect(screen.getByText('Home moved')).toBeVisible()
    expect(retryGfsUserHome).toHaveBeenCalledWith(baseHome.userId, undefined)
    fireEvent.click(retry)
    expect(await screen.findByText('Being created…')).toBeVisible()
    expect(retryGfsUserHome).toHaveBeenCalledTimes(2)
  })

  it('offers no name control and retries without a name for a bound ancestor conflict', async () => {
    const conflict: GfsUserHomeDetail = {
      ...baseHome,
      state: 'conflict',
      conflictCode: 'ancestor_grant_conflict',
      conflictDetail: { code: 'ancestor_grant_conflict', entries: [] },
    }
    vi.mocked(getGfsUserHome).mockResolvedValue({ home: conflict })
    vi.mocked(retryGfsUserHome).mockResolvedValue({
      home: { ...conflict, state: 'pending', conflictCode: null },
    })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    expect(
      await screen.findByText(
        'An inherited grant or share on the drive root or Users folder exposed home folders.'
      )
    ).toHaveAttribute('role', 'status')
    expect(screen.queryByLabelText('Folder name')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Retry with another name…' })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Being created…')).toBeVisible()
    expect(retryGfsUserHome).toHaveBeenCalledWith(baseHome.userId, undefined)
  })

  it('explains a stale retry of a bound ancestor conflict without the raw code', async () => {
    const conflict: GfsUserHomeDetail = {
      ...baseHome,
      state: 'conflict',
      conflictCode: 'ancestor_grant_conflict',
      conflictDetail: { code: 'ancestor_grant_conflict', entries: [] },
    }
    vi.mocked(getGfsUserHome).mockResolvedValue({ home: conflict })
    vi.mocked(retryGfsUserHome).mockRejectedValueOnce(
      Object.assign(new Error('409 Conflict - home_not_retryable'), {
        code: 'home_not_retryable',
        status: 409,
      })
    )
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    const error = await screen.findByText(/This home changed since the page loaded/)
    expect(error).toHaveTextContent(/Refresh to see its current state/)
    expect(error).not.toHaveTextContent('home_not_retryable')
    expect(error).not.toHaveTextContent(/database correction/i)
    expect(retryGfsUserHome).toHaveBeenCalledWith(baseHome.userId, undefined)
  })

  it('retries an unbound ancestor conflict with its reserved name and no name control', async () => {
    const conflict: GfsUserHomeDetail = {
      ...baseHome,
      state: 'conflict',
      path: null,
      resourceId: null,
      conflictCode: 'ancestor_grant_conflict',
      conflictDetail: { code: 'ancestor_grant_conflict', entries: [] },
    }
    vi.mocked(getGfsUserHome).mockResolvedValue({ home: conflict })
    vi.mocked(retryGfsUserHome).mockResolvedValue({
      home: { ...conflict, state: 'pending', conflictCode: null },
    })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(screen.queryByLabelText('Folder name')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Retry with another name…' })
    ).not.toBeInTheDocument()
    fireEvent.click(retry)
    expect(await screen.findByText('Being created…')).toBeVisible()
    expect(retryGfsUserHome).toHaveBeenCalledWith(baseHome.userId, 'member')
  })

  it('keeps a name validation error in the dialog and then accepts a valid name', async () => {
    const conflict: GfsUserHomeDetail = {
      ...baseHome,
      state: 'conflict',
      path: null,
      resourceId: null,
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
    const guidance = await screen.findByRole('region', { name: 'Path conflict recovery' })
    expect(
      within(guidance).getByText('The item that occupied /Users/member no longer exists.')
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Retry with another name…' }))
    const name = within(renameDialog()).getByLabelText('Folder name')
    fireEvent.change(name, { target: { value: '..' } })
    fireEvent.click(within(renameDialog()).getByRole('button', { name: 'Retry' }))
    expect(await within(renameDialog()).findByText(/Enter a valid folder name/)).toBeVisible()
    expect(within(homeField()).getByText('Not created')).toBeVisible()
    fireEvent.change(name, { target: { value: 'member-new' } })
    fireEvent.click(within(renameDialog()).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Being created…')).toBeVisible()
    expect(retryGfsUserHome).toHaveBeenLastCalledWith(baseHome.userId, 'member-new')
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
    expect(
      screen.getByText('The owner’s access was removed or reduced by an operator.')
    ).toBeVisible()
    expect(screen.getByText('The owner grant is missing.')).toBeVisible()
    expect(
      screen.getByText('Missing permissions: read, write, delete, share, manage_acl.')
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    fireEvent.click(restore)
    expect(await screen.findByText('/Users/member')).toBeVisible()
    expect(restoreGfsUserHomeOwner).toHaveBeenCalledWith(baseHome.userId)
    expect(screen.queryByRole('button', { name: 'Restore owner access' })).not.toBeInTheDocument()
  })

  it('shows the conflicting item and the grants and shares on it, without its resource id', async () => {
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
    expect(within(details).getByText('Conflicting directory: /Users/member')).toBeVisible()
    expect(within(details).queryByText(/foreign-id/)).not.toBeInTheDocument()
    expect(within(details).queryByText(/2026-10-27/)).not.toBeInTheDocument()
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

  it('shows every conflicting ancestor path and the subject and scope of its access', async () => {
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
    expect(within(details).getByText(/^\/Users — Share — team: Platform \(team-1\)/)).toBeVisible()
    expect(within(details).getByText(/^\/ — Grant — user \(user-2\)/)).toBeVisible()
    expect(within(details).queryByText(/ancestor-[12]/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
  })

  it('shows an unavailable path when the server has no cached path', async () => {
    vi.mocked(getGfsUserHome)
      .mockResolvedValueOnce({
        home: {
          ...baseHome,
          state: 'conflict',
          conflictCode: 'path_conflict',
          conflictDetail: {
            code: 'path_conflict',
            resource: {
              resourceId: 'conflict-1',
              path: null,
              kind: 'directory',
              createdAt: '2026-10-27T00:00:00.000Z',
            },
            access: [],
          },
        },
      })
      .mockResolvedValueOnce({
        home: {
          ...baseHome,
          state: 'conflict',
          conflictCode: 'ancestor_grant_conflict',
          conflictDetail: {
            code: 'ancestor_grant_conflict',
            entries: [
              {
                relation: 'grant',
                resourceId: 'ancestor-1',
                path: null,
                subjectType: 'team',
                subjectId: 'team-1',
                subjectLabel: 'Platform',
                permissions: ['read'],
                inherit: true,
              },
            ],
          },
        },
      })
    const first = render(<GfsUserHomeBlock userId={baseHome.userId} />)
    const pathDetails = await screen.findByRole('region', { name: 'Path conflict details' })
    expect(within(pathDetails).getByText('Conflicting directory: path not available')).toBeVisible()
    first.unmount()
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    const ancestorDetails = await screen.findByRole('region', {
      name: 'Ancestor access conflict details',
    })
    expect(within(ancestorDetails).getByText(/^Path not available — Grant — team/)).toBeVisible()
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
    const first = render(<GfsUserHomeBlock userId={baseHome.userId} />)
    expect(
      await screen.findByText('Conflict details are unavailable. Refresh the page to check again.')
    ).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Path conflict details' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
    first.unmount()
    vi.mocked(getGfsUserHome).mockResolvedValueOnce({
      home: {
        ...baseHome,
        state: 'conflict',
        conflictCode: 'path_conflict',
        conflictDetail: { code: 'path_conflict', resource: null, access: [] },
      },
    })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    const details = await screen.findByRole('region', { name: 'Path conflict details' })
    expect(within(details).getByText('The conflicting item no longer exists.')).toBeVisible()
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
    expect(screen.getByText('Being created…')).toBeVisible()
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(screen.getByText('Still pending')).toBeVisible()
    const callsAtDeadline = vi.mocked(getGfsUserHome).mock.calls.length
    expect(callsAtDeadline).toBeGreaterThan(1)
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(getGfsUserHome).toHaveBeenCalledTimes(callsAtDeadline)
    vi.mocked(getGfsUserHome).mockResolvedValueOnce({ home: baseHome })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })))
    expect(screen.getByText('/Users/member')).toBeVisible()
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
    expect(screen.getByText('/Users/member')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('stops polling on unmount', async () => {
    const pending: GfsUserHomeDetail = { ...baseHome, state: 'pending' }
    vi.mocked(getGfsUserHome).mockResolvedValue({ home: pending })
    vi.useFakeTimers()
    const view = render(<GfsUserHomeBlock userId={baseHome.userId} />)
    await act(async () => {})

    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    // Witness: the load plus exactly one poll, with the pending line on screen.
    expect(getGfsUserHome).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Being created…')).toBeVisible()

    view.unmount()
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(getGfsUserHome).toHaveBeenCalledTimes(2)
  })

  it('shows the error and Refresh when a poll fails', async () => {
    const pending: GfsUserHomeDetail = { ...baseHome, state: 'pending' }
    vi.mocked(getGfsUserHome)
      .mockResolvedValueOnce({ home: pending })
      .mockRejectedValueOnce(new Error('Could not read the home folder.'))
    vi.useFakeTimers()
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    await act(async () => {})

    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(getGfsUserHome).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read the home folder.')
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled()
  })

  it('starts a new polling window when Refresh finds a pending home', async () => {
    vi.mocked(getGfsUserHome)
      .mockRejectedValueOnce(homeNotFound())
      .mockResolvedValueOnce({ home: { ...baseHome, state: 'pending' } })
      .mockResolvedValueOnce({ home: baseHome })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    await screen.findByText('No home folder yet')
    vi.useFakeTimers()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })))
    expect(screen.getByText('Being created…')).toBeVisible()
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    // Witness: the load, the Refresh and one poll; the poll turned the field ready.
    expect(getGfsUserHome).toHaveBeenCalledTimes(3)
    expect(screen.getByText('/Users/member')).toBeVisible()
  })

  it('replaces a stale pending home with no home folder when Refresh finds no row', async () => {
    vi.mocked(getGfsUserHome).mockResolvedValue({ home: { ...baseHome, state: 'pending' } })
    vi.useFakeTimers()
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    await act(async () => {})
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(screen.getByText('Still pending')).toBeVisible()
    vi.mocked(getGfsUserHome).mockRejectedValueOnce(homeNotFound())
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' })))
    expect(within(homeField()).getByText('No home folder yet')).toBeVisible()
    expect(screen.queryByText('Still pending')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows no home folder, not an error, when a poll finds no row', async () => {
    vi.mocked(getGfsUserHome)
      .mockResolvedValueOnce({ home: { ...baseHome, state: 'pending' } })
      .mockRejectedValueOnce(homeNotFound())
    vi.useFakeTimers()
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    await act(async () => {})
    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    expect(getGfsUserHome).toHaveBeenCalledTimes(2)
    expect(within(homeField()).getByText('No home folder yet')).toBeVisible()
    expect(screen.queryByText('Being created…')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('puts the recovery actions right under the cause, before the longer guidance', async () => {
    vi.mocked(getGfsUserHome).mockResolvedValue({
      home: {
        ...baseHome,
        state: 'conflict',
        path: null,
        resourceId: null,
        conflictCode: 'path_conflict',
        conflictDetail: { code: 'path_conflict', resource: null, access: [] },
      },
    })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    const guidance = await screen.findByRole('region', { name: 'Path conflict recovery' })
    const cause = within(homeField()).getByRole('status')
    const retry = screen.getByRole('button', { name: 'Retry' })
    expect(cause.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(retry.compareDocumentPosition(guidance) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('moves focus to the status line when an accepted rename retry removes the opener', async () => {
    const conflict: GfsUserHomeDetail = {
      ...baseHome,
      state: 'conflict',
      path: null,
      resourceId: null,
      conflictCode: 'path_conflict',
      conflictDetail: { code: 'path_conflict', resource: null, access: [] },
    }
    vi.mocked(getGfsUserHome).mockResolvedValue({ home: conflict })
    vi.mocked(retryGfsUserHome).mockResolvedValue({
      home: { ...conflict, state: 'pending', conflictCode: null },
    })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry with another name…' }))
    fireEvent.change(within(renameDialog()).getByLabelText('Folder name'), {
      target: { value: 'member-new' },
    })
    fireEvent.click(within(renameDialog()).getByRole('button', { name: 'Retry' }))
    const status = await screen.findByText('Being created…')
    expect(screen.queryByRole('button', { name: 'Retry with another name…' })).toBeNull()
    expect(document.activeElement).toBe(status)
  })

  it('shows the load error and a Refresh that recovers', async () => {
    vi.mocked(getGfsUserHome)
      .mockRejectedValueOnce(new Error('Could not read the home folder.'))
      .mockResolvedValueOnce({ home: baseHome })
    render(<GfsUserHomeBlock userId={baseHome.userId} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read the home folder.')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('/Users/member')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
