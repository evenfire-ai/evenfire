import type {
  ApprovalChannelTarget,
  CreateWorkflowApprovalMediumChallengeInput,
  CreateWorkflowApprovalMediumLinkSessionInput,
  WorkflowApprovalMediumAccount,
  WorkflowApprovalMediumChallenge,
  WorkflowApprovalMediumLinkSession,
} from '../app/types/approvalChannels'
import { apiGet, apiSend } from './api'

export function providerLabel(medium: string): string {
  if (medium === 'telegram') return 'Telegram'
  if (medium === 'slack') return 'Slack'
  if (medium === 'teams') return 'Microsoft Teams'
  return medium.charAt(0).toUpperCase() + medium.slice(1)
}

function communicationChannelNameFromRef(value: string | null | undefined): string {
  const ref = value?.trim()
  if (!ref) return ''
  if (!ref.includes('/')) return ref
  const parts = ref.split('/').filter(Boolean)
  return parts[parts.length - 1] || ref
}

export function targetDisplayName(target: ApprovalChannelTarget): string {
  return target.channelName || `${target.agentName} - ${target.botLabel}`
}

export function targetDetailLabels(target: ApprovalChannelTarget): string[] {
  const labels = [providerLabel(target.medium)]
  if (target.agentName) labels.push(`Agent ${target.agentName}`)
  const bot = providerBotHandle(target)
  if (bot) labels.push(bot)
  return labels
}

export function approvalAccountChannelName(account: WorkflowApprovalMediumAccount): string {
  const displayName = account.displayName?.trim()
  if (displayName) return displayName
  const targetName = account.targets?.find(target => target.channelName)?.channelName
  if (targetName) return targetName
  const refName = communicationChannelNameFromRef(account.communicationChannelRef)
  if (refName) return refName
  return approvalAccountDisplayFallbackName(account)
}

function providerChannelTitle(account: WorkflowApprovalMediumAccount): string {
  const title = account.providerChannelTitle?.trim()
  const handle = account.providerChannelHandle?.trim()
  if (title) return title
  if (handle) return `@${handle.replace(/^@/, '')}`
  return ''
}

function approvalAccountDisplayFallbackName(account: WorkflowApprovalMediumAccount): string {
  const channelTitle = providerChannelTitle(account)
  if (channelTitle) return channelTitle
  if (account.medium === 'slack' || account.medium === 'teams') {
    const channel = account.providerChannelId?.trim()
    if (channel) return channel
  }
  return `${providerLabel(account.medium)} conversation`
}

export function approvalAccountDisplayName(account: WorkflowApprovalMediumAccount): string {
  return approvalAccountChannelName(account)
}

export function approvalAccountConversationTypeLabel(
  account: WorkflowApprovalMediumAccount
): string {
  const type = account.providerChannelType?.trim().toLowerCase()
  if (type === 'supergroup') return 'Supergroup'
  if (type === 'group') return 'Group'
  if (type === 'private') return account.medium === 'slack' ? 'Direct message' : 'Private chat'
  if (type === 'personal') return 'Personal chat'
  if (type === 'groupchat') return 'Group chat'
  if (type === 'channel') return 'Channel'
  if (account.medium === 'slack') return 'Slack conversation'
  if (account.medium === 'teams') return 'Teams conversation'
  return 'Telegram chat'
}

export function approvalAccountBotLabel(account: WorkflowApprovalMediumAccount): string {
  const bot = account.targets?.map(providerBotHandle).find(Boolean)
  if (bot) return bot
  if (account.medium === 'slack') return 'Slack App unavailable'
  if (account.medium === 'teams') return 'Teams bot unavailable'
  return 'Bot handle unavailable'
}

export function approvalAccountDetailLabels(account: WorkflowApprovalMediumAccount): string[] {
  const labels = [
    providerLabel(account.medium),
    approvalAccountConversationTypeLabel(account),
    approvalAccountBotLabel(account),
  ]
  const channelTitle = providerChannelTitle(account)
  if (channelTitle && channelTitle !== approvalAccountChannelName(account)) {
    labels.push(channelTitle)
  }
  return labels
}

export function approvalAccountStatusLabel(account: WorkflowApprovalMediumAccount): string {
  return account.disabledAt ? 'Disconnected' : 'Verified'
}

export function approvalAccountAssociationLabel(account: WorkflowApprovalMediumAccount): string {
  if (account.disabledAt) return 'Disconnected verification record'
  return (account.targets || []).length > 0
    ? (account.targets || []).map(target => targetDetailLabels(target).join(' · ')).join(', ')
    : 'No accessible agent association found'
}

export function autoSelectedTargetId(targets: ApprovalChannelTarget[]): string {
  return targets.length === 1 ? targets[0]!.id : ''
}

export function activeApprovalAccounts(
  accounts: WorkflowApprovalMediumAccount[]
): WorkflowApprovalMediumAccount[] {
  return accounts.filter(account => !account.disabledAt)
}

export function preferredAccountOptionLabel(account: WorkflowApprovalMediumAccount): string {
  return [approvalAccountChannelName(account), ...approvalAccountDetailLabels(account)]
    .filter((label, index, labels) => label && labels.indexOf(label) === index)
    .join(' · ')
}

export function telegramVerificationCommand(
  challenge: Pick<WorkflowApprovalMediumChallenge, 'code'>
): string | null {
  return challenge.code ? `/verify ${challenge.code}` : null
}

export function slackVerificationCommand(
  session: Pick<WorkflowApprovalMediumLinkSession, 'nonce'>
): string | null {
  return session.nonce ? `verify ${session.nonce}` : null
}

export function teamsVerificationCommand(
  session: Pick<WorkflowApprovalMediumLinkSession, 'nonce'>
): string | null {
  return session.nonce ? `verify ${session.nonce}` : null
}

export function telegramBotHandle(target: ApprovalChannelTarget | null | undefined): string | null {
  if (!target?.botUsername) return null
  return `@${target.botUsername.replace(/^@/, '')}`
}

export function providerBotHandle(target: ApprovalChannelTarget | null | undefined): string | null {
  if (!target) return null
  if (target.medium === 'telegram') return telegramBotHandle(target)
  return target.botLabel || target.botUsername || null
}

export function challengeExpirationLabel(
  challenge: Pick<WorkflowApprovalMediumChallenge, 'expiresAt'>
): string {
  return challenge.expiresAt ? `Expires at ${challenge.expiresAt}` : 'Expiration unavailable'
}

export function challengeRemainingSeconds(expiresAt: string, nowMs = Date.now()): number {
  const expiresAtMs = Date.parse(expiresAt)
  if (!Number.isFinite(expiresAtMs)) return 0
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000))
}

export function challengeCountdownLabel(remainingSeconds: number): string {
  const normalized = Math.max(0, Math.floor(remainingSeconds))
  const minutes = Math.floor(normalized / 60)
  const seconds = normalized % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export async function listApprovalChannelTargets(): Promise<ApprovalChannelTarget[]> {
  const response = (await apiGet('/api/v1/workflow-approval-mediums/targets')) as {
    items?: ApprovalChannelTarget[]
  }
  return Array.isArray(response.items) ? response.items : []
}

export async function createWorkflowApprovalMediumChallenge(
  input: CreateWorkflowApprovalMediumChallengeInput
): Promise<WorkflowApprovalMediumChallenge> {
  return (await apiSend(
    'POST',
    '/api/v1/workflow-approval-mediums/challenges',
    input
  )) as WorkflowApprovalMediumChallenge
}

export async function createWorkflowApprovalMediumLinkSession(
  input: CreateWorkflowApprovalMediumLinkSessionInput
): Promise<WorkflowApprovalMediumLinkSession> {
  return (await apiSend(
    'POST',
    '/api/v1/workflow-approval-mediums/link-sessions',
    input
  )) as WorkflowApprovalMediumLinkSession
}

export async function listWorkflowApprovalMediums(
  options: { includeDisabled?: boolean } = {}
): Promise<WorkflowApprovalMediumAccount[]> {
  const response = (await apiGet('/api/v1/workflow-approval-mediums', {
    includeDisabled: options.includeDisabled ? 'true' : undefined,
  })) as {
    items?: WorkflowApprovalMediumAccount[]
  }
  return Array.isArray(response.items) ? response.items : []
}

export async function disconnectWorkflowApprovalMedium(accountId: string): Promise<void> {
  await apiSend('DELETE', `/api/v1/workflow-approval-mediums/${encodeURIComponent(accountId)}`)
}

export async function updateWorkflowApprovalMediumDisplayName(
  accountId: string,
  displayName: string
): Promise<WorkflowApprovalMediumAccount> {
  const response = (await apiSend(
    'PATCH',
    `/api/v1/workflow-approval-mediums/${encodeURIComponent(accountId)}/display-name`,
    { displayName }
  )) as { account?: WorkflowApprovalMediumAccount }
  if (!response.account) throw new Error('Updated workflow approval medium was not returned')
  return response.account
}
