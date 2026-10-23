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
  deleteMcpSecret,
  deleteRecipeSecret,
  getMcpServers,
  getRecipeSecrets,
  getRecipes,
  listMcpSecrets,
} from '../../lib/api'
import {
  buildDirectCrdMcpServerReference,
  buildRegistryMcpServerReference,
} from '../../test/fixtures/mcpServer'
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
    deleteMcpSecret: vi.fn(),
    deleteRecipeSecret: vi.fn(),
    getMcpServers: vi.fn(),
    getRecipeSecrets: vi.fn(),
    getRecipes: vi.fn(),
    listMcpSecrets: vi.fn(),
  }
})

const apiSendMock = vi.mocked(apiSend)
const deleteMcpSecretMock = vi.mocked(deleteMcpSecret)
const deleteRecipeSecretMock = vi.mocked(deleteRecipeSecret)
const getMcpServersMock = vi.mocked(getMcpServers)
const getRecipeSecretsMock = vi.mocked(getRecipeSecrets)
const getRecipesMock = vi.mocked(getRecipes)
const listMcpSecretsMock = vi.mocked(listMcpSecrets)

// apiSend is the shared write path for every scope in this table, so its state
// is reset for the whole file rather than per describe.
beforeEach(() => {
  apiSendMock.mockReset()
  apiSendMock.mockResolvedValue(undefined as never)
  deleteMcpSecretMock.mockReset()
  deleteMcpSecretMock.mockResolvedValue(undefined as never)
  deleteRecipeSecretMock.mockReset()
  deleteRecipeSecretMock.mockResolvedValue(undefined as never)
  // The provisioned listing defaults to empty; connector tests that care
  // about unreferenced secrets or delete identity override it explicitly.
  listMcpSecretsMock.mockReset()
  listMcpSecretsMock.mockResolvedValue({ items: [] })
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

describe('SecretsTable — LLM secret update entry point', () => {
  const SECRET = 'chatllm-api-keys'

  beforeEach(() => {
    mockReplace.mockClear()
    mockPush.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

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

  it('shows the providers whose complete credentials are stored in each secret', () => {
    renderLlmTable(['openai-api-key', 'claude-api-key'])

    const providers = screen.getByLabelText(`Providers for ${SECRET}`)
    expect(within(providers).getByText('OpenAI')).toBeInTheDocument()
    expect(within(providers).getByText('Anthropic')).toBeInTheDocument()
  })

  it('navigates from the Update action to the full-screen secret editor', () => {
    renderLlmTable(['openai-api-key'])

    fireEvent.click(screen.getByRole('button', { name: `Actions for LLM secret ${SECRET}` }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))

    expect(mockPush).toHaveBeenCalledWith(`/secrets/llm/${SECRET}/edit`)
    // The editor moved to its own route — no stacked modal remains here.
    expect(screen.queryByRole('button', { name: 'Update secret' })).not.toBeInTheDocument()
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
    const connector = buildRegistryMcpServerReference({
      name: 'newtenantwf-conn',
      catalogId: '@newtenantwf/conn',
      catalogVersion: '1.0.0',
    })
    expect(connector.spec?.managed).toBe(true)
    expect(connector.spec?.envSecret?.keys).toEqual([{ secretKey: 'api-key', envVar: 'api-key' }])
    getMcpServersMock.mockResolvedValue({
      items: [connector],
    })

    renderTable()

    await waitFor(() => {
      expect(screen.getByText(/@newtenantwf\/conn@1\.0\.0/)).toBeTruthy()
    })
    const row = screen.getByText('newtenantwf-conn-credentials').closest('tr')!
    expect(within(row).getByText('1 server(s): newtenantwf-conn')).toBeInTheDocument()
  })

  it('still derives registryEntries from LABELS for legacy (pre-annotation) installs', async () => {
    getMcpServersMock.mockResolvedValue({
      items: [
        buildDirectCrdMcpServerReference({
          name: 'legacy-conn',
          secretName: 'legacy-conn-credentials',
          labels: {
            'clerum.io/catalog-id': 'mcp-filesystem',
            'clerum.io/catalog-version': '2.3.0',
            'clerum.io/managed-by': 'control-api',
          },
        }),
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
        buildDirectCrdMcpServerReference({
          name: 'both-conn',
          secretName: 'both-conn-credentials',
          annotations: {
            'clerum.io/catalog-id': '@org/new',
            'clerum.io/catalog-version': '9.9.9',
          },
          labels: {
            'clerum.io/catalog-id': 'stale',
            'clerum.io/catalog-version': '0.0.1',
            'clerum.io/managed-by': 'control-api',
          },
        }),
      ],
    })

    renderTable()

    await waitFor(() => {
      expect(screen.getByText(/@org\/new@9\.9\.9/)).toBeTruthy()
    })
    expect(screen.queryByText(/stale@0\.0\.1/)).toBeNull()
  })

  it('lists a newly created connector secret that no server references yet', async () => {
    getMcpServersMock.mockResolvedValue({
      items: [
        buildDirectCrdMcpServerReference({
          name: 'attached-conn',
          secretName: 'attached-conn-credentials',
        }),
      ],
    })
    listMcpSecretsMock.mockResolvedValue({
      items: [
        { name: 'attached-conn-credentials', keys: ['api-key'] },
        { name: 'brand-new-conn-credentials', keys: ['api-key'] },
      ],
    })

    renderTable()

    const freshRow = await waitFor(() => {
      const row = screen.getByText('brand-new-conn-credentials').closest('tr')!
      expect(row).toBeTruthy()
      return row
    })
    expect(within(freshRow).getByText('Not yet attached to a connector.')).toBeInTheDocument()
    expect(within(freshRow).getByText('Created manually or source unknown.')).toBeInTheDocument()
    const attachedRow = screen.getByText('attached-conn-credentials').closest('tr')!
    expect(within(attachedRow).getByText('1 server(s): attached-conn')).toBeInTheDocument()
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

describe('SecretsTable — connector row actions', () => {
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

  function mockConnectorRow(identity?: { uid?: string; resourceVersion?: string }) {
    getMcpServersMock.mockResolvedValue({
      items: [
        buildDirectCrdMcpServerReference({
          name: 'linear-conn',
          secretName: 'linear-credentials',
          annotations: {
            'clerum.io/catalog-id': 'mcp-linear',
            'clerum.io/catalog-version': '1.4.0',
          },
        }),
      ],
    })
    if (identity) {
      listMcpSecretsMock.mockResolvedValue({
        items: [{ name: 'linear-credentials', keys: ['api-key'], ...identity }],
      })
    }
  }

  async function openRowMenu() {
    const trigger = await screen.findByRole('button', {
      name: 'Actions for connector secret linear-credentials',
    })
    fireEvent.click(trigger)
  }

  it('offers Update and enabled Delete, and no create-flow Add, on an existing secret', async () => {
    mockConnectorRow({
      uid: 'uid-linear-1',
      resourceVersion: '42',
    })
    renderTable()
    await openRowMenu()

    expect(screen.getByRole('menuitem', { name: 'Update' })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: /^Delete/ })).toBeEnabled()
    // The Secret exists (the listing returned it); the create flow would 409.
    expect(screen.queryByRole('menuitem', { name: 'Add' })).toBeNull()
  })

  it('routes Add to the create flow only for a referenced but missing secret', async () => {
    getMcpServersMock.mockResolvedValue({
      items: [
        buildDirectCrdMcpServerReference({
          name: 'ghost-conn',
          secretName: 'ghost-credentials',
        }),
      ],
    })
    renderTable()

    const trigger = await screen.findByRole('button', {
      name: 'Actions for connector secret ghost-credentials',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add' }))

    expect(mockPush).toHaveBeenCalledWith('/secrets/new?scope=mcp&name=ghost-credentials')
  })

  it('deletes a connector secret through its live identity after confirmation', async () => {
    mockConnectorRow({
      uid: 'uid-linear-1',
      resourceVersion: '42',
    })
    deleteMcpSecretMock.mockResolvedValue({ name: 'linear-credentials', namespace: 'mcp-servers' })
    renderTable()
    await openRowMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: /^Delete/ }))
    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(deleteMcpSecretMock).toHaveBeenCalledWith('linear-credentials', {
        uid: 'uid-linear-1',
        resourceVersion: '42',
      })
    })
  })

  it('keeps Delete disabled without a listing-provided identity', async () => {
    mockConnectorRow()
    renderTable()
    await openRowMenu()

    const deleteAction = screen.getByRole('menuitem', { name: /^Delete/ })
    expect(deleteAction).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByText('Refresh to load this Secret identity before deleting it.')
    ).toBeInTheDocument()

    fireEvent.click(deleteAction)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(apiSendMock).not.toHaveBeenCalled()
  })

  it('navigates Update to the connector secret edit page for its attached connector', async () => {
    mockConnectorRow()
    renderTable()
    await openRowMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))

    expect(mockPush).toHaveBeenCalledWith(
      '/secrets/connector/linear-credentials/edit?server=linear-conn'
    )
  })

  it('navigates Update without a server filter when several connectors share the secret', async () => {
    getMcpServersMock.mockResolvedValue({
      items: [
        buildDirectCrdMcpServerReference({ name: 'conn-a', secretName: 'shared-credentials' }),
        buildDirectCrdMcpServerReference({ name: 'conn-b', secretName: 'shared-credentials' }),
      ],
    })
    renderTable()

    fireEvent.click(
      await screen.findByRole('button', { name: 'Actions for connector secret shared-credentials' })
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))

    expect(mockPush).toHaveBeenCalledWith('/secrets/connector/shared-credentials/edit')
  })

  it('keeps a non-canonical Secret reference distinct from its trimmed name', async () => {
    getMcpServersMock.mockResolvedValue({
      items: [
        buildDirectCrdMcpServerReference({
          name: 'canonical-conn',
          secretName: 'linear-credentials',
        }),
        buildDirectCrdMcpServerReference({
          name: 'stale-conn',
          secretName: '  linear-credentials  ',
        }),
      ],
    })
    renderTable()

    const malformedIdentity = await screen.findByText(
      (_, element) =>
        element?.tagName === 'CODE' && element.textContent === '"  linear-credentials  "'
    )
    const malformedRow = malformedIdentity.closest('tr')!
    const canonicalRow = screen.getByText('linear-credentials').closest('tr')!
    expect(within(malformedRow).getByText('1 server(s): stale-conn')).toBeInTheDocument()
    expect(within(canonicalRow).getByText('1 server(s): canonical-conn')).toBeInTheDocument()
    expect(within(canonicalRow).queryByText(/stale-conn/)).not.toBeInTheDocument()

    fireEvent.click(within(malformedRow).getByRole('button'))
    expect(screen.getByRole('menuitem', { name: /^Add/ })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Update' }))
    expect(mockPush).toHaveBeenCalledWith(
      '/secrets/connector/%20%20linear-credentials%20%20/edit?server=stale-conn'
    )
    expect(apiSendMock).not.toHaveBeenCalled()
  })

  it('still prefills the create flow from the row Add action', async () => {
    mockConnectorRow()
    renderTable()
    await openRowMenu()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Add' }))

    expect(mockPush).toHaveBeenCalledWith(
      '/secrets/new?scope=mcp&name=linear-credentials&registryEntry=mcp-linear&registryVersion=1.4.0'
    )
  })

  it('does not leak the internal connector lifecycle note', async () => {
    getMcpServersMock.mockResolvedValue({ items: [] })
    renderTable()

    await screen.findByText('No connector secrets found.')
    expect(screen.queryByText(/Connector secret lifecycle/i)).toBeNull()
    expect(screen.queryByText(/requires backend API support/i)).toBeNull()
  })
})

describe('SecretsTable — recipe missing-secret hint copy', () => {
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

  it('separates "Add" and "on" in the missing-secret hint (BUG-26)', async () => {
    getRecipeSecretsMock.mockResolvedValue({ items: [] })
    getRecipesMock.mockResolvedValue({
      items: [
        {
          metadata: { name: 'hint-recipe' },
          spec: {
            steps: [
              {
                id: 'snippet',
                run: {
                  type: 'snippet',
                  capabilities: {
                    secrets: [{ secretRef: { name: 'hint-creds', key: 'apiKey' } }],
                  },
                },
              },
            ],
          },
        },
      ],
    })

    renderTable('recipe')

    const hint = await waitFor(() => {
      const match = screen
        .getAllByText((_, element) => element?.classList.contains('cu-banner') ?? false)
        .find(element =>
          (element.textContent ?? '').replace(/\s+/g, ' ').includes('Click Add on a Missing row')
        )
      if (!match) throw new Error('missing-secret hint banner not rendered yet')
      return match
    })
    expect(hint.textContent?.replace(/\s+/g, ' ')).not.toMatch(/Addon/)
  })
})

describe('SecretsTable — LLM empty state', () => {
  it('shows LLM API Keys and LLM Subscriptions as sibling top-level scopes', async () => {
    rtlRender(
      <ToastProvider>
        <SecretsTable
          activeScope="llm"
          items={[]}
          onChanged={async () => {}}
          onCreateLlmSecret={() => {}}
          onCreateMcpSecret={() => {}}
          onCreateRecipeSecret={() => {}}
          onCreateRecipeSecretFor={() => {}}
        />
      </ToastProvider>
    )
    expect(await screen.findByText('No LLM secrets found.')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'LLM API Keys' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByRole('tab', { name: 'LLM Subscriptions' })).toHaveAttribute(
      'href',
      '/secrets/llm/subscriptions'
    )
    expect(screen.getByRole('tab', { name: 'Connector' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Recipe' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'API-KEY' })).not.toBeInTheDocument()
  })
})

// ─── Connector Secret management guidance ───────────────────────────────────
//
// Reusable connector Secrets are assigned from a connector's Credentials tab
// (Change assigned Secret) or during connector creation. The Connectors scope
// header is where operators look first, so it carries that pointer instead of
// the generic one-liner.
describe('SecretsTable — connector Secret management guidance', () => {
  afterEach(() => {
    cleanup()
  })

  it('points at assignment from creation and the Credentials tab in the Connectors scope', () => {
    renderTable('mcp')

    expect(
      screen.getByText(
        /Create reusable connector Secrets here\. Assign them when creating a connector or from its Credentials tab using Change assigned Secret\./
      )
    ).toBeInTheDocument()
  })

  it('keeps the generic subtitle outside the Connectors scope', () => {
    renderTable('recipe')

    expect(
      screen.getByText('Manage LLM, connector, and recipe credentials in one place.')
    ).toBeInTheDocument()
    expect(screen.queryByText(/Change assigned Secret/)).not.toBeInTheDocument()
  })
})
