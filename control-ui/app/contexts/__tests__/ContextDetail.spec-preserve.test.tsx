import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { ToastProvider } from '../../../components/Toast'
import * as api from '../../../lib/api'
import ContextDetailsPage from '../[name]/page'

const replaceMock = vi.fn()
const pushMock = vi.fn()
let mockParams: { name: string; tab?: string } = { name: 'prod-ctx' }

vi.mock('next/navigation', () => ({
  useParams: () => mockParams,
  usePathname: () => '/contexts/prod-ctx',
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(),
}))

// Render the frame as a passthrough so the form is the unit under test.
vi.mock('../../../components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../../lib/api', () => ({
  apiSend: vi.fn().mockResolvedValue({}),
  createContext: vi.fn().mockResolvedValue({}),
  deleteContext: vi.fn().mockResolvedValue({}),
  getAdminTeamContexts: vi.fn().mockResolvedValue({ contextIds: [] }),
  getAdminTeams: vi.fn().mockResolvedValue({ items: [] }),
  getAdminUserContexts: vi.fn().mockResolvedValue({ contextIds: [] }),
  getAdminUsers: vi.fn().mockResolvedValue({ items: [] }),
  getContext: vi.fn(),
  getContextTeams: vi.fn().mockResolvedValue({ items: [] }),
  getContextUsers: vi.fn().mockResolvedValue({ items: [] }),
  getHosts: vi.fn().mockResolvedValue({ items: [] }),
  getMcpServers: vi.fn().mockResolvedValue({ items: [] }),
  getSharedFileSystems: vi.fn().mockResolvedValue({ items: [] }),
  updateAdminTeamContexts: vi.fn().mockResolvedValue({}),
  updateAdminUserContexts: vi.fn().mockResolvedValue({}),
  updateContext: vi.fn().mockResolvedValue({}),
}))

type TestContext = {
  metadata: { name: string }
  spec: Record<string, unknown>
}

function mockContext(ctx: TestContext) {
  ;(api.getContext as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ctx)
}

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

async function openEditModal() {
  fireEvent.click(await screen.findByRole('button', { name: 'Context actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit context' }))
}

function lastPutSpec(): Record<string, unknown> {
  const calls = (api.updateContext as unknown as ReturnType<typeof vi.fn>).mock.calls
  const [, payload] = calls[calls.length - 1] as [string, { spec: Record<string, unknown> }]
  return payload.spec
}

afterEach(() => {
  cleanup()
})

describe('ContextDetailsPage spec preservation on update (R5-M2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockParams = { name: 'prod-ctx' }
  })

  it('(a) preserves a spec field the form does not model on a display-only rename', async () => {
    // spec.gfs is a real additive field of the context CRD that this form has no
    // input for. A full-replace PUT built only from form state would drop it.
    const gfs = {
      mounts: [{ drive: 'main', target: '/data/shared', scopes: ['gfs.read'] }],
    }
    mockContext({
      metadata: { name: 'prod-ctx' },
      spec: {
        contextId: 'prod-ctx',
        description: 'Original description',
        mcpServers: ['srv-a'],
        displayName: 'Prod Ctx',
        gfs,
      },
    })

    render(<ContextDetailsPage />)
    await screen.findByText('Prod Ctx')
    await openEditModal()

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Prod Ctx 2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.updateContext).toHaveBeenCalled())
    const spec = lastPutSpec()
    // The unknown-to-the-form field survives the rename.
    expect(spec.gfs).toEqual(gfs)
    // And the field the user actually changed is applied.
    expect(spec.displayName).toBe('Prod Ctx 2')
    expect(spec.contextId).toBe('prod-ctx')
  })

  it('(b) removes displayName from the PUT body when the user clears it', async () => {
    mockContext({
      metadata: { name: 'prod-ctx' },
      spec: {
        contextId: 'prod-ctx',
        description: 'Original description',
        mcpServers: ['srv-a'],
        displayName: 'Prod Ctx',
      },
    })

    render(<ContextDetailsPage />)
    await screen.findByText('Prod Ctx')
    await openEditModal()

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.updateContext).toHaveBeenCalled())
    const spec = lastPutSpec()
    // Cleared display name must be absent, not the stale value from the spread.
    expect('displayName' in spec).toBe(false)
    expect(spec.contextId).toBe('prod-ctx')
  })

  it('(c) still reflects edited description and preserves the loaded mcpServers/sharedFileSystems', async () => {
    const sharedFileSystems = [{ name: 'sfs-a', mountPath: '/workspace/sfs-a' }]
    mockContext({
      metadata: { name: 'prod-ctx' },
      spec: {
        contextId: 'prod-ctx',
        description: 'Original description',
        mcpServers: ['srv-a', 'srv-b'],
        sharedFileSystems,
        displayName: 'Prod Ctx',
      },
    })

    render(<ContextDetailsPage />)
    await screen.findByText('Prod Ctx')
    await openEditModal()

    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Updated description' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.updateContext).toHaveBeenCalled())
    const spec = lastPutSpec()
    expect(spec.description).toBe('Updated description')
    expect(spec.mcpServers).toEqual(['srv-a', 'srv-b'])
    expect(spec.sharedFileSystems).toEqual(sharedFileSystems)
    expect(spec.displayName).toBe('Prod Ctx')
  })
})
