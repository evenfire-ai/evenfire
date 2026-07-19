import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { LlmCredentialFields } from '../LlmCredentialFields'

afterEach(cleanup)

// A tiny controlled host so the component's draft/onChange contract is exercised
// the way the real forms wire it.
function Harness({ existingKeys }: { existingKeys?: string[] }) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  return (
    <LlmCredentialFields
      draft={draft}
      onChange={(dataKey, value) => setDraft(prev => ({ ...prev, [dataKey]: value }))}
      existingKeys={existingKeys}
    />
  )
}

describe('LlmCredentialFields (spec R4.5)', () => {
  it('renders a group per provider from the shared package', () => {
    render(<Harness />)
    for (const label of [
      'OpenAI',
      'Anthropic',
      'Z.AI',
      'Bailian',
      'Google Vertex AI',
      'Amazon Bedrock',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('renders the Bedrock access-key pair and the Vertex JSON textarea', () => {
    render(<Harness />)
    expect(screen.getByLabelText(/Amazon Bedrock access key ID/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/Amazon Bedrock secret access key/i)).toBeInTheDocument()
    const vertex = screen.getByLabelText(/Google Vertex AI service account JSON/i)
    expect(vertex.tagName).toBe('TEXTAREA')
  })

  it('shows the non-secret env hint pointing at Host → Environment (no editor)', () => {
    render(<Harness />)
    expect(screen.getByText(/AWS_REGION/)).toBeInTheDocument()
    const links = screen.getAllByRole('link', { name: /Host → Environment/i })
    expect(links.length).toBeGreaterThan(0)
    expect(links[0]).toHaveAttribute('href', '/agents')
  })

  it('flips a slot chip from absent to present as the value is typed', () => {
    render(<Harness />)
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
    const openaiGroup = screen.getByText('OpenAI').closest('section') as HTMLElement
    // The stored key reads "present" even though no value is typed (values are
    // never returned by the listing).
    expect(within(openaiGroup).getAllByLabelText('present').length).toBeGreaterThan(0)
  })

  it('adds an extra credential slot with the suggested fallback name (R4.5.6)', () => {
    render(<Harness />)
    const openaiGroup = screen.getByText('OpenAI').closest('section') as HTMLElement
    fireEvent.click(within(openaiGroup).getByRole('button', { name: /Add credential slot/i }))
    const nameInput = within(openaiGroup).getByLabelText(
      /Extra credential slot key name/i
    ) as HTMLInputElement
    expect(nameInput.value).toBe('openai-api-key-fb1')
  })

  it('renaming an extra slot onto a real provider key does not clobber it', () => {
    render(<Harness />)
    const openai = screen.getByLabelText(/^OpenAI API key/i) as HTMLInputElement
    fireEvent.change(openai, { target: { value: 'sk-real' } })

    const openaiGroup = screen.getByText('OpenAI').closest('section') as HTMLElement
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
