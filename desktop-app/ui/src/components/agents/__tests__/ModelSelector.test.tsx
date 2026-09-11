// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HostModelsResult } from '@hooks/useChatStore'
import { ModelSelector } from '../ModelSelector'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Drive the component purely through the hook's return shape.
const hookState = {
  data: undefined as HostModelsResult | null | undefined,
  loading: false,
  saving: false,
  error: null as string | null,
  selectModel: vi.fn(async (_model: string) => true),
  clearError: vi.fn(),
}

vi.mock('@hooks/useHostModels', () => ({
  useHostModels: () => hookState,
}))

function setHook(overrides: Partial<typeof hookState>) {
  Object.assign(hookState, overrides)
}

function baseData(overrides: Partial<HostModelsResult> = {}): HostModelsResult {
  return {
    provider: 'claude',
    hostDefault: 'claude-opus-4-8',
    sessionModel: 'claude-haiku-4-5',
    degraded: false,
    models: [
      { name: 'claude-opus-4-8', displayName: 'Opus 4.8' },
      { name: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
    ],
    ...overrides,
  }
}

function renderSelector() {
  return render(<ModelSelector agentRef="chatllm" chatId="chat-1" />)
}

afterEach(() => {
  cleanup()
  setHook({
    data: undefined,
    loading: false,
    saving: false,
    error: null,
    selectModel: vi.fn(async () => true),
    clearError: vi.fn(),
  })
  vi.clearAllMocks()
})

describe('ModelSelector', () => {
  it('renders nothing while data is loading (undefined) — no flash', () => {
    setHook({ data: undefined })
    const { container } = renderSelector()
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the host predates the endpoint (data null) — compat', () => {
    setHook({ data: null })
    const { container } = renderSelector()
    expect(container.firstChild).toBeNull()
  })

  it('shows the effective model (sessionModel over hostDefault)', () => {
    setHook({ data: baseData() })
    renderSelector()
    expect(screen.getByRole('button', { name: /Model — Haiku 4.5/ })).toBeTruthy()
  })

  it('falls back to the host default label when no session model is selected', () => {
    setHook({ data: baseData({ sessionModel: null }) })
    renderSelector()
    expect(screen.getByRole('button', { name: /Model — Opus 4.8/ })).toBeTruthy()
  })

  it('lists the allowed models and applies the badge on a successful switch', async () => {
    const selectModel = vi.fn(async () => true)
    setHook({ data: baseData(), selectModel })
    renderSelector()

    fireEvent.click(screen.getByRole('button', { name: /Model —/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Opus 4.8/ }))

    await waitFor(() => expect(selectModel).toHaveBeenCalledWith('claude-opus-4-8'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/next message/i))
  })

  it('does not call selectModel when the already-active model is re-selected', () => {
    const selectModel = vi.fn(async () => true)
    setHook({ data: baseData(), selectModel })
    renderSelector()

    fireEvent.click(screen.getByRole('button', { name: /Model —/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Haiku 4.5/ }))

    expect(selectModel).not.toHaveBeenCalled()
  })

  it('renders a disabled, non-interactive chip with a tooltip when degraded', () => {
    setHook({ data: baseData({ degraded: true }) })
    renderSelector()
    // No menu trigger — the chip is static.
    expect(screen.queryByRole('button')).toBeNull()
    const chip = screen.getByLabelText(/selection unavailable/i)
    expect(chip.getAttribute('title')).toMatch(/host default/i)
  })

  it('warns when the previously selected model fell out of the allowlist', () => {
    setHook({ data: baseData({ sessionModelBlocked: 'claude-sonnet-4-5' }) })
    renderSelector()
    fireEvent.click(screen.getByRole('button', { name: /Model —/ }))
    expect(screen.getByText(/no longer allowed/i).textContent).toContain('claude-sonnet-4-5')
  })

  it('defaults to downward placement (no --up modifier)', () => {
    setHook({ data: baseData() })
    const { container } = renderSelector()
    const root = container.querySelector('.model-selector')
    expect(root).toBeTruthy()
    expect(root?.classList.contains('model-selector--up')).toBe(false)
  })

  it('applies the upward placement modifier when placement="up" (composer)', () => {
    setHook({ data: baseData() })
    const { container } = render(
      <ModelSelector agentRef="chatllm" chatId="chat-1" placement="up" />
    )
    const root = container.querySelector('.model-selector')
    expect(root?.classList.contains('model-selector--up')).toBe(true)
  })

  it('does not invent a Codex default when the session has no selected model', () => {
    setHook({
      data: baseData({
        provider: 'codex-subscription',
        hostDefault: '',
        sessionModel: null,
        models: [
          { name: 'gpt-5.3', displayName: 'GPT-5.3' },
          { name: 'gpt-5.2', displayName: 'GPT-5.2' },
        ],
      }),
    })
    renderSelector()
    expect(screen.getByRole('button', { name: /Model — Select model/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /GPT-5\.3/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Model —/ }))
    expect(
      screen.getByRole('menuitemradio', { name: /GPT-5\.3/ }).getAttribute('aria-checked')
    ).toBe('false')
    expect(screen.queryByText('default')).toBeNull()
  })

  it('hides stale and disabled Codex models from new picks, keeping a saved selection', () => {
    setHook({
      data: baseData({
        provider: 'codex-subscription',
        hostDefault: '',
        sessionModel: 'gpt-5.2-stale',
        models: [
          { name: 'gpt-5.3', displayName: 'GPT-5.3' },
          { name: 'gpt-5.2-stale', displayName: 'GPT-5.2', stale: true },
          { name: 'gpt-5.1-off', displayName: 'GPT-5.1', disabled: true },
        ],
      }),
    })
    renderSelector()
    fireEvent.click(screen.getByRole('button', { name: /Model — GPT-5\.2/ }))
    expect(screen.getByRole('menuitemradio', { name: /GPT-5\.3/ })).toBeTruthy()
    expect(screen.getByRole('menuitemradio', { name: /GPT-5\.2/ })).toBeTruthy()
    expect(screen.queryByRole('menuitemradio', { name: /GPT-5\.1/ })).toBeNull()
  })

  it('surfaces the inline error from a rejected switch without changing selection', () => {
    setHook({
      data: baseData(),
      error: 'That model is no longer allowed — selection unchanged.',
    })
    renderSelector()
    fireEvent.click(screen.getByRole('button', { name: /Model —/ }))
    expect(screen.getByRole('alert').textContent).toMatch(/no longer allowed/i)
  })
})
