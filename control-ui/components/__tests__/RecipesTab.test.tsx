import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { WorkflowRecipeResource } from '../../lib/api'
import { RecipesTab } from '../RecipesTab'

const pushSpy = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushSpy }),
}))

afterEach(() => {
  cleanup()
  pushSpy.mockReset()
})

const BASE_RECIPE: WorkflowRecipeResource = {
  apiVersion: 'clerum.io/v1alpha1',
  kind: 'WorkflowRecipe',
  metadata: {
    name: 'test-recipe',
    namespace: 'sandbox-recipes',
    creationTimestamp: '2024-01-01T00:00:00Z',
  },
  spec: { workloads: [{ id: 'w1' }, { id: 'w2' }] },
  status: { phase: 'active' },
}

const DEFAULT_PROPS = {
  items: [BASE_RECIPE],
  loading: false,
  error: '',
  onInstall: vi.fn(),
  onRefresh: vi.fn(),
}

describe('RecipesTab — render', () => {
  it('shows recipe name in table', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    expect(screen.getByText('test-recipe')).toBeInTheDocument()
  })

  it('does not show namespace in the table', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    expect(screen.queryByText('sandbox-recipes')).not.toBeInTheDocument()
  })

  it('does not show workload ids in the table', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    expect(screen.queryByText('w1')).not.toBeInTheDocument()
    expect(screen.queryByText('w2')).not.toBeInTheDocument()
  })

  it("shows phase badge with 'active' text", () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.getByLabelText('Phase: active')).toBeInTheDocument()
  })

  it("shows 'unknown' when the parent recipe has no phase", () => {
    render(<RecipesTab {...DEFAULT_PROPS} items={[{ ...BASE_RECIPE, status: {} }]} />)
    expect(screen.getByText('unknown')).toBeInTheDocument()
    expect(screen.getByLabelText('Phase: unknown')).toBeInTheDocument()
  })

  it("shows 'deploying' when the parent recipe phase is deploying", () => {
    render(
      <RecipesTab {...DEFAULT_PROPS} items={[{ ...BASE_RECIPE, status: { phase: 'deploying' } }]} />
    )

    expect(screen.getByText('deploying')).toBeInTheDocument()
  })

  it("shows 'failed' when the parent recipe phase is failed", () => {
    render(
      <RecipesTab {...DEFAULT_PROPS} items={[{ ...BASE_RECIPE, status: { phase: 'failed' } }]} />
    )

    expect(screen.getByText('failed')).toBeInTheDocument()
  })

  it('keeps the list phase bound to the parent recipe when a current run exists', () => {
    render(
      <RecipesTab
        {...DEFAULT_PROPS}
        items={[
          {
            ...BASE_RECIPE,
            status: {
              phase: 'active',
              workflowExecution: {
                phase: 'running',
                startedAt: '2024-01-01T00:00:05Z',
              },
            },
          },
        ]}
      />
    )

    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.queryByText('running')).not.toBeInTheDocument()
    expect(screen.queryByText('deploying')).not.toBeInTheDocument()
  })

  it('keeps the list phase bound to the parent recipe after a cancelled run', () => {
    render(
      <RecipesTab
        {...DEFAULT_PROPS}
        items={[
          {
            ...BASE_RECIPE,
            status: {
              phase: 'active',
              workflowExecution: {
                phase: 'cancelled',
                startedAt: '2024-01-01T00:00:05Z',
                completedAt: '2024-01-01T00:01:00Z',
              },
            },
          },
        ]}
      />
    )

    expect(screen.getByText('active')).toBeInTheDocument()
    expect(screen.queryByText('cancelled')).not.toBeInTheDocument()
  })

  it('shows Install Plugin button', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    expect(screen.getByText(/Install Plugin/)).toBeInTheDocument()
  })

  it('shows Plugins SDK button', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    expect(screen.getByRole('button', { name: 'Plugins SDK' })).toBeInTheDocument()
  })

  it('shows Refresh button', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    expect(screen.getByLabelText('Reload plugins')).toBeInTheDocument()
  })

  it('renders empty state when no items', () => {
    render(<RecipesTab {...DEFAULT_PROPS} items={[]} />)
    expect(screen.getByText(/No plugins installed/)).toBeInTheDocument()
  })

  it('shows loading state in Refresh button', () => {
    render(<RecipesTab {...DEFAULT_PROPS} loading={true} items={[]} />)
    const refreshBtn = screen.getByLabelText('Refreshing…') as HTMLButtonElement
    expect(refreshBtn.disabled).toBe(true)
  })

  it('shows error message when error prop set', () => {
    render(<RecipesTab {...DEFAULT_PROPS} error="API error 500" />)
    expect(screen.getByText('API error 500')).toBeInTheDocument()
  })

  it('shows table headers with an unlabeled navigation column', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('Created')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Navigation' })).toBeInTheDocument()
    expect(screen.queryByText('Navigation')).not.toBeInTheDocument()
    expect(screen.queryByText('Namespace')).not.toBeInTheDocument()
    expect(screen.queryByText('Workloads')).not.toBeInTheDocument()
    expect(screen.getByText('Phase')).toBeInTheDocument()
    expect(screen.queryByText('Actions')).not.toBeInTheDocument()
  })
})

describe('RecipesTab — actions', () => {
  it("calls onInstall when 'Install Plugin' clicked", () => {
    const onInstall = vi.fn()
    render(<RecipesTab {...DEFAULT_PROPS} onInstall={onInstall} />)
    fireEvent.click(screen.getByText(/Install Plugin/))
    expect(onInstall).toHaveBeenCalledOnce()
  })

  it('calls onRefresh when Refresh clicked', () => {
    const onRefresh = vi.fn()
    render(<RecipesTab {...DEFAULT_PROPS} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByLabelText('Reload plugins'))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it("navigates to the Plugin SDK when 'Plugins SDK' clicked", () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Plugins SDK' }))
    expect(pushSpy).toHaveBeenCalledWith('/plugins/sdk')
  })

  it('does NOT render per-row Status/Edit/Run/Uninstall buttons', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    expect(screen.queryByRole('button', { name: /^status$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^run…$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^uninstall$/i })).not.toBeInTheDocument()
  })
})

describe('RecipesTab — row navigation', () => {
  it('clicking a row navigates to the recipe detail page', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    const row = screen.getByRole('link', { name: /open test-recipe/i })
    fireEvent.click(row)
    expect(pushSpy).toHaveBeenCalledWith('/plugins/sandbox-recipes/test-recipe/workloads')
  })

  it('row is keyboard-activatable via Enter', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    const row = screen.getByRole('link', { name: /open test-recipe/i })
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(pushSpy).toHaveBeenCalledWith('/plugins/sandbox-recipes/test-recipe/workloads')
  })

  it('row is keyboard-activatable via Space', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    const row = screen.getByRole('link', { name: /open test-recipe/i })
    fireEvent.keyDown(row, { key: ' ' })
    expect(pushSpy).toHaveBeenCalledWith('/plugins/sandbox-recipes/test-recipe/workloads')
  })

  it('URL-encodes namespace and name', () => {
    const tricky: WorkflowRecipeResource = {
      ...BASE_RECIPE,
      metadata: { name: 'spaces in name', namespace: 'sandbox-recipes' },
    }
    render(<RecipesTab {...DEFAULT_PROPS} items={[tricky]} />)
    const row = screen.getByRole('link', { name: /open spaces in name/i })
    fireEvent.click(row)
    expect(pushSpy).toHaveBeenCalledWith('/plugins/sandbox-recipes/spaces%20in%20name/workloads')
  })
})
