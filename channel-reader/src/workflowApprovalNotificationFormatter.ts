import { createHash } from 'node:crypto'
import type {
  ApprovalRequestedNotificationDelivery,
  NotificationDelivery,
  PluginWorkloadSdkNotificationDelivery,
  WorkflowRunCompletedNotificationDelivery,
} from './notificationDeliveryClient'
import {
  telegramWorkflowApprovalCallbackData,
  telegramWorkflowResultCallbackData,
} from './telegramCallbackData'
import type { SendMessageOptions } from './types'

export type FormattedNotificationDelivery = {
  content: string
  sendOptions?: SendMessageOptions
}

export type FormatNotificationDeliveryOptions = {
  communicationChannelRef?: string | null
}

const TELEGRAM_PROVIDER_USER_ID_RE = /^\d{1,20}$/
const SLACK_PROVIDER_USER_ID_RE = /^[UW][A-Z0-9]{2,31}$/
const CHANNEL_ALIAS_LEN = 16
const WORKFLOW_RECIPE_NAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i
const APPROVAL_ACTION_RE =
  /^([a-z]+):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::.*)?$/i

function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function isSharedProviderChannel(delivery: NotificationDelivery): boolean {
  return (
    String(delivery.providerChannelId || '').trim() !== String(delivery.providerUserId || '').trim()
  )
}

function communicationChannelAlias(communicationChannelRef?: string | null): string | null {
  return communicationChannelRef
    ? createHash('sha256').update(communicationChannelRef).digest('hex').slice(0, CHANNEL_ALIAS_LEN)
    : null
}

function approvalActionKind(value: string | undefined): 'approve' | 'deny' | null {
  const normalized = value?.trim().toLowerCase() || ''
  if (normalized.startsWith('approve:') || normalized.startsWith('approved:')) return 'approve'
  if (
    normalized.startsWith('deny:') ||
    normalized.startsWith('denied:') ||
    normalized.startsWith('reject:') ||
    normalized.startsWith('rejected:')
  ) {
    return 'deny'
  }
  return null
}

function slackApprovalActionValue(params: {
  decision: 'approve' | 'deny'
  approvalRequestId: string
  workflowRef: string
  communicationChannelRef?: string | null
}): string {
  const base = `${params.decision}:${params.approvalRequestId}:${params.workflowRef}`
  const channelAlias = communicationChannelAlias(params.communicationChannelRef)
  return channelAlias ? `${base}:${channelAlias}` : base
}

function slackApprovalSendOptions(
  delivery: ApprovalRequestedNotificationDelivery,
  content: string,
  options: FormatNotificationDeliveryOptions
): SendMessageOptions | undefined {
  if (delivery.medium !== 'slack') return undefined

  const workflowRef = `${delivery.payload.recipeNamespace}/${delivery.payload.recipeName}`
  const rawActions =
    delivery.payload.actions && delivery.payload.actions.length > 0
      ? delivery.payload.actions
      : [
          { id: `approve:${delivery.payload.approvalRequestId}`, label: 'Approve' },
          { id: `deny:${delivery.payload.approvalRequestId}`, label: 'Deny' },
        ]
  const elements = rawActions
    .map(action => {
      const match = action.id.match(APPROVAL_ACTION_RE)
      const decision = approvalActionKind(action.id)
      if (!match || !decision) return null
      return {
        type: 'button' as const,
        action_id: `workflow_approval_${decision}`,
        text: {
          type: 'plain_text' as const,
          text: action.label || (decision === 'approve' ? 'Approve' : 'Deny'),
        },
        value: slackApprovalActionValue({
          decision,
          approvalRequestId: match[2] || delivery.payload.approvalRequestId,
          workflowRef,
          communicationChannelRef: options.communicationChannelRef,
        }),
        ...(decision === 'approve' ? { style: 'primary' as const } : {}),
        ...(decision === 'deny' ? { style: 'danger' as const } : {}),
      }
    })
    .filter((element): element is NonNullable<typeof element> => !!element)

  if (elements.length === 0) return undefined
  return {
    slackBlocks: [
      { type: 'section', text: { type: 'mrkdwn', text: content } },
      { type: 'actions', elements },
    ],
  }
}

function completionMessageForPhase(
  recipeName: string,
  phase: WorkflowRunCompletedNotificationDelivery['payload']['phase'],
  sharedChannel: boolean
): string {
  if (phase === 'Succeeded') {
    return sharedChannel
      ? 'Workflow ' +
          recipeName +
          ' completed. Results are ready. Reply: download result from your verified account.'
      : 'Workflow ' + recipeName + ' completed. Results are ready. Reply: download result'
  }
  return sharedChannel
    ? 'Workflow ' +
        recipeName +
        ' finished with status ' +
        phase +
        '. Reply: download result from your verified account to check available results.'
    : 'Workflow ' +
        recipeName +
        ' finished with status ' +
        phase +
        '. Reply: download result to check available results.'
}

function formatWorkflowApprovalNotification(
  delivery: ApprovalRequestedNotificationDelivery,
  options: FormatNotificationDeliveryOptions
): FormattedNotificationDelivery {
  const title = delivery.payload.title?.trim() || 'Workflow approval requested'
  const recipeName = delivery.payload.recipeName
  const rawBody = delivery.payload.body?.trim()
  const body =
    rawBody && !rawBody.includes(`${delivery.payload.recipeNamespace}/${recipeName}`)
      ? rawBody
      : `Approval requested for workflow ${recipeName}.`
  const content = [
    title,
    body,
    '',
    delivery.medium === 'slack'
      ? 'Reply \\approve ' + recipeName + ' to approve or \\deny ' + recipeName + ' to deny.'
      : 'Reply /approve ' + recipeName + ' to approve or /deny ' + recipeName + ' to deny.',
  ].join('\n')
  return {
    content,
    ...(delivery.medium === 'telegram'
      ? {
          sendOptions: {
            telegramInlineKeyboard: [
              [
                {
                  text: 'Approve',
                  callbackData: telegramWorkflowApprovalCallbackData(
                    'approve',
                    delivery.payload.approvalRequestId
                  ),
                },
                {
                  text: 'Deny',
                  callbackData: telegramWorkflowApprovalCallbackData(
                    'deny',
                    delivery.payload.approvalRequestId
                  ),
                },
              ],
            ],
          },
        }
      : { sendOptions: slackApprovalSendOptions(delivery, content, options) }),
  }
}

function telegramResultSendOptions(
  workflowName: string,
  base: SendMessageOptions = {}
): SendMessageOptions | undefined {
  const callbackData = telegramWorkflowResultCallbackData(workflowName)
  if (!callbackData) return undefined
  return {
    ...base,
    telegramInlineKeyboard: [[{ text: 'Download result', callbackData }]],
  }
}

function slackResultSendOptions(
  workflowName: string,
  content: string
): SendMessageOptions | undefined {
  const normalized = workflowName.trim()
  if (!WORKFLOW_RECIPE_NAME_RE.test(normalized)) return undefined
  return {
    slackBlocks: [
      { type: 'section', text: { type: 'mrkdwn', text: content } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            action_id: 'workflow_result_download',
            text: { type: 'plain_text', text: 'Download result' },
            value: `workflow_result:${normalized}`,
          },
        ],
      },
    ],
  }
}

function formatWorkflowRunCompletedNotification(
  delivery: WorkflowRunCompletedNotificationDelivery
): FormattedNotificationDelivery {
  const recipeName = delivery.payload.recipeName?.trim() || 'workflow'
  const sharedChannel = isSharedProviderChannel(delivery)
  const message = completionMessageForPhase(recipeName, delivery.payload.phase, sharedChannel)
  if (!sharedChannel) {
    const sendOptions =
      delivery.medium === 'telegram'
        ? telegramResultSendOptions(recipeName)
        : delivery.medium === 'slack'
          ? slackResultSendOptions(recipeName, message)
          : undefined
    return {
      content: message,
      ...(sendOptions ? { sendOptions } : {}),
    }
  }

  if (delivery.medium === 'slack' && SLACK_PROVIDER_USER_ID_RE.test(delivery.providerUserId)) {
    const content = '<@' + delivery.providerUserId + '> ' + message
    const sendOptions = slackResultSendOptions(recipeName, content)
    return { content, ...(sendOptions ? { sendOptions } : {}) }
  }

  if (
    delivery.medium === 'telegram' &&
    TELEGRAM_PROVIDER_USER_ID_RE.test(delivery.providerUserId)
  ) {
    const sendOptions = telegramResultSendOptions(recipeName, { parseMode: 'telegram-html' })
    return {
      content:
        '<a href="tg://user?id=' +
        delivery.providerUserId +
        '">User</a> ' +
        escapeTelegramHtml(message),
      ...(sendOptions ? { sendOptions } : { sendOptions: { parseMode: 'telegram-html' as const } }),
    }
  }

  const sendOptions =
    delivery.medium === 'telegram'
      ? telegramResultSendOptions(recipeName)
      : delivery.medium === 'slack'
        ? slackResultSendOptions(recipeName, 'Verified user ' + message)
        : undefined
  return {
    content: 'Verified user ' + message,
    ...(sendOptions ? { sendOptions } : {}),
  }
}

/**
 * Plugin Workload SDK notification (plan §4.3): the payload's title/body
 * were validated and authorized by control-api; channel-reader renders them
 * verbatim with no reinterpretation. No reply commands — these are
 * informational intents from recipe workloads.
 */
function formatPluginWorkloadSdkNotification(
  delivery: PluginWorkloadSdkNotificationDelivery
): FormattedNotificationDelivery {
  const title = delivery.payload.title?.trim() || 'Workflow notification'
  const body = delivery.payload.body?.trim() ?? ''
  return { content: body ? `${title}\n${body}` : title }
}

export function formatNotificationDelivery(
  delivery: NotificationDelivery,
  options: FormatNotificationDeliveryOptions = {}
): FormattedNotificationDelivery {
  if (delivery.eventType === 'approval.requested') {
    return formatWorkflowApprovalNotification(delivery, options)
  }
  if (delivery.eventType === 'workflow.run.completed') {
    return formatWorkflowRunCompletedNotification(delivery)
  }
  if (delivery.eventType === 'plugin_workload_sdk.notification') {
    return formatPluginWorkloadSdkNotification(delivery)
  }
  const unknown = delivery as { eventType?: unknown }
  throw new Error(`unsupported_notification_delivery_event:${String(unknown.eventType)}`)
}
