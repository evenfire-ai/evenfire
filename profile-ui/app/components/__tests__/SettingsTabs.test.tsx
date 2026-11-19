import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { SettingsTabs } from '../../settings/SettingsTabs'

const access = vi.hoisted(() => ({
  approvalTargets: [] as Array<{ id: string }>,
  approvalTargetsLoading: false,
}))
vi.mock('@components/ProfileAccessContext', () => ({ useProfileAccess: () => access }))
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props}>{children}</a>
  ),
}))
afterEach(cleanup)

describe('Approval settings tab visibility', () => {
  it.each([false, true])('hides the tab without known access (loading=%s)', loading => {
    access.approvalTargets = []
    access.approvalTargetsLoading = loading
    render(<SettingsTabs active="profile" />)
    expect(screen.queryByRole('tab', { name: 'Approval channels' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps the tab during refresh when access was already established', () => {
    access.approvalTargets = [{ id: 'known-target' }]
    access.approvalTargetsLoading = true
    render(<SettingsTabs active="approvalChannels" />)
    expect(screen.getByRole('tab', { name: 'Approval channels' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })
})
