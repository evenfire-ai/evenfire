import { randomInt, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { pool } from '../db.js'
import type { K8sGateway } from '../k8s.js'
import { getTeamAgents, getUserAgents, listTeams } from './directory/index.js'
import {
  type VerifiedMediumAccount,
  createChallengeCodeHash,
} from './workflowApprovalMediumIdentityService.js'

export { upsertVerifiedTelegramAccount } from './workflowApprovalMediumTelegramAccountService.js'

export const TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID = '__telegram_provider_event_pending__'

type CommunicationChannelResource = {
  metadata?: {
    annotations?: Record<string, string>
    name?: string
    namespace?: string
  }
  spec?: {
    access?: unknown
    credentialsSecretRef?: { name?: string }
    hostRef?: unknown
    telegram?: unknown
    telegramSettings?: unknown
  }
}

type TelegramGroup = {
  channelId?: string
  userIds?: string[]
  replyOnlyWhenMentioned?: boolean
}

type CommunicationChannelAccess = {
  users: string[]
  teams: string[]
}

export type TelegramApprovalTarget = {
  id: string
  medium: 'telegram'
  agentName: string
  channelName: string
  channelNamespace: string
  botLabel: string
  botUsername: string | null
  botDeepLink: string | null
  replyOnlyWhenMentioned: boolean
  status: 'ready'
}

type UserTelegramTargetAccess = {
  agentNames: Set<string>
  teamIds: Set<string>
}

export type TelegramProviderEventChallengeRow = {
  id: string
  userId: string
  userEmail: string
  targetId: string | null
  codeHash: string
  isExpired: boolean
  consumedAt: string | null
  attempts: number
}

const TARGET_PREFIX = 'telegram:'
const K8S_NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/
const K8S_NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

function generateSixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const normalized = String(value).trim()
  return normalized ? normalized : null
}

function normalizeTelegramGroups(value: unknown): TelegramGroup[] {
  if (!Array.isArray(value)) return []
  return value
    .map(group => (group && typeof group === 'object' ? (group as TelegramGroup) : null))
    .filter((group): group is TelegramGroup => !!group)
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const items: string[] = []
  for (const raw of value) {
    const normalized = String(raw ?? '').trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    items.push(normalized)
  }
  return items
}

function normalizeChannelAccess(value: unknown): CommunicationChannelAccess {
  const access = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    users: normalizeStringArray(access.users),
    teams: normalizeStringArray(access.teams),
  }
}

function hasTelegramProviderEnabled(channel: CommunicationChannelResource): boolean {
  const telegram = normalizeTelegramGroups(channel.spec?.telegram)
  if (telegram.length > 0) return true
  const settings =
    channel.spec?.telegramSettings &&
    typeof channel.spec.telegramSettings === 'object' &&
    !Array.isArray(channel.spec.telegramSettings)
      ? (channel.spec.telegramSettings as Record<string, unknown>)
      : null
  if (!settings) return false
  return ['botHandle', 'replyOnlyWhenMentioned'].some(key => settings[key] !== undefined)
}

function telegramSettings(channel: CommunicationChannelResource): Record<string, unknown> {
  return channel.spec?.telegramSettings &&
    typeof channel.spec.telegramSettings === 'object' &&
    !Array.isArray(channel.spec.telegramSettings)
    ? (channel.spec.telegramSettings as Record<string, unknown>)
    : {}
}

async function loadTelegramTargetAccess(userId: string): Promise<UserTelegramTargetAccess> {
  const [directAgents, teams] = await Promise.all([getUserAgents(userId), listTeams(userId, '')])
  const teamItems = Array.isArray(teams.items) ? teams.items : []
  const teamIds = new Set(teamItems.map(team => String(team.id)).filter(Boolean))
  const agentNames = new Set(directAgents.agentNames)
  await Promise.all(
    [...teamIds].map(async teamId => {
      const teamAgents = await getTeamAgents(teamId)
      for (const agentName of teamAgents.agentNames) {
        agentNames.add(agentName)
      }
    })
  )
  return { agentNames, teamIds }
}

function userCanAccessChannel(
  channel: CommunicationChannelResource,
  userId: string,
  access: UserTelegramTargetAccess
): boolean {
  const hostRef = optionalString(channel.spec?.hostRef)
  if (!hostRef || !access.agentNames.has(hostRef)) return false
  const channelAccess = normalizeChannelAccess(channel.spec?.access)
  if (channelAccess.users.includes(userId)) return true
  return channelAccess.teams.some(teamId => access.teamIds.has(teamId))
}

function targetId(namespace: string, name: string): string {
  return `${TARGET_PREFIX}${Buffer.from(JSON.stringify({ namespace, name })).toString('base64url')}`
}

function decodeTargetId(id: string): { namespace: string; name: string } {
  if (!id.startsWith(TARGET_PREFIX)) throw new Error('invalid_target_id')
  try {
    const raw = Buffer.from(id.slice(TARGET_PREFIX.length), 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as { namespace?: unknown; name?: unknown }
    const namespace = String(parsed.namespace || '').trim()
    const name = String(parsed.name || '').trim()
    if (!K8S_NAMESPACE_RE.test(namespace) || !K8S_NAME_RE.test(name)) {
      throw new Error('invalid_target_id')
    }
    return { namespace, name }
  } catch {
    throw new Error('invalid_target_id')
  }
}

function botUsernameForChannel(channel: CommunicationChannelResource): string | null {
  const settings = telegramSettings(channel)
  const raw = optionalString(
    settings.botHandle ??
      channel.metadata?.annotations?.['clerum.io/telegram-bot-username'] ??
      channel.metadata?.annotations?.['clerum.io/bot-username']
  )
  if (!raw) return null
  const withoutAt = raw.replace(/^@/, '').trim()
  return /^[A-Za-z0-9_]{5,32}$/.test(withoutAt) ? withoutAt : null
}

function projectTarget(channel: CommunicationChannelResource): TelegramApprovalTarget | null {
  const name = optionalString(channel.metadata?.name)
  const namespace = optionalString(channel.metadata?.namespace)
  const hostRef = optionalString(channel.spec?.hostRef)
  const credentialName = optionalString(channel.spec?.credentialsSecretRef?.name)
  if (!name || !namespace || !hostRef || !credentialName || !hasTelegramProviderEnabled(channel)) {
    return null
  }
  const botUsername = botUsernameForChannel(channel)
  const botLabel =
    optionalString(channel.metadata?.annotations?.['clerum.io/telegram-bot-label']) ??
    (botUsername ? `@${botUsername}` : `${name} Telegram bot`)
  return {
    id: targetId(namespace, name),
    medium: 'telegram',
    agentName: hostRef,
    channelName: name,
    channelNamespace: namespace,
    botLabel,
    botUsername,
    botDeepLink: botUsername ? `https://t.me/${botUsername}` : null,
    replyOnlyWhenMentioned: telegramSettings(channel).replyOnlyWhenMentioned === true,
    status: 'ready',
  }
}

export async function listTelegramApprovalTargets(params: {
  gateway: K8sGateway
  userId: string
}): Promise<{ items: TelegramApprovalTarget[] }> {
  const access = await loadTelegramTargetAccess(params.userId)
  if (access.agentNames.size === 0) return { items: [] }
  const channels = (await params.gateway.listResource(
    'communicationchannels',
    '*'
  )) as CommunicationChannelResource[]
  const items = channels
    .flatMap(channel => {
      const target = projectTarget(channel)
      if (!target || !userCanAccessChannel(channel, params.userId, access)) return []
      return [target]
    })
    .sort(
      (a, b) =>
        a.agentName.localeCompare(b.agentName) ||
        a.channelNamespace.localeCompare(b.channelNamespace) ||
        a.channelName.localeCompare(b.channelName)
    )
  return { items }
}

export async function resolveTelegramProviderEventTarget(params: {
  gateway: K8sGateway
  userId: string
  targetId: string
}): Promise<TelegramApprovalTarget> {
  const decoded = decodeTargetId(params.targetId)
  const channel = (await params.gateway.getResource(
    'communicationchannels',
    decoded.name,
    decoded.namespace
  )) as CommunicationChannelResource
  const target = projectTarget(channel)
  if (!target) throw new Error('telegram_target_not_ready')
  const access = await loadTelegramTargetAccess(params.userId)
  if (!userCanAccessChannel(channel, params.userId, access)) {
    throw new Error('telegram_target_not_found')
  }
  if (target.id !== params.targetId) throw new Error('telegram_target_not_found')
  return target
}

export async function userCanAccessTelegramCommunicationChannel(params: {
  gateway: K8sGateway
  userId: string
  hostRef: string
  channelName: string
  channelNamespace: string
}): Promise<boolean> {
  let channel: CommunicationChannelResource
  try {
    channel = (await params.gateway.getResource(
      'communicationchannels',
      params.channelName,
      params.channelNamespace
    )) as CommunicationChannelResource
  } catch {
    return false
  }
  const target = projectTarget(channel)
  if (!target || target.agentName !== params.hostRef) return false
  const access = await loadTelegramTargetAccess(params.userId)
  return userCanAccessChannel(channel, params.userId, access)
}

export async function createTelegramProviderEventChallenge(params: {
  gateway: K8sGateway
  userId: string
  targetId: string
}): Promise<{
  challengeId: string
  expiresAt: string
  code: string
  target: TelegramApprovalTarget
}> {
  const target = await resolveTelegramProviderEventTarget(params)
  const code = generateSixDigitCode()
  const codeHash = createChallengeCodeHash({
    userId: params.userId,
    medium: 'telegram',
    providerUserId: TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID,
    code,
  })
  const result = await pool.query(
    `INSERT INTO workflow_approval_medium_challenges
       (user_id, medium, provider_user_id, provider_workspace_id, provider_channel_id, code_hash, expires_at)
     VALUES ($1, 'telegram', $2, NULL, $3, $4, NOW() + interval '1 second' * $5)
     RETURNING id, expires_at AS "expiresAt"`,
    [
      params.userId,
      TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID,
      params.targetId,
      codeHash,
      config.telegramProviderEventChallengeTtlSec,
    ]
  )
  const row = result.rows[0] as { id: string; expiresAt: string }
  return { challengeId: row.id, expiresAt: row.expiresAt, code, target }
}

export function verifyTelegramProviderEventChallengeCodeHash(params: {
  row: TelegramProviderEventChallengeRow
  code: string
}): boolean {
  const [, saltHex, expectedHex] = params.row.codeHash.split(':')
  if (!saltHex || !expectedHex) return false
  const actual = createChallengeCodeHash({
    userId: params.row.userId,
    medium: 'telegram',
    providerUserId: TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID,
    code: params.code,
    saltHex,
  }).split(':')[2]
  const actualBuf = Buffer.from(actual, 'hex')
  const expectedBuf = Buffer.from(expectedHex, 'hex')
  return actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf)
}

export async function findMatchingTelegramProviderEventChallenge(
  code: string
): Promise<TelegramProviderEventChallengeRow | { error: string }> {
  const result = await pool.query(
    `SELECT c.id,
            c.user_id AS "userId",
            u.email AS "userEmail",
            c.provider_channel_id AS "targetId",
            c.code_hash AS "codeHash",
            c.expires_at <= NOW() AS "isExpired",
            c.consumed_at AS "consumedAt",
            c.attempts
       FROM workflow_approval_medium_challenges c
       JOIN users u ON u.id = c.user_id
      WHERE c.medium = 'telegram'
        AND c.provider_user_id = $1
        AND c.created_at > NOW() - interval '1 day'
      ORDER BY c.created_at DESC
      LIMIT 200`,
    [TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID]
  )
  const matches = (result.rows as TelegramProviderEventChallengeRow[]).filter(row =>
    verifyTelegramProviderEventChallengeCodeHash({ row, code })
  )
  if (matches.length === 0) return { error: 'challenge_not_found' }
  const viable = matches.filter(
    row =>
      !row.consumedAt && !row.isExpired && row.attempts < config.approvalMediumChallengeMaxAttempts
  )
  if (viable.length > 1) return { error: 'ambiguous_code' }
  if (viable.length === 1) return viable[0]!
  const row = matches[0]!
  if (row.consumedAt) return { error: 'challenge_consumed' }
  if (row.isExpired) return { error: 'challenge_expired' }
  if (row.attempts >= config.approvalMediumChallengeMaxAttempts) {
    return { error: 'too_many_attempts' }
  }
  return row
}
