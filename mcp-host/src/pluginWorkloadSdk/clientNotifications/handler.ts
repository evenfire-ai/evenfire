import { PluginWorkloadError } from '../domain/errors'
import {
  type ClientNotificationRequest,
  type ClientNotificationResult,
  DEFAULT_IDEMPOTENCY_KEY_PATTERN,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_TITLE_BYTES,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from '../domain/types'
import { pluginSdkClientNotificationsTotal } from '../metrics'
import type {
  ClientNotificationRecipient,
  PluginWorkloadSdkControlApiClient,
} from '../promptBridge/controlApiClient'

/**
 * clientNotifications handler (plan §4.1): validates the notification
 * intent locally, forwards it to control-api (which authorizes, persists
 * the audit record, and enqueues delivery), and maps the response into the
 * spec §14 result shape. Targets stay opaque refs — never raw channel
 * addresses.
 */

const IDEMPOTENCY_KEY_RE = new RegExp(DEFAULT_IDEMPOTENCY_KEY_PATTERN)
const EMAIL_LIKE_RE = /@/
const PHONE_LIKE_RE = /^\+?[0-9][0-9\s().-]{6,}$/

export interface ClientNotificationsHandlerDeps {
  controlApiClient: PluginWorkloadSdkControlApiClient
  recipeNamespace: string
  recipeName: string
}

export function validateClientNotificationRequest(raw: unknown): ClientNotificationRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PluginWorkloadError('invalid_request', 'request body must be an object')
  }
  const body = raw as Record<string, unknown>

  if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length === 0) {
    throw new PluginWorkloadError('invalid_request', 'idempotencyKey is required')
  }
  if (
    body.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !IDEMPOTENCY_KEY_RE.test(body.idempotencyKey)
  ) {
    throw new PluginWorkloadError('invalid_request', 'idempotencyKey has an invalid format')
  }
  if (typeof body.eventType !== 'string' || !body.eventType.trim()) {
    throw new PluginWorkloadError('invalid_request', 'eventType is required')
  }

  const target = body.target as Record<string, unknown> | undefined
  const targetRef =
    target && typeof target === 'object' && typeof target.targetRef === 'string'
      ? target.targetRef
      : undefined
  const userRef = typeof body.userRef === 'string' ? body.userRef : undefined
  if ((targetRef === undefined) === (userRef === undefined)) {
    throw new PluginWorkloadError(
      'invalid_request',
      'exactly one of target.targetRef or userRef is required'
    )
  }
  for (const [field, value] of [
    ['target.targetRef', targetRef],
    ['userRef', userRef],
  ] as const) {
    if (value === undefined) continue
    if (EMAIL_LIKE_RE.test(value) || PHONE_LIKE_RE.test(value)) {
      throw new PluginWorkloadError(
        'invalid_request',
        `${field} must be an opaque reference, not a raw channel address`
      )
    }
  }

  const notification = body.notification as Record<string, unknown> | undefined
  if (!notification || typeof notification !== 'object') {
    throw new PluginWorkloadError('invalid_request', 'notification is required')
  }
  if (typeof notification.title !== 'string' || !notification.title.trim()) {
    throw new PluginWorkloadError('invalid_request', 'notification.title is required')
  }
  if (Buffer.byteLength(notification.title, 'utf8') > DEFAULT_MAX_TITLE_BYTES) {
    throw new PluginWorkloadError('payload_too_large', 'notification.title exceeds the byte cap')
  }
  if (typeof notification.body !== 'string') {
    throw new PluginWorkloadError('invalid_request', 'notification.body is required')
  }
  if (Buffer.byteLength(notification.body, 'utf8') > DEFAULT_MAX_BODY_BYTES) {
    throw new PluginWorkloadError('payload_too_large', 'notification.body exceeds the byte cap')
  }

  // Validate optional notification fields: reject if provided with wrong type.
  if (
    notification.data !== undefined &&
    (typeof notification.data !== 'object' ||
      notification.data === null ||
      Array.isArray(notification.data))
  ) {
    throw new PluginWorkloadError('invalid_request', 'notification.data must be an object')
  }
  if (notification.actionRef !== undefined) {
    const ar = notification.actionRef as Record<string, unknown>
    if (
      typeof ar !== 'object' ||
      ar === null ||
      typeof ar.type !== 'string' ||
      typeof ar.id !== 'string'
    ) {
      throw new PluginWorkloadError(
        'invalid_request',
        'notification.actionRef must be { type, id, urlRef? }'
      )
    }
    if (ar.urlRef !== undefined && typeof ar.urlRef !== 'string') {
      throw new PluginWorkloadError(
        'invalid_request',
        'notification.actionRef.urlRef must be a string'
      )
    }
  }
  if (
    notification.deliveryPolicyRef !== undefined &&
    typeof notification.deliveryPolicyRef !== 'string'
  ) {
    throw new PluginWorkloadError(
      'invalid_request',
      'notification.deliveryPolicyRef must be a string'
    )
  }
  if (notification.correlationId !== undefined && typeof notification.correlationId !== 'string') {
    throw new PluginWorkloadError('invalid_request', 'notification.correlationId must be a string')
  }

  return {
    idempotencyKey: body.idempotencyKey as string,
    eventType: body.eventType as string,
    target: targetRef !== undefined ? { targetRef } : undefined,
    userRef: typeof body.userRef === 'string' ? body.userRef : undefined,
    notification: {
      title: notification.title as string,
      body: notification.body as string,
      data:
        typeof notification.data === 'object' &&
        notification.data !== null &&
        !Array.isArray(notification.data)
          ? (notification.data as Record<string, unknown>)
          : undefined,
      actionRef:
        notification.actionRef !== undefined
          ? (() => {
              const ar = notification.actionRef as Record<string, unknown>
              return {
                type: ar.type as string,
                id: ar.id as string,
                urlRef: typeof ar.urlRef === 'string' ? ar.urlRef : undefined,
              }
            })()
          : undefined,
      deliveryPolicyRef:
        typeof notification.deliveryPolicyRef === 'string'
          ? notification.deliveryPolicyRef
          : undefined,
      correlationId:
        typeof notification.correlationId === 'string' ? notification.correlationId : undefined,
    },
  }
}

export class ClientNotificationsHandler {
  constructor(private readonly deps: ClientNotificationsHandlerDeps) {}

  /**
   * List the recipients this caller may notify (read-only). Delegates to
   * control-api, which authorizes the caller and returns the grant's
   * allowedUserRefs resolved to display labels — the authoritative source for
   * a sandbox-ui recipient picker, with no recipe-baked recipients env.
   */
  async listRecipients(callerRef: string): Promise<ClientNotificationRecipient[]> {
    const result = await this.deps.controlApiClient.listClientNotificationRecipients({
      recipeNamespace: this.deps.recipeNamespace,
      recipeName: this.deps.recipeName,
      callerRef,
    })
    return result.recipients
  }

  async handle(rawBody: unknown, callerRef: string): Promise<ClientNotificationResult> {
    let eventType = 'unresolved'
    try {
      const result = await this.handleInner(rawBody, callerRef, et => {
        eventType = et
      })
      pluginSdkClientNotificationsTotal.inc(
        { recipe: this.deps.recipeName, event_type: result.eventType, status: result.status },
        1
      )
      return result
    } catch (err) {
      const status = err instanceof PluginWorkloadError ? err.code : 'internal_error'
      pluginSdkClientNotificationsTotal.inc(
        { recipe: this.deps.recipeName, event_type: eventType, status },
        1
      )
      throw err
    }
  }

  private async handleInner(
    rawBody: unknown,
    callerRef: string,
    onEventType: (eventType: string) => void
  ): Promise<ClientNotificationResult> {
    const request = validateClientNotificationRequest(rawBody)
    onEventType(request.eventType)

    const submitted = await this.deps.controlApiClient.submitClientNotification({
      recipeNamespace: this.deps.recipeNamespace,
      recipeName: this.deps.recipeName,
      callerRef,
      eventType: request.eventType,
      target: request.target,
      userRef: request.userRef,
      idempotencyKey: request.idempotencyKey,
      notification: request.notification,
    })

    return {
      notificationId: submitted.notificationId,
      status: submitted.status === 'delivered' ? 'delivered' : 'accepted',
      target: submitted.target,
      eventType: request.eventType,
      title: request.notification.title,
      body: request.notification.body,
      data: request.notification.data,
      actionRef: request.notification.actionRef,
      deliveryPolicyRef: request.notification.deliveryPolicyRef,
      correlationId: request.notification.correlationId,
      createdAt: new Date().toISOString(),
    }
  }
}
