import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ProfileAccessProvider } from '@components/ProfileAccessContext'
import SocialChannelPage from '../../channels/[network]/page'
import ChannelsPage from '../../channels/page'

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  redirect: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
  notFound: vi.fn(),
  usePathname: () => '/channels/telegram',
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

// An OIDC member who is in no team: me.teamId is null.
vi.mock('@components/AuthContext', () => ({
  useAuth: () => ({
    authState: {
      isLoggedIn: true,
      isLoading: false,
      me: {
        id: 'user-teamless-fixture',
        email: 'member@example.test',
        teamId: null,
        teamName: null,
        role: 'member',
      },
    },
  }),
}))

vi.mock('@components/ProfileShell', () => ({
  ProfileShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/Toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

vi.mock('@components/ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), confirmDialog: null }),
}))

vi.mock('@lib/api', () => ({
  apiGet: mocks.apiGet,
  apiSend: vi.fn(),
  getManageableTeams: vi.fn().mockResolvedValue({ items: [] }),
  isSilentApiError: () => false,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.apiGet.mockResolvedValue({ items: [] })
})

afterEach(cleanup)

describe('Channels for a member who is in no team', () => {
  it('sends / to the channels route, which is the page a teamless member lands on', () => {
    ChannelsPage()

    expect(mocks.redirect).toHaveBeenCalledWith('/channels/telegram')
  })

  it('renders the social channels page without an error state when teamId is null', async () => {
    const page = await SocialChannelPage({ params: Promise.resolve({ network: 'telegram' }) })

    render(<ProfileAccessProvider>{page}</ProfileAccessProvider>)

    expect(await screen.findByRole('heading', { name: 'Social channels' })).toBeInTheDocument()
    // Liveness: the page asked the edge for its data and finished loading it.
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.queryByRole('status', { name: /loading social channels/i })).toBeNull()
    )
    expect(document.querySelector('.message--error')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
