import { useCallback, useEffect, useRef, useState } from 'react'
import { NOTIFICATION_SETTINGS_STORAGE_KEY } from '@constants/notificationSettings'
import {
  sanitizeNotificationSettings,
  shouldDeliverChatResponseNotification,
} from '@lib/notifications'
import type {
  DesktopNotificationPayload,
  DesktopNotificationPermission,
  NotificationSettings,
} from '@/uiTypes'

type DesktopNotificationOptions = NotificationOptions & {
  actions?: DesktopNotificationPayload['actions']
}

type ActionableNotification = Notification & {
  onaction?: (event: Event & { action?: string }) => void
}

type DesktopNotificationHandler = Pick<DesktopNotificationPayload, 'onClick' | 'onAction'>

function getNotificationApi(): typeof Notification | null {
  if (typeof window === 'undefined' || !('Notification' in window)) return null
  return window.Notification
}

function readDesktopNotificationPermission(): DesktopNotificationPermission {
  const notificationApi = getNotificationApi()
  return notificationApi ? notificationApi.permission : 'unsupported'
}

function readInitialNotificationSettings(): NotificationSettings {
  if (typeof window === 'undefined') return sanitizeNotificationSettings(null)
  try {
    const raw = window.localStorage.getItem(NOTIFICATION_SETTINGS_STORAGE_KEY)
    return sanitizeNotificationSettings(raw ? JSON.parse(raw) : null)
  } catch {
    return sanitizeNotificationSettings(null)
  }
}

function isAppFocused(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState === 'visible' && document.hasFocus()
}

export function useNotificationSettingsController() {
  const [settings, setSettings] = useState<NotificationSettings>(readInitialNotificationSettings)
  const [desktopNotificationPermission, setDesktopNotificationPermission] =
    useState<DesktopNotificationPermission>(readDesktopNotificationPermission)
  const desktopNotificationHandlersRef = useRef<Map<string, DesktopNotificationHandler>>(new Map())

  const runDesktopNotificationHandler = useCallback(
    (handler: (() => void | Promise<void>) | undefined, warning: string) => {
      void Promise.resolve(handler?.()).catch(error => {
        console.warn(warning, error)
      })
    },
    []
  )

  useEffect(() => {
    const bridge = window.clerum?.notifications
    if (!bridge) return undefined

    const unsubscribeClick = bridge.onClick(({ id }) => {
      const handler = desktopNotificationHandlersRef.current.get(id)
      if (!handler?.onAction) {
        desktopNotificationHandlersRef.current.delete(id)
      }
      runDesktopNotificationHandler(
        handler?.onClick,
        '[useNotificationSettingsController] notification click failed'
      )
    })
    const unsubscribeAction = bridge.onAction(({ id, action }) => {
      const handler = desktopNotificationHandlersRef.current.get(id)
      desktopNotificationHandlersRef.current.delete(id)
      runDesktopNotificationHandler(
        handler?.onAction ? () => handler.onAction?.(action) : handler?.onClick,
        '[useNotificationSettingsController] notification action failed'
      )
    })
    const unsubscribeFailed = bridge.onFailed(({ id, error }) => {
      desktopNotificationHandlersRef.current.delete(id)
      console.warn('[useNotificationSettingsController] desktop notification failed', error)
    })

    return () => {
      unsubscribeClick()
      unsubscribeAction()
      unsubscribeFailed()
    }
  }, [runDesktopNotificationHandler])

  const refreshDesktopNotificationPermission = useCallback(() => {
    const permission = readDesktopNotificationPermission()
    setDesktopNotificationPermission(permission)
    return permission
  }, [])

  const requestDesktopNotificationPermission = useCallback(async () => {
    const notificationApi = getNotificationApi()
    if (!notificationApi) {
      setDesktopNotificationPermission('unsupported')
      return 'unsupported' as DesktopNotificationPermission
    }

    if (notificationApi.permission !== 'default') {
      setDesktopNotificationPermission(notificationApi.permission)
      return notificationApi.permission
    }

    try {
      const permission = await notificationApi.requestPermission()
      setDesktopNotificationPermission(permission)
      return permission
    } catch {
      setDesktopNotificationPermission(notificationApi.permission)
      return notificationApi.permission
    }
  }, [])

  const persistNotificationSettings = useCallback((nextSettings: NotificationSettings) => {
    const sanitized = sanitizeNotificationSettings(nextSettings)
    try {
      window.localStorage.setItem(NOTIFICATION_SETTINGS_STORAGE_KEY, JSON.stringify(sanitized))
    } catch {
      // Keep the in-memory setting even when storage is unavailable.
    }
    setSettings(sanitized)
    return sanitized
  }, [])

  const saveNotificationSettings = useCallback(
    async (
      nextSettings: NotificationSettings,
      options: { requestDesktopPermission?: boolean } = {}
    ) => {
      const { requestDesktopPermission = true } = options
      persistNotificationSettings(nextSettings)
      return requestDesktopPermission
        ? requestDesktopNotificationPermission()
        : refreshDesktopNotificationPermission()
    },
    [
      persistNotificationSettings,
      refreshDesktopNotificationPermission,
      requestDesktopNotificationPermission,
    ]
  )

  const setNotificationSoundVolume = useCallback(
    (soundVolume: number) => {
      persistNotificationSettings({ ...settings, soundVolume })
    },
    [persistNotificationSettings, settings]
  )

  const showDesktopNotification = useCallback(
    async (payload: DesktopNotificationPayload) => {
      const notificationApi = getNotificationApi()
      if (!notificationApi) {
        setDesktopNotificationPermission('unsupported')
        return 'unsupported' as DesktopNotificationPermission
      }

      const permission =
        notificationApi.permission === 'default'
          ? await requestDesktopNotificationPermission()
          : refreshDesktopNotificationPermission()

      if (permission !== 'granted') return permission

      const bridge = window.clerum?.notifications
      if (bridge) {
        const notificationId = crypto.randomUUID()
        desktopNotificationHandlersRef.current.set(notificationId, {
          onClick: payload.onClick,
          onAction: payload.onAction,
        })
        window.setTimeout(() => {
          desktopNotificationHandlersRef.current.delete(notificationId)
        }, 10 * 60_000)
        try {
          const result = await bridge.show({
            id: notificationId,
            title: payload.title,
            body: payload.body,
            tag: payload.tag,
            actions: payload.actions,
          })
          if (result.supported) return permission
        } catch (error) {
          console.warn(
            '[useNotificationSettingsController] desktop notification bridge failed',
            error
          )
        }
        desktopNotificationHandlersRef.current.delete(notificationId)
      }

      const options: DesktopNotificationOptions = {
        body: payload.body,
        icon: './logo.svg',
        tag: payload.tag,
      }
      if (payload.actions?.length) {
        options.actions = payload.actions
      }

      const notification = new notificationApi(payload.title, options)
      const runHandler = (handler: (() => void | Promise<void>) | undefined, warning: string) => {
        runDesktopNotificationHandler(handler, warning)
      }
      notification.onclick = () => {
        window.focus()
        notification.close()
        runHandler(payload.onClick, '[useNotificationSettingsController] notification click failed')
      }
      const actionableNotification = notification as ActionableNotification
      actionableNotification.onaction = event => {
        window.focus()
        notification.close()
        const action = typeof event.action === 'string' ? event.action : ''
        runHandler(
          action ? () => payload.onAction?.(action) : payload.onClick,
          '[useNotificationSettingsController] notification action failed'
        )
      }
      return permission
    },
    [
      refreshDesktopNotificationPermission,
      requestDesktopNotificationPermission,
      runDesktopNotificationHandler,
    ]
  )

  const canDeliverChatResponseNotification = useCallback(
    (channel: 'inApp' | 'desktop', context: { activeChatVisible: boolean }) =>
      shouldDeliverChatResponseNotification(settings[channel], {
        appFocused: isAppFocused(),
        activeChatVisible: context.activeChatVisible,
      }),
    [settings]
  )

  return {
    settings,
    desktopNotificationPermission,
    canDeliverChatResponseNotification,
    saveNotificationSettings,
    setNotificationSoundVolume,
    requestDesktopNotificationPermission,
    refreshDesktopNotificationPermission,
    showDesktopNotification,
  }
}
