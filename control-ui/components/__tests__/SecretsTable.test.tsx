import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import {
  apiSend,
  deleteRecipeSecret,
  getMcpServers,
  getRecipeSecrets,
  getRecipes,
} from '../../lib/api'
import { buildSecretSummary } from '../../test/fixtures/secretSummary'
import { SecretsTable } from '../SecretsTable'
import { ToastProvider } from '../Toast'

const mockReplace = vi.fn()
const mockPush = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}))

vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  return {
    ...actual,
    apiSend: vi.fn(),
    deleteRecipeSecret: vi.fn(),
    getMcpServers: vi.fn(),
    getRecipeSecrets: vi.fn(),
    getRecipes: vi.fn(),
  }
})

const apiSendMock = vi.mocked(apiSend)
const deleteRecipeSecretMock = vi.mocked(deleteRecipeSecret)
const getMcpServersMock = vi.mocked(getMcpServers)
const getRecipeSecretsMock = vi.mocked(getRecipeSecrets)
const getRecipesMock = vi.mocked(getRecipes)

// apiSend is the shared write path for every scope in this table, so its state
// is reset for the whole file rather than per describe.
beforeEach(() => {
  apiSendMock.mockReset()
  apiSendMock.mockResolvedValue(undefined as never)
  deleteRecipeSecretMock.mockReset()
  deleteRecipeSecretMock.mockResolvedValue(undefined as never)
})

function renderTable(
  activeScope: 'mcp' | 'recipe' = 'mcp',
  onCreateRecipeSecretFor: (
    name: string,
    keys: string[],
    ownerRecipe?: string,
    namespace?: string
  ) => void = () => {}
) {
  return rtlRender(
    <ToastProvider>
      <SecretsTable
        activeScope={activeScope}
        items={[]}
        onChanged={async () => {}}
        onCreateLlmSecret={() => {}}
        onCreateMcpSecret={() => {}}
        onCreateRecipeSecret={() => {}}
        onCreateRecipeSecretFor={onCreateRecipeSecretFor}
      />
    </ToastProvider>
  )
}

// The LLM update modal is the only surface that can retire a stored data key.
// These assert the WRITE it produces: without `removeKeys` in the payload the
// row disappears from the editor while the key survives in the Secret.
describe('SecretsTable — LLM secret update payload', () => {
  const SECRET = 'chatllm-api-keys'

  function renderLlmTable(keys: string[]) {
    return rtlRender(
      <ToastProvider>
        <SecretsTable
          activeScope="llm"
          items={[buildSecretSummary({ name: SECRET, keys })]}
          onChanged={async () => {}}
          onCreateLlmSecret={() => {}}
          onCreateMcpSecret={() => {}}
          onCreateRecipeSecret={() => {}}
          onCreateRecipeSecretFor={() => {}}
        />
      </ToastProvider>
    )
  }

  function openUpdateModal(keys: string[]) {
    renderLlmTable(keys)
    fireEvent.click(screen.getByRole('button', { name: `Actions for LLM secret ${SECRET}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
  }

  it('shows the providers whose complete credentials are stored in each secret', () => {
    renderLlmTable(['openai-api-key', 'claude-api-key'])

    const providers = screen.getByLabelText(`Providers for ${SECRET}`)
    expect(within(providers).getByText('OpenAI')).toBeInTheDocument()
    expect(within(providers).getByText('Anthropic')).toBeInTheDocument()
  })

  const sectionFor = (label: string) =>
    screen.getByText(label, { selector: '.cu-llm-cred-group__title' }).closest('section')!

  const removeExtraSlotIn = (label: string) =>
    fireEvent.click(
      within(sectionFor(label)).getByRole('button', { name: 'Remove extra credential slot' })
    )

  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Update secret' }))

  const replaceOpenAiKey = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Replace OpenAI API key' }))

  // Retirement is irreversible, so the save goes through a danger confirm. The
  // dialog is scoped by role — the LLM modal has its own "Cancel" button.
  async function resolveRemovalConfirm(action: 'Remove and save' | 'Cancel') {
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: action }))
  }

  beforeEach(() => {
    mockReplace.mockClear()
    mockPush.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('sends removeKeys for a retire-only edit once the removal is confirmed', async () => {
    openUpdateModal(['claude-api-key-fb1', 'openai-api-key'])
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
    openUpdateModal(['claude-api-key-fb1', 'openai-api-key'])
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
    openUpdateModal(['claude-api-key-fb1', 'openai-api-key'])
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
    openUpdateModal(['openai-api-key'])
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
    openUpdateModal(['claude-api-key-fb1', 'openai-api-key'])
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
    openUpdateModal(['claude-api-key-fb1'])
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

  it('still blocks a save that neither writes nor retires anything', () => {
    openUpdateModal(['openai-api-key'])
    save()

    // Surfaced both in the panel strip and inside the modal.
    expect(screen.getAllByText(/Provide at least one API key/i).length).toBeGreaterThan(0)
    expect(apiSendMock).not.toHaveBeenCalled()
  })

  it('drops queued removals when the modal is closed and reopened', async () => {
    // Regression guard: a stale `removedKeys` would delete keys belonging to
    // whichever secret is edited next.
    renderLlmTable(['claude-api-key-fb1', 'openai-api-key'])
    fireEvent.click(screen.getByRole('button', { name: `Actions for LLM secret ${SECRET}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
    removeExtraSlotIn('Anthropic')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    fireEvent.click(screen.getByRole('button', { name: `Actions for LLM secret ${SECRET}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
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

describe('SecretsTable — connector marketplace source', () => {
  beforeEach(() => {
    getMcpServersMock.mockReset()
    getRecipeSecretsMock.mockReset()
    getRecipesMock.mockReset()
    mockReplace.mockClear()
    mockPush.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('derives registryEntries from catalog-id/version ANNOTATIONS (org-scoped install)', async () => {
    getMcpServersMock.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'newtenantwf-conn',
            annotations: {
              'clerum.io/catalog-id': '@newtenantwf/conn',
              'clerum.io/catalog-version': '1.0.0',
            },
            labels: {
              'clerum.io/managed-by': 'control-api',
              'clerum.io/server-mode': 'local',
            },
          },
          spec: { envSecret: { name: 'newtenantwf-conn-credentials' } },
        },
      ],
    })

    renderTable()

    await waitFor(() => {
      expect(screen.getByText(/@newtenantwf\/conn@1\.0\.0/)).toBeTruthy()
    })
  })

  it('still derives registryEntries from LABELS for legacy (pre-annotation) installs', async () => {
    getMcpServersMock.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'legacy-conn',
            labels: {
              'clerum.io/catalog-id': 'mcp-filesystem',
              'clerum.io/catalog-version': '2.3.0',
              'clerum.io/managed-by': 'control-api',
            },
          },
          spec: { envSecret: { name: 'legacy-conn-credentials' } },
        },
      ],
    })

    renderTable()

    await waitFor(() => {
      expect(screen.getByText(/mcp-filesystem@2\.3\.0/)).toBeTruthy()
    })
  })

  it('prefers ANNOTATIONS over LABELS when both are present', async () => {
    getMcpServersMock.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'both-conn',
            annotations: {
              'clerum.io/catalog-id': '@org/new',
              'clerum.io/catalog-version': '9.9.9',
            },
            labels: {
              'clerum.io/catalog-id': 'stale',
              'clerum.io/catalog-version': '0.0.1',
              'clerum.io/managed-by': 'control-api',
            },
          },
          spec: { envSecret: { name: 'both-conn-credentials' } },
        },
      ],
    })

    renderTable()

    await waitFor(() => {
      expect(screen.getByText(/@org\/new@9\.9\.9/)).toBeTruthy()
    })
    expect(screen.queryByText(/stale@0\.0\.1/)).toBeNull()
  })
})

describe('SecretsTable — recipe deletion identity', () => {
  beforeEach(() => {
    getMcpServersMock.mockReset()
    getRecipeSecretsMock.mockReset()
    getRecipesMock.mockReset()
    mockReplace.mockClear()
    mockPush.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('requires a refresh before deleting a legacy row without identity', async () => {
    getRecipeSecretsMock.mockResolvedValue({
      items: [
        {
          name: 'legacy-recipe-credentials',
          namespace: 'sandbox-recipes',
          keys: ['api-key'],
          ownership: { kind: 'shared' },
        },
      ],
    })
    getRecipesMock.mockResolvedValue({ items: [] })

    renderTable('recipe')

    const trigger = await screen.findByRole('button', {
      name: 'Actions for recipe secret legacy-recipe-credentials',
    })
    fireEvent.click(trigger)
    const deleteAction = screen.getByRole('menuitem', { name: 'Delete' })
    expect(deleteAction).not.toBeDisabled()
    fireEvent.click(deleteAction)

    expect(
      await screen.findByText(
        'Secret legacy-recipe-credentials has no current identity. Refresh the page and review the latest state before deleting it.'
      )
    ).toBeInTheDocument()
    expect(deleteRecipeSecretMock).not.toHaveBeenCalled()
  })

  it('sends the listed identity when deleting a current recipe Secret', async () => {
    getRecipeSecretsMock.mockResolvedValue({
      items: [
        {
          name: 'current-recipe-credentials',
          namespace: 'sandbox-recipes',
          keys: ['api-key'],
          ownership: { kind: 'shared' },
          uid: 'uid-current-recipe-credentials',
          resourceVersion: '7',
        },
      ],
    })
    getRecipesMock.mockResolvedValue({ items: [] })

    renderTable('recipe')

    const trigger = await screen.findByRole('button', {
      name: 'Actions for recipe secret current-recipe-credentials',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Recipe Secret' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(deleteRecipeSecretMock).toHaveBeenCalledWith(
        'current-recipe-credentials',
        'sandbox-recipes',
        { uid: 'uid-current-recipe-credentials', resourceVersion: '7' }
      )
    })
  })
})

describe('SecretsTable — recipe pending refs', () => {
  beforeEach(() => {
    getMcpServersMock.mockReset()
    getRecipeSecretsMock.mockReset()
    getRecipesMock.mockReset()
    mockReplace.mockClear()
    mockPush.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('surfaces missing snippet secretRef keys as recipe secrets to add', async () => {
    getRecipeSecretsMock.mockResolvedValue({ items: [] })
    getRecipesMock.mockResolvedValue({
      items: [
        {
          metadata: { name: 'snippet-recipe' },
          spec: {
            steps: [
              {
                id: 'snippet',
                run: {
                  type: 'snippet',
                  capabilities: {
                    secrets: [{ secretRef: { name: 'snippet-creds', key: 'apiKey' } }],
                  },
                },
              },
            ],
          },
        },
      ],
    })

    renderTable('recipe')

    await waitFor(() => {
      expect(screen.getByText('snippet-creds')).toBeTruthy()
      expect(screen.getByText('apiKey')).toBeTruthy()
      expect(screen.getByText('Missing')).toBeTruthy()
    })
  })

  it('surfaces missing oauth client secret refs as recipe secrets to add', async () => {
    getRecipeSecretsMock.mockResolvedValue({ items: [] })
    getRecipesMock.mockResolvedValue({
      items: [
        {
          metadata: { name: 'oauth-recipe' },
          spec: {
            oauthClients: [
              {
                id: 'github',
                clientIdRef: { name: 'github-oauth', key: 'clientId' },
                clientSecretRef: { name: 'github-oauth', key: 'clientSecret' },
              },
            ],
          },
        },
      ],
    })

    renderTable('recipe')

    await waitFor(() => {
      expect(screen.getByText('github-oauth')).toBeTruthy()
      expect(screen.getByText('clientId, clientSecret')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Add recipe secret github-oauth' })).toBeTruthy()
    })
  })

  it('keeps missing transport workload secrets attached to the mcp-server namespace', async () => {
    getRecipeSecretsMock.mockResolvedValue({ items: [] })
    getRecipesMock.mockResolvedValue({
      items: [
        {
          metadata: { name: 'transport-recipe' },
          spec: {
            workloads: [
              {
                id: 'tools',
                transport: { type: 'streamableHttp', path: '/mcp' },
                envSecret: {
                  name: 'transport-creds',
                  keys: [{ secretKey: 'apiKey', envVar: 'API_KEY' }],
                },
              },
            ],
          },
        },
      ],
    })

    const createFor = vi.fn()
    renderTable('recipe', createFor)

    const addButton = await screen.findByRole('button', {
      name: 'Add recipe secret transport-creds',
    })
    expect(screen.getByText('mcp-server')).toBeTruthy()

    fireEvent.click(addButton)

    expect(createFor).toHaveBeenCalledWith(
      'transport-creds',
      ['apiKey'],
      'transport-recipe',
      'mcp-server'
    )
  })

  it('opens provisioned runtime recipe secrets with their namespace', async () => {
    getRecipeSecretsMock.mockResolvedValue({
      items: [
        {
          name: 'ui-creds',
          namespace: 'sandbox-ui',
          keys: ['apiKey'],
          ownership: { kind: 'shared' },
        },
      ],
    })
    getRecipesMock.mockResolvedValue({ items: [] })

    renderTable('recipe')

    const trigger = await screen.findByRole('button', {
      name: 'Actions for recipe secret ui-creds',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))

    expect(mockPush).toHaveBeenCalledWith('/secrets/recipe/ui-creds/edit?namespace=sandbox-ui')
  })
})
