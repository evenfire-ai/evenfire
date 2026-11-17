// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HostModelsResult } from '@hooks/useChatStore'
import {
  getHostModelSelectionSnapshot,
  loadHostModels,
  resetHostModelSelectionStore,
} from '@lib/hostModelSelectionStore'
import { ModelSelector } from '../ModelSelector'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Drive the component purely through the hook's return shape. Every field of the
// real return shape must exist here — the component reads them directly.
type HookState = {
  data: HostModelsResult | null | undefined
  loading: boolean
  saving: boolean
  error: string | null
  state: 'unloaded' | 'loading' | 'ready' | 'unavailable' | 'error'
  effectiveModel: string
  intentModel: string | null
  pending: boolean
  selectionUnsettled: boolean
  conflicted: boolean
  confirmedRevision: number | null
  imageInput: {
    state: 'supported' | 'unsupported' | 'unknown'
    reason: string
    validUntil?: string
  }
  canAttachImages: boolean
  imageBlockMessage: string | null
  loadError: string | null
  visualSendBlocked: boolean
  selectModel: (model: string) => Promise<boolean>
  clearError: () => void
  refresh: () => Promise<void>
}

function makeHookState(overrides: Partial<HookState> = {}): HookState {
  const data = overrides.data
  return {
    data,
    loading: false,
    saving: false,
    error: null,
    state: data === undefined ? 'unloaded' : data === null ? 'unavailable' : 'ready',
    effectiveModel: data ? (data.sessionModel ?? data.hostDefault) : '',
    intentModel: null,
    pending: false,
    selectionUnsettled: false,
    conflicted: false,
    confirmedRevision: null,
    imageInput: { state: 'unknown', reason: 'model_unknown' },
    canAttachImages: false,
    imageBlockMessage: null,
    loadError: null,
    visualSendBlocked: false,
    selectModel: vi.fn(async (_model: string) => true),
    clearError: vi.fn(),
    refresh: vi.fn(async () => undefined),
    ...overrides,
  }
}

let hookState: HookState = makeHookState()

vi.mock('@hooks/useHostModels', () => ({
  useHostModels: () => hookState,
}))

function setHook(overrides: Partial<HookState>) {
  hookState = makeHookState(overrides)
}

/**
 * The hook is mocked, so the effective model would otherwise be whatever this
 * file computes. Resolving the view through the REAL selection store keeps the
 * store's fallback rules under test here too.
 */
async function setHookFromStore(data: HostModelsResult) {
  resetHostModelSelectionStore()
  await loadHostModels(
    { getHostModels: async () => data, setHostModel: vi.fn() },
    'chatllm',
    'chat-1'
  )
  hookState = makeHookState(
    getHostModelSelectionSnapshot('chatllm', 'chat-1') as Partial<HookState>
  )
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
  hookState = makeHookState()
  resetHostModelSelectionStore()
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

  // #654 M7 — a failed fetch is not the host saying "I have no models". Hiding
  // the chip there left the user with a capability-less composer and no way to
  // recover; the chip stays as the retry affordance.
  it('shows a retry chip when the model list failed to load', () => {
    const refresh = vi.fn(async () => undefined)
    setHook({
      data: undefined,
      state: 'error',
      error: 'The model list could not be loaded. Retry.',
      loadError: 'The model list could not be loaded. Retry.',
      refresh,
    })
    renderSelector()

    const chip = screen.getByRole('button', { name: /Models unavailable/ })
    expect(chip.getAttribute('title')).toMatch(/could not be loaded/)

    fireEvent.click(chip)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('announces the image hint through aria-describedby for a model that cannot receive images', () => {
    setHook({
      data: baseData(),
      imageInput: { state: 'unsupported', reason: 'model_unsupported' },
    })
    renderSelector()
    const chip = screen.getByRole('button', { name: /Model — Haiku 4.5/ })
    const describedBy = chip.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      'This model cannot receive images.'
    )
  })

  it('has no image hint for a model that can receive images', () => {
    setHook({ data: baseData(), imageInput: { state: 'supported', reason: 'supported' } })
    renderSelector()
    // Witness: the chip rendered.
    const chip = screen.getByRole('button', { name: /Model — Haiku 4.5/ })
    expect(chip.hasAttribute('aria-describedby')).toBe(false)
    expect(chip.hasAttribute('title')).toBe(false)
  })

  it('lists models without capability or default tags (#735)', () => {
    setHook({
      data: baseData({
        models: [
          {
            name: 'claude-opus-4-8',
            displayName: 'Opus 4.8',
            imageInput: { state: 'supported', reason: 'supported' },
          },
          {
            name: 'claude-haiku-4-5',
            displayName: 'Haiku 4.5',
            imageInput: { state: 'unsupported', reason: 'model_unsupported' },
          },
          { name: 'claude-sonnet-5', displayName: 'Sonnet 5' },
        ],
      }),
    })
    renderSelector()
    fireEvent.click(screen.getByRole('button', { name: /Model —/ }))

    // Liveness witness: all three rows really rendered, so the tag assertions
    // below cannot be satisfied by an empty or unopened list.
    const optionOf = (name: RegExp) => screen.getByRole('menuitemradio', { name })
    expect(optionOf(/Opus 4\.8/).textContent).toBe('Opus 4.8')
    expect(optionOf(/Haiku 4\.5/).textContent).toBe('Haiku 4.5')
    expect(optionOf(/Sonnet 5/).textContent).toBe('Sonnet 5')

    // hostDefault is claude-opus-4-8 and the three models cover supported /
    // unsupported / unverified image input — none of them may render a tag.
    expect(document.querySelectorAll('.model-selector-item-tag').length).toBe(0)
    expect(screen.queryByText('default')).toBeNull()
    expect(screen.queryByText('images')).toBeNull()
    expect(screen.queryByText('no images')).toBeNull()
    expect(screen.queryByText('images not verified')).toBeNull()

    // Structural premise the Playwright image-capability spec asserts on the
    // live app: a row is one span (the label) plus, on the active row, the
    // check svg. Pinned here because this suite can actually run it.
    expect(optionOf(/Opus 4\.8/).querySelectorAll('span')).toHaveLength(1)
    expect(optionOf(/Haiku 4\.5/).querySelectorAll('span')).toHaveLength(1)
    expect(optionOf(/Sonnet 5/).querySelectorAll('span')).toHaveLength(1)
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

  it('shows the Grok Host default when the session has no selected model', async () => {
    await setHookFromStore(
      baseData({
        provider: 'grok-subscription',
        hostDefault: 'grok-4.6',
        sessionModel: null,
        // The default is not the first row: the chip must not seed `models[0]`.
        models: [
          { name: 'grok-4.5', displayName: 'Grok 4.5' },
          { name: 'grok-4.6', displayName: 'Grok 4.6' },
        ],
      })
    )
    renderSelector()
    expect(screen.getByRole('button', { name: /Model — Grok 4\.6/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Select model|Grok 4\.5/ })).toBeNull()
  })

  it('shows the Codex Host default and marks it, never the first catalog row', async () => {
    await setHookFromStore(
      baseData({
        provider: 'codex-subscription',
        hostDefault: 'gpt-5.5',
        sessionModel: null,
        models: [
          { name: 'gpt-5.3', displayName: 'GPT-5.3' },
          { name: 'gpt-5.5', displayName: 'GPT-5.5' },
        ],
      })
    )
    renderSelector()
    expect(screen.getByRole('button', { name: /Model — GPT-5\.5/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Select model/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Model —/ }))
    expect(
      screen.getByRole('menuitemradio', { name: /GPT-5\.5/ }).getAttribute('aria-checked')
    ).toBe('true')
    expect(
      screen.getByRole('menuitemradio', { name: /GPT-5\.3/ }).getAttribute('aria-checked')
    ).toBe('false')
  })

  it('names a broker Host default that the catalog does not list', async () => {
    // The runtime dispatches `spec.model.name` even when the allowlist omits
    // it, so the chip must name that model rather than ask for a pick.
    await setHookFromStore(
      baseData({
        provider: 'codex-subscription',
        hostDefault: 'gpt-5.6-codex',
        sessionModel: null,
        models: [
          { name: 'gpt-5.3', displayName: 'GPT-5.3' },
          { name: 'gpt-5.5', displayName: 'GPT-5.5' },
        ],
      })
    )
    renderSelector()
    const chip = screen.getByRole('button', { name: /^Model — / })
    expect(chip.getAttribute('aria-label')).toBe('Model — gpt-5.6-codex')
    expect(chip.textContent).toBe('gpt-5.6-codex')
  })

  it('shows the Host default on the static chip of a degraded broker-backed Host', async () => {
    // Without an allowlist the Host projects only its default, with unknown
    // image input.
    await setHookFromStore(
      baseData({
        provider: 'codex-subscription',
        hostDefault: 'gpt-5.5',
        sessionModel: null,
        degraded: true,
        models: [{ name: 'gpt-5.5', imageInput: { state: 'unknown', reason: 'model_unknown' } }],
      })
    )
    renderSelector()
    const chip = screen.getByLabelText('Model gpt-5.5 (selection unavailable)')
    expect(chip.textContent).toBe('gpt-5.5')
  })

  it('defensive guard: shows "Select model" if a broker-backed Host reports an empty model', async () => {
    // Only reachable for a Host written outside control-api with an empty
    // `spec.model.name`: the Host forwards it as `hostDefault: ''`.
    await setHookFromStore(
      baseData({ provider: 'codex-subscription', hostDefault: '', sessionModel: null })
    )
    renderSelector()
    expect(screen.getByRole('button', { name: /Model — Select model/ })).toBeTruthy()
  })

  it('hides stale and disabled Codex models from new picks, keeping a saved selection', () => {
    setHook({
      data: baseData({
        provider: 'codex-subscription',
        hostDefault: 'gpt-5.3',
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
