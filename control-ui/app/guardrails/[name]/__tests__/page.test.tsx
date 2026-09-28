import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import GuardrailTabPage from '../[tab]/page'
import GuardrailDetailPage from '../page'

const navigation = vi.hoisted(() => ({
  params: { name: 'sample-hook', tab: 'details' as string | undefined },
  push: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND')
  }),
}))
const api = vi.hoisted(() => ({
  getLlmHook: vi.fn(),
  getHosts: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => navigation.params,
  useRouter: () => ({ push: navigation.push }),
  notFound: navigation.notFound,
}))
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('@lib/api', () => ({
  getLlmHook: api.getLlmHook,
  getHosts: api.getHosts,
  deleteLlmHook: vi.fn(),
  isSilentApiError: () => false,
}))
vi.mock('@components/ConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(), confirmDialog: null }),
}))
vi.mock('@components/Toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }))
vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}))

beforeEach(() => {
  vi.clearAllMocks()
  navigation.params.tab = 'details'
  api.getLlmHook.mockResolvedValue({
    metadata: { name: 'sample-hook' },
    spec: { path: '/check', lifecyclePoints: ['preCall'] },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  })
  api.getHosts.mockResolvedValue({
    items: [
      {
        metadata: { name: 'sample-agent' },
        spec: { guardrails: { hooks: { preCall: [{ id: 'sample-hook' }] } } },
      },
    ],
  })
})
afterEach(cleanup)

describe('guardrail detail routes', () => {
  it.each(['details', 'agents'])('opens the %s tab directly', async tab => {
    navigation.params.tab = tab
    const page = await GuardrailTabPage({ params: Promise.resolve({ tab }) })
    render(page)

    expect(
      await screen.findByText(
        tab === 'details' ? 'Runtime configuration reported by the installed hook.' : 'sample-agent'
      )
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tab', { name: tab === 'details' ? 'Details' : 'Agents with access' })
    ).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Agents with access' })).toHaveAttribute(
      'href',
      '/guardrails/sample-hook/agents'
    )
  })

  it('switches sections when a tab link is clicked in the real shell', async () => {
    render(<GuardrailDetailPage />)
    expect(
      await screen.findByText('Runtime configuration reported by the installed hook.')
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Agents with access' }))

    expect(screen.getByText('sample-agent')).toBeInTheDocument()
    expect(screen.queryByText('Runtime configuration reported by the installed hook.')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Agents with access' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByRole('tab', { name: 'Agents with access' })).toHaveAttribute(
      'aria-current',
      'page'
    )
  })

  it('rejects unknown tab routes', async () => {
    await expect(GuardrailTabPage({ params: Promise.resolve({ tab: 'unknown' }) })).rejects.toThrow(
      'NOT_FOUND'
    )
    expect(navigation.notFound).toHaveBeenCalledOnce()
  })

  it('opens the agent guardrails route by keyboard', async () => {
    navigation.params.tab = 'agents'
    render(<GuardrailDetailPage />)
    const agent = await screen.findByRole('link', { name: 'Open agent sample-agent guardrails' })
    fireEvent.keyDown(agent, { key: 'Enter' })
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith('/agents/sample-agent/guardrails')
    )
    navigation.push.mockClear()
    fireEvent.keyDown(agent, { key: ' ' })
    expect(navigation.push).toHaveBeenCalledWith('/agents/sample-agent/guardrails')
  })
})
