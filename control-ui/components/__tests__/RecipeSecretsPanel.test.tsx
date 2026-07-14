import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  type RecipeSecretItem,
  type WorkflowRecipeResource,
  getRecipe,
  getRecipeSecrets,
} from '../../lib/api'
import { RecipeSecretsPanel } from '../RecipeSecretsPanel'
import { ToastProvider } from '../Toast'

const pushMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('../../lib/api', () => ({
  getRecipe: vi.fn(),
  getRecipeSecrets: vi.fn(),
}))

const recipe: WorkflowRecipeResource = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: {
    name: 'operator-secret-recipe',
    namespace: 'sandbox-recipes',
  },
  spec: {
    workloads: [
      {
        id: 'api',
        type: 'deployment',
        image: 'example/api:latest',
        envSecret: {
          name: 'operator-api-credentials',
          keys: [
            { secretKey: 'apiKey', envVar: 'API_KEY' },
            { secretKey: 'dbPassword', envVar: 'DB_PASSWORD' },
          ],
        },
      },
    ],
    steps: [
      {
        id: 'call-api',
        run: {
          type: 'snippet',
          language: 'typescript',
          code: 'return { ok: true }',
          capabilities: {
            secrets: [
              {
                alias: 'apiKey',
                secretRef: { name: 'operator-api-credentials', key: 'apiKey' },
              },
            ],
          },
        },
      },
    ],
  },
}

const provisionedSecret: RecipeSecretItem = {
  name: 'operator-api-credentials',
  namespace: 'sandbox-recipes',
  keys: ['apiKey', 'dbPassword'],
  ownership: { kind: 'owner-recipe', recipeName: 'operator-secret-recipe' },
}

function mockRecipeSecrets(items: RecipeSecretItem[]) {
  vi.mocked(getRecipe).mockResolvedValue(recipe)
  vi.mocked(getRecipeSecrets).mockResolvedValue({ items })
}

function renderPanel() {
  return render(
    <ToastProvider>
      <RecipeSecretsPanel recipeName="operator-secret-recipe" />
    </ToastProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RecipeSecretsPanel', () => {
  it('shows declared recipe secret refs as missing and routes to create with required keys', async () => {
    mockRecipeSecrets([])

    renderPanel()

    await waitFor(() => {
      expect(getRecipe).toHaveBeenCalledWith('operator-secret-recipe')
      expect(getRecipeSecrets).toHaveBeenCalled()
    })

    expect(await screen.findByText('operator-api-credentials')).toBeInTheDocument()
    expect(screen.getByText('Missing')).toBeInTheDocument()
    expect(screen.getByText('apiKey, dbPassword')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Add recipe secret operator-api-credentials' })
    )

    expect(pushMock).toHaveBeenCalledWith(
      '/secrets/new?scope=recipe&name=operator-api-credentials&ownerRecipe=operator-secret-recipe&namespace=sandbox-recipes&keys=apiKey%2CdbPassword'
    )
  })

  it('shows provisioned recipe secrets and routes to edit in the target namespace', async () => {
    mockRecipeSecrets([provisionedSecret])

    renderPanel()

    expect(await screen.findByText('operator-api-credentials')).toBeInTheDocument()
    expect(screen.queryByText('Missing')).not.toBeInTheDocument()
    expect(screen.getByText('Owner: operator-secret-recipe')).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'Update recipe secret operator-api-credentials' })
    )

    expect(pushMock).toHaveBeenCalledWith(
      '/secrets/recipe/operator-api-credentials/edit?namespace=sandbox-recipes'
    )
  })
})
