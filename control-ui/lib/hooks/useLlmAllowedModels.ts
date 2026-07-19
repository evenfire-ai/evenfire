'use client'

import { useCallback, useEffect, useState } from 'react'
import { type LlmAllowedModel, getLlmModels, isSilentApiError } from '../api'

export type UseLlmAllowedModels = {
  models: LlmAllowedModel[]
  loading: boolean
  error: string
  reload: () => Promise<void>
}

/**
 * Loads the operator-declared model allowlist (`/admin/llm-models`, spec §3-R3)
 * once on mount. This is the single source of usable models for every UI picker
 * that previously read the static `LLM_MODELS_BY_PROVIDER` catalog. On error the
 * caller shows an error/empty picker — there is no hardcoded fallback list
 * (spec R4.5.1). Pass the returned `models` to the catalog helpers in lib/llm.
 */
export function useLlmAllowedModels(): UseLlmAllowedModels {
  const [models, setModels] = useState<LlmAllowedModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await getLlmModels()
      setModels(res.rows ?? [])
    } catch (e) {
      if (isSilentApiError(e)) return
      setError(e instanceof Error ? e.message : 'Failed to load allowed models')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { models, loading, error, reload }
}
