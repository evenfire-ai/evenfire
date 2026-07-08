import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as api from '../../lib/api'
import { GrantedToMe } from '../PublisherView/GrantedToMe'

vi.mock('../../lib/api', () => ({ listGrantedToMe: vi.fn() }))
afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

describe('GrantedToMe', () => {
  it('renders inbound grants read-only (no revoke)', async () => {
    vi.mocked(api.listGrantedToMe).mockResolvedValue({
      grants: [{ pluginName: '@beta/tool', ownerOrg: 'beta', createdAt: '2026-06-01T00:00:00Z' }],
    })
    render(<GrantedToMe />)
    expect(await screen.findByText('@beta/tool')).toBeInTheDocument()
    expect(screen.getByText('beta')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull()
  })

  it('empty state', async () => {
    vi.mocked(api.listGrantedToMe).mockResolvedValue({ grants: [] })
    render(<GrantedToMe />)
    expect(await screen.findByText(/no plugins.*shared with/i)).toBeInTheDocument()
  })

  it('error + Retry', async () => {
    vi.mocked(api.listGrantedToMe)
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))
      .mockResolvedValueOnce({ grants: [] })
    render(<GrantedToMe />)
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }))
    expect(await screen.findByText(/no plugins.*shared with/i)).toBeInTheDocument()
  })
})
