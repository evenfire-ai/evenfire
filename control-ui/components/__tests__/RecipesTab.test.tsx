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

  it('shows namespace', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    expect(screen.getByText('sandbox-recipes')).toBeInTheDocument()
  })

  it('shows spec workload ids when no status data available', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    expect(screen.getByText('w1')).toBeInTheDocument()
    expect(screen.getByText('w2')).toBeInTheDocument()
  })

  it('shows workload readiness indicators from the parent recipe resource', () => {
    const recipe: WorkflowRecipeResource = {
      ...BASE_RECIPE,
      status: {
        phase: 'active',
        workloads: [
          { id: 'w1', ready: true, replicas: 1 },
          { id: 'w2', ready: false },
        ],
      },
    }
    render(<RecipesTab {...DEFAULT_PROPS} items={[recipe]} />)
    expect(screen.getByText('w1')).toBeInTheDocument()
    expect(screen.getByText('w2')).toBeInTheDocument()
    expect(screen.getByTitle('Ready')).toBeInTheDocument()
    expect(screen.getByTitle('Not Ready')).toBeInTheDocument()
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

  it('shows table headers (no actions column)', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('Namespace')).toBeInTheDocument()
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
    expect(pushSpy).toHaveBeenCalledWith('/plugin-workload-sdk')
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
    expect(pushSpy).toHaveBeenCalledWith('/workflow-recipes/sandbox-recipes/test-recipe')
  })

  it('row is keyboard-activatable via Enter', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    const row = screen.getByRole('link', { name: /open test-recipe/i })
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(pushSpy).toHaveBeenCalledWith('/workflow-recipes/sandbox-recipes/test-recipe')
  })

  it('row is keyboard-activatable via Space', () => {
    render(<RecipesTab {...DEFAULT_PROPS} />)
    const row = screen.getByRole('link', { name: /open test-recipe/i })
    fireEvent.keyDown(row, { key: ' ' })
    expect(pushSpy).toHaveBeenCalledWith('/workflow-recipes/sandbox-recipes/test-recipe')
  })

  it('URL-encodes namespace and name', () => {
    const tricky: WorkflowRecipeResource = {
      ...BASE_RECIPE,
      metadata: { name: 'spaces in name', namespace: 'sandbox-recipes' },
    }
    render(<RecipesTab {...DEFAULT_PROPS} items={[tricky]} />)
    const row = screen.getByRole('link', { name: /open spaces in name/i })
    fireEvent.click(row)
    expect(pushSpy).toHaveBeenCalledWith('/workflow-recipes/sandbox-recipes/spaces%20in%20name')
  })
})
