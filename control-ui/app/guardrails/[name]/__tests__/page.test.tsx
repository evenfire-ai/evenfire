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
vi.mock('@components/DetailPageShell', () => ({
  DetailPageShell: ({
    activeTab,
    children,
    tabs,
  }: {
    activeTab: string
    children: ReactNode
    tabs: Array<{ href: string; label: string; value: string }>
  }) => (
    <main>
      <nav aria-label="Guardrail detail sections">
        {tabs.map(tab => (
          <a
            key={tab.value}
            aria-current={tab.value === activeTab ? 'page' : undefined}
            href={tab.href}
          >
            {tab.label}
          </a>
        ))}
      </nav>
      {children}
    </main>
  ),
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
      screen.getByRole('link', { name: tab === 'details' ? 'Details' : 'Agents with access' })
    ).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Agents with access' })).toHaveAttribute(
      'href',
      '/guardrails/sample-hook/agents'
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
