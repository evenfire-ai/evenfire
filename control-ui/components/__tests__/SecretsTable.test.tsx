import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { getMcpServers, getRecipeSecrets, getRecipes } from '../../lib/api'
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
    getMcpServers: vi.fn(),
    getRecipeSecrets: vi.fn(),
    getRecipes: vi.fn(),
  }
})

const getMcpServersMock = vi.mocked(getMcpServers)
const getRecipeSecretsMock = vi.mocked(getRecipeSecrets)
const getRecipesMock = vi.mocked(getRecipes)

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

    const editButton = await screen.findByRole('button', {
      name: 'Update recipe secret ui-creds',
    })
    fireEvent.click(editButton)

    expect(mockPush).toHaveBeenCalledWith('/secrets/recipe/ui-creds/edit?namespace=sandbox-ui')
  })
})
