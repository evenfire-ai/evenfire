// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TurnGuardrailsLite } from '../../../hooks/useChatStore'
import { MessageGuardrails } from '../MessageGuardrails'

afterEach(cleanup)

const activity = (over: Partial<TurnGuardrailsLite> = {}): TurnGuardrailsLite => ({
  tokensBefore: 96600,
  tokensAfter: 84700,
  llmCalls: 3,
  changes: [
    { sourceId: 'token-trim', kind: 'builtin', deltaTokens: -11900, changed: true, calls: 3 },
    { sourceId: 'prompt-shaping', kind: 'builtin', deltaTokens: 400, changed: true, calls: 3 },
  ],
  ...over,
})

describe('MessageGuardrails (spec §7.1)', () => {
  it('renders nothing when no source acted (a quiet turn shows no shield)', () => {
    const { container } = render(<MessageGuardrails guardrails={activity({ changes: [] })} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the collapsed net delta and toggles the per-source rows', () => {
    render(<MessageGuardrails guardrails={activity()} />)
    const toggle = screen.getByRole('button')
    // Net = 84700 − 96600 = −11900 → "11.9k", direction spelled in the aria-label.
    expect(toggle.textContent).toContain('11.9k')
    expect(toggle.getAttribute('aria-label')).toContain('reduced')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('token-trim (built-in)')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByText('token-trim (built-in)')).not.toBeNull()
    expect(screen.queryByText('prompt-shaping (built-in)')).not.toBeNull()
  })

  it('shows `changed` for a same-size rewrite (net zero, D4) and renders a hook CR name verbatim (§8)', () => {
    render(
      <MessageGuardrails
        guardrails={activity({
          tokensBefore: 100,
          tokensAfter: 100,
          changes: [
            { sourceId: 'my-redactor', kind: 'hook', deltaTokens: 0, changed: true, calls: 1 },
          ],
        })}
      />
    )
    const toggle = screen.getByRole('button')
    expect(toggle.textContent).toContain('changed')
    expect(toggle.getAttribute('aria-label')).toBe('Guardrails changed your input')
    fireEvent.click(toggle)
    expect(screen.queryByText('my-redactor')).not.toBeNull()
  })
})
