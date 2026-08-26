import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import type { RegistryEntry } from '../../lib/api'
import { HookInstallForm } from '../HookInstallForm'
import { ToastProvider } from '../Toast'

vi.mock('../../lib/api', () => ({
  getHosts: vi.fn(),
  getRegistryCredentialSchema: vi.fn(),
  installHookFromRegistry: vi.fn(),
}))

function entryWith(hookMeta: Record<string, unknown>): RegistryEntry {
  return {
    name: '@acme1/token-compactor',
    version: '0.2.3',
    entry_type: 'llm-hook',
    description: 'Compacts prompts.',
    hook_meta: {
      target: { image: { ref: 'zot.local/acme1/token-compactor@sha256:abc', port: 8080 } },
      lifecyclePoints: ['preCall'],
      ...hookMeta,
    },
  } as unknown as RegistryEntry
}

/**
 * A Host whose guardrails ceiling allows `ceiling`. `null` writes no ceiling at
 * all, which the install route reads as the empty set — an agent that permits
 * nothing, not one that permits everything.
 */
function host(name: string, ceiling: string[] | null) {
  return { metadata: { name }, spec: ceiling ? { guardrails: { capabilityCeiling: ceiling } } : {} }
}

/** A ceiling that permits every capability, so a test can isolate the seeding. */
const ALL_CAPABILITIES = ['may_deny', 'may_rewrite', 'may_substitute_result', 'may_add_context']

function render(ui: React.ReactNode) {
  return rtlRender(<ToastProvider>{ui}</ToastProvider>)
}

function capabilityBox(label: string): HTMLInputElement {
  // CheckboxField renders the label text alongside its input.
  return screen.getByRole('checkbox', { name: new RegExp(label, 'i') }) as HTMLInputElement
}

/**
 * Capabilities, order, and fail mode live inside the "Advanced details"
 * disclosure, so none of them are in the DOM until it is open. Idempotent on
 * purpose: if the section ever ships open by default, an unconditional click
 * would close it and fail every test here for an unrelated reason.
 */
async function openAdvanced() {
  const toggle = await screen.findByRole('button', { name: /advanced details/i })
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle)
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: /may deny/i })).toBeInTheDocument()
  )
}

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getRegistryCredentialSchema).mockResolvedValue({ keys: [] } as never)
  vi.mocked(api.getHosts).mockResolvedValue({
    items: [host('agent-a', ALL_CAPABILITIES)],
  } as never)
})

const noop = () => undefined

describe('HookInstallForm — author declarations', () => {
  it('pre-ticks the capabilities the author declares', async () => {
    render(
      <HookInstallForm
        entry={entryWith({ requiredCapabilities: ['may_rewrite'] })}
        onCancel={noop}
        onInstalled={noop}
      />
    )
    await openAdvanced()
    await waitFor(() => expect(capabilityBox('May rewrite').checked).toBe(true))
    expect(capabilityBox('May deny').checked).toBe(false)
    expect(screen.getByText(/required by this hook/i)).toBeInTheDocument()
  })

  it('leaves everything unticked when the author declares nothing', async () => {
    render(<HookInstallForm entry={entryWith({})} onCancel={noop} onInstalled={noop} />)
    await openAdvanced()
    expect(capabilityBox('May rewrite').checked).toBe(false)
    expect(capabilityBox('May deny').checked).toBe(false)
    expect(screen.queryByText(/required by this hook/i)).toBeNull()
  })

  it('applies the author fail mode', async () => {
    render(
      <HookInstallForm
        entry={entryWith({ authorDefaults: { failMode: 'closed' } })}
        onCancel={noop}
        onInstalled={noop}
      />
    )
    await openAdvanced()
    const select = await screen.findByLabelText(/fail mode/i)
    await waitFor(() => expect(select).toHaveValue('closed'))
  })

  it('shows the order hint without inventing a numeric order', async () => {
    render(
      <HookInstallForm
        entry={entryWith({ authorDefaults: { orderHint: 'early' } })}
        onCancel={noop}
        onInstalled={noop}
      />
    )
    await openAdvanced()
    expect(await screen.findByText(/suggests running this hook early/i)).toBeInTheDocument()
    // `order` stays the backend default — the hint is a word, not a number.
    expect(await screen.findByLabelText(/^order$/i)).toHaveValue(100)
  })

  it('ignores an order hint naming an inherited object key', async () => {
    // `orderHint: "toString"` used to resolve to Object.prototype.toString off
    // the label map and render as if it were a real hint.
    render(
      <HookInstallForm
        entry={entryWith({ authorDefaults: { orderHint: 'toString' } })}
        onCancel={noop}
        onInstalled={noop}
      />
    )
    await openAdvanced()
    const order = await screen.findByLabelText(/^order$/i)
    expect(order).toHaveValue(100)
    expect(screen.queryByText(/native code/i)).toBeNull()
    expect(screen.queryByText(/the author suggests/i)).toBeNull()
  })

  it('ignores capability values outside the known set', async () => {
    render(
      <HookInstallForm
        entry={entryWith({ requiredCapabilities: ['not_a_capability', 'may_deny'] })}
        onCancel={noop}
        onInstalled={noop}
      />
    )
    await openAdvanced()
    await waitFor(() => expect(capabilityBox('May deny').checked).toBe(true))
    expect(capabilityBox('May rewrite').checked).toBe(false)
  })

  it('survives a malformed declaration rather than breaking the page', async () => {
    render(
      <HookInstallForm
        entry={entryWith({ requiredCapabilities: 'may_deny' })}
        onCancel={noop}
        onInstalled={noop}
      />
    )
    await openAdvanced()
    await waitFor(() => expect(capabilityBox('May deny')).toBeInTheDocument())
    expect(capabilityBox('May deny').checked).toBe(false)
  })
})

describe('HookInstallForm — declaration never escapes the ceiling', () => {
  it('does not grant a declared capability the agent forbids, and says so', async () => {
    vi.mocked(api.getHosts).mockResolvedValue({
      items: [host('agent-a', ['may_add_context'])],
    } as never)
    render(
      <HookInstallForm
        entry={entryWith({ requiredCapabilities: ['may_deny'] })}
        onCancel={noop}
        onInstalled={noop}
      />
    )
    await openAdvanced()
    // Declared, but outside the ceiling: unticked, disabled, and flagged.
    await waitFor(() => expect(capabilityBox('May deny')).toBeDisabled())
    expect(capabilityBox('May deny').checked).toBe(false)
    // The declared-but-forbidden one is marked as both, not merely forbidden.
    expect(
      screen.getByText(/required by this hook, but outside the agent's ceiling/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/needs may_deny to function/i)).toBeInTheDocument()
  })

  it('grants nothing on an agent with no ceiling, matching the install route', async () => {
    // control-api reads a missing capabilityCeiling as [] and 403s anything
    // requested against it, so a seeded tick here would submit a request the
    // server is certain to reject.
    vi.mocked(api.getHosts).mockResolvedValue({ items: [host('agent-a', null)] } as never)
    render(
      <HookInstallForm
        entry={entryWith({ requiredCapabilities: ['may_rewrite'] })}
        onCancel={noop}
        onInstalled={noop}
      />
    )
    await openAdvanced()
    await waitFor(() => expect(capabilityBox('May rewrite')).toBeDisabled())
    expect(capabilityBox('May rewrite').checked).toBe(false)
    expect(screen.getByText(/no capability can be granted/i)).toBeInTheDocument()
    expect(screen.getByText(/needs may_rewrite to function/i)).toBeInTheDocument()
  })

  it('a declared may_deny still forces fail closed, as a manual tick does', async () => {
    render(
      <HookInstallForm
        entry={entryWith({
          requiredCapabilities: ['may_deny'],
          // The author asks for fail open; may_deny overrides it.
          authorDefaults: { failMode: 'open' },
        })}
        onCancel={noop}
        onInstalled={noop}
      />
    )
    await openAdvanced()
    await waitFor(() => expect(capabilityBox('May deny').checked).toBe(true))
    const select = await screen.findByLabelText(/fail mode/i)
    expect(select).toHaveValue('closed')
    expect(select).toBeDisabled()
  })
})

describe('HookInstallForm — ungranted-capability warning', () => {
  // `enforceCapabilities` neutralizes deny/rewrite/substitute and nothing else,
  // so the "actions are discarded" warning must not be shown for a capability
  // the runtime never withholds.
  it('does not claim discarded actions for an unenforced capability', async () => {
    vi.mocked(api.getHosts).mockResolvedValue({ items: [host('agent-a', null)] } as never)
    render(
      <HookInstallForm
        entry={entryWith({ requiredCapabilities: ['may_add_context'] })}
        onCancel={noop}
        onInstalled={noop}
      />
    )
    await openAdvanced()
    await waitFor(() =>
      expect(screen.getByText(/the author lists may_add_context/i)).toBeInTheDocument()
    )
    expect(screen.getByText(/does not enforce today/i)).toBeInTheDocument()
    expect(screen.queryByText(/the actions it takes are discarded/i)).toBeNull()
  })

  it('warns about the enforced capability and notes the unenforced one apart', async () => {
    vi.mocked(api.getHosts).mockResolvedValue({ items: [host('agent-a', null)] } as never)
    render(
      <HookInstallForm
        entry={entryWith({ requiredCapabilities: ['may_deny', 'may_add_context'] })}
        onCancel={noop}
        onInstalled={noop}
      />
    )
    await openAdvanced()
    // The strong warning names only the capability the runtime withholds.
    await waitFor(() => expect(screen.getByText(/needs may_deny to function/i)).toBeInTheDocument())
    expect(screen.queryByText(/needs may_deny, may_add_context to function/i)).toBeNull()
    expect(screen.getByText(/the author also lists may_add_context/i)).toBeInTheDocument()
  })
})
