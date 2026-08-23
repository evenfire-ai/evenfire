import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { LLM_CREDENTIAL_GROUPS, LLM_SECRET_EDITOR_GROUPS, providerForDataKey } from '@/lib/llm'
import { LlmCredentialFields } from '../LlmCredentialFields'

afterEach(cleanup)

// A tiny controlled host so the component's draft/onChange contract is exercised
// the way the real forms wire it. `onDraftChange` observes every write for the
// cleanup assertions (the draft itself stays write-only).
function Harness({
  existingKeys,
  onDraftChange,
  onRemovedKeysChange,
}: {
  existingKeys?: string[]
  onDraftChange?: (dataKey: string, value: string) => void
  onRemovedKeysChange?: (keys: string[]) => void
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
      onRemovedKeysChange={onRemovedKeysChange}
    />
  )
}

// The "＋ Add provider" picker is a SelectionDropdown: its <Field> label names
// the trigger button, and the options only exist in the DOM while the menu is
// open (single-select closes it again as soon as one is picked).
const addProviderTrigger = () => screen.getByLabelText('Add provider')

function openAddProvider() {
  fireEvent.click(addProviderTrigger())
}

function providerLabel(provider: string): string {
  const group = LLM_CREDENTIAL_GROUPS.find(item => item.provider === provider)
  if (!group) throw new Error(`unknown provider in test: ${provider}`)
  return group.label
}

function addProvider(provider: string) {
  openAddProvider()
  fireEvent.click(screen.getByRole('option', { name: providerLabel(provider) }))
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
    // One option per Secret-backed provider (oauth-broker stays off this form).
    // The dropdown has no placeholder entry — the placeholder lives on the trigger.
    openAddProvider()
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(LLM_SECRET_EDITOR_GROUPS.length)
    expect(
      options.some(option => option.querySelector('[data-provider="codex-subscription"]'))
    ).toBe(false)
    // Every entry carries its provider brand mark, keyed to the provider id.
    for (const group of LLM_SECRET_EDITOR_GROUPS) {
      const option = screen.getByRole('option', { name: group.label })
      expect(
        option.querySelector(`.cu-llm-provider-icon[data-provider="${group.provider}"]`)
      ).not.toBeNull()
    }
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
    openAddProvider()
    expect(screen.queryByRole('option', { name: 'OpenAI' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Anthropic' })).toBeInTheDocument()
    // The rest stays hidden.
    expect(sectionTitle('Anthropic')).toBeNull()
  })

  it('hides the picker once every Secret-backed provider is visible', () => {
    render(<Harness />)
    for (const group of LLM_SECRET_EDITOR_GROUPS) addProvider(group.provider)
    expect(screen.queryByLabelText('Add provider')).toBeNull()
  }, 15_000)

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
    openAddProvider()
    expect(screen.getByRole('option', { name: 'OpenAI' })).toBeInTheDocument()
  })

  it('offers no remove control for a stored provider or one holding a typed value', () => {
    render(<Harness existingKeys={['zai-api-key']} />)
    // Stored in the Secret → retiring it is the per-slot X, never the
    // section-level remove control.
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

// Removing or renaming a STORED extra slot has to travel out of the component
// as an explicit retirement: the draft is write-only, and a blank value is not
// a deletion server-side, so without this channel the row would disappear from
// the form while the key stayed in the Kubernetes Secret forever.
describe('LlmCredentialFields — retiring stored extra slots', () => {
  const removeSlotButton = (group: HTMLElement) =>
    within(group).getByRole('button', { name: 'Remove extra credential slot' })

  // The queued-removal hint is a permanently mounted live region (empty when
  // nothing is queued), and its keys are wrapped in <code>, so it is read as
  // one element's text rather than matched with getByText.
  const removalHint = () => document.querySelector('.cu-llm-cred-removed') as HTMLElement

  it('reports the stored key when its seeded slot is removed', () => {
    const onRemovedKeysChange = vi.fn()
    render(
      <Harness existingKeys={['claude-api-key-fb1']} onRemovedKeysChange={onRemovedKeysChange} />
    )
    // Nothing is pending until the operator acts, but the live region is
    // already mounted so its first announcement is not missed.
    expect(onRemovedKeysChange).toHaveBeenLastCalledWith([])
    expect(removalHint()).toBeEmptyDOMElement()

    fireEvent.click(removeSlotButton(sectionOf('Anthropic')))

    expect(onRemovedKeysChange).toHaveBeenLastCalledWith(['claude-api-key-fb1'])
    // The row is gone, exactly as before — the hint is what makes the queued
    // deletion visible before it is written.
    expect(screen.queryByLabelText(/Extra credential slot key name/i)).toBeNull()
    expect(removalHint()).toHaveTextContent(
      'Will be removed from the stored secret on save: claude-api-key-fb1.'
    )
  })

  it('reports the original key when a seeded slot is renamed with a value', () => {
    const onRemovedKeysChange = vi.fn()
    render(
      <Harness existingKeys={['claude-api-key-fb1']} onRemovedKeysChange={onRemovedKeysChange} />
    )
    const group = sectionOf('Anthropic')
    const name = within(group).getByLabelText(/Extra credential slot key name/i)
    const value = within(group).getByLabelText(/Extra credential slot value/i)

    fireEvent.change(name, { target: { value: 'claude-api-key-fb2' } })
    // Renamed but nothing typed yet: the rename writes no replacement, so
    // retiring the stored key would delete the credential instead of moving it.
    expect(onRemovedKeysChange).toHaveBeenLastCalledWith([])

    fireEvent.change(value, { target: { value: 'sk-ant-new' } })
    expect(onRemovedKeysChange).toHaveBeenLastCalledWith(['claude-api-key-fb1'])

    // Renaming back to the stored name un-queues it — the write now targets the
    // very key that was pending retirement, and "retirement wins" server-side
    // would have dropped the new value.
    fireEvent.change(name, { target: { value: 'claude-api-key-fb1' } })
    expect(onRemovedKeysChange).toHaveBeenLastCalledWith([])
    expect(removalHint()).toBeEmptyDOMElement()
  })

  it('reports nothing when an invalid rename never commits a replacement', () => {
    const onRemovedKeysChange = vi.fn()
    render(
      <Harness existingKeys={['claude-api-key-fb1']} onRemovedKeysChange={onRemovedKeysChange} />
    )
    const group = sectionOf('Anthropic')
    fireEvent.change(within(group).getByLabelText(/Extra credential slot key name/i), {
      target: { value: 'claude-api-key' },
    })
    fireEvent.change(within(group).getByLabelText(/Extra credential slot value/i), {
      target: { value: 'sk-ant-new' },
    })
    // The name collides with the canonical Anthropic slot, so nothing is
    // committed — and an uncommitted rename must not retire anything.
    expect(within(group).getByText(/already exists as a provider slot/i)).toBeInTheDocument()
    expect(onRemovedKeysChange).toHaveBeenLastCalledWith([])
  })

  it('reports nothing when a slot created in this session is removed', () => {
    const onRemovedKeysChange = vi.fn()
    render(<Harness onRemovedKeysChange={onRemovedKeysChange} />)
    addProvider('zai')
    const group = sectionOf('Z.AI')
    fireEvent.click(within(group).getByRole('button', { name: /Add credential slot/i }))
    fireEvent.change(within(group).getByLabelText(/Extra credential slot value/i), {
      target: { value: 'zai-fallback' },
    })
    fireEvent.click(removeSlotButton(group))

    // No stored key was ever behind this row — clearing the draft is the whole
    // removal.
    expect(onRemovedKeysChange).toHaveBeenLastCalledWith([])
    expect(removalHint()).toBeEmptyDOMElement()
  })

  it('un-retires a stored key re-created under the same name (no silent delete)', () => {
    // Repro of the delete-then-recreate hole: X the seeded row, add a fresh
    // slot, type the SAME key name back with a value. If the name kept
    // colliding with `knownKeys` it would never commit, the value would never
    // reach the draft, and the queued retirement would still ship — deleting
    // the key and throwing away the credential typed for it.
    const onDraftChange = vi.fn()
    const onRemovedKeysChange = vi.fn()
    render(
      <Harness
        existingKeys={['claude-api-key-fb1']}
        onDraftChange={onDraftChange}
        onRemovedKeysChange={onRemovedKeysChange}
      />
    )
    fireEvent.click(removeSlotButton(sectionOf('Anthropic')))
    expect(onRemovedKeysChange).toHaveBeenLastCalledWith(['claude-api-key-fb1'])

    const group = sectionOf('Anthropic')
    fireEvent.click(within(group).getByRole('button', { name: /Add credential slot/i }))
    fireEvent.change(within(group).getByLabelText(/Extra credential slot key name/i), {
      target: { value: 'claude-api-key-fb1' },
    })

    // A key on its way out is not a collision — re-typing it takes the removal
    // back, and the row becomes an ordinary seeded row again.
    expect(within(group).queryByText(/already exists as a provider slot/i)).toBeNull()
    expect(onRemovedKeysChange).toHaveBeenLastCalledWith([])
    expect(removalHint()).toBeEmptyDOMElement()

    fireEvent.change(within(group).getByLabelText(/Extra credential slot value/i), {
      target: { value: 'sk-ant-new' },
    })
    expect(onDraftChange).toHaveBeenLastCalledWith('claude-api-key-fb1', 'sk-ant-new')
    expect(onRemovedKeysChange).toHaveBeenLastCalledWith([])
  })

  it('re-creating a retired key with no value neither writes nor retires it', () => {
    const onRemovedKeysChange = vi.fn()
    render(
      <Harness existingKeys={['claude-api-key-fb1']} onRemovedKeysChange={onRemovedKeysChange} />
    )
    fireEvent.click(removeSlotButton(sectionOf('Anthropic')))
    const group = sectionOf('Anthropic')
    fireEvent.click(within(group).getByRole('button', { name: /Add credential slot/i }))
    fireEvent.change(within(group).getByLabelText(/Extra credential slot key name/i), {
      target: { value: 'claude-api-key-fb1' },
    })

    // Nothing queued: the stored key simply survives untouched.
    expect(onRemovedKeysChange).toHaveBeenLastCalledWith([])
    // And the row is a seeded row again, so it is not flagged as an incomplete
    // rename either.
    expect(within(group).queryByText(/Type a value to complete the rename/i)).toBeNull()
  })

  it('flags a seeded slot renamed without a value as an incomplete rename', () => {
    render(<Harness existingKeys={['claude-api-key-fb1']} />)
    const group = sectionOf('Anthropic')
    const name = within(group).getByLabelText(/Extra credential slot key name/i)

    expect(within(group).queryByText(/Type a value to complete the rename/i)).toBeNull()
    fireEvent.change(name, { target: { value: 'claude-api-key-fb2' } })
    // Mute state made audible: the rename writes nothing, so the stored key
    // keeps its old name and saving does nothing to this row.
    expect(
      within(group).getByText(/Type a value to complete the rename.*claude-api-key-fb1/i)
    ).toBeInTheDocument()

    fireEvent.change(within(group).getByLabelText(/Extra credential slot value/i), {
      target: { value: 'sk-ant-new' },
    })
    expect(within(group).queryByText(/Type a value to complete the rename/i)).toBeNull()
  })

  it('does not re-report while unrelated canonical slots are typed', () => {
    const onRemovedKeysChange = vi.fn()
    render(<Harness existingKeys={['openai-api-key']} onRemovedKeysChange={onRemovedKeysChange} />)
    // One report on mount, establishing the (empty) live region.
    expect(onRemovedKeysChange.mock.calls).toHaveLength(1)

    const input = screen.getByLabelText(/^OpenAI API key/i)
    for (const value of ['s', 'sk', 'sk-', 'sk-l']) {
      fireEvent.change(input, { target: { value } })
    }
    // The effect keys off the retirement signature, not the draft — keystrokes
    // that retire nothing must not churn the parent's state.
    expect(onRemovedKeysChange.mock.calls).toHaveLength(1)
  })

  it('lists every queued key in one hint, deduplicated and ordered', () => {
    const onRemovedKeysChange = vi.fn()
    render(
      <Harness
        existingKeys={['openai-api-key-fb2', 'claude-api-key-fb1']}
        onRemovedKeysChange={onRemovedKeysChange}
      />
    )
    fireEvent.click(removeSlotButton(sectionOf('OpenAI')))
    fireEvent.click(removeSlotButton(sectionOf('Anthropic')))

    expect(onRemovedKeysChange).toHaveBeenLastCalledWith([
      'claude-api-key-fb1',
      'openai-api-key-fb2',
    ])
    expect(removalHint()).toHaveTextContent(
      'Will be removed from the stored secret on save: claude-api-key-fb1, openai-api-key-fb2.'
    )
  })
})

describe('providerForDataKey (B1, canonical-slot-prefix aware)', () => {
  it('resolves canonical slot keys to their provider', () => {
    expect(providerForDataKey('openai-api-key')).toBe('openai')
    expect(providerForDataKey('claude-api-key')).toBe('claude')
    expect(providerForDataKey('aws-access-key-id')).toBe('bedrock')
    expect(providerForDataKey('aws-secret-access-key')).toBe('bedrock')
    expect(providerForDataKey('vertex-service-account-json')).toBe('vertex')
  })

  it('resolves extra-slot keys only by canonical-slot prefix', () => {
    expect(providerForDataKey('claude-api-key-fb1')).toBe('claude')
    expect(providerForDataKey('openai-api-key-fb2')).toBe('openai')
    expect(providerForDataKey('zai-secondary-key')).toBeNull()
    expect(providerForDataKey('bedrock-api-key-fb1')).toBeNull()
    // Bedrock extras minted from the canonical slot name carry no `bedrock-`
    // prefix — the canonical-slot-prefix rule must still claim them.
    expect(providerForDataKey('aws-access-key-id-fb1')).toBe('bedrock')
  })

  it('returns null for keys owned by no provider', () => {
    expect(providerForDataKey('random-key')).toBeNull()
    expect(providerForDataKey('openai-project')).toBeNull()
    expect(providerForDataKey('SOME_ENV_VAR')).toBeNull()
    expect(providerForDataKey('')).toBeNull()
  })
})
