import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { LlmModelCatalogEntry, LlmPolicy } from '@/lib/llm'
import { LlmPolicyEditor } from '../LlmPolicyEditor'

afterEach(cleanup)

const CATALOG: LlmModelCatalogEntry[] = [
  { provider: 'claude', model: 'claude-opus-4-8', enabled: true },
  { provider: 'claude', model: 'claude-haiku-4-5', enabled: true },
  { provider: 'claude', model: 'claude-legacy', enabled: false },
  { provider: 'openai', model: 'gpt-5.4', enabled: true },
  { provider: 'openai', model: 'gpt-5.4-mini', enabled: true },
  { provider: 'bedrock', model: 'anthropic.claude-sonnet-4-6-v1:0', enabled: true },
  { provider: 'vertex', model: 'gemini-2.5-pro', enabled: true },
]

// A controlled host mirroring how the Host edit page wires the editor, exposing
// the last emitted policy so tests can assert the persisted shape.
function Harness({
  initial,
  secretKeys,
  onLatest,
}: {
  initial?: LlmPolicy
  secretKeys?: string[]
  onLatest?: (p: LlmPolicy | undefined) => void
}) {
  const [policy, setPolicy] = useState<LlmPolicy | undefined>(initial)
  return (
    <LlmPolicyEditor
      value={policy}
      onChange={next => {
        setPolicy(next)
        onLatest?.(next)
      }}
      catalog={CATALOG}
      secretKeys={secretKeys}
      defaultProvider="claude"
    />
  )
}

describe('LlmPolicyEditor (spec §3-R5 / R4.5.6)', () => {
  it('renders the empty state when the Host has no fallback', () => {
    render(<Harness />)
    expect(screen.getByText('No fallback configured.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add fallback provider' })).toBeInTheDocument()
  })

  it('renders existing fallbacks from the spec, in order', () => {
    render(
      <Harness
        initial={{
          cooldownSeconds: 120,
          triggerOn: ['auth'],
          fallbacks: [
            { provider: 'claude', model: 'claude-haiku-4-5', credentialSlot: 'claude-api-key-fb1' },
            { provider: 'openai', model: 'gpt-5.4' },
          ],
        }}
        secretKeys={['claude-api-key', 'claude-api-key-fb1', 'openai-api-key']}
      />
    )
    expect(screen.getByText('Fallback #1')).toBeInTheDocument()
    expect(screen.getByText('Fallback #2')).toBeInTheDocument()

    const cooldown = screen.getByLabelText('Cooldown (seconds)') as HTMLInputElement
    expect(cooldown.value).toBe('120')

    // Row 1 model + slot come from the spec.
    const model0 = screen.getByLabelText('Model', { selector: '#llm-fallback-0-model' })
    expect((model0 as HTMLSelectElement).value).toBe('claude-haiku-4-5')
    const slot0 = screen.getByLabelText('Credential slot', { selector: '#llm-fallback-0-slot' })
    expect((slot0 as HTMLSelectElement).value).toBe('claude-api-key-fb1')
  })

  it('adds a fallback seeded with the host provider + a default enabled model', () => {
    let latest: LlmPolicy | undefined
    render(<Harness onLatest={p => (latest = p)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add fallback provider' }))
    expect(latest).toBeDefined()
    expect(latest?.fallbacks).toHaveLength(1)
    expect(latest?.fallbacks[0].provider).toBe('claude')
    // Model must be one of the ENABLED claude models (not the disabled one).
    expect(['claude-opus-4-8', 'claude-haiku-4-5']).toContain(latest?.fallbacks[0].model)
    // Defaults seeded: cooldown 300 + all four triggers.
    expect(latest?.cooldownSeconds).toBe(300)
    expect(latest?.triggerOn).toEqual([
      'insufficient_quota',
      'auth',
      'provider_unavailable',
      'rate_limited',
    ])
  })

  it('removing the last fallback clears the policy (undefined = no llmPolicy)', () => {
    let latest: LlmPolicy | undefined = { fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }] }
    render(
      <Harness
        initial={{ fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }] }}
        onLatest={p => (latest = p)}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove fallback 1' }))
    expect(latest).toBeUndefined()
  })

  it('model dropdown lists only ENABLED allowlist models for the entry provider', () => {
    render(<Harness initial={{ fallbacks: [{ provider: 'claude', model: 'claude-opus-4-8' }] }} />)
    const model = screen.getByLabelText('Model', {
      selector: '#llm-fallback-0-model',
    }) as HTMLSelectElement
    const values = within(model)
      .getAllByRole('option')
      .map(o => (o as HTMLOptionElement).value)
    expect(values).toContain('claude-opus-4-8')
    expect(values).toContain('claude-haiku-4-5')
    expect(values).not.toContain('claude-legacy') // disabled row excluded
    expect(values).not.toContain('gpt-5.4') // other provider excluded
  })

  it('credentialSlot is a dropdown (registry slots + extra Secret keys) — never free text', () => {
    render(
      <Harness
        initial={{ fallbacks: [{ provider: 'claude', model: 'claude-opus-4-8' }] }}
        secretKeys={['claude-api-key', 'claude-api-key-fb1', 'openai-api-key']}
      />
    )
    const slot = screen.getByLabelText('Credential slot', {
      selector: '#llm-fallback-0-slot',
    }) as HTMLSelectElement
    // It's a <select>, not a text input — the anti-typo guarantee (R4.5.6).
    expect(slot.tagName).toBe('SELECT')
    const values = within(slot)
      .getAllByRole('option')
      .map(o => (o as HTMLOptionElement).value)
    expect(values).toContain('') // "Provider default slot"
    expect(values).toContain('claude-api-key') // registry slot
    expect(values).toContain('claude-api-key-fb1') // extra key detected in the Secret
    expect(values).not.toContain('openai-api-key') // belongs to another provider
  })

  it('offers NO credentialSlot dropdown for a Bedrock fallback (key-pair provider)', () => {
    render(
      <Harness
        initial={{
          fallbacks: [{ provider: 'bedrock', model: 'anthropic.claude-sonnet-4-6-v1:0' }],
        }}
        secretKeys={['aws-access-key-id', 'aws-secret-access-key']}
      />
    )
    // The slot <select> is suppressed — a single dataKey can't express the pair;
    // the backend rejects any credentialSlot on Bedrock (422). A reuse note shows.
    expect(
      screen.queryByLabelText('Credential slot', { selector: '#llm-fallback-0-slot' })
    ).toBeNull()
    expect(
      screen.getByText(/Amazon Bedrock fallbacks reuse the primary credentials/i)
    ).toBeInTheDocument()
  })

  it('offers NO credentialSlot dropdown for a Vertex fallback (JSON slot provider)', () => {
    render(
      <Harness
        initial={{ fallbacks: [{ provider: 'vertex', model: 'gemini-2.5-pro' }] }}
        secretKeys={['vertex-service-account-json']}
      />
    )
    expect(
      screen.queryByLabelText('Credential slot', { selector: '#llm-fallback-0-slot' })
    ).toBeNull()
    expect(
      screen.getByText(/Google Vertex AI fallbacks reuse the primary credentials/i)
    ).toBeInTheDocument()
  })

  it('self-heals a legacy credentialSlot loaded on a now-unsupported provider (Bedrock)', async () => {
    let latest: LlmPolicy | undefined
    render(
      <Harness
        initial={{
          triggerOn: ['auth'],
          fallbacks: [
            {
              provider: 'bedrock',
              model: 'anthropic.claude-sonnet-4-6-v1:0',
              credentialSlot: 'aws-access-key-id',
            },
          ],
        }}
        onLatest={p => (latest = p)}
      />
    )
    // The suppressed control can't clear it, so the editor clears the stale slot
    // itself — the loaded state ends up matching the reuse-primary note.
    await waitFor(() => expect(latest?.fallbacks[0].credentialSlot).toBeUndefined())
  })

  it('still offers the credentialSlot dropdown for a single-key provider (Anthropic)', () => {
    render(<Harness initial={{ fallbacks: [{ provider: 'claude', model: 'claude-opus-4-8' }] }} />)
    expect(
      screen.getByLabelText('Credential slot', { selector: '#llm-fallback-0-slot' })
    ).toBeInTheDocument()
  })

  it('persists the expected shape when editing model + slot', () => {
    let latest: LlmPolicy | undefined
    render(
      <Harness
        initial={{
          cooldownSeconds: 300,
          triggerOn: ['auth', 'rate_limited'],
          fallbacks: [{ provider: 'claude', model: 'claude-opus-4-8' }],
        }}
        secretKeys={['claude-api-key', 'claude-api-key-fb1']}
        onLatest={p => (latest = p)}
      />
    )
    fireEvent.change(screen.getByLabelText('Model', { selector: '#llm-fallback-0-model' }), {
      target: { value: 'claude-haiku-4-5' },
    })
    fireEvent.change(
      screen.getByLabelText('Credential slot', { selector: '#llm-fallback-0-slot' }),
      {
        target: { value: 'claude-api-key-fb1' },
      }
    )
    expect(latest).toEqual({
      cooldownSeconds: 300,
      triggerOn: ['auth', 'rate_limited'],
      fallbacks: [
        { provider: 'claude', model: 'claude-haiku-4-5', credentialSlot: 'claude-api-key-fb1' },
      ],
    })
  })

  it('switching provider re-defaults the model and drops the credentialSlot', () => {
    let latest: LlmPolicy | undefined
    render(
      <Harness
        initial={{
          fallbacks: [
            { provider: 'claude', model: 'claude-opus-4-8', credentialSlot: 'claude-api-key-fb1' },
          ],
        }}
        onLatest={p => (latest = p)}
      />
    )
    fireEvent.change(screen.getByLabelText('Provider', { selector: '#llm-fallback-0-provider' }), {
      target: { value: 'openai' },
    })
    expect(latest?.fallbacks[0].provider).toBe('openai')
    expect(['gpt-5.4', 'gpt-5.4-mini']).toContain(latest?.fallbacks[0].model)
    expect(latest?.fallbacks[0].credentialSlot).toBeUndefined()
  })
})
