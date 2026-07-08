import type React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import CreateSharedFileSystemPage from '../../app/shared-filesystems/new/page'
import { createSharedFileSystem } from '../../lib/api'
import { ToastProvider } from '../Toast'

const mockPush = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
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
    createSharedFileSystem: vi.fn(),
  }
})

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

describe('CreateSharedFileSystemPage', () => {
  beforeEach(() => {
    mockPush.mockClear()
    vi.mocked(createSharedFileSystem).mockResolvedValue({
      metadata: { name: 'team-mission' },
      spec: { size: '10Gi', accessModes: ['ReadWriteOnce'] },
    })
  })

  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('creates a SharedFileSystem from the route form', async () => {
    render(<CreateSharedFileSystemPage />)

    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'team-mission' } })
    fireEvent.change(screen.getByLabelText('Shared filesystem size'), {
      target: { value: '10' },
    })
    fireEvent.change(screen.getByLabelText('Shared filesystem size unit'), {
      target: { value: 'Gi' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.change(screen.getByLabelText('Storage class (optional)'), {
      target: { value: 'fast' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.change(screen.getByLabelText('Directory name'), { target: { value: 'docs' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add folder' }))
    fireEvent.change(screen.getByLabelText('Directory name'), { target: { value: 'data' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(createSharedFileSystem).toHaveBeenCalledWith({
        name: 'team-mission',
        size: '10Gi',
        accessModes: ['ReadWriteOnce'],
        storageClassName: 'fast',
        directories: ['docs', 'data'],
        retainOnDelete: true,
      })
    })
    expect(mockPush).toHaveBeenCalledWith('/shared-filesystems')
  })
})
