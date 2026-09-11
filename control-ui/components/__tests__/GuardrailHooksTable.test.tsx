import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { LlmHookResource } from '../../lib/api'
import { GuardrailHooksTable } from '../GuardrailHooksTable'

const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push }),
}))

const HOOKS = [
  {
    metadata: { name: 'hook-token-compactor' },
    spec: { lifecyclePoints: ['preCall'], order: 0, failMode: 'open' },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  },
] as unknown as LlmHookResource[]

afterEach(cleanup)
beforeEach(() => vi.clearAllMocks())

describe('GuardrailHooksTable', () => {
  it('offers Install Guardrail, which the page routes to the guardrail marketplace', () => {
    const onInstall = vi.fn()
    render(<GuardrailHooksTable items={HOOKS} onInstall={onInstall} />)
    fireEvent.click(screen.getByRole('button', { name: 'Install Guardrail' }))
    expect(onInstall).toHaveBeenCalledTimes(1)
  })

  it('omits Install Guardrail when the page supplies no handler', () => {
    render(<GuardrailHooksTable items={HOOKS} />)
    expect(screen.queryByRole('button', { name: 'Install Guardrail' })).toBeNull()
  })

  it('a row navigates to the guardrail detail page rather than expanding in place', () => {
    const view = render(<GuardrailHooksTable items={HOOKS} />)
    fireEvent.click(screen.getByRole('button', { name: 'View guardrail hook-token-compactor' }))
    expect(navigation.push).toHaveBeenCalledWith('/guardrails/hook-token-compactor')
    // The chevron is a navigation affordance, not an expander: it must not
    // borrow the expandable-row vocabulary, which promises in-place detail.
    expect(view.container.querySelector('.cu-expandable-row__chevron')).toBeNull()
    expect(view.container.querySelector('.cu-expandable-table')).toBeNull()
    expect(
      view.container.querySelector('[aria-label="View guardrail hook-token-compactor"]')
    ).not.toBeNull()
  })
})
