import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { WorkflowRecipeResource } from '@lib/api'
import { getRecipes } from '@lib/api'
import { useRecipePolling } from '../useRecipePolling'

vi.mock('@lib/api', () => ({
  getRecipes: vi.fn(),
}))

const mockGetRecipes = vi.mocked(getRecipes)

function makeRecipe(name: string, phase: string): WorkflowRecipeResource {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: {
      name,
      namespace: 'sandbox-recipes',
      creationTimestamp: '2024-01-01T00:00:00Z',
    },
    spec: {
      workloads: [{ id: 'worker' }],
    },
    status: { phase: phase as WorkflowRecipeResource['status']['phase'] },
  }
}

async function flushAsyncUpdates() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function advancePollingInterval() {
  await act(async () => {
    vi.advanceTimersByTime(5_000)
    await Promise.resolve()
    await Promise.resolve()
  })
}

function StrictModeWrapper({ children }: { children: React.ReactNode }) {
  return <React.StrictMode>{children}</React.StrictMode>
}

describe('useRecipePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('loads recipes on initial fetch', async () => {
    mockGetRecipes.mockResolvedValue({ items: [makeRecipe('active-recipe', 'deploying')] })

    const { result } = renderHook(() => useRecipePolling({ enabled: true }))
    await flushAsyncUpdates()

    expect(mockGetRecipes).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBe('')
    expect(result.current.recipes).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('does not hydrate per-recipe status or runs from the list polling hook', async () => {
    mockGetRecipes.mockResolvedValue({ items: [makeRecipe('active-recipe', 'active')] })

    const { result } = renderHook(() => useRecipePolling({ enabled: true }))
    await flushAsyncUpdates()

    expect(Object.keys(result.current)).toEqual(['recipes', 'loading', 'error', 'refresh'])
    expect(mockGetRecipes).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps polling while a parent recipe phase is non-terminal', async () => {
    mockGetRecipes.mockResolvedValue({ items: [makeRecipe('active-recipe', 'deploying')] })

    renderHook(() => useRecipePolling({ enabled: true }))
    await flushAsyncUpdates()

    expect(vi.getTimerCount()).toBe(1)

    await advancePollingInterval()

    expect(mockGetRecipes).toHaveBeenCalledTimes(2)
  })

  it('does not keep loading true after the list fetch resolves', async () => {
    mockGetRecipes.mockResolvedValue({ items: [makeRecipe('active-recipe', 'deploying')] })

    const { result } = renderHook(() => useRecipePolling({ enabled: true }))
    await flushAsyncUpdates()

    expect(mockGetRecipes).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(false)
    expect(result.current.recipes).toHaveLength(1)
  })

  it('suspends the interval once every recipe is terminal', async () => {
    mockGetRecipes
      .mockResolvedValueOnce({ items: [makeRecipe('active-recipe', 'pending')] })
      .mockResolvedValueOnce({ items: [makeRecipe('active-recipe', 'active')] })

    renderHook(() => useRecipePolling({ enabled: true }))
    await flushAsyncUpdates()

    expect(vi.getTimerCount()).toBe(1)

    await advancePollingInterval()

    expect(mockGetRecipes).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('re-enables polling when a non-terminal recipe appears later', async () => {
    mockGetRecipes
      .mockResolvedValueOnce({ items: [makeRecipe('done-recipe', 'active')] })
      .mockResolvedValueOnce({ items: [makeRecipe('new-active-recipe', 'pending')] })

    const { result } = renderHook(() => useRecipePolling({ enabled: true }))
    await flushAsyncUpdates()

    expect(vi.getTimerCount()).toBe(0)

    await act(async () => {
      await result.current.refresh()
    })

    await flushAsyncUpdates()

    expect(vi.getTimerCount()).toBe(1)
  })

  it('replaces the recipes list when recipes are removed on refresh', async () => {
    mockGetRecipes
      .mockResolvedValueOnce({
        items: [makeRecipe('active-recipe', 'pending'), makeRecipe('stale-recipe', 'active')],
      })
      .mockResolvedValueOnce({ items: [makeRecipe('active-recipe', 'pending')] })

    const { result } = renderHook(() => useRecipePolling({ enabled: true }))
    await flushAsyncUpdates()

    expect(result.current.recipes.map(recipe => recipe.metadata?.name)).toEqual([
      'active-recipe',
      'stale-recipe',
    ])

    await act(async () => {
      await result.current.refresh()
    })

    await flushAsyncUpdates()

    expect(result.current.recipes.map(recipe => recipe.metadata?.name)).toEqual(['active-recipe'])
  })

  it('cleans up the polling interval on unmount', async () => {
    mockGetRecipes.mockResolvedValue({ items: [makeRecipe('active-recipe', 'pending')] })

    const { unmount } = renderHook(() => useRecipePolling({ enabled: true }))
    await flushAsyncUpdates()

    expect(vi.getTimerCount()).toBe(1)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('loads once on strict-mode mount and does not get stuck loading', async () => {
    mockGetRecipes.mockResolvedValue({ items: [makeRecipe('active-recipe', 'pending')] })

    const { result } = renderHook(() => useRecipePolling({ enabled: true }), {
      wrapper: StrictModeWrapper,
    })
    await flushAsyncUpdates()

    expect(mockGetRecipes).toHaveBeenCalledTimes(1)
    expect(result.current.loading).toBe(false)
    expect(result.current.recipes).toHaveLength(1)
  })
})
