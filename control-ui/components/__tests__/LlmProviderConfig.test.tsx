import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { HostAllowedModel, LlmModelCatalogEntry, LlmPolicy, LlmProvider } from '@/lib/llm'
import { LlmProviderConfig } from '../LlmProviderConfig'

afterEach(cleanup)

const CATALOG: LlmModelCatalogEntry[] = [
  { provider: 'openai', model: 'gpt-5.4-mini', enabled: true },
  { provider: 'openai', model: 'gpt-5.4', enabled: true },
  { provider: 'claude', model: 'claude-sonnet-4-6', enabled: true },
]

// Controlled host mirroring how the wizard/edit page wire the surface.
function Harness({
  initialProvider = 'openai',
  initialModel = 'gpt-5.4-mini',
  initialPolicy,
  initialAllowed = [],
  withCredentials = true,
  existingKeys,
  replacePrimaryModelWithAllowedModels = false,
}: {
  initialProvider?: LlmProvider
  initialModel?: string
  initialPolicy?: LlmPolicy
  initialAllowed?: HostAllowedModel[]
  withCredentials?: boolean
  existingKeys?: string[]
  replacePrimaryModelWithAllowedModels?: boolean
}) {
  const [provider, setProvider] = useState<LlmProvider>(initialProvider)
  const [model, setModel] = useState(initialModel)
  const [policy, setPolicy] = useState<LlmPolicy | undefined>(initialPolicy)
  const [allowedModels, setAllowedModels] = useState<HostAllowedModel[]>(initialAllowed)
  const [draft, setDraft] = useState<Record<string, string>>({})
  return (
    <LlmProviderConfig
      provider={provider}
      model={model}
      onPrimaryChange={next => {
        setProvider(next.provider)
        setModel(next.model)
      }}
      policy={policy}
      onPolicyChange={setPolicy}
      allowedModels={allowedModels}
      onAllowedModelsChange={setAllowedModels}
      catalog={CATALOG}
      credentials={
        withCredentials
          ? {
              draft,
              onChange: (dataKey, value) => setDraft(prev => ({ ...prev, [dataKey]: value })),
              existingKeys,
            }
          : undefined
      }
      replacePrimaryModelWithAllowedModels={replacePrimaryModelWithAllowedModels}
      secretKeys={existingKeys}
    />
  )
}

describe('LlmProviderConfig (spec Topic 1b — domain projection + usable gate)', () => {
  it('projects ONLY the in-use provider blocks, not the wall of all providers', () => {
    render(<Harness />)
    // Primary provider block for the chosen provider is present…
    expect(screen.getByLabelText('OpenAI credentials')).toBeInTheDocument()
    // …and no unrelated provider gets a credential block.
    expect(screen.queryByLabelText('Anthropic credentials')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Bailian credentials')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Amazon Bedrock credentials')).not.toBeInTheDocument()
  })

  it('blocks with a primary warning until the primary credential is provided', () => {
    render(<Harness />)
    const primary = screen.getByLabelText('OpenAI credentials')
    expect(within(primary).getByText(/Add the OpenAI credential/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/OpenAI API key/i), { target: { value: 'sk-live' } })
    expect(within(primary).queryByText(/Add the OpenAI credential/i)).not.toBeInTheDocument()
  })

  it('keeps the primary credential below Provider, Model, and Allowed models', () => {
    render(<Harness />)

    const row = screen
      .getByLabelText('Provider', { selector: '#llm-primary-provider' })
      .closest('.cu-llm-config__model-row')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).queryByLabelText(/OpenAI API key/i)).not.toBeInTheDocument()

    const allowedModels = screen.getByText('Allowed models · OpenAI').closest('.cu-field')
    const credentials = screen.getByLabelText('OpenAI credentials')
    expect(allowedModels).not.toBeNull()
    expect(allowedModels?.compareDocumentPosition(credentials)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('scopes the provider icon treatment to the provider selector', () => {
    render(<Harness />)

    const providerSelect = screen
      .getByLabelText('Provider', { selector: '#llm-primary-provider' })
      .closest('.cu-selection-dropdown')
    const modelSelect = screen
      .getByLabelText('Model', { selector: '#llm-primary-model' })
      .closest('.cu-selection-dropdown')

    expect(providerSelect).toHaveClass('cu-llm-config__provider-select')
    expect(modelSelect).not.toHaveClass('cu-llm-config__provider-select')
  })

  it('replaces Model with Allowed models in the existing-agent layout', () => {
    render(<Harness replacePrimaryModelWithAllowedModels />)

    const row = screen
      .getByLabelText('Provider', { selector: '#llm-primary-provider' })
      .closest('.cu-llm-config__model-row')
    expect(row).not.toBeNull()
    expect(within(row as HTMLElement).getByText('Allowed models · OpenAI')).toBeInTheDocument()
    expect(
      screen.queryByLabelText('Model', { selector: '#llm-primary-model' })
    ).not.toBeInTheDocument()
  })

  it('treats a stored key (existingKeys) as usable without re-entry (edit mode)', () => {
    render(<Harness existingKeys={['openai-api-key']} />)
    const primary = screen.getByLabelText('OpenAI credentials')
    expect(within(primary).queryByText(/Add the OpenAI credential/i)).not.toBeInTheDocument()
    expect(within(primary).getAllByLabelText('present').length).toBeGreaterThan(0)
    expect(within(primary).getByRole('status')).toHaveTextContent(/Stored/i)
    expect(
      within(primary).queryByLabelText(/OpenAI API key/i, { selector: 'input' })
    ).not.toBeInTheDocument()
  })

  it('reveals a stored credential input only when replacement is requested', () => {
    render(<Harness existingKeys={['openai-api-key']} />)
    const primary = screen.getByLabelText('OpenAI credentials')

    fireEvent.click(within(primary).getByRole('button', { name: 'Replace OpenAI API key' }))

    expect(within(primary).getByLabelText(/OpenAI API key/i)).toBeInTheDocument()
    expect(within(primary).getByPlaceholderText(/Enter a new openai api key/i)).toBeInTheDocument()
    expect(within(primary).getByRole('button', { name: 'Keep stored' })).toBeInTheDocument()
  })

  it('starts fallbacks at ZERO and adds a same-provider fallback that reuses the primary key', () => {
    render(<Harness />)
    expect(screen.queryByText('Fallback #1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add fallback provider' }))
    // The added fallback defaults to the primary provider and reuses its key…
    expect(screen.getByText(/reuses the OpenAI credentials above/i)).toBeInTheDocument()
    // …until the operator asks for a separate slot, which mints its own block.
    fireEvent.click(screen.getByRole('button', { name: /Use a separate key/i }))
    const fbBlock = screen.getByLabelText('Fallback #1 · OpenAI credentials')
    expect(within(fbBlock).getByText(/won't run until you add its OpenAI key/i)).toBeInTheDocument()
  })

  it('renders a different-provider fallback block that WARNS (never blocks) on a missing key', () => {
    render(
      <Harness
        initialPolicy={{
          cooldownSeconds: 300,
          triggerOn: ['auth'],
          fallbacks: [{ provider: 'claude', model: 'claude-sonnet-4-6' }],
        }}
      />
    )
    const fbBlock = screen.getByLabelText('Fallback #1 · Anthropic credentials')
    // A missing fallback key is advisory (warn), not the blocking primary error.
    expect(
      within(fbBlock).getByText(/won't run until you add its Anthropic key/i)
    ).toBeInTheDocument()
    expect(within(fbBlock).queryByText(/Add the .* credential for the primary/i)).toBeNull()
  })

  it('omits credential inputs when no credential wiring is passed (reuse-existing-secret)', () => {
    render(<Harness withCredentials={false} />)
    expect(screen.queryByLabelText('OpenAI credentials')).not.toBeInTheDocument()
    // Provider + model selection still render.
    expect(
      screen.getByLabelText('Provider', { selector: '#llm-primary-provider' })
    ).toHaveTextContent('OpenAI')
    expect(screen.getByLabelText('Model', { selector: '#llm-primary-model' })).toBeInTheDocument()
  })
})

describe('LlmProviderConfig (spec Topic 3a — per-host allowed-models subset)', () => {
  it('defaults the primary provider to the "All models" (unrestricted) state', () => {
    render(<Harness />)
    expect(screen.getByText(/this host offers every enabled OpenAI model/i)).toBeInTheDocument()
    // No restriction yet — the model dropdown still offers the full enabled list.
    fireEvent.click(screen.getByLabelText('Model', { selector: '#llm-primary-model' }))
    expect(screen.getByRole('option', { name: 'gpt-5.4-mini' })).toBeInTheDocument()
  })

  it('constrains the primary model dropdown to a pre-loaded subset (edit hydration)', () => {
    // Host restricts OpenAI to just gpt-5.4-mini (a strict subset of the two
    // enabled OpenAI models) — mirrors normalizeAllowedModels on edit load.
    render(<Harness initialAllowed={[{ provider: 'openai', model: 'gpt-5.4-mini' }]} />)
    expect(
      screen.getByText(/Restricted — this host offers only the 1 selected OpenAI model/i)
    ).toBeInTheDocument()
    const modelSelect = screen.getByLabelText('Model', { selector: '#llm-primary-model' })
    fireEvent.click(modelSelect)
    // The subset drives the dropdown: gpt-5.4-mini stays, gpt-5.4 is excluded.
    expect(screen.getByRole('option', { name: 'gpt-5.4-mini' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'gpt-5.4' })).not.toBeInTheDocument()
  })

  it('warns (non-disruptive) when the saved primary model falls outside the subset', () => {
    render(
      <Harness
        initialModel="gpt-5.4"
        initialAllowed={[{ provider: 'openai', model: 'gpt-5.4-mini' }]}
      />
    )
    // The saved model stays selectable but the operator is warned it won't be offered.
    expect(screen.getByText(/gpt-5\.4 isn.t in the models offered for OpenAI/i)).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Model', { selector: '#llm-primary-model' }))
    expect(screen.getByRole('option', { name: 'gpt-5.4' })).toHaveTextContent('out of allowlist')
  })

  it('shows an allowed-models control for a fallback provider on a different provider', () => {
    render(
      <Harness
        initialPolicy={{
          cooldownSeconds: 300,
          triggerOn: ['auth'],
          fallbacks: [{ provider: 'claude', model: 'claude-sonnet-4-6' }],
        }}
      />
    )
    // The fallback-providers allowed-models section appears with a Claude control.
    expect(screen.getByText('Allowed models · fallback providers')).toBeInTheDocument()
    expect(screen.getByText(/this host offers every enabled Anthropic model/i)).toBeInTheDocument()
  })
})
