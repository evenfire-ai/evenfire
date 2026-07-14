import { useCallback, useEffect, useState } from 'react'
import type { UserNotificationPreferences } from '../../../../src/types'
import type { Tone } from '../../uiTypes'

type UseChannelNotificationPreferencesControllerParams = {
  isAuthenticated: boolean
  pushToast: (message: string, tone: Tone) => void
}

const EMPTY_PREFERENCES: UserNotificationPreferences = {
  preferredMedium: null,
  channelFallbackEnabled: true,
  verifiedMedia: [],
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNotificationPreferencesUnavailable(error: unknown): boolean {
  const message = errorMessage(error)
  return /\b404\b/.test(message) && /not found/i.test(message)
}

export function useChannelNotificationPreferencesController({
  isAuthenticated,
  pushToast,
}: UseChannelNotificationPreferencesControllerParams) {
  const [preferences, setPreferences] = useState<UserNotificationPreferences>(EMPTY_PREFERENCES)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const refreshPreferences = useCallback(async () => {
    if (!isAuthenticated) {
      setPreferences(EMPTY_PREFERENCES)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const next = await window.clerum.notificationPreferences.get()
      setPreferences(next)
    } catch (error) {
      if (isNotificationPreferencesUnavailable(error)) {
        // Older desktop endpoints may not expose channel notification preferences yet.
        setPreferences(EMPTY_PREFERENCES)
        return
      }
      pushToast(`Failed to load channel notification preferences: ${errorMessage(error)}`, 'error')
    } finally {
      setLoading(false)
    }
  }, [isAuthenticated, pushToast])

  useEffect(() => {
    void refreshPreferences()
  }, [refreshPreferences])

  const savePreferences = useCallback(
    async (next: {
      preferredMedium: 'telegram' | 'slack' | null
      channelFallbackEnabled: boolean
    }) => {
      if (!isAuthenticated) return
      setSaving(true)
      try {
        const saved = await window.clerum.notificationPreferences.update(next)
        setPreferences(saved)
        pushToast('Channel notification preferences saved.', 'success')
      } catch (error) {
        pushToast(
          `Failed to save channel notification preferences: ${errorMessage(error)}`,
          'error'
        )
      } finally {
        setSaving(false)
      }
    },
    [isAuthenticated, pushToast]
  )

  return {
    channelNotificationPreferences: preferences,
    channelNotificationPreferencesLoading: loading,
    channelNotificationPreferencesSaving: saving,
    refreshChannelNotificationPreferences: refreshPreferences,
    saveChannelNotificationPreferences: savePreferences,
  }
}
