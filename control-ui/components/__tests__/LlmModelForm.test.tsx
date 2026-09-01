import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { LlmAllowedModel } from '@lib/api'
import { LlmModelForm } from '../LlmModelForm'

afterEach(cleanup)

const model: LlmAllowedModel = {
  id: 'model-1',
  provider: 'codex-subscription',
  model: 'gpt-5.3-codex',
  vendor: 'OpenAI',
  display_name: 'GPT-5.3 Codex',
  context_window_tokens: 200000,
  enabled: true,
  source: 'discovery',
  stale: false,
  discovered_at: null,
  last_seen_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

describe('LlmModelForm', () => {
  it('disables the Enabled toggle for ChatGPT subscription models', () => {
    render(
      <LlmModelForm
        mode="edit"
        initial={model}
        saving={false}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />
    )
    const toggle = screen.getByRole('checkbox')
    expect(toggle).toBeDisabled()
    expect(
      screen.getByText(/enabled by the assigned grant catalog after sync/i)
    ).toBeInTheDocument()
  })

  it('keeps the Enabled toggle editable for API-key providers', () => {
    render(
      <LlmModelForm
        mode="edit"
        initial={{ ...model, provider: 'openai', model: 'gpt-5.4' }}
        saving={false}
        onSubmit={() => undefined}
        onCancel={() => undefined}
      />
    )
    expect(screen.getByRole('checkbox')).toBeEnabled()
  })
})
