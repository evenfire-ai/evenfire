// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HostModelsResult } from '@hooks/useChatStore'
import { installAntdDomEnvironment } from '../../../test/antdDomEnvironment'
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
  vi.clearAllMocks()
})

beforeEach(installAntdDomEnvironment)

function selector() {
  return screen.getByRole('combobox', { name: /Model/ })
}

function openSelector() {
  fireEvent.mouseDown(selector())
}

function option(name: RegExp) {
  const label = screen
    .getAllByText(name)
    .find(candidate => candidate.closest('.ant-select-item-option'))
  const visibleOption = label?.closest('.ant-select-item-option')
  if (!(visibleOption instanceof HTMLElement)) {
    throw new Error(`Expected a visible Ant Design option matching ${name}`)
  }
  return visibleOption
}

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
    const chip = screen.getByRole('combobox', { name: /Model — Haiku 4.5/ })
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
    const chip = screen.getByRole('combobox', { name: /Model — Haiku 4.5/ })
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
    openSelector()

    // Liveness witness: all three options really rendered, so the content
    // assertions below cannot be satisfied by an empty or unopened list.
    const optionOf = option
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

    expect(optionOf(/Opus 4\.8/).textContent).toBe('Opus 4.8')
    expect(optionOf(/Haiku 4\.5/).textContent).toBe('Haiku 4.5')
    expect(optionOf(/Sonnet 5/).textContent).toBe('Sonnet 5')
  })

  it('shows the effective model (sessionModel over hostDefault)', () => {
    setHook({ data: baseData() })
    renderSelector()
    expect(screen.getByRole('combobox', { name: /Model — Haiku 4.5/ })).toBeTruthy()
  })

  it('falls back to the host default label when no session model is selected', () => {
    setHook({ data: baseData({ sessionModel: null }) })
    renderSelector()
    expect(screen.getByRole('combobox', { name: /Model — Opus 4.8/ })).toBeTruthy()
  })

  it('lists the allowed models and applies the badge on a successful switch', async () => {
    const selectModel = vi.fn(async () => true)
    setHook({ data: baseData(), selectModel })
    renderSelector()

    openSelector()
    fireEvent.click(option(/Opus 4.8/))

    await waitFor(() => expect(selectModel).toHaveBeenCalledWith('claude-opus-4-8'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/next message/i))
  })

  it('does not call selectModel when the already-active model is re-selected', () => {
    const selectModel = vi.fn(async () => true)
    setHook({ data: baseData(), selectModel })
    renderSelector()

    openSelector()
    fireEvent.click(option(/Haiku 4.5/))

    expect(selectModel).not.toHaveBeenCalled()
  })

  it('renders a disabled, non-interactive chip with a tooltip when degraded', () => {
    setHook({ data: baseData({ degraded: true }) })
    renderSelector()
    const control = screen.getByRole('combobox', { name: /selection unavailable/i })
    expect((control as HTMLInputElement).disabled).toBe(true)
    const descriptionId = control.getAttribute('aria-describedby')
    expect(document.getElementById(descriptionId as string)?.textContent).toMatch(
      /using the host default/i
    )
  })

  it('warns when the previously selected model fell out of the allowlist', () => {
    setHook({ data: baseData({ sessionModelBlocked: 'claude-sonnet-4-5' }) })
    renderSelector()
    openSelector()
    expect(screen.getByText(/no longer allowed/i).textContent).toContain('claude-sonnet-4-5')
  })

  it('defaults to downward placement (no --up modifier)', () => {
    setHook({ data: baseData() })
    const { container } = renderSelector()
    expect(container.querySelector('[data-testid="model-selector-down"]')).toBeTruthy()
  })

  it('applies the upward placement modifier when placement="up" (composer)', () => {
    setHook({ data: baseData() })
    const { container } = render(
      <ModelSelector agentRef="chatllm" chatId="chat-1" placement="up" />
    )
    expect(container.querySelector('[data-testid="model-selector-up"]')).toBeTruthy()
  })

  it('does not invent a Grok default when the session has no selected model', () => {
    setHook({
      data: baseData({
        provider: 'grok-subscription',
        hostDefault: '',
        sessionModel: null,
        models: [
          { name: 'grok-4.6', displayName: 'Grok 4.6' },
          { name: 'grok-4.5', displayName: 'Grok 4.5' },
        ],
      }),
    })
    renderSelector()
    expect(screen.getByRole('combobox', { name: /Model — Select model/ })).toBeTruthy()
    expect(
      screen.queryByText('Grok 4.6', { selector: '.ant-select-item-option-content' })
    ).toBeNull()
  })

  it('does not invent a Codex default when the session has no selected model', () => {
    const selectModel = vi.fn(async () => true)
    setHook({
      selectModel,
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
    expect(screen.getByRole('combobox', { name: /Model — Select model/ })).toBeTruthy()
    expect(
      screen.queryByText('GPT-5.3', { selector: '.ant-select-item-option-content' })
    ).toBeNull()
    openSelector()
    expect(option(/GPT-5\.3/).getAttribute('aria-selected')).not.toBe('true')
    expect(selectModel).not.toHaveBeenCalled()
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
    openSelector()
    expect(option(/GPT-5\.3/)).toBeTruthy()
    expect(option(/GPT-5\.2/)).toBeTruthy()
    expect(
      screen.queryByText('GPT-5.1', { selector: '.ant-select-item-option-content' })
    ).toBeNull()
  })

  it('surfaces the inline error from a rejected switch without changing selection', () => {
    setHook({
      data: baseData(),
      error: 'That model is no longer allowed — selection unchanged.',
    })
    renderSelector()
    openSelector()
    expect(screen.getByRole('alert').textContent).toMatch(/no longer allowed/i)
  })
})
