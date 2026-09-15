import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import CommunicationChannelsPage from '../../app/communication-channels/page'
import * as api from '../../lib/api'

const navigation = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push }),
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    apiGet: vi.fn(),
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('CommunicationChannelsPage', () => {
  it('exposes one action for the row detail destination', async () => {
    vi.mocked(api.apiGet).mockResolvedValue({
      items: [
        {
          metadata: { name: 'channel-a', namespace: 'channels' },
          spec: { hostRef: 'agent-a' },
        },
      ],
    })

    render(
      <ToastProvider>
        <CommunicationChannelsPage />
      </ToastProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for channel channel-a' }))

    expect(screen.getAllByRole('menuitem', { name: 'View details' })).toHaveLength(1)
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).not.toBeInTheDocument()
  })
})
