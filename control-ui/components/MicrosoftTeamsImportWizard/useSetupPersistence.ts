'use client'

import { useCallback, useEffect, useRef } from 'react'
import {
  saveMicrosoftIdentityProviderSetupSecret,
  updateMicrosoftIdentityProviderSetup,
} from '@lib/api'
import type { MicrosoftIdentityProviderSetup, MicrosoftIdentityProviderSetupDraft } from './types'

type UseSetupPersistenceInput = {
  setup: MicrosoftIdentityProviderSetup | null
  draft: MicrosoftIdentityProviderSetupDraft
  step: number
  clientSecret: string
  enabled: boolean
  debounceMs: number
  onSetup: (setup: MicrosoftIdentityProviderSetup) => void
  onError: (error: unknown) => void
}

type SaveInput = {
  step: number
  draft: MicrosoftIdentityProviderSetupDraft
  includeSecret: boolean
}

export function useSetupPersistence(input: UseSetupPersistenceInput) {
  const timerRef = useRef<number | null>(null)
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const lastDraftKeyRef = useRef('')
  const savedSecretRef = useRef('')

  useEffect(() => {
    lastDraftKeyRef.current = ''
    savedSecretRef.current = ''
  }, [input.setup?.id])

  const enqueue = useCallback(
    (save: SaveInput): Promise<void> => {
      const setupId = input.setup?.id
      if (!setupId) return Promise.resolve()
      const draftKey = JSON.stringify({ currentStep: save.step + 1, draft: save.draft })
      const secret = save.includeSecret ? input.clientSecret.trim() : ''
      const needsDraftSave = draftKey !== lastDraftKeyRef.current
      const needsSecretSave = Boolean(secret && secret !== savedSecretRef.current)
      if (!needsDraftSave && !needsSecretSave) return queueRef.current

      const operation = async () => {
        let nextSetup: MicrosoftIdentityProviderSetup | null = null
        if (needsDraftSave) {
          nextSetup = (
            await updateMicrosoftIdentityProviderSetup(setupId, {
              currentStep: save.step + 1,
              draft: save.draft,
            })
          ).setup
          lastDraftKeyRef.current = draftKey
        }
        if (needsSecretSave) {
          nextSetup = (await saveMicrosoftIdentityProviderSetupSecret(setupId, secret)).setup
          savedSecretRef.current = secret
        }
        if (nextSetup) input.onSetup(nextSetup)
      }

      const result = queueRef.current.then(operation)
      queueRef.current = result.catch(() => undefined)
      return result
    },
    [input.clientSecret, input.onSetup, input.setup?.id]
  )

  useEffect(() => {
    if (!input.enabled || !input.setup) return
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      void enqueue({
        step: input.step,
        draft: input.draft,
        includeSecret: true,
      }).catch(input.onError)
    }, input.debounceMs)
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [
    enqueue,
    input.debounceMs,
    input.draft,
    input.enabled,
    input.onError,
    input.setup,
    input.step,
  ])

  return useCallback(
    async (step = input.step, draft = input.draft): Promise<void> => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      await enqueue({ step, draft, includeSecret: true })
    },
    [enqueue, input.draft, input.step]
  )
}
