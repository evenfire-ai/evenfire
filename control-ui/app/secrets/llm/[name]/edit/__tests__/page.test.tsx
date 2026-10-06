import React from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { ToastProvider } from '@components/Toast'
import { apiSend, getHosts, listLlmHostSecrets } from '@lib/api'
import EditLlmSecretPage from '../page'

const navigation = vi.hoisted(() => ({
  params: { name: 'chatllm-api-keys' },
  push: vi.fn(),
  searchParams: new URLSearchParams(),
}))

vi.mock('next/navigation', () => ({
  useParams: () => navigation.params,
  useRouter: () => ({ push: navigation.push }),
  useSearchParams: () => navigation.searchParams,
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@components/AuthGate', () => ({
  AuthGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@components/DashboardLayout', () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}))

vi.mock('@lib/api', async () => {
  const actual = await vi.importActual<typeof import('@lib/api')>('@lib/api')
  return {
    ...actual,
    apiSend: vi.fn(),
    getHosts: vi.fn(),
    listLlmHostSecrets: vi.fn(),
  }
})

const apiSendMock = vi.mocked(apiSend)
const getHostsMock = vi.mocked(getHosts)
const listLlmHostSecretsMock = vi.mocked(listLlmHostSecrets)

const SECRET = 'chatllm-api-keys'

function seedSecret(keys: string[]) {
  listLlmHostSecretsMock.mockResolvedValue({ items: [{ name: SECRET, keys }] })
}

function seedHosts(hosts: Array<{ name: string; secretRef?: string; fallbackSlot?: string }> = []) {
  getHostsMock.mockResolvedValue({
    items: hosts.map(host => ({
      metadata: { name: host.name },
      spec: {
        ...(host.secretRef ? { secretRef: host.secretRef } : {}),
        ...(host.fallbackSlot
          ? {
              llmPolicy: {
                fallbacks: [
                  {
                    provider: 'claude',
                    model: 'claude-sonnet-4-6',
                    credentialSlot: host.fallbackSlot,
                  },
                ],
              },
            }
          : {}),
      },
    })),
  })
}

async function renderEditor() {
  const view = rtlRender(
    <ToastProvider>
      <EditLlmSecretPage />
    </ToastProvider>
  )
  await screen.findByRole('button', { name: 'Update secret' })
  return view
}

const sectionFor = (label: string) =>
  screen.getByText(label, { selector: '.cu-llm-cred-group__title' }).closest('section')!

const removeExtraSlotIn = (label: string) =>
  fireEvent.click(
    within(sectionFor(label)).getByRole('button', { name: 'Remove extra credential slot' })
  )

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Update secret' }))

const replaceOpenAiKey = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Replace OpenAI API key' }))

// Retirement is irreversible, so the save goes through a danger confirm.
async function resolveRemovalConfirm(action: 'Remove and save' | 'Cancel') {
  const dialog = await screen.findByRole('alertdialog')
  fireEvent.click(within(dialog).getByRole('button', { name: action }))
}

beforeEach(() => {
  vi.clearAllMocks()
  navigation.params = { name: SECRET }
  navigation.searchParams = new URLSearchParams()
  apiSendMock.mockResolvedValue(undefined as never)
  seedHosts([])
})

afterEach(() => {
  cleanup()
})

describe('Edit LLM secret page — loading', () => {
  it('loads the named secret and renders the full-screen editor', async () => {
    seedSecret(['openai-api-key', 'claude-api-key'])
    await renderEditor()

    expect(screen.getByRole('heading', { name: `Edit LLM secret: ${SECRET}` })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace OpenAI API key' })).toBeInTheDocument()
    expect(listLlmHostSecretsMock).toHaveBeenCalled()
    expect(getHostsMock).toHaveBeenCalled()
  })

  it('composes the editor inside the shared CreateFlowPanel layout', async () => {
    // Structural parity with the add-LLM-price / add-allowed-model flows:
    // header + body live in one cu-agent-create-panel--with-header, the body
    // is a real form (cu-create-content cu-px-form) with a FormSection and
    // cu-create-actions footer.
    seedSecret(['openai-api-key'])
    const { container } = await renderEditor()

    const panel = container.querySelector('.cu-agent-create-panel--with-header')
    expect(panel).not.toBeNull()
    expect(panel?.querySelector('.cu-agent-create-panel__header')).toContainElement(
      screen.getByRole('heading', { name: `Edit LLM secret: ${SECRET}` })
    )
    const form = panel?.querySelector('form.cu-create-content.cu-px-form')
    expect(form).not.toBeNull()
    expect(form).toContainElement(screen.getByRole('heading', { name: 'Stored credentials' }))
    expect(form).toContainElement(
      screen.getByRole('button', { name: 'Update secret', type: 'submit' })
    )
    expect(form).toContainElement(screen.getByRole('button', { name: 'Cancel' }))
  })

  it('fails closed with an error banner when the Host read fails', async () => {
    seedSecret(['openai-api-key'])
    getHostsMock.mockRejectedValue(new Error('hosts unavailable'))

    rtlRender(
      <ToastProvider>
        <EditLlmSecretPage />
      </ToastProvider>
    )

    expect(await screen.findByText('hosts unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Update secret' })).not.toBeInTheDocument()
    expect(apiSendMock).not.toHaveBeenCalled()
  })

  it('reports a secret that no longer exists', async () => {
    seedSecret([])
    listLlmHostSecretsMock.mockResolvedValue({ items: [] })
    seedHosts([])

    rtlRender(
      <ToastProvider>
        <EditLlmSecretPage />
      </ToastProvider>
    )

    expect(await screen.findByText(SECRET, { selector: 'code' })).toBeInTheDocument()
    expect(screen.getByText(/was not found\./)).toBeInTheDocument()
  })
})

describe('Edit LLM secret page — navigation', () => {
  it('returns to the LLM secrets list by default', async () => {
    seedSecret(['openai-api-key'])
    await renderEditor()

    fireEvent.click(screen.getByRole('button', { name: 'Back to secrets' }))

    expect(navigation.push).toHaveBeenCalledWith('/secrets/llm')
  })

  it('honors an internal from path and returns to it', async () => {
    seedSecret(['openai-api-key'])
    navigation.searchParams = new URLSearchParams({ from: '/agents/foo/model' })
    await renderEditor()

    fireEvent.click(screen.getByRole('button', { name: 'Back to secrets' }))

    expect(navigation.push).toHaveBeenCalledWith('/agents/foo/model')
  })

  it('ignores a non-internal from value', async () => {
    seedSecret(['openai-api-key'])
    navigation.searchParams = new URLSearchParams({ from: 'https://evil.example' })
    await renderEditor()

    fireEvent.click(screen.getByRole('button', { name: 'Back to secrets' }))

    expect(navigation.push).toHaveBeenCalledWith('/secrets/llm')
  })

  it('navigates back after a successful save', async () => {
    seedSecret(['openai-api-key'])
    navigation.searchParams = new URLSearchParams({ from: '/agents/foo/model' })
    await renderEditor()

    replaceOpenAiKey()
    fireEvent.change(screen.getByLabelText(/^OpenAI API key/i), { target: { value: 'sk-live' } })
    save()

    await waitFor(() => {
      expect(apiSendMock).toHaveBeenCalledWith('PUT', '/api/v1/admin/secrets', {
        name: SECRET,
        merge: true,
        stringData: { 'openai-api-key': 'sk-live' },
      })
    })
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith('/agents/foo/model'))
  })
})

// The editor on this page is the only surface that can retire a stored data
// key. These assert the WRITE it produces: without `removeKeys` in the payload
// the key disappears from the editor while surviving in the Secret.
describe('Edit LLM secret page — update payload', () => {
  it('sends removeKeys for a retire-only edit once the removal is confirmed', async () => {
    seedSecret(['claude-api-key-fb1', 'openai-api-key'])
    await renderEditor()
    removeExtraSlotIn('Anthropic')
    save()

    // Nothing is written until the operator confirms.
    await resolveRemovalConfirm('Remove and save')

    await waitFor(() => {
      expect(apiSendMock).toHaveBeenCalledWith('PUT', '/api/v1/admin/secrets', {
        name: SECRET,
        merge: true,
        stringData: {},
        removeKeys: ['claude-api-key-fb1'],
      })
    })
    // Retiring a key IS an edit: the "provide at least one API key" gate must
    // not swallow it.
    expect(screen.queryAllByText(/Provide at least one API key/i)).toHaveLength(0)
  })

  it('writes nothing when the removal confirmation is cancelled', async () => {
    seedSecret(['claude-api-key-fb1', 'openai-api-key'])
    await renderEditor()
    removeExtraSlotIn('Anthropic')
    save()

    await resolveRemovalConfirm('Cancel')

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    expect(apiSendMock).not.toHaveBeenCalled()
    // The edit is still open and still queued — cancelling the confirm is not
    // cancelling the edit.
    expect(screen.getByRole('button', { name: 'Update secret' })).toBeInTheDocument()
  })

  it('sends written values and retired keys in the same merge write', async () => {
    seedSecret(['claude-api-key-fb1', 'openai-api-key'])
    await renderEditor()
    replaceOpenAiKey()
    fireEvent.change(screen.getByLabelText(/^OpenAI API key/i), { target: { value: 'sk-live' } })
    removeExtraSlotIn('Anthropic')
    save()
    await resolveRemovalConfirm('Remove and save')

    await waitFor(() => {
      expect(apiSendMock).toHaveBeenCalledWith('PUT', '/api/v1/admin/secrets', {
        name: SECRET,
        merge: true,
        stringData: { 'openai-api-key': 'sk-live' },
        removeKeys: ['claude-api-key-fb1'],
      })
    })
  })

  it('omits removeKeys — and the confirm — when nothing was retired', async () => {
    seedSecret(['openai-api-key'])
    await renderEditor()
    replaceOpenAiKey()
    fireEvent.change(screen.getByLabelText(/^OpenAI API key/i), { target: { value: 'sk-live' } })
    save()

    await waitFor(() => {
      expect(apiSendMock).toHaveBeenCalledWith('PUT', '/api/v1/admin/secrets', {
        name: SECRET,
        merge: true,
        stringData: { 'openai-api-key': 'sk-live' },
      })
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('writes the key instead of retiring it when a removed slot is re-created', async () => {
    // End-to-end of the delete-then-recreate hole: the payload must WRITE
    // claude-api-key-fb1, never retire it — retirement-wins server-side would
    // otherwise delete the key and discard the value typed for it.
    seedSecret(['claude-api-key-fb1', 'openai-api-key'])
    await renderEditor()
    removeExtraSlotIn('Anthropic')
    fireEvent.click(
      within(sectionFor('Anthropic')).getByRole('button', { name: /Add credential slot/i })
    )
    const anthropic = sectionFor('Anthropic')
    fireEvent.change(within(anthropic).getByLabelText(/Extra credential slot key name/i), {
      target: { value: 'claude-api-key-fb1' },
    })
    fireEvent.change(within(anthropic).getByLabelText(/Extra credential slot value/i), {
      target: { value: 'sk-ant-new' },
    })
    save()

    await waitFor(() => {
      expect(apiSendMock).toHaveBeenCalledWith('PUT', '/api/v1/admin/secrets', {
        name: SECRET,
        merge: true,
        stringData: { 'claude-api-key-fb1': 'sk-ant-new' },
      })
    })
    // No retirement left to confirm.
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('blocks retiring every stored key instead of letting the server 400', async () => {
    seedSecret(['claude-api-key-fb1'])
    await renderEditor()
    removeExtraSlotIn('Anthropic')
    save()

    await waitFor(() => {
      expect(
        screen.getAllByText(/Removing every key would leave the secret empty/i).length
      ).toBeGreaterThan(0)
    })
    // Refused before the confirm — no point asking about a write that cannot
    // succeed.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(apiSendMock).not.toHaveBeenCalled()
  })

  it('still blocks a save that neither writes nor retires anything', async () => {
    seedSecret(['openai-api-key'])
    await renderEditor()
    save()

    expect(screen.getAllByText(/Provide at least one API key/i).length).toBeGreaterThan(0)
    expect(apiSendMock).not.toHaveBeenCalled()
  })

  it('starts from a clean draft on a fresh visit to the route', async () => {
    // Regression guard (route edition): a stale `removedKeys` from a previous
    // visit must not delete keys on the next one. Each navigation remounts the
    // page, so the second visit begins empty.
    seedSecret(['claude-api-key-fb1', 'openai-api-key'])
    const first = rtlRender(
      <ToastProvider>
        <EditLlmSecretPage />
      </ToastProvider>
    )
    await screen.findByRole('button', { name: 'Update secret' })
    removeExtraSlotIn('Anthropic')
    first.unmount()
    cleanup()

    await renderEditor()
    replaceOpenAiKey()
    fireEvent.change(screen.getByLabelText(/^OpenAI API key/i), { target: { value: 'sk-live' } })
    save()

    await waitFor(() => {
      expect(apiSendMock).toHaveBeenCalledWith('PUT', '/api/v1/admin/secrets', {
        name: SECRET,
        merge: true,
        stringData: { 'openai-api-key': 'sk-live' },
      })
    })
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('Edit LLM secret page — fallback credential slot guard', () => {
  it('marks a stored slot still referenced by a Host fallback as locked and unremovable', async () => {
    const fallbackSlot = 'claude-api-key-fb1'
    seedSecret(['openai-api-key', fallbackSlot])
    // The guard scans every Host, not just the linking surface's: any Host
    // whose secretRef points at this Secret contributes protected slots.
    seedHosts([
      { name: 'foo', secretRef: SECRET, fallbackSlot },
      { name: 'unrelated', secretRef: 'another-secret' },
    ])

    await renderEditor()

    // Recipe-edit parity: the row carries a locked state chip, and the remove
    // control is disabled so the retirement cannot even be queued.
    const lockedChip = screen.getByText('fallback-locked', { selector: '.cu-chip' })
    expect(lockedChip).toBeInTheDocument()
    expect(lockedChip).toHaveAttribute(
      'title',
      'An active Host fallback still references this credential slot. Update the fallback configuration before removing this key.'
    )
    const removeButton = within(sectionFor('Anthropic')).getByRole('button', {
      name: 'Remove extra credential slot',
    })
    expect(removeButton).toBeDisabled()
    fireEvent.click(removeButton)
    save()

    expect(screen.getAllByText(/Provide at least one API key/i).length).toBeGreaterThan(0)
    expect(
      apiSendMock.mock.calls.some(args => args[0] === 'PUT' && args[1] === '/api/v1/admin/secrets')
    ).toBe(false)
  })

  it('still blocks a rename that would retire a fallback-locked slot at save time', async () => {
    // The chip and disabled X close the click path; renaming a locked slot
    // with a value still queues the old key for retirement, and the save-time
    // guard refuses it with the actionable reason.
    const fallbackSlot = 'claude-api-key-fb1'
    seedSecret(['openai-api-key', fallbackSlot])
    seedHosts([{ name: 'foo', secretRef: SECRET, fallbackSlot }])

    await renderEditor()
    const anthropic = sectionFor('Anthropic')
    fireEvent.change(within(anthropic).getByLabelText(/Extra credential slot key name/i), {
      target: { value: 'claude-api-key-fb2' },
    })
    // The rename commits the new key, so the row's value input is live.
    fireEvent.change(within(anthropic).getByLabelText(/Extra credential slot value/i), {
      target: { value: 'sk-ant-new' },
    })
    save()

    expect(
      await screen.findByText(
        new RegExp(`Cannot remove "${fallbackSlot}".*active fallback.*credential slot`)
      )
    ).toBeInTheDocument()
    expect(
      apiSendMock.mock.calls.some(args => args[0] === 'PUT' && args[1] === '/api/v1/admin/secrets')
    ).toBe(false)
  })
})

describe('Edit LLM secret page — additional provider credentials', () => {
  it('adds another provider section from the Add provider picker', async () => {
    seedSecret(['openai-api-key'])
    await renderEditor()

    fireEvent.click(screen.getByLabelText('Add provider'))
    fireEvent.click(screen.getByRole('option', { name: 'Anthropic' }))

    expect(
      screen.getByText('Anthropic', { selector: '.cu-llm-cred-group__title' })
    ).toBeInTheDocument()
    expect(screen.getByLabelText(/Claude API key/i)).toBeInTheDocument()
  })

  it('appends a newly added provider below the stored one, whatever the canonical order', async () => {
    // openai canonically precedes zai; the stored zai credentials must stay
    // on top and the session-added OpenAI section must land below them.
    seedSecret(['zai-api-key'])
    await renderEditor()

    fireEvent.click(screen.getByLabelText('Add provider'))
    fireEvent.click(screen.getByRole('option', { name: 'OpenAI' }))

    const titles = document.querySelectorAll('.cu-llm-cred-group__title')
    expect(Array.from(titles).map(entry => entry.textContent)).toEqual(['Z.AI', 'OpenAI'])
  })
})
