import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { LLM_CREDENTIAL_GROUPS, providerForDataKey } from '@/lib/llm'
import { LlmCredentialFields } from '../LlmCredentialFields'

afterEach(cleanup)

// A tiny controlled host so the component's draft/onChange contract is exercised
// the way the real forms wire it. `onDraftChange` observes every write for the
// cleanup assertions (the draft itself stays write-only).
function Harness({
  existingKeys,
  onDraftChange,
}: {
  existingKeys?: string[]
  onDraftChange?: (dataKey: string, value: string) => void
}) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  return (
    <LlmCredentialFields
      draft={draft}
      onChange={(dataKey, value) => {
        onDraftChange?.(dataKey, value)
        setDraft(prev => ({ ...prev, [dataKey]: value }))
      }}
      existingKeys={existingKeys}
    />
  )
}

const addProviderSelect = () => screen.getByLabelText('Add provider') as HTMLSelectElement

function addProvider(provider: string) {
  fireEvent.change(addProviderSelect(), { target: { value: provider } })
}

// Provider sections are the only elements using this title class; option
// elements inside the "Add provider" picker share the same visible label, so
// plain getByText would be ambiguous.
const sectionTitle = (label: string) =>
  screen.queryByText(label, { selector: '.cu-llm-cred-group__title' })

const sectionOf = (label: string) => sectionTitle(label)!.closest('section') as HTMLElement

describe('LlmCredentialFields (additive provider editor)', () => {
  it('starts with no provider sections in create mode and offers every provider', () => {
    const { container } = render(<Harness />)
    expect(container.querySelectorAll('.cu-llm-cred-group')).toHaveLength(0)
    expect(screen.getByText(/No providers added yet/i)).toBeInTheDocument()
    // Placeholder option + one option per provider in the shared package.
    const options = within(addProviderSelect()).getAllByRole('option')
    expect(options).toHaveLength(LLM_CREDENTIAL_GROUPS.length + 1)
  })

  it('edit mode renders only the providers that already have a stored key', () => {
    render(<Harness existingKeys={['zai-api-key']} />)
    expect(sectionTitle('Z.AI')).toBeInTheDocument()
    expect(sectionTitle('OpenAI')).toBeNull()
    expect(sectionTitle('Anthropic')).toBeNull()
    expect(sectionTitle('Amazon Bedrock')).toBeNull()
  })

  it('adding a provider mounts its section and removes it from the picker', () => {
    render(<Harness />)
    addProvider('openai')
    expect(sectionTitle('OpenAI')).toBeInTheDocument()
    expect(within(addProviderSelect()).queryByRole('option', { name: 'OpenAI' })).toBeNull()
    // The rest stays hidden.
    expect(sectionTitle('Anthropic')).toBeNull()
  })

  it('hides the picker once every provider is visible', () => {
    render(<Harness />)
    for (const group of LLM_CREDENTIAL_GROUPS) addProvider(group.provider)
    expect(screen.queryByLabelText('Add provider')).toBeNull()
  })

  it('renders the Bedrock access-key pair and the Vertex JSON textarea when added', () => {
    render(<Harness />)
    addProvider('bedrock')
    addProvider('vertex')
    expect(screen.getByLabelText(/Amazon Bedrock access key ID/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Amazon Bedrock secret access key/i)).toBeInTheDocument()
    const vertex = screen.getByLabelText(/Google Vertex AI service account JSON/i)
    expect(vertex.tagName).toBe('TEXTAREA')
  })

  it('shows the non-secret env hint pointing at Host → Environment (no editor)', () => {
    render(<Harness />)
    addProvider('bedrock')
    expect(screen.getByText(/AWS_REGION/)).toBeInTheDocument()
    const links = screen.getAllByRole('link', { name: /Host → Environment/i })
    expect(links.length).toBeGreaterThan(0)
    expect(links[0]).toHaveAttribute('href', '/agents')
  })

  it('flips a slot chip from absent to present as the value is typed', () => {
    render(<Harness />)
    addProvider('openai')
    // Anchor to start: a bare substring regex would also hit "Azure OpenAI API
    // key" (R6). `^` excludes it while tolerating the trailing chip text.
    const input = screen.getByLabelText(/^OpenAI API key/i)
    // Both a group chip and the per-slot marker read "absent" initially.
    expect(screen.getAllByLabelText('absent').length).toBeGreaterThan(0)
    fireEvent.change(input, { target: { value: 'sk-live' } })
    expect((input as HTMLInputElement).value).toBe('sk-live')
    expect(screen.getAllByLabelText('present').length).toBeGreaterThan(0)
  })

  it('lights up a present chip for a stored key passed via existingKeys (edit mode)', () => {
    render(<Harness existingKeys={['openai-api-key']} />)
    const openaiGroup = sectionOf('OpenAI')
    // The stored key reads "present" even though no value is typed (values are
    // never returned by the listing).
    expect(within(openaiGroup).getAllByLabelText('present').length).toBeGreaterThan(0)
  })

  it('keeps a section visible from a non-empty draft across a remount (create-flow back/forward)', () => {
    // Mirrors /secrets/new: CreateStepFlow unmounts the step on Back, resetting
    // manuallyAdded, while the draft lives in the parent. The draft term of the
    // visibility formula (spec S1) must resurrect the section — otherwise the
    // typed value would be invisible but still submitted.
    function RemountHarness() {
      const [draft, setDraft] = useState<Record<string, string>>({})
      const [mounted, setMounted] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setMounted(current => !current)}>
            toggle-mount
          </button>
          {mounted ? (
            <LlmCredentialFields
              draft={draft}
              onChange={(dataKey, value) => setDraft(prev => ({ ...prev, [dataKey]: value }))}
            />
          ) : null}
        </>
      )
    }
    render(<RemountHarness />)
    addProvider('zai')
    fireEvent.change(screen.getByLabelText(/^Z\.AI API key/i), { target: { value: 'zai-live' } })
    fireEvent.click(screen.getByRole('button', { name: 'toggle-mount' }))
    expect(sectionTitle('Z.AI')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'toggle-mount' }))
    expect(sectionTitle('Z.AI')).toBeInTheDocument()
    expect((screen.getByLabelText(/^Z\.AI API key/i) as HTMLInputElement).value).toBe('zai-live')
  })

  it('a manually added provider without values can be removed and returns to the picker', () => {
    render(<Harness />)
    addProvider('openai')
    fireEvent.click(screen.getByRole('button', { name: 'Remove OpenAI provider' }))
    expect(sectionTitle('OpenAI')).toBeNull()
    expect(within(addProviderSelect()).getByRole('option', { name: 'OpenAI' })).toBeInTheDocument()
  })

  it('offers no remove control for a stored provider or one holding a typed value', () => {
    render(<Harness existingKeys={['zai-api-key']} />)
    // Stored in the Secret → deletion stays on removeSecretKey, never here.
    expect(screen.queryByRole('button', { name: 'Remove Z.AI provider' })).toBeNull()

    addProvider('openai')
    const input = screen.getByLabelText(/^OpenAI API key/i)
    fireEvent.change(input, { target: { value: 'sk-live' } })
    expect(screen.queryByRole('button', { name: 'Remove OpenAI provider' })).toBeNull()
    // Clearing the value re-arms the gate.
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByRole('button', { name: 'Remove OpenAI provider' })).toBeInTheDocument()
  })

  it('removing a provider clears its committed extra-slot keys from the draft', () => {
    const onDraftChange = vi.fn()
    render(<Harness onDraftChange={onDraftChange} />)
    addProvider('zai')
    const group = sectionOf('Z.AI')
    fireEvent.click(within(group).getByRole('button', { name: /Add credential slot/i }))
    const value = within(group).getByLabelText(/Extra credential slot value/i)
    fireEvent.change(value, { target: { value: 'zai-fallback' } })
    // A committed extra-slot value blocks removal (spec S2 gate).
    expect(screen.queryByRole('button', { name: 'Remove Z.AI provider' })).toBeNull()
    fireEvent.change(value, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Z.AI provider' }))
    expect(sectionTitle('Z.AI')).toBeNull()
    // The committed key was cleared — no orphan stays behind in the draft.
    expect(onDraftChange).toHaveBeenLastCalledWith('zai-api-key-fb1', '')
  })

  it('an extra slot renamed to a custom key with a value still blocks removal (S2)', () => {
    // providerForDataKey cannot attribute `team1.key` to any provider, so the
    // gate must fall back to the extra-slot state itself — otherwise the X
    // would silently discard the typed value in one click.
    const onDraftChange = vi.fn()
    render(<Harness onDraftChange={onDraftChange} />)
    addProvider('openai')
    const group = sectionOf('OpenAI')
    fireEvent.click(within(group).getByRole('button', { name: /Add credential slot/i }))
    const name = within(group).getByLabelText(/Extra credential slot key name/i)
    const value = within(group).getByLabelText(/Extra credential slot value/i)
    fireEvent.change(name, { target: { value: 'team1.key' } })
    fireEvent.change(value, { target: { value: 'sk-custom' } })
    expect(onDraftChange).toHaveBeenLastCalledWith('team1.key', 'sk-custom')
    // Committed value under an unattributable key → NOT removable.
    expect(screen.queryByRole('button', { name: 'Remove OpenAI provider' })).toBeNull()
    // Clearing the value re-arms the gate…
    fireEvent.change(value, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove OpenAI provider' }))
    // …and removal cleans the custom committed key out of the draft.
    expect(sectionTitle('OpenAI')).toBeNull()
    expect(onDraftChange).toHaveBeenLastCalledWith('team1.key', '')
  })

  it('a secret holding only an extra slot shows that provider with the slot editable (B1)', () => {
    const onDraftChange = vi.fn()
    render(<Harness existingKeys={['claude-api-key-fb1']} onDraftChange={onDraftChange} />)
    expect(sectionTitle('Anthropic')).toBeInTheDocument()
    const group = sectionOf('Anthropic')
    const name = within(group).getByLabelText(/Extra credential slot key name/i) as HTMLInputElement
    expect(name.value).toBe('claude-api-key-fb1')
    // Its own stored name is not flagged as a collision.
    expect(within(group).queryByText(/already exists as a provider slot/i)).toBeNull()
    // Present in the Secret → never removable from here.
    expect(screen.queryByRole('button', { name: 'Remove Anthropic provider' })).toBeNull()
    // Typing a value rewrites the stored key through the normal commit path.
    fireEvent.change(within(group).getByLabelText(/Extra credential slot value/i), {
      target: { value: 'sk-ant-new' },
    })
    expect(onDraftChange).toHaveBeenLastCalledWith('claude-api-key-fb1', 'sk-ant-new')
  })

  it('adds an extra credential slot with the suggested fallback name (R4.5.6)', () => {
    render(<Harness />)
    addProvider('openai')
    const openaiGroup = sectionOf('OpenAI')
    fireEvent.click(within(openaiGroup).getByRole('button', { name: /Add credential slot/i }))
    const nameInput = within(openaiGroup).getByLabelText(
      /Extra credential slot key name/i
    ) as HTMLInputElement
    expect(nameInput.value).toBe('openai-api-key-fb1')
  })

  it('suggests the next free fallback name when the Secret already claims fb1', () => {
    render(<Harness existingKeys={['openai-api-key', 'openai-api-key-fb1']} />)
    const openaiGroup = sectionOf('OpenAI')
    fireEvent.click(within(openaiGroup).getByRole('button', { name: /Add credential slot/i }))
    const names = within(openaiGroup).getAllByLabelText(/Extra credential slot key name/i)
    // names[0] is the seeded fb1; the new slot skips to fb2.
    expect((names[1] as HTMLInputElement).value).toBe('openai-api-key-fb2')
  })

  it('renaming an extra slot onto a real provider key does not clobber it', () => {
    render(<Harness />)
    addProvider('openai')
    const openai = screen.getByLabelText(/^OpenAI API key/i) as HTMLInputElement
    fireEvent.change(openai, { target: { value: 'sk-real' } })

    const openaiGroup = sectionOf('OpenAI')
    fireEvent.click(within(openaiGroup).getByRole('button', { name: /Add credential slot/i }))
    const extraName = within(openaiGroup).getByLabelText(
      /Extra credential slot key name/i
    ) as HTMLInputElement
    const extraValue = within(openaiGroup).getByLabelText(
      /Extra credential slot value/i
    ) as HTMLInputElement
    fireEvent.change(extraValue, { target: { value: 'sk-fallback' } })

    // Collide the extra slot's name with the real provider slot.
    fireEvent.change(extraName, { target: { value: 'openai-api-key' } })

    // The real OpenAI credential is untouched; the collision is flagged.
    expect(openai.value).toBe('sk-real')
    expect(within(openaiGroup).getByText(/already exists as a provider slot/i)).toBeInTheDocument()
  })
})

describe('providerForDataKey (B1, prefix-aware)', () => {
  it('resolves canonical slot keys to their provider', () => {
    expect(providerForDataKey('openai-api-key')).toBe('openai')
    expect(providerForDataKey('claude-api-key')).toBe('claude')
    expect(providerForDataKey('aws-access-key-id')).toBe('bedrock')
    expect(providerForDataKey('aws-secret-access-key')).toBe('bedrock')
    expect(providerForDataKey('vertex-service-account-json')).toBe('vertex')
  })

  it('resolves extra-slot keys by provider prefix or canonical-slot prefix', () => {
    expect(providerForDataKey('claude-api-key-fb1')).toBe('claude')
    expect(providerForDataKey('openai-api-key-fb2')).toBe('openai')
    expect(providerForDataKey('zai-secondary-key')).toBe('zai')
    expect(providerForDataKey('bedrock-api-key-fb1')).toBe('bedrock')
    // Bedrock extras minted from the canonical slot name carry no `bedrock-`
    // prefix — the canonical-slot-prefix rule must still claim them.
    expect(providerForDataKey('aws-access-key-id-fb1')).toBe('bedrock')
  })

  it('returns null for keys owned by no provider', () => {
    expect(providerForDataKey('random-key')).toBeNull()
    expect(providerForDataKey('SOME_ENV_VAR')).toBeNull()
    expect(providerForDataKey('')).toBeNull()
  })
})
