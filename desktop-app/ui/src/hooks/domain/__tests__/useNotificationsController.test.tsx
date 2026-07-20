// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { WorkflowNotificationStreamEvent } from '../../../../../src/types'
import { useNotificationsController } from '../useNotificationsController'

type StreamHandler = (event: WorkflowNotificationStreamEvent) => void

const audioPlay = vi.fn(async () => undefined)
const audioInstances: Array<{ currentTime: number; src: string; volume: number }> = []

class AudioMock {
  currentTime = 0
  volume = 1

  constructor(public readonly src: string) {
    audioInstances.push(this)
  }

  play = audioPlay
}

function sdkNotificationEvent(): Extract<
  WorkflowNotificationStreamEvent,
  { type: 'sdk.notification' }
> {
  return {
    type: 'sdk.notification',
    id: 'delivery-1',
    cursor: 'cursor-1',
    observedAt: new Date().toISOString(),
    notification: {
      notificationId: 'notification-1',
      origin: 'plugin_workload_sdk',
      recipeNamespace: 'sandbox-recipes',
      recipeName: 'prompt-notify',
      callerRef: 'backend',
      eventType: 'app.update',
      title: 'App update',
      body: 'The app finished its work.',
      data: {},
      actionRef: null,
      deliveryPolicyRef: null,
    },
  }
}

function installNotificationBridge() {
  let streamHandler: StreamHandler | null = null
  const ack = vi.fn(async () => ({ ok: true, status: 'delivered' }))
  const subscribe = vi.fn(async (handler: StreamHandler) => {
    streamHandler = handler
    return async () => undefined
  })

  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: {
      notifications: { ack, subscribe },
      approvals: { listPending: vi.fn(async () => []) },
    },
  })

  return {
    ack,
    emit(event: WorkflowNotificationStreamEvent) {
      if (!streamHandler) throw new Error('Notification stream is not subscribed')
      streamHandler(event)
    },
    subscribed: () => streamHandler !== null,
  }
}

function renderNotificationsController(
  canDeliver: (channel: 'inApp' | 'desktop') => boolean,
  notificationSoundVolume = 35
) {
  const showDesktopNotification = vi.fn(async () => 'granted' as const)
  const rendered = renderHook(() =>
    useNotificationsController({
      isAuthenticated: true,
      notificationSoundVolume,
      canDeliverChatResponseNotification: channel => canDeliver(channel),
      showDesktopNotification,
      decideApproval: vi.fn(async () => undefined),
      pushToast: vi.fn(),
      setStatus: vi.fn(),
    })
  )
  return { ...rendered, showDesktopNotification }
}

describe('useNotificationsController SDK notification delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    audioInstances.length = 0
    vi.stubGlobal('Audio', AudioMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    delete (window as { clerum?: unknown }).clerum
  })

  it('uses the in-app preference and configured sound volume for app notifications', async () => {
    const bridge = installNotificationBridge()
    const { result, showDesktopNotification } = renderNotificationsController(
      channel => channel === 'inApp'
    )
    await waitFor(() => expect(bridge.subscribed()).toBe(true))

    act(() => bridge.emit(sdkNotificationEvent()))

    await waitFor(() => expect(result.current.notifications).toHaveLength(1))
    expect(result.current.notifications[0]).toMatchObject({
      kind: 'sdk_notification',
      agentName: 'prompt-notify',
      text: 'The app finished its work.',
    })
    expect(showDesktopNotification).not.toHaveBeenCalled()
    await waitFor(() => expect(audioPlay).toHaveBeenCalledTimes(1))
    expect(audioInstances[0]?.volume).toBe(0.35)
    expect(bridge.ack).toHaveBeenCalledWith('delivery-1')
  })

  it('uses the desktop preference and configured sound when the in-app channel is hidden', async () => {
    const bridge = installNotificationBridge()
    const { result, showDesktopNotification } = renderNotificationsController(
      channel => channel === 'desktop'
    )
    await waitFor(() => expect(bridge.subscribed()).toBe(true))

    act(() => bridge.emit(sdkNotificationEvent()))

    await waitFor(() => {
      expect(showDesktopNotification).toHaveBeenCalledWith({
        title: 'App update',
        body: 'The app finished its work.',
        tag: 'sdk-notification:notification-1',
        silent: true,
      })
    })
    expect(result.current.notifications).toHaveLength(0)
    await waitFor(() => expect(audioPlay).toHaveBeenCalledTimes(1))
    expect(audioInstances[0]?.volume).toBe(0.35)
    expect(bridge.ack).toHaveBeenCalledWith('delivery-1')
  })

  it('acknowledges app notifications without displaying or sounding disabled channels', async () => {
    const bridge = installNotificationBridge()
    const { result, showDesktopNotification } = renderNotificationsController(() => false)
    await waitFor(() => expect(bridge.subscribed()).toBe(true))

    act(() => bridge.emit(sdkNotificationEvent()))

    await waitFor(() => expect(bridge.ack).toHaveBeenCalledWith('delivery-1'))
    expect(result.current.notifications).toHaveLength(0)
    expect(showDesktopNotification).not.toHaveBeenCalled()
    expect(audioPlay).not.toHaveBeenCalled()
  })

  it('keeps app notifications silent when notification sound is muted', async () => {
    const bridge = installNotificationBridge()
    const { showDesktopNotification } = renderNotificationsController(
      channel => channel === 'desktop',
      0
    )
    await waitFor(() => expect(bridge.subscribed()).toBe(true))

    act(() => bridge.emit(sdkNotificationEvent()))

    await waitFor(() => expect(showDesktopNotification).toHaveBeenCalledTimes(1))
    expect(audioPlay).not.toHaveBeenCalled()
    expect(bridge.ack).toHaveBeenCalledWith('delivery-1')
  })
})
