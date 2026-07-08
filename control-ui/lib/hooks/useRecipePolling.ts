'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NON_TERMINAL_RECIPE_PHASES } from '@constants/dashboard'
import { getRecipes, isSilentApiError } from '@lib/api'
import type { WorkflowRecipeResource } from '@lib/api'

const STATUS_POLL_INTERVAL_MS = 5000

function recipeNeedsPolling(recipe: WorkflowRecipeResource): boolean {
  const phase =
    typeof recipe.status?.phase === 'string' ? recipe.status.phase.trim().toLowerCase() : ''
  return NON_TERMINAL_RECIPE_PHASES.has(phase) || phase === 'unknown'
}

export function useRecipePolling({
  enabled,
  onError,
}: {
  enabled: boolean
  onError?: (error: unknown) => void
}) {
  const [recipes, setRecipes] = useState<WorkflowRecipeResource[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const isMountedRef = useRef(false)
  const hasLoadedForEnabledRef = useRef(false)
  const onErrorRef = useRef(onError)

  useEffect(() => {
    isMountedRef.current = true

    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  const syncRecipes = useCallback(
    async ({ silent, showLoading }: { silent: boolean; showLoading: boolean }) => {
      if (showLoading && isMountedRef.current) {
        setLoading(true)
        setError('')
      }

      try {
        const response = await getRecipes()
        const fetchedRecipes = response.items || []
        if (!isMountedRef.current) return

        setRecipes(fetchedRecipes)
      } catch (fetchError) {
        onErrorRef.current?.(fetchError)
        if (isSilentApiError(fetchError)) {
          if (isMountedRef.current) setError('')
          return
        }
        if (!silent && isMountedRef.current) {
          setError(fetchError instanceof Error ? fetchError.message : 'Failed to load recipes')
        }
      } finally {
        if (showLoading && isMountedRef.current) {
          setLoading(false)
        }
      }
    },
    []
  )

  const refresh = useCallback(async () => {
    await syncRecipes({ silent: false, showLoading: true })
  }, [syncRecipes])

  useEffect(() => {
    if (!enabled) {
      hasLoadedForEnabledRef.current = false
      return
    }

    if (hasLoadedForEnabledRef.current) return
    hasLoadedForEnabledRef.current = true

    void refresh()
  }, [enabled, refresh])

  const hasActiveRecipes = useMemo(() => recipes.some(recipeNeedsPolling), [recipes])

  useEffect(() => {
    if (!enabled || !hasActiveRecipes) return

    const timer = setInterval(() => {
      void syncRecipes({ silent: true, showLoading: false })
    }, STATUS_POLL_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [enabled, hasActiveRecipes, syncRecipes])

  return {
    recipes,
    loading,
    error,
    refresh,
  }
}
