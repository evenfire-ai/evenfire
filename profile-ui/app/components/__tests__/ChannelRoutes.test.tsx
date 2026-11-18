import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import ApprovalChannelsPage from '../../approval-channels/page'
import SocialChannelPage from '../../channels/[network]/page'
import ChannelsPage from '../../channels/page'
import ApprovalChannelsSettingsPage from '../../settings/approval-channels/page'

vi.mock('next/navigation', () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`)
  },
  notFound: () => {
    throw new Error('not-found')
  },
}))
vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="auth-gate">{children}</div>
  ),
}))
vi.mock('../../channels/ChannelsContent', () => ({
  ChannelsContent: ({ activeChannel }: { activeChannel: string }) => (
    <div>channel:{activeChannel}</div>
  ),
}))
vi.mock('../../settings/ApprovalChannelsContent', () => ({
  ApprovalChannelsContent: () => <div>Approval preferences</div>,
}))

afterEach(cleanup)

describe('Channel App Router page contracts', () => {
  it('completes the root landing second hop to Telegram', () => {
    expect(() => ChannelsPage()).toThrow('redirect:/channels/telegram')
  })

  it.each(['telegram', 'slack', 'teams'])(
    'gates and renders the %s provider page',
    async network => {
      render(await SocialChannelPage({ params: Promise.resolve({ network }) }))
      expect(screen.getByTestId('auth-gate')).toHaveTextContent(`channel:${network}`)
    }
  )

  it('rejects unknown providers with notFound', async () => {
    await expect(
      SocialChannelPage({ params: Promise.resolve({ network: 'unknown' }) })
    ).rejects.toThrow('not-found')
  })

  it('redirects the legacy approval section to its Settings tab', () => {
    expect(() => ApprovalChannelsPage()).toThrow('redirect:/settings/approval-channels')
  })

  it('gates the approval Settings page', () => {
    render(<ApprovalChannelsSettingsPage />)
    expect(screen.getByTestId('auth-gate')).toHaveTextContent('Approval preferences')
  })
})
