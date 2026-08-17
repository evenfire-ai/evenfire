import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { validateCommunicationChannelConfig } from './channelConfigValidation'
import { EmailAdapter, SlackAdapter, TeamsAdapter, TelegramAdapter } from './channels'
import { config } from './config'
import { CredentialsResolver, DevCredentialsResolver, ResolvedCredentials } from './credentials'
import {
  type SlackEnrollmentHandoff,
  type SlackHandoffRequest,
  type SlackHandoffResponse,
  type SlackMessageHandoff,
  type TeamsEnrollmentHandoff,
  type TeamsFileConsentHandoff,
  type TeamsHandoffRequest,
  type TeamsMessageHandoff,
  createChannelReaderHandoffServer,
} from './handoffServer'
import type { NotificationDeliveryClient } from './notificationDeliveryClient'
import { createProgressStream } from './progressClient'
import { formatFinalMessage, formatProgressUpdate } from './progressFormatter'
import { type ChannelReaderRuntimeSource, MessageResponse, RPCClient } from './rpcClient'
import { type TraceContextV1, mintChannelTraceContext } from './traceContext'
import {
  Attachment,
  ChannelAdapter,
  CommunicationChannelCRD,
  CommunicationChannelSpec,
  Message,
  ProgressStep,
  ProviderTargetIdentity,
  SendMessageOptions,
  TelegramProviderChatType,
} from './types'
import { WorkflowApprovalCoordinator } from './workflowApprovalCoordinator'
import {
  contentWithoutAddressedBotMention,
  parseWorkflowApprovalDecisionCallback,
  parseWorkflowApprovalDecisionCommand,
} from './workflowApprovalDecision'

// Only import k8s client in production mode
let CommunicationChannelWatcher: typeof import('./k8sClient').CommunicationChannelWatcher

/**
 * Read the pod's own namespace from the Kubernetes downward-API ServiceAccount
 * file. Returns 'channels' as a safe default when the file is absent (dev/test).
 */
async function readPodNamespace(): Promise<string> {
  try {
    const { readFile } = await import('fs/promises')
    const nsPath = '/var/run/secrets/kubernetes.io/serviceaccount/namespace'
    const ns = await readFile(nsPath, 'utf8')
    return ns.trim() || 'channels'
  } catch {
    return 'channels'
  }
}

/**
 * Namespace where channel-reader resolves CC.spec.credentialsSecretRef Secrets.
 * Uses the reader's OWN namespace (CLERUM_NAMESPACE); falls back first to the
 * pod's self-derived namespace (downward-API SA file) and then to 'channels'
 * for single-tenant Clerum where CLERUM_NAMESPACE is empty and the reader runs
 * in 'channels'. In multi-tenant (MCC) deployments CLERUM_NAMESPACE is the
 * slug-scoped 'channels-<slug>' namespace where the credentials Secret lives —
 * a hardcoded 'channels' there 403s.
 */
export async function resolveCredentialsNamespace(clerumNamespace: string): Promise<string> {
  if (clerumNamespace) return clerumNamespace
  return readPodNamespace() // env empty → self-derive from downward API file
}

/**
 * Tracks a pending approval for a user/channel so channel-reader can
 * intercept /approve and /deny commands and poll for the final result.
 */
interface PendingApprovalState {
  taskId: string
  requestId: string
  userId: string
  channelType: 'telegram' | 'email' | 'slack' | 'teams'
  channelId: string
  originalMessage: Message
  createdAt: Date
  actionToken: string
  startResultPollingFallback?: () => void
  updateStatusAfterDecision?: (content: string) => Promise<void>
}

interface ProcessedProviderEvent {
  seenAt: number
}

/** Stale approval entries are cleaned up after this interval. */
const PENDING_APPROVAL_TTL_MS = 10 * 60 * 1000 // 10 minutes
const RESULT_POLL_FALLBACK_INTERVAL_MS = 2 * 1000
const RESULT_POLL_FALLBACK_TIMEOUT_MS = 30 * 60 * 1000
/** Telegram and Slack can redeliver the same provider event while poll offsets settle. */
const PROVIDER_EVENT_DEDUPE_TTL_MS = 10 * 60 * 1000 // 10 minutes
/** One "you are not linked" notice per Slack user per conversation per day. */
const UNRESOLVED_NOTICE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const UNRESOLVED_NOTICE_COPY =
  "I can't accept messages from this Slack account. If you haven't linked it yet, " +
  'do that in your evenfire profile. If you think you should already have access, contact your admin.'
const UNRESOLVED_NOTICE_COPY_TEAMS =
  "I can't accept messages from this Teams account. If you haven't linked it yet, " +
  'do that in your evenfire profile. If you think you should already have access, contact your admin.'
// Telegram deliberately gets no Profile UI link and no product name: unlike Teams
// and Slack, anyone who discovers the bot handle can message it, so a reply must
// not confirm what the bot belongs to.
const UNRESOLVED_NOTICE_COPY_TELEGRAM =
  "I can't accept messages from this account. If you think that is wrong, contact your administrator."
/**
 * Ceiling on live notice records, so a misconfiguration cannot turn the bot
 * into a flooder. Exported so tests assert against the real value.
 */
export const UNRESOLVED_NOTICE_GLOBAL_CAP = 50
/**
 * Limiter key prefix for a provider identity with no workspace/tenant scope.
 * Only Telegram ever reaches this: Slack and Teams identities always carry a
 * real workspaceId (sendUnresolvedSenderNotice returns early otherwise), so
 * this literal can never collide with an actual workspace or tenant id.
 */
const UNRESOLVED_NOTICE_NO_WORKSPACE_KEY = 'no-workspace'
const SLACK_VERIFICATION_SCAN_INTERVAL_MS = 60 * 1000
const TOOL_APPROVAL_ACTION_RE = /^tool:([ald]):([A-Za-z0-9_-]{16})$/
/**
 * Periodic CommunicationChannel resync interval (production mode only).
 * Even when no watch event fires, a re-list every 60 s self-heals missed
 * events from earlier reconnect gaps.
 */
export const CHANNEL_RESYNC_INTERVAL_MS = 60_000 // 60 seconds

type ToolApprovalDecision = '/approve' | '/approve always' | '/deny'

function newToolApprovalActionToken(): string {
  return randomBytes(12).toString('base64url')
}

function toolApprovalActionValue(
  decision: 'approve' | 'approveAlways' | 'deny',
  actionToken: string
): string {
  const code = decision === 'approve' ? 'a' : decision === 'approveAlways' ? 'l' : 'd'
  return `tool:${code}:${actionToken}`
}

function parseToolApprovalAction(content: string): {
  command: ToolApprovalDecision
  actionToken: string
} | null {
  const match = TOOL_APPROVAL_ACTION_RE.exec(content.trim())
  if (!match) return null
  return {
    command: match[1] === 'a' ? '/approve' : match[1] === 'l' ? '/approve always' : '/deny',
    actionToken: match[2],
  }
}

function toolApprovalMessageOptions(
  channelType: Message['channelType'],
  notification: string,
  actionToken: string
): SendMessageOptions | undefined {
  const approve = toolApprovalActionValue('approve', actionToken)
  const approveAlways = toolApprovalActionValue('approveAlways', actionToken)
  const deny = toolApprovalActionValue('deny', actionToken)
  if (channelType === 'telegram') {
    return {
      telegramInlineKeyboard: [
        [
          { text: 'Approve', callbackData: approve },
          { text: 'Deny', callbackData: deny },
        ],
        [{ text: 'Always approve', callbackData: approveAlways }],
      ],
    }
  }
  if (channelType === 'slack') {
    return {
      slackBlocks: [
        { type: 'section', text: { type: 'mrkdwn', text: notification } },
        {
          type: 'actions',
          block_id: `tool_approval_${actionToken}`,
          elements: [
            {
              type: 'button',
              action_id: 'tool_approval_approve',
              text: { type: 'plain_text', text: 'Approve' },
              value: approve,
              style: 'primary',
            },
            {
              type: 'button',
              action_id: 'tool_approval_always',
              text: { type: 'plain_text', text: 'Always approve' },
              value: approveAlways,
            },
            {
              type: 'button',
              action_id: 'tool_approval_deny',
              text: { type: 'plain_text', text: 'Deny' },
              value: deny,
              style: 'danger',
            },
          ],
        },
      ],
    }
  }
  if (channelType === 'teams') {
    return {
      teamsActions: [
        { title: 'Approve', value: approve, style: 'positive' },
        { title: 'Always approve', value: approveAlways },
        { title: 'Deny', value: deny, style: 'destructive' },
      ],
    }
  }
  return undefined
}

function supportedTelegramOperationalChatType(value: unknown): TelegramProviderChatType | null {
  return value === 'private' || value === 'group' || value === 'supergroup' ? value : null
}

function providerTargetFromChannel(
  channelCRD: CommunicationChannelCRD
): ProviderTargetIdentity | null {
  const hostRef = channelCRD.spec.hostRef?.trim()
  const communicationChannelName = channelCRD.name?.trim()
  const communicationChannelNamespace = channelCRD.namespace?.trim()
  if (!hostRef || !communicationChannelName || !communicationChannelNamespace) return null
  return { hostRef, communicationChannelNamespace, communicationChannelName }
}

function hasSlackChannelConfig(spec: CommunicationChannelSpec): boolean {
  if (spec.slack && spec.slack.length > 0) return true
  const settings = spec.slackSettings
  return !!(settings?.workspaceId?.trim() || settings?.botHandle?.trim())
}

function hasTeamsChannelConfig(spec: CommunicationChannelSpec): boolean {
  if (spec.teams && spec.teams.length > 0) return true
  const settings = spec.teamsSettings
  return !!(
    settings?.tenantId?.trim() ||
    settings?.appId?.trim() ||
    settings?.appName?.trim() ||
    settings?.replyOnlyWhenMentioned !== undefined
  )
}

type ChannelReaderRpcClient = Pick<
  RPCClient,
  | 'healthCheck'
  | 'sendMessage'
  | 'getBaseUrl'
  | 'getTaskResult'
  | 'sendApproval'
  | 'sendDenial'
  | 'sendWorkflowApprovalDecision'
  | 'resolveWorkflowApproval'
  | 'fetchDeliveries'
  | 'acknowledge'
  | 'fail'
  | 'confirmTelegramChallenge'
  | 'getCronResults'
  | 'acknowledgeCronResult'
> & {
  authorizeProviderMessage?: RPCClient['authorizeProviderMessage']
  downloadWorkflowResultByRun?: RPCClient['downloadWorkflowResultByRun']
  confirmSlackLinkSession?: RPCClient['confirmSlackLinkSession']
  confirmTeamsLinkSession?: RPCClient['confirmTeamsLinkSession']
}

type ChannelType = ChannelAdapter['channelType']
type CommunicationChannelRef = {
  namespace: string
  name: string
}

export interface ChannelReaderOptions {
  rpcClient?: ChannelReaderRpcClient
  notificationDeliveryClient?: NotificationDeliveryClient | null
  adapters?: Map<string, ChannelAdapter>
  channels?: CommunicationChannelCRD[]
  sleep?: (ms: number) => Promise<void>
  credentialsResolver?: { resolve(cc: CommunicationChannelCRD): Promise<ResolvedCredentials> }
}

export class ChannelReader {
  private watcher?: InstanceType<typeof CommunicationChannelWatcher>
  private adapters: Map<string, ChannelAdapter> = new Map()
  private channels: CommunicationChannelCRD[] = []
  private running: boolean = false
  private needsRestart: boolean = false
  private rpcClient: ChannelReaderRpcClient
  private notificationDeliveryClient: NotificationDeliveryClient | null
  private sleepImpl: (ms: number) => Promise<void>
  private credentialsResolver: {
    resolve(cc: CommunicationChannelCRD): Promise<ResolvedCredentials>
  } | null
  /** Pending approvals keyed by provider conversation/thread and sender. */
  private pendingApprovals: Map<string, PendingApprovalState> = new Map()
  /** Recently processed provider events keyed by stable provider or channel message identity. */
  private processedProviderEvents: Map<string, ProcessedProviderEvent> = new Map()
  /** Unresolved-sender notices already sent, keyed by workspace + user + channel. */
  private unresolvedNoticesSent: Map<string, { seenAt: number }> = new Map()
  /**
   * Whether the global-cap warning below has already logged for the current
   * capped episode. Reset to false once cleanupStaleApprovals' TTL sweep drains
   * unresolvedNoticesSent back under UNRESOLVED_NOTICE_GLOBAL_CAP, so a later
   * trip into the cap logs again instead of staying silent forever.
   */
  private unresolvedNoticeCapLogged = false
  /** Adapter route key by provider + CommunicationChannel ref. */
  private adapterKeysByCommunicationChannel: Map<string, string> = new Map()
  /** Adapter route key by provider + runtime channel id. */
  private adapterKeysByRuntimeChannel: Map<string, string> = new Map()
  /** Default adapter route key by provider for legacy/generic delivery paths. */
  private defaultAdapterKeyByChannelType: Map<ChannelType, string> = new Map()
  /** Last full Slack conversation scan by CommunicationChannel target key. */
  private lastSlackVerificationScanAtByTarget: Map<string, number> = new Map()
  private handoffServer: http.Server | null = null
  private workflowApprovalCoordinator: WorkflowApprovalCoordinator
  /** Timestamp (Date.now()) of the last periodic CommunicationChannel resync. */
  private lastChannelResyncAt: number = 0

  constructor(options: ChannelReaderOptions = {}) {
    if (options.rpcClient) {
      this.rpcClient = options.rpcClient
    } else {
      this.rpcClient = new RPCClient(config.mcpHostUrl)
    }
    this.notificationDeliveryClient =
      options.notificationDeliveryClient === undefined
        ? this.rpcClient
        : options.notificationDeliveryClient
    this.adapters = options.adapters ?? new Map()
    this.channels = options.channels ?? []
    this.sleepImpl = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.credentialsResolver = options.credentialsResolver ?? null
    this.workflowApprovalCoordinator = new WorkflowApprovalCoordinator({
      rpcClient: this.rpcClient,
      notificationDeliveryClient: this.notificationDeliveryClient,
      getAdapters: () => this.adapters,
      getChannels: () => this.channels,
      getAdapterForChannel: (medium, channelRef) =>
        this.adapterForCommunicationChannelRef(medium, channelRef),
      sendReply: (message, content) => this.sendReply(message, content),
    })
  }

  async initialize(): Promise<void> {
    if (!config.devMode) {
      // Dynamically import k8s client only in production mode
      const k8sModule = await import('./k8sClient')
      CommunicationChannelWatcher = k8sModule.CommunicationChannelWatcher

      this.watcher = new CommunicationChannelWatcher(config.hostRef, config.namespace)

      // Set up change handler
      this.watcher.onChange(channels => {
        console.log(`[Main] CommunicationChannel CRDs changed, scheduling restart...`)
        this.needsRestart = true
      })
    }

    if (!this.credentialsResolver) {
      if (config.devMode) {
        this.credentialsResolver = new DevCredentialsResolver()
      } else {
        const k8s = await import('@kubernetes/client-node')
        const kc = new k8s.KubeConfig()
        kc.loadFromCluster()
        const coreApi = kc.makeApiClient(k8s.CoreV1Api)
        const credentialsNamespace = await resolveCredentialsNamespace(config.namespace)
        this.credentialsResolver = new CredentialsResolver(coreApi, credentialsNamespace)
      }
    }

    // Check if mcp-host is reachable
    console.log(`[Main] Checking mcp-host connectivity at ${config.mcpHostUrl}...`)
    const healthy = await this.rpcClient.healthCheck()
    if (healthy) {
      console.log('[Main] mcp-host is reachable')
    } else {
      console.warn(
        '[Main] mcp-host is not reachable - messages will be queued until it becomes available'
      )
    }
  }

  validateChannelConfig(channelCRD: CommunicationChannelCRD): void {
    validateCommunicationChannelConfig(channelCRD)
  }

  private shouldRunSlackVerificationScan(scanKey: string): boolean {
    const now = Date.now()
    const lastRun = this.lastSlackVerificationScanAtByTarget.get(scanKey)
    if (lastRun === undefined) {
      this.lastSlackVerificationScanAtByTarget.set(scanKey, now)
      return true
    }
    if (now - lastRun < SLACK_VERIFICATION_SCAN_INTERVAL_MS) return false
    this.lastSlackVerificationScanAtByTarget.set(scanKey, now)
    return true
  }

  /**
   * Initialize channel adapters for configured channels. If no channels are
   * loaded yet (zero CRDs match the hostRef filter), logs a warning and
   * returns. The CRD watcher will trigger a restart when channels appear.
   */
  async initializeAdapters(): Promise<void> {
    console.log('[Main] Initializing channel adapters...')
    this.adapterKeysByCommunicationChannel.clear()
    this.adapterKeysByRuntimeChannel.clear()
    this.defaultAdapterKeyByChannelType.clear()

    for (const channel of this.channels) {
      this.validateChannelConfig(channel)
    }

    const ccsWithTelegram = this.channels.filter(
      c =>
        (c.spec.telegram && c.spec.telegram.length > 0) ||
        (c.spec.telegramSettings &&
          typeof c.spec.telegramSettings === 'object' &&
          !Array.isArray(c.spec.telegramSettings))
    )
    const ccsWithEmail = this.channels.filter(c => c.spec.email && c.spec.email.length > 0)
    const ccsWithSlack = this.channels.filter(c => hasSlackChannelConfig(c.spec))
    const ccsWithTeams = this.channels.filter(c => hasTeamsChannelConfig(c.spec))

    console.log(`[Main] needsTelegram: ${ccsWithTelegram.length > 0}`)
    console.log(`[Main] needsEmail: ${ccsWithEmail.length > 0}`)
    console.log(`[Main] needsSlack: ${ccsWithSlack.length > 0}`)
    console.log(`[Main] needsTeams: ${ccsWithTeams.length > 0}`)

    if (
      ccsWithTelegram.length === 0 &&
      ccsWithEmail.length === 0 &&
      ccsWithSlack.length === 0 &&
      ccsWithTeams.length === 0
    ) {
      console.warn(
        '[Main] No channel adapters to initialize yet. Waiting for CommunicationChannel CRDs to be created.'
      )
      return
    }

    // Build per-channel-type credential winner. Conflict policy: pick the
    // CC whose name sorts first (localeCompare en) and log a warning.
    const resolved = new Map<string, ResolvedCredentials>()
    if (this.credentialsResolver) {
      for (const cc of this.channels) {
        resolved.set(cc.name, await this.credentialsResolver.resolve(cc))
      }
    }

    const pickToken = (
      ccs: CommunicationChannelCRD[],
      channelType: 'telegram' | 'slack' | 'email',
      pluck: (r: ResolvedCredentials) => string | undefined
    ): { creds: ResolvedCredentials | undefined; sourceChannel?: CommunicationChannelCRD } => {
      const withCreds = ccs
        .map(cc => ({
          cc,
          name: cc.name,
          token: pluck(resolved.get(cc.name) ?? {}),
          creds: resolved.get(cc.name),
        }))
        .filter(({ token }) => !!token)
        .sort((a, b) => a.name.localeCompare(b.name, 'en'))
      if (withCreds.length === 0) return { creds: undefined }
      const distinctTokens = new Set(withCreds.map(c => c.token))
      if (distinctTokens.size > 1) {
        const losers = withCreds
          .slice(1)
          .map(c => c.name)
          .join(', ')
        console.warn(
          `[Main] WARN: multiple CCs with different credentialsSecretRef for ${channelType}; using ${withCreds[0].name}'s token (losers: ${losers}). PR2 will lift this.`
        )
      }
      return { creds: withCreds[0].creds, sourceChannel: withCreds[0].cc }
    }

    if (ccsWithTelegram.length > 0) {
      const withTelegramCreds = ccsWithTelegram
        .map(cc => ({
          cc,
          token: resolved.get(cc.name)?.telegramBotToken,
        }))
        .filter((entry): entry is { cc: CommunicationChannelCRD; token: string } =>
          Boolean(entry.token)
        )
        .sort((a, b) => a.cc.name.localeCompare(b.cc.name, 'en'))
      const groupsByToken = new Map<string, CommunicationChannelCRD[]>()
      for (const entry of withTelegramCreds) {
        const current = groupsByToken.get(entry.token) ?? []
        current.push(entry.cc)
        groupsByToken.set(entry.token, current)
      }
      const telegramCredentialGroups = [...groupsByToken.entries()]
      if (telegramCredentialGroups.length > 1) {
        console.log(
          `[Main] Initializing ${telegramCredentialGroups.length} Telegram adapters from CommunicationChannel credentials`
        )
      }
      for (const [telegramBotToken, ccs] of telegramCredentialGroups) {
        const sourceChannel = ccs[0]!
        const providerTargets = ccs
          .map(cc => providerTargetFromChannel(cc))
          .filter((target): target is ProviderTargetIdentity => target !== null)
        const adapterKey = `telegram:${sourceChannel.namespace}/${sourceChannel.name}`
        for (const cc of ccs) {
          this.bindAdapterToCommunicationChannel('telegram', cc, adapterKey)
        }
        this.defaultAdapterKeyByChannelType.set(
          'telegram',
          this.defaultAdapterKeyByChannelType.get('telegram') ?? adapterKey
        )
        const adapter = this.adapters.get(adapterKey) ?? new TelegramAdapter(this.rpcClient)
        await adapter.connect({
          telegramBotToken,
          providerTarget: providerTargetFromChannel(sourceChannel) ?? undefined,
          providerTargets,
        })
        this.adapters.set(adapterKey, adapter)
      }
    }

    if (ccsWithEmail.length > 0) {
      const { creds } = pickToken(ccsWithEmail, 'email', r => r.emailUsername)
      if (creds?.emailUsername && creds?.emailPassword) {
        const adapter = this.adapters.get('email') ?? new EmailAdapter()
        await adapter.connect({
          emailUsername: creds.emailUsername,
          emailPassword: creds.emailPassword,
        })
        this.adapters.set('email', adapter)
        for (const cc of ccsWithEmail) {
          this.bindAdapterToCommunicationChannel('email', cc, 'email')
        }
        this.defaultAdapterKeyByChannelType.set('email', 'email')
      }
    }

    if (ccsWithSlack.length > 0) {
      const withSlackCreds = ccsWithSlack
        .map(cc => ({
          cc,
          token: resolved.get(cc.name)?.slackBotToken,
        }))
        .filter((entry): entry is { cc: CommunicationChannelCRD; token: string } =>
          Boolean(entry.token)
        )
        .sort((a, b) => a.cc.name.localeCompare(b.cc.name, 'en'))
      const groupsByToken = new Map<string, CommunicationChannelCRD[]>()
      for (const entry of withSlackCreds) {
        const current = groupsByToken.get(entry.token) ?? []
        current.push(entry.cc)
        groupsByToken.set(entry.token, current)
      }
      const slackCredentialGroups = [...groupsByToken.entries()]
      if (slackCredentialGroups.length > 1) {
        console.log(
          `[Main] Initializing ${slackCredentialGroups.length} Slack adapters from CommunicationChannel credentials`
        )
      }
      for (const [slackBotToken, ccs] of slackCredentialGroups) {
        const sourceChannel = ccs[0]!
        const providerTargets = ccs
          .map(cc => providerTargetFromChannel(cc))
          .filter((target): target is ProviderTargetIdentity => target !== null)
        const adapterKey = `slack:${sourceChannel.namespace}/${sourceChannel.name}`
        for (const cc of ccs) {
          this.bindAdapterToCommunicationChannel('slack', cc, adapterKey)
        }
        this.defaultAdapterKeyByChannelType.set(
          'slack',
          this.defaultAdapterKeyByChannelType.get('slack') ?? adapterKey
        )
        const slackVerificationClient = this.rpcClient.confirmSlackLinkSession
          ? {
              confirmSlackLinkSession: (
                params: Parameters<RPCClient['confirmSlackLinkSession']>[0]
              ) => this.rpcClient.confirmSlackLinkSession!(params),
            }
          : null
        const adapter = this.adapters.get(adapterKey) ?? new SlackAdapter(slackVerificationClient)
        await adapter.connect({
          slackBotToken,
          providerTarget: providerTargetFromChannel(sourceChannel) ?? undefined,
          providerTargets,
        })
        this.adapters.set(adapterKey, adapter)
      }
    }

    if (ccsWithTeams.length > 0) {
      const withTeamsCreds = ccsWithTeams
        .map(cc => ({
          cc,
          appId: cc.spec.teamsSettings?.appId?.trim(),
          tenantId: cc.spec.teamsSettings?.tenantId?.trim(),
          password: resolved.get(cc.name)?.teamsAppPassword,
        }))
        .filter(
          (
            entry
          ): entry is {
            cc: CommunicationChannelCRD
            appId: string
            tenantId: string
            password: string
          } => Boolean(entry.appId && entry.tenantId && entry.password)
        )
        .sort((a, b) => a.cc.name.localeCompare(b.cc.name, 'en'))
      const groupsByCredential = new Map<string, typeof withTeamsCreds>()
      for (const entry of withTeamsCreds) {
        const key = `${entry.tenantId}\0${entry.appId}\0${entry.password}`
        const current = groupsByCredential.get(key) ?? []
        current.push(entry)
        groupsByCredential.set(key, current)
      }
      const teamsCredentialGroups = [...groupsByCredential.values()]
      if (teamsCredentialGroups.length > 1) {
        console.log(
          `[Main] Initializing ${teamsCredentialGroups.length} Teams adapters from CommunicationChannel credentials`
        )
      }
      for (const entries of teamsCredentialGroups) {
        const source = entries[0]!
        const ccs = entries.map(entry => entry.cc)
        const sourceChannel = source.cc
        const providerTargets = ccs
          .map(cc => providerTargetFromChannel(cc))
          .filter((target): target is ProviderTargetIdentity => target !== null)
        const serviceUrls = new Map<string, string>()
        for (const cc of ccs) {
          for (const group of cc.spec.teams ?? []) {
            const conversationId = group.channelId?.trim()
            const serviceUrl = group.serviceUrl?.trim()
            if (conversationId && serviceUrl) serviceUrls.set(conversationId, serviceUrl)
          }
        }
        const adapterKey = `teams:${sourceChannel.namespace}/${sourceChannel.name}`
        for (const cc of ccs) {
          this.bindAdapterToCommunicationChannel('teams', cc, adapterKey)
        }
        this.defaultAdapterKeyByChannelType.set(
          'teams',
          this.defaultAdapterKeyByChannelType.get('teams') ?? adapterKey
        )
        const adapter = this.adapters.get(adapterKey) ?? new TeamsAdapter()
        await adapter.connect({
          teamsAppId: source.appId,
          teamsTenantId: source.tenantId,
          teamsAppPassword: source.password,
          teamsServiceUrlsByConversationId: serviceUrls,
          providerTarget: providerTargetFromChannel(sourceChannel) ?? undefined,
          providerTargets,
        })
        this.adapters.set(adapterKey, adapter)
      }
    }

    if (this.adapters.size === 0) {
      console.warn(
        '[Main] No channel adapters connected — credentials may be missing. Set them via Control UI on the relevant CommunicationChannel.'
      )
      return
    }

    console.log(`[Main] Initialized ${this.adapters.size} channel adapter(s)`)
  }

  /**
   * Shutdown all channel adapters.
   */
  async shutdownAdapters(): Promise<void> {
    console.log('[Main] Shutting down channel adapters...')

    await Promise.all([...new Set(this.adapters.values())].map(adapter => adapter.disconnect()))

    this.adapters.clear()
    this.adapterKeysByCommunicationChannel.clear()
    this.adapterKeysByRuntimeChannel.clear()
    this.defaultAdapterKeyByChannelType.clear()
    console.log('[Main] Channel adapters shut down')
  }

  private communicationChannelKey(channel: CommunicationChannelRef): string {
    return `${channel.namespace}/${channel.name}`
  }

  private communicationChannelAdapterMapKey(
    channelType: ChannelType,
    channel: CommunicationChannelRef
  ): string {
    return `${channelType}:${this.communicationChannelKey(channel)}`
  }

  private runtimeChannelAdapterMapKey(channelType: ChannelType, channelId: string): string {
    return `${channelType}:${channelId}`
  }

  private runtimeChannelIdsForChannel(
    channelType: ChannelType,
    channel: CommunicationChannelCRD
  ): string[] {
    const groups =
      channelType === 'telegram'
        ? channel.spec.telegram
        : channelType === 'slack'
          ? channel.spec.slack
          : channelType === 'teams'
            ? channel.spec.teams
            : channel.spec.email
    return (groups ?? []).map(group => String(group.channelId || '').trim()).filter(Boolean)
  }

  private bindAdapterToCommunicationChannel(
    channelType: ChannelType,
    channel: CommunicationChannelCRD,
    adapterKey: string
  ): void {
    this.adapterKeysByCommunicationChannel.set(
      this.communicationChannelAdapterMapKey(channelType, channel),
      adapterKey
    )
    for (const channelId of this.runtimeChannelIdsForChannel(channelType, channel)) {
      this.adapterKeysByRuntimeChannel.set(
        this.runtimeChannelAdapterMapKey(channelType, channelId),
        adapterKey
      )
    }
  }

  private adapterForCommunicationChannelRef(
    channelType: ChannelType,
    channel: CommunicationChannelRef
  ): ChannelAdapter | undefined {
    const adapterKey = this.adapterKeysByCommunicationChannel.get(
      this.communicationChannelAdapterMapKey(channelType, channel)
    )
    if (adapterKey) {
      const adapter = this.adapters.get(adapterKey)
      if (adapter) return adapter
      console.warn(
        `[Main] Adapter key ${adapterKey} for ${channelType} CommunicationChannel ` +
          `${this.communicationChannelKey(channel)} is not initialized; using default adapter`
      )
    } else {
      console.warn(
        `[Main] No ${channelType} adapter key for CommunicationChannel ` +
          `${this.communicationChannelKey(channel)}; using default adapter`
      )
    }
    return this.adapterForChannelType(channelType)
  }

  private adapterForChannel(
    channelType: ChannelType,
    channel: CommunicationChannelCRD
  ): ChannelAdapter | undefined {
    return this.adapterForCommunicationChannelRef(channelType, channel)
  }

  private adapterForChannelType(channelType: ChannelType): ChannelAdapter | undefined {
    const defaultKey = this.defaultAdapterKeyByChannelType.get(channelType)
    if (defaultKey) return this.adapters.get(defaultKey)
    return this.adapters.get(channelType)
  }

  private adapterForMessage(message: Message): ChannelAdapter | undefined {
    const target = message.providerIdentity?.providerTarget
    if (target?.communicationChannelNamespace && target.communicationChannelName) {
      return this.adapterForCommunicationChannelRef(message.channelType, {
        namespace: target.communicationChannelNamespace,
        name: target.communicationChannelName,
      })
    }
    return this.adapterForChannelType(message.channelType)
  }

  private adapterForRuntimeSource(source: ChannelReaderRuntimeSource): ChannelAdapter | undefined {
    const adapterKey = this.adapterKeysByRuntimeChannel.get(
      this.runtimeChannelAdapterMapKey(source.channelType, source.channelId)
    )
    if (adapterKey) {
      const adapter = this.adapters.get(adapterKey)
      if (adapter) return adapter
      console.warn(
        `[Main] Adapter key ${adapterKey} for ${source.channelType} runtime channel ` +
          `${source.channelId} is not initialized; using default adapter`
      )
    } else {
      console.warn(
        `[Main] No ${source.channelType} adapter key for runtime channel ` +
          `${source.channelId}; using default adapter`
      )
    }
    return this.adapterForChannelType(source.channelType)
  }

  private slackMessageFromHandoff(handoff: SlackMessageHandoff): Message | null {
    const providerTarget = handoff.providerTarget
    if (
      !handoff.content?.trim() ||
      !handoff.providerUserId?.trim() ||
      !handoff.providerWorkspaceId?.trim() ||
      !handoff.providerChannelId?.trim() ||
      !handoff.providerEventId?.trim() ||
      !handoff.providerMessageTs?.trim() ||
      !providerTarget?.hostRef ||
      !providerTarget.communicationChannelNamespace ||
      !providerTarget.communicationChannelName
    ) {
      return null
    }

    const timestampMs = Number.parseFloat(handoff.providerMessageTs) * 1000
    return {
      channelType: 'slack',
      channelId: handoff.providerChannelId,
      sender: handoff.providerUserId,
      content: handoff.content,
      timestamp: Number.isFinite(timestampMs) ? new Date(timestampMs) : new Date(),
      messageId: handoff.providerMessageTs,
      ...(handoff.responseThreadTs ? { threadId: handoff.responseThreadTs } : {}),
      providerIdentity: {
        medium: 'slack',
        providerUserId: handoff.providerUserId,
        providerWorkspaceId: handoff.providerWorkspaceId,
        providerChannelId: handoff.providerChannelId,
        providerEventId: handoff.providerEventId,
        providerTarget,
      },
      rawData: handoff.rawData ?? {},
    }
  }

  private teamsMessageFromHandoff(handoff: TeamsMessageHandoff): Message | null {
    const providerTarget = handoff.providerTarget
    if (
      !handoff.content?.trim() ||
      !handoff.providerUserId?.trim() ||
      !handoff.providerWorkspaceId?.trim() ||
      !handoff.providerChannelId?.trim() ||
      !handoff.providerConversationId?.trim() ||
      !handoff.providerReplyToMessageId?.trim() ||
      !handoff.providerEventId?.trim() ||
      !handoff.providerMessageId?.trim() ||
      !handoff.serviceUrl?.trim() ||
      !providerTarget?.hostRef ||
      !providerTarget.communicationChannelNamespace ||
      !providerTarget.communicationChannelName
    ) {
      return null
    }

    return {
      channelType: 'teams',
      channelId: handoff.providerConversationId,
      sender: handoff.providerUserId,
      content: handoff.content,
      timestamp: new Date(),
      messageId: handoff.providerMessageId,
      threadId: handoff.providerReplyToMessageId,
      providerIdentity: {
        medium: 'teams',
        providerUserId: handoff.providerUserId,
        providerWorkspaceId: handoff.providerWorkspaceId,
        providerChannelId: handoff.providerChannelId,
        providerChannelType: handoff.providerChannelType ?? null,
        providerEventId: handoff.providerEventId,
        providerTarget,
      },
      rawData: {
        ...(handoff.rawData ?? {}),
        serviceUrl: handoff.serviceUrl,
      },
    }
  }

  private rememberTeamsConversation(
    providerTarget: ProviderTargetIdentity,
    channelId: string,
    serviceUrl: string
  ): void {
    const adapter = this.adapterForCommunicationChannelRef('teams', {
      namespace: providerTarget.communicationChannelNamespace,
      name: providerTarget.communicationChannelName,
    })
    if (adapter instanceof TeamsAdapter) {
      adapter.rememberConversation(channelId, serviceUrl)
    }
  }

  private async deliverProviderWorkflowResult(
    message: Message,
    workflowRunId: string
  ): Promise<void> {
    const adapter = this.adapterForMessage(message)
    if (!adapter) return
    if (!this.rpcClient.downloadWorkflowResultByRun) {
      await adapter.sendMessage(
        message.channelId,
        'Workflow result download is not available from this channel.',
        message.threadId
      )
      return
    }
    const result = await this.rpcClient.downloadWorkflowResultByRun(message, workflowRunId)
    if (!result.success) {
      await adapter.sendMessage(
        message.channelId,
        result.error?.message || 'Workflow result could not be downloaded.',
        message.threadId
      )
      return
    }

    const attachments = result.attachments ?? []
    if (adapter instanceof TeamsAdapter && attachments.length > 0) {
      const attachment = attachments[0]!
      if (message.providerIdentity?.providerChannelType === 'personal') {
        await adapter.sendFileConsent(
          message.channelId,
          attachment,
          {
            workflowRunId,
            artifactName: attachment.artifactName || attachment.filename || attachment.id,
          },
          message.threadId
        )
        return
      }
      if (attachment.mimeType.split(';', 1)[0]?.toLowerCase() !== 'text/plain') {
        await adapter.sendMessage(
          message.channelId,
          'Open a direct chat with this bot to download the workflow result file.',
          message.threadId
        )
        return
      }
    }

    await adapter.sendMessage(
      message.channelId,
      attachments.length > 0 ? '' : result.response || 'No workflow result file is available.',
      message.threadId,
      attachments
    )
  }

  async handleSlackHandoff(request: SlackHandoffRequest): Promise<SlackHandoffResponse> {
    if (request.kind === 'slack.message') {
      const message = this.slackMessageFromHandoff(request)
      if (!message) return { ok: false, status: 400, error: 'invalid_slack_message_handoff' }
      if (request.workflowRunId) {
        await this.deliverProviderWorkflowResult(message, request.workflowRunId)
      } else {
        await this.handleMessages([message])
      }
      return { ok: true }
    }

    if (request.kind === 'slack.enrollment') {
      return this.handleSlackEnrollmentHandoff(request)
    }

    return { ok: false, status: 400, error: 'unsupported_handoff_kind' }
  }

  async handleTeamsHandoff(request: TeamsHandoffRequest): Promise<SlackHandoffResponse> {
    if (request.kind === 'teams.message') {
      const message = this.teamsMessageFromHandoff(request)
      if (!message) return { ok: false, status: 400, error: 'invalid_teams_message_handoff' }
      this.rememberTeamsConversation(
        request.providerTarget,
        request.providerConversationId,
        request.serviceUrl
      )
      if (request.workflowRunId) {
        await this.deliverProviderWorkflowResult(message, request.workflowRunId)
      } else {
        await this.handleMessages([message])
      }
      return { ok: true }
    }

    if (request.kind === 'teams.file-consent') {
      return this.handleTeamsFileConsentHandoff(request)
    }

    if (request.kind === 'teams.enrollment') {
      return this.handleTeamsEnrollmentHandoff(request)
    }

    return { ok: false, status: 400, error: 'unsupported_handoff_kind' }
  }

  private async handleTeamsFileConsentHandoff(
    handoff: TeamsFileConsentHandoff
  ): Promise<SlackHandoffResponse> {
    const providerTarget = handoff.providerTarget
    if (
      !handoff.workflowRunId?.trim() ||
      !handoff.artifactName?.trim() ||
      !handoff.providerUserId?.trim() ||
      !handoff.providerWorkspaceId?.trim() ||
      !handoff.providerChannelId?.trim() ||
      !handoff.providerConversationId?.trim() ||
      !handoff.providerEventId?.trim() ||
      !handoff.providerMessageId?.trim() ||
      !handoff.serviceUrl?.trim() ||
      !providerTarget?.hostRef ||
      !providerTarget.communicationChannelNamespace ||
      !providerTarget.communicationChannelName
    ) {
      return { ok: false, status: 400, error: 'invalid_teams_file_consent_handoff' }
    }

    const adapter = this.adapterForCommunicationChannelRef('teams', {
      namespace: providerTarget.communicationChannelNamespace,
      name: providerTarget.communicationChannelName,
    })
    if (!(adapter instanceof TeamsAdapter)) {
      return { ok: false, status: 503, error: 'teams_adapter_unavailable' }
    }
    adapter.rememberConversation(handoff.providerConversationId, handoff.serviceUrl)
    if (handoff.action === 'decline') {
      await adapter.sendMessage(
        handoff.providerConversationId,
        'Workflow result download canceled.',
        handoff.providerReplyToMessageId || undefined
      )
      return { ok: true }
    }
    if (!handoff.uploadInfo) {
      return { ok: false, status: 400, error: 'teams_file_upload_info_missing' }
    }

    const message: Message = {
      channelType: 'teams',
      channelId: handoff.providerConversationId,
      sender: handoff.providerUserId,
      content: 'Download the completed workflow result',
      timestamp: new Date(),
      messageId: handoff.providerMessageId,
      threadId: handoff.providerReplyToMessageId,
      providerIdentity: {
        medium: 'teams',
        providerUserId: handoff.providerUserId,
        providerWorkspaceId: handoff.providerWorkspaceId,
        providerChannelId: handoff.providerChannelId,
        providerChannelType: handoff.providerChannelType ?? null,
        providerEventId: handoff.providerEventId,
        providerTarget,
      },
      rawData: { serviceUrl: handoff.serviceUrl },
    }
    if (!this.rpcClient.downloadWorkflowResultByRun) {
      return { ok: false, status: 503, error: 'workflow_result_download_unavailable' }
    }
    const result = await this.rpcClient.downloadWorkflowResultByRun(
      message,
      handoff.workflowRunId,
      handoff.artifactName
    )
    const attachment = result.attachments?.[0]
    if (!result.success || !attachment) {
      await adapter.sendMessage(
        handoff.providerConversationId,
        result.error?.message || 'Workflow result could not be downloaded.',
        handoff.providerReplyToMessageId || undefined
      )
      return { ok: true }
    }

    try {
      await adapter.uploadConsentedFile(
        handoff.providerConversationId,
        attachment,
        handoff.uploadInfo,
        handoff.providerReplyToMessageId || undefined
      )
    } catch (error) {
      console.error(
        '[Teams] Workflow result upload failed:',
        error instanceof Error ? error.message : error
      )
      await adapter.sendMessage(
        handoff.providerConversationId,
        'Teams could not upload the workflow result file. Try the download again.',
        handoff.providerReplyToMessageId || undefined
      )
    }
    return { ok: true }
  }

  private async handleSlackEnrollmentHandoff(
    handoff: SlackEnrollmentHandoff
  ): Promise<SlackHandoffResponse> {
    const providerTarget = handoff.providerTarget
    if (
      !handoff.nonce?.trim() ||
      !handoff.providerUserId?.trim() ||
      !handoff.providerWorkspaceId?.trim() ||
      !handoff.providerChannelId?.trim() ||
      !providerTarget?.hostRef ||
      !providerTarget.communicationChannelNamespace ||
      !providerTarget.communicationChannelName
    ) {
      return { ok: false, status: 400, error: 'invalid_slack_enrollment_handoff' }
    }

    if (!this.rpcClient.confirmSlackLinkSession) {
      return { ok: false, status: 503, error: 'slack_verification_unavailable' }
    }

    const adapter = this.adapterForCommunicationChannelRef('slack', {
      namespace: providerTarget.communicationChannelNamespace,
      name: providerTarget.communicationChannelName,
    })
    if (!adapter) {
      return { ok: false, status: 503, error: 'slack_adapter_unavailable' }
    }
    const conversationMetadata =
      adapter instanceof SlackAdapter
        ? await adapter.getConversationMetadata(handoff.providerChannelId, handoff.providerUserId)
        : {}

    const result = await this.rpcClient.confirmSlackLinkSession({
      nonce: handoff.nonce,
      providerUserId: handoff.providerUserId,
      providerWorkspaceId: handoff.providerWorkspaceId,
      providerChannelId: handoff.providerChannelId,
      providerChannelType:
        handoff.providerChannelType ?? conversationMetadata.providerChannelType ?? null,
      providerChannelTitle:
        handoff.providerChannelTitle ?? conversationMetadata.providerChannelTitle ?? null,
      providerTarget,
    })
    await adapter.sendMessage(
      handoff.providerChannelId,
      result.ok
        ? 'Slack identity confirmed.'
        : 'Slack verification failed. Check that the code is active and try again.',
      handoff.responseThreadTs || undefined
    )
    return { ok: true }
  }

  private async handleTeamsEnrollmentHandoff(
    handoff: TeamsEnrollmentHandoff
  ): Promise<SlackHandoffResponse> {
    const providerTarget = handoff.providerTarget
    if (
      !handoff.nonce?.trim() ||
      !handoff.providerUserId?.trim() ||
      !handoff.providerWorkspaceId?.trim() ||
      !handoff.providerChannelId?.trim() ||
      !handoff.providerConversationId?.trim() ||
      !handoff.providerReplyToMessageId?.trim() ||
      !handoff.serviceUrl?.trim() ||
      !providerTarget?.hostRef ||
      !providerTarget.communicationChannelNamespace ||
      !providerTarget.communicationChannelName
    ) {
      return { ok: false, status: 400, error: 'invalid_teams_enrollment_handoff' }
    }

    if (!this.rpcClient.confirmTeamsLinkSession) {
      return { ok: false, status: 503, error: 'teams_verification_unavailable' }
    }

    const adapter = this.adapterForCommunicationChannelRef('teams', {
      namespace: providerTarget.communicationChannelNamespace,
      name: providerTarget.communicationChannelName,
    })
    if (!adapter) {
      return { ok: false, status: 503, error: 'teams_adapter_unavailable' }
    }
    this.rememberTeamsConversation(
      providerTarget,
      handoff.providerConversationId,
      handoff.serviceUrl
    )
    if (adapter instanceof TeamsAdapter) {
      await adapter.verifyCredentials()
    }

    const result = await this.rpcClient.confirmTeamsLinkSession({
      nonce: handoff.nonce,
      providerUserId: handoff.providerUserId,
      providerWorkspaceId: handoff.providerWorkspaceId,
      providerChannelId: handoff.providerChannelId,
      providerChannelType: handoff.providerChannelType ?? null,
      providerChannelTitle: handoff.providerChannelTitle ?? null,
      providerTeamId: handoff.providerTeamId ?? null,
      providerTeamsChannelId: handoff.providerTeamsChannelId ?? null,
      serviceUrl: handoff.serviceUrl,
      providerTarget,
    })
    const replyAdapter =
      this.adapterForCommunicationChannelRef('teams', {
        namespace: providerTarget.communicationChannelNamespace,
        name: providerTarget.communicationChannelName,
      }) ?? adapter
    if (replyAdapter instanceof TeamsAdapter) {
      replyAdapter.rememberConversation(handoff.providerConversationId, handoff.serviceUrl)
    }
    await replyAdapter.sendMessage(
      handoff.providerConversationId,
      result.ok
        ? 'Teams identity confirmed.'
        : 'Teams verification failed. Check that the code is active and try again.',
      result.ok && result.replyInThreads === false
        ? undefined
        : handoff.providerReplyToMessageId || handoff.providerMessageId || undefined
    )
    return { ok: true }
  }

  /**
   * Load channels from dev config.
   * @throws Error if no channel config is provided in dev mode
   */
  loadDevChannels(): CommunicationChannelCRD[] {
    if (!config.devChannelConfig) {
      throw new Error(
        'No CLERUM_CHANNEL environment variable provided. In dev mode, you must set CLERUM_CHANNEL with a JSON channel configuration.'
      )
    }

    const crd: CommunicationChannelCRD = {
      name: 'dev-channel',
      namespace: 'dev',
      spec: config.devChannelConfig,
    }

    return [crd]
  }

  /**
   * Run a single poll cycle across all channels.
   */
  async pollCycle(): Promise<Message[]> {
    const allMessages: Message[] = []

    for (const channelCRD of this.channels) {
      const { spec } = channelCRD

      // Process Telegram private chats, groups, and supergroups. Personal identity is verified separately.
      //
      // Guard on length, not presence. control-ui writes every provider array on
      // every channel, so a Teams or Slack channel arrives carrying `telegram: []`.
      // An empty array is truthy, so this branch used to run for those channels,
      // fail to find a telegram adapter, and `continue` -- skipping every
      // remaining provider on the same channel. An empty array means "no telegram
      // groups to poll", not "this is a telegram channel".
      if (spec.telegram?.length) {
        const adapter = this.adapterForChannel('telegram', channelCRD)
        if (!adapter) continue
        const providerTarget = providerTargetFromChannel(channelCRD)
        if (!providerTarget) {
          console.warn(
            '[Main] Skipping Telegram channels for ' +
              channelCRD.namespace +
              '/' +
              channelCRD.name +
              ': provider target is incomplete'
          )
          continue
        }
        const telegramPollGroups = new Map<
          string,
          {
            channelId: string
            chatType: TelegramProviderChatType
            userIds: Set<string>
            allowUnlistedSender: boolean
            replyOnlyWhenMentioned: boolean
          }
        >()
        for (const group of spec.telegram) {
          const channelId = String(group.channelId || '').trim()
          const chatType = supportedTelegramOperationalChatType(group.chatType)
          if (!channelId) {
            console.warn(
              '[Main] Skipping Telegram channel for ' +
                channelCRD.namespace +
                '/' +
                channelCRD.name +
                ': missing channelId'
            )
            continue
          }
          if (!chatType) {
            console.warn(
              '[Main] Skipping Telegram channel ' +
                channelId +
                ': unsupported or missing chatType ' +
                String(group.chatType ?? '')
            )
            continue
          }
          const configuredUserIds = (group.userIds ?? [])
            .map(id => String(id).trim())
            .filter(Boolean)
          const key = `${channelId}\0${chatType}`
          const current = telegramPollGroups.get(key) ?? {
            channelId,
            chatType,
            userIds: new Set<string>(),
            allowUnlistedSender: false,
            replyOnlyWhenMentioned: false,
          }
          for (const userId of configuredUserIds) {
            current.userIds.add(userId)
          }
          // OR wins here by design: a confirmed-user approval row has no userIds,
          // so channel-reader forwards the group message and backend auth decides
          // whether the Telegram sender has current member/channel access.
          current.allowUnlistedSender =
            current.allowUnlistedSender || configuredUserIds.length === 0
          current.replyOnlyWhenMentioned =
            current.replyOnlyWhenMentioned || !!group.replyOnlyWhenMentioned
          telegramPollGroups.set(key, current)
        }
        for (const group of telegramPollGroups.values()) {
          const messages = await adapter.fetchMessages(group.channelId, group.userIds, {
            replyOnlyWhenMentioned:
              spec.telegramSettings?.replyOnlyWhenMentioned ?? group.replyOnlyWhenMentioned,
            telegramChatType: group.chatType,
            allowUnlistedSender: group.allowUnlistedSender,
            providerTarget,
          })
          allMessages.push(...messages)
        }
      }

      // Process Email groups. Same empty-array reasoning as the telegram guard above.
      if (spec.email?.length) {
        const adapter = this.adapterForChannel('email', channelCRD)
        if (!adapter) continue
        for (const group of spec.email) {
          const allowedSenders = new Set(group.emails)
          const messages = await adapter.fetchMessages(group.channelId, allowedSenders)
          allMessages.push(...messages)
        }
      }

      // Process Slack groups
      if (hasSlackChannelConfig(spec)) {
        console.log(
          `[Main] Skipping Slack polling for CommunicationChannel ${this.communicationChannelKey(
            channelCRD
          )}; Slack app messages are handled by workflow-approval-request-reader webhooks`
        )
      }

      if (hasTeamsChannelConfig(spec)) {
        console.log(
          `[Main] Skipping Teams polling for CommunicationChannel ${this.communicationChannelKey(
            channelCRD
          )}; Teams app messages are handled by workflow-approval-request-reader webhooks`
        )
      }
    }

    if (allMessages.length > 0) {
      console.log(`[Main] Received ${allMessages.length} message(s)`)
      await this.handleMessages(allMessages)
    }

    // Deliver any pending cron task results
    await this.pollCronResults()

    // Deliver workflow approval notifications via mcp-host, which is the
    // authenticated control-plane caller for the control-api hop.
    await this.workflowApprovalCoordinator.pollNotifications()

    // Clean up stale pending approvals and provider event dedupe keys.
    this.cleanupStaleApprovals()

    return allMessages
  }

  /**
   * Handle received messages by forwarding them to mcp-host and replying with LLM response.
   * Intercepts /approve and /deny commands when an approval is pending.
   */
  async handleMessages(messages: Message[]): Promise<void> {
    for (const msg of messages) {
      console.log('\n' + '-'.repeat(50))
      console.log(`[Main] New message from ${msg.channelType}`)
      console.log(`[Main]   Channel: ${msg.channelType} (${msg.channelId})`)
      console.log(`[Main]   Sender: ${msg.sender}`)
      console.log(`[Main]   Message ID: ${msg.messageId || '(none)'}`)
      if (msg.providerIdentity?.providerEventId) {
        console.log(`[Main]   Provider Event: ${msg.providerIdentity.providerEventId}`)
      }
      console.log(`[Main]   Time: ${msg.timestamp.toISOString()}`)
      console.log(
        `[Main]   Content: ${msg.content.substring(0, 100)}${msg.content.length > 100 ? '...' : ''}`
      )
      console.log('-'.repeat(50))

      const providerEventKey = this.providerEventDedupeKey(msg)
      if (providerEventKey && this.processedProviderEvents.has(providerEventKey)) {
        console.warn(`[Main] Duplicate provider message ignored: ${providerEventKey}`)
        continue
      }
      if (msg.providerIdentity && this.rpcClient.authorizeProviderMessage) {
        const authorization = await this.rpcClient.authorizeProviderMessage(msg.providerIdentity)
        if (!authorization.authorized) {
          if (providerEventKey) {
            this.processedProviderEvents.set(providerEventKey, { seenAt: Date.now() })
          }
          console.warn(
            `[Main] Ignoring unauthorized ${msg.channelType} message from ${msg.sender} in ${msg.channelId}`
          )
          if (authorization.reason === 'unresolved') {
            await this.sendUnresolvedSenderNotice(msg)
          }
          continue
        }
      }

      const traceContext = mintChannelTraceContext(msg)
      if (providerEventKey) {
        this.processedProviderEvents.set(providerEventKey, { seenAt: Date.now() })
      }

      // Check if this is an approval/denial command
      const runtimeContent = contentWithoutAddressedBotMention(msg)
      const runtimeMsg = runtimeContent === msg.content ? msg : { ...msg, content: runtimeContent }
      const trimmed = runtimeContent.trim().toLowerCase()
      const toolApprovalAction = parseToolApprovalAction(runtimeContent)
      if (toolApprovalAction) {
        await this.handleApprovalCommand(
          msg,
          toolApprovalAction.command,
          toolApprovalAction.actionToken
        )
        continue
      }
      const workflowApprovalCallback = parseWorkflowApprovalDecisionCallback(msg)
      if (workflowApprovalCallback) {
        await this.workflowApprovalCoordinator.handleDecisionCallback(msg, workflowApprovalCallback)
        continue
      }
      const workflowApprovalDecision = parseWorkflowApprovalDecisionCommand(msg)
      if (workflowApprovalDecision) {
        await this.workflowApprovalCoordinator.handleDecisionCommand(msg, workflowApprovalDecision)
        continue
      }
      if (
        trimmed === '/approve' ||
        trimmed === '/approve always' ||
        trimmed === '/deny' ||
        trimmed === '\\approve' ||
        trimmed === '\\approve always' ||
        trimmed === '\\deny'
      ) {
        await this.handleApprovalCommand(msg, trimmed.replace(/^\\/, '/') as ToolApprovalDecision)
        continue
      }

      // Forward to mcp-host
      console.log('[Main] Forwarding message to mcp-host...')

      const adapter = this.adapterForMessage(msg)
      if (adapter && msg.channelType !== 'email') {
        // Telegram, Slack, and Teams: use async progress flow with edit-in-place
        try {
          await this.handleMessageWithProgress(runtimeMsg, adapter, traceContext)
        } catch (err) {
          console.error(`[Main] Progress flow failed, falling back:`, err)
          // Fall back to synchronous
          const response = await this.rpcClient.sendMessage(runtimeMsg, { traceContext })
          if (response.success && response.status === 'waiting_approval' && response.approval) {
            const { taskId, requestId, userId, notification } = response.approval
            console.log(`[Main] Tool approval needed (task: ${taskId}, request: ${requestId})`)
            const approvalKey = this.pendingApprovalKey(msg)
            const actionToken = newToolApprovalActionToken()
            this.pendingApprovals.set(approvalKey, {
              taskId,
              requestId,
              userId,
              channelType: msg.channelType,
              channelId: msg.channelId,
              originalMessage: msg,
              createdAt: new Date(),
              actionToken,
            })
            await this.sendReply(
              msg,
              notification,
              undefined,
              toolApprovalMessageOptions(msg.channelType, notification, actionToken)
            )
          } else if (response.success && response.response) {
            console.log('[Main] mcp-host response:')
            console.log(`[Main]   Model: ${response.model}`)
            console.log(
              `[Main]   Response: ${response.response.substring(0, 200)}${response.response.length > 200 ? '...' : ''}`
            )
            if (response.usage) {
              console.log(`[Main]   Tokens: ${response.usage.totalTokens}`)
            }
            await this.sendReply(msg, response.response, response.attachments)
          } else {
            console.error(
              `[Main] Failed to process message: ${response.error?.message ?? 'unknown error'}`
            )
          }
        }
      } else {
        // Email: existing synchronous flow
        const response = await this.rpcClient.sendMessage(runtimeMsg, { traceContext })

        if (response.success && response.status === 'waiting_approval' && response.approval) {
          const { taskId, requestId, userId, notification } = response.approval
          console.log(`[Main] Tool approval needed (task: ${taskId}, request: ${requestId})`)
          const approvalKey = this.pendingApprovalKey(msg)
          const actionToken = newToolApprovalActionToken()
          this.pendingApprovals.set(approvalKey, {
            taskId,
            requestId,
            userId,
            channelType: msg.channelType,
            channelId: msg.channelId,
            originalMessage: msg,
            createdAt: new Date(),
            actionToken,
          })
          await this.sendReply(
            msg,
            notification,
            undefined,
            toolApprovalMessageOptions(msg.channelType, notification, actionToken)
          )
        } else if (response.success && response.response) {
          console.log('[Main] mcp-host response:')
          console.log(`[Main]   Model: ${response.model}`)
          console.log(
            `[Main]   Response: ${response.response.substring(0, 200)}${response.response.length > 200 ? '...' : ''}`
          )
          if (response.usage) {
            console.log(`[Main]   Tokens: ${response.usage.totalTokens}`)
          }
          await this.sendReply(msg, response.response, response.attachments)
        } else {
          console.error(
            `[Main] Failed to process message: ${response.error?.message ?? 'unknown error'}`
          )
        }
      }
    }
  }

  private providerEventDedupeKey(msg: Message): string | null {
    const providerEventId = msg.providerIdentity?.providerEventId?.trim()
    if (providerEventId) {
      return `provider:${providerEventId}`
    }

    const messageId = msg.messageId?.trim()
    if (!messageId) {
      return null
    }

    return ['message', msg.channelType, msg.channelId, msg.sender, messageId].join(':')
  }

  /**
   * Tell an unresolved Slack, Teams, or Telegram sender why the agent is ignoring
   * them, at most once per user per conversation per UNRESOLVED_NOTICE_TTL_MS, and
   * never past UNRESOLVED_NOTICE_GLOBAL_CAP live notice records in total.
   */
  private async sendUnresolvedSenderNotice(msg: Message): Promise<void> {
    if (
      msg.channelType !== 'slack' &&
      msg.channelType !== 'teams' &&
      msg.channelType !== 'telegram'
    )
      return
    const identity = msg.providerIdentity
    const userId = identity?.providerUserId?.trim()
    const workspaceId = identity?.providerWorkspaceId?.trim()
    const channelId = msg.channelId?.trim()
    if (!userId || !channelId) return
    // Slack and Teams identities are scoped to a workspace/tenant an admin
    // controls, and the limiter key below relies on that scope. Telegram has no
    // such concept: every real Telegram message carries providerWorkspaceId: null,
    // so requiring one here would silently drop the notice for every Telegram
    // sender.
    if (msg.channelType !== 'telegram' && !workspaceId) return

    // Scope the limiter by provider identity, the same way pendingApprovalChannelScope
    // does. The SEND still targets msg.channelId, which is what replyChannelId hands
    // every other outbound Slack call; only the dedupe identity is provider-scoped.
    const conversationId = identity?.providerChannelId?.trim() || channelId
    const key = `${workspaceId ?? UNRESOLVED_NOTICE_NO_WORKSPACE_KEY}:${userId}:${conversationId}`
    if (this.unresolvedNoticesSent.has(key)) return
    if (this.unresolvedNoticesSent.size >= UNRESOLVED_NOTICE_GLOBAL_CAP) {
      // Log only on the transition into the capped state, not on every blocked
      // send: at the cap, every inbound message from every unresolved sender
      // across every provider would otherwise emit its own warning, which is
      // loudest in exactly the misconfiguration this cap exists to contain.
      // unresolvedNoticeCapLogged resets once cleanupStaleApprovals' TTL sweep
      // drains the map back under the cap, so a later trip logs again.
      if (!this.unresolvedNoticeCapLogged) {
        this.unresolvedNoticeCapLogged = true
        console.warn(
          `[Main] Unresolved-sender notice cap (${UNRESOLVED_NOTICE_GLOBAL_CAP}) reached; ` +
            `suppressing further notices until the TTL sweep frees a slot.`
        )
      }
      return
    }
    // Record on ATTEMPT, not on success: a conversation Slack keeps rejecting
    // must not produce one outbound call per inbound message.
    this.unresolvedNoticesSent.set(key, { seenAt: Date.now() })

    const adapter = this.adapterForMessage(msg)
    if (!adapter) return
    let content: string
    if (msg.channelType === 'telegram') {
      content = UNRESOLVED_NOTICE_COPY_TELEGRAM
    } else {
      const profileUrl = config.profileUiUrl?.trim()
      const baseCopy =
        msg.channelType === 'teams' ? UNRESOLVED_NOTICE_COPY_TEAMS : UNRESOLVED_NOTICE_COPY
      content = profileUrl ? `${baseCopy} ${profileUrl}` : baseCopy
    }
    try {
      if (msg.channelType === 'teams') {
        // TeamsAdapter has no ephemeral concept, so the notice is a normal message.
        // Thread it under the triggering message so an unconnected user does not
        // produce a top-level post in a shared channel.
        //
        // The reply target is the thread ROOT, the same target replyTargetMessageId
        // picks for every other Teams reply. threadId is the root activity id
        // (providerReplyToMessageId) and messageId is the leaf activity that just
        // arrived; replying to the leaf does not attach the notice to the
        // conversation, which is the whole mitigation here. The fallback is for a
        // direct chat, which has no separate root.
        await adapter.sendMessage(channelId, content, msg.threadId || msg.messageId)
      } else if (msg.channelType === 'telegram') {
        // No reply id: the spec fixes this as sendMessage(channelId, content) for
        // Telegram, with no threading. Group and supergroup chats do have a
        // channel-wide audience (see telegramOperationalMessage.ts), so this is
        // not a threading-is-pointless argument; the copy itself is deliberately
        // terse so a top-level post leaks nothing meaningful, and threading here
        // is a possible follow-up.
        await adapter.sendMessage(channelId, content)
      } else {
        if (!adapter.sendEphemeral) return
        await adapter.sendEphemeral(channelId, userId, content)
      }
    } catch (error) {
      // Contain the failure HERE. SlackAdapter swallows its own errors today, but
      // the ChannelAdapter interface promises nothing, and this runs inside the
      // per-message loop in handleMessages: an adapter that ever throws would
      // abort the rest of the batch over a notice that is best-effort by design.
      console.warn(
        `[Main] Could not send unresolved-sender notice to ${userId} in ${channelId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  private pendingApprovalChannelScope(msg: Message): string {
    return `${msg.channelType}:${msg.providerIdentity?.providerChannelId || msg.channelId}`
  }

  private pendingApprovalKey(msg: Message): string {
    let threadId = ''
    if (msg.channelType === 'telegram' || msg.channelType === 'slack') {
      threadId = msg.threadId || ''
    } else if (
      msg.channelType === 'teams' &&
      msg.providerIdentity?.providerChannelType === 'channel'
    ) {
      threadId = msg.threadId || ''
    }
    return [this.pendingApprovalChannelScope(msg), threadId, msg.sender].join(':')
  }

  private pendingApprovalByActionToken(
    msg: Message,
    actionToken: string
  ): [string, PendingApprovalState] | null {
    const channelScope = this.pendingApprovalChannelScope(msg)
    for (const [key, pending] of this.pendingApprovals) {
      if (
        pending.actionToken === actionToken &&
        pending.originalMessage.sender === msg.sender &&
        this.pendingApprovalChannelScope(pending.originalMessage) === channelScope
      ) {
        return [key, pending]
      }
    }
    return null
  }

  private clearPendingApprovalForTask(msg: Message, taskId: string): void {
    const channelScope = this.pendingApprovalChannelScope(msg)
    for (const [key, pending] of this.pendingApprovals) {
      if (
        pending.taskId === taskId &&
        this.pendingApprovalChannelScope(pending.originalMessage) === channelScope
      ) {
        this.pendingApprovals.delete(key)
      }
    }
  }

  private replyTargetMessageId(msg: Message): string | undefined {
    if (msg.channelType === 'slack') return msg.threadId
    if (msg.channelType === 'teams') {
      return this.teamsReplyInThreads(msg) ? msg.threadId || msg.messageId : undefined
    }
    return msg.messageId
  }

  private teamsReplyInThreads(msg: Message): boolean {
    if (msg.channelType !== 'teams') return false
    const target = msg.providerIdentity?.providerTarget
    const workspaceId = msg.providerIdentity?.providerWorkspaceId
    const providerChannelId = msg.providerIdentity?.providerChannelId
    const channel = this.channels.find(
      item =>
        item.namespace === target?.communicationChannelNamespace &&
        item.name === target?.communicationChannelName
    )
    const group = channel?.spec.teams?.find(
      item => item.channelId === providerChannelId && item.tenantId === workspaceId
    )
    return group?.replyInThreads !== false
  }

  private replyChannelId(msg: Message): string {
    if (msg.channelType === 'teams' && !this.teamsReplyInThreads(msg)) {
      return msg.providerIdentity?.providerChannelId || msg.channelId
    }
    return msg.channelId
  }

  /**
   * Handle a message using the async progress flow.
   * Sends the message with async=true, opens an SSE progress stream that stays
   * open for the entire task lifecycle, and edits a status message in-place as
   * progress events arrive.
   *
   * Architecture:
   * - The wrapping Promise resolves on the FIRST state-signal event
   *   (suspended OR terminal OR error). This unblocks handleMessages's for
   *   loop quickly so the poll cycle can move on.
   * - The SSE stream's IIFE in progressClient.ts keeps reading via its own
   *   abortController/fetch reader; JavaScript closures keep msg, adapter,
   *   editStatus, and `this` (ChannelReader instance) alive for the callbacks
   *   to use after this function returns.
   * - On `suspended`: register pending approval, edit bubble with the
   *   notification (fetched once from getTaskResult; falls back to a generic
   *   message if the cache hasn't been written yet — the sub-millisecond
   *   micro-race in mcp-host's taskExecutor.ts:472-485).
   * - On `tool_start`/`tool_complete` after approval: keeps editing the
   *   bubble with progress.
   * - On `terminal`: fetch final response via getTaskResult, edit bubble.
   * - After approval: keep relying on SSE, with a task-result polling fallback
   *   if the stream closes or misses the terminal event.
   * - No waitForTaskResult. No drainApprovalCommands.
   */
  private async handleMessageWithProgress(
    msg: Message,
    adapter: ChannelAdapter,
    traceContext: TraceContextV1
  ): Promise<void> {
    // 1. Send message with async=true
    const response = await this.rpcClient.sendMessage(msg, { async: true, traceContext })

    if (!response.taskId) {
      console.log('[Main] No taskId returned from async send, falling back to sync')
      if (response.success && response.status === 'waiting_approval' && response.approval) {
        const { taskId, requestId, userId, notification } = response.approval
        console.log(`[Main] Tool approval needed (task: ${taskId}, request: ${requestId})`)
        const approvalKey = this.pendingApprovalKey(msg)
        const actionToken = newToolApprovalActionToken()
        this.pendingApprovals.set(approvalKey, {
          taskId,
          requestId,
          userId,
          channelType: msg.channelType,
          channelId: msg.channelId,
          originalMessage: msg,
          createdAt: new Date(),
          actionToken,
        })
        await this.sendReply(
          msg,
          notification,
          undefined,
          toolApprovalMessageOptions(msg.channelType, notification, actionToken)
        )
      } else if (response.success && response.response) {
        await this.sendReply(msg, response.response, response.attachments)
      } else if (response.error) {
        console.error(
          `[Main] Failed to process message: ${response.error?.message ?? 'unknown error'}`
        )
      }
      return
    }

    const taskId = response.taskId
    console.log(`[Main] Async task created: ${taskId}`)
    const responseChannelId = this.replyChannelId(msg)

    // 2. Send initial processing message and capture messageId for editing.
    const statusMessageId = await adapter.sendMessage(
      responseChannelId,
      '\u23f3 Processing your request...',
      this.replyTargetMessageId(msg)
    )

    if (!statusMessageId) {
      console.log('[Main] No messageId returned from initial status message; cannot edit-in-place')
      return
    }

    // 3. Open SSE stream and wire callbacks. The stream stays open until terminal.
    //
    // Fire-and-detach: we create the wrapping Promise so the callback lambdas
    // capture a shared `resolveOnce()` (used by every state-signal handler to
    // mark the "first state event" boundary cleanly), but we do NOT await it.
    // Awaiting would serialise channel-reader's `for (msg of messages)` loop
    // on a slow task; instead, JavaScript closures keep `msg`, `adapter`,
    // `editStatus`, the stream handle, and `this` alive for the SSE callbacks
    // to use after this function returns. The SSE IIFE in progressClient.ts
    // owns its own abortController + reader and runs independently.
    void new Promise<void>(resolve => {
      let resolved = false
      const resolveOnce = () => {
        if (!resolved) {
          resolved = true
          resolve()
        }
      }

      let statusEditQueue: Promise<void> = Promise.resolve()
      let acceptProgressUpdates = true

      const editStatus = (
        content: string,
        mustSucceed = false,
        options?: SendMessageOptions
      ): Promise<void> => {
        const operation = statusEditQueue.then(async () => {
          try {
            await adapter.editMessage(responseChannelId, statusMessageId, content, options)
          } catch (err) {
            console.error(`[Main] Failed to edit status message for task ${taskId}:`, err)
            if (mustSucceed) throw err
          }
        })
        statusEditQueue = operation.catch(() => undefined)
        return operation
      }

      let finalDelivered = false
      let finalDeliveryInFlight: Promise<boolean> | null = null
      let resultPollingFallbackStarted = false
      let approvalPromptDelivered = false

      const deliverApprovalPrompt = async (params: {
        requestId: string
        userId: string
        notification: string
      }): Promise<void> => {
        const approvalKey = this.pendingApprovalKey(msg)
        const existing = this.pendingApprovals.get(approvalKey)
        if (approvalPromptDelivered && existing?.requestId === params.requestId) return

        approvalPromptDelivered = true
        acceptProgressUpdates = false
        const actionToken =
          existing?.requestId === params.requestId
            ? existing.actionToken
            : newToolApprovalActionToken()

        console.log(`[Main] Tool approval needed (task: ${taskId}, request: ${params.requestId})`)
        this.pendingApprovals.set(approvalKey, {
          taskId,
          requestId: params.requestId,
          userId: params.userId,
          channelType: msg.channelType,
          channelId: msg.channelId,
          originalMessage: msg,
          createdAt: new Date(),
          actionToken,
          startResultPollingFallback,
          updateStatusAfterDecision: content => {
            acceptProgressUpdates = true
            return editStatus(content)
          },
        })
        await editStatus(
          params.notification,
          false,
          toolApprovalMessageOptions(msg.channelType, params.notification, actionToken)
        )
      }

      const deliverFinalResult = async (): Promise<boolean> => {
        if (finalDelivered) return true
        if (finalDeliveryInFlight) return finalDeliveryInFlight

        finalDeliveryInFlight = (async () => {
          const result = await this.rpcClient.getTaskResult(taskId, msg)
          if (result.status === 'waiting_approval' && result.approval) {
            await deliverApprovalPrompt({
              requestId: result.approval.requestId,
              userId: result.approval.userId,
              notification: result.approval.notification,
            })
            return false
          }
          if (result.status === 'pending' || result.status === 'waiting_approval') {
            return false
          }
          acceptProgressUpdates = false

          if (result.success && result.response) {
            const finalText = formatFinalMessage(stream.steps, result.response)
            try {
              await editStatus(finalText, true)
            } catch {
              await adapter.sendMessage(
                responseChannelId,
                finalText,
                this.replyTargetMessageId(msg)
              )
            }
            finalDelivered = true
            this.clearPendingApprovalForTask(msg, taskId)
            console.log(`[Main] Final result delivered for task ${taskId} via ${msg.channelType}`)
            if (result.attachments && result.attachments.length > 0) {
              await adapter.sendMessage(
                responseChannelId,
                '',
                this.replyTargetMessageId(msg),
                result.attachments
              )
            }
          } else if (result.error) {
            const errorText = `Error: ${result.error.message ?? 'Unknown error'}`
            try {
              await editStatus(errorText, true)
            } catch {
              await adapter.sendMessage(
                responseChannelId,
                errorText,
                this.replyTargetMessageId(msg)
              )
            }
            finalDelivered = true
            this.clearPendingApprovalForTask(msg, taskId)
            console.log(`[Main] Final error delivered for task ${taskId} via ${msg.channelType}`)
          } else {
            const finalText = formatFinalMessage(stream.steps, 'Done.')
            try {
              await editStatus(finalText, true)
            } catch {
              await adapter.sendMessage(
                responseChannelId,
                finalText,
                this.replyTargetMessageId(msg)
              )
            }
            finalDelivered = true
            this.clearPendingApprovalForTask(msg, taskId)
            console.log(`[Main] Final result delivered for task ${taskId} via ${msg.channelType}`)
          }
          return true
        })()

        try {
          return await finalDeliveryInFlight
        } finally {
          finalDeliveryInFlight = null
        }
      }

      const startResultPollingFallback = () => {
        if (resultPollingFallbackStarted) return
        resultPollingFallbackStarted = true

        void (async () => {
          const deadline = Date.now() + RESULT_POLL_FALLBACK_TIMEOUT_MS
          while (!finalDelivered && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, RESULT_POLL_FALLBACK_INTERVAL_MS))
            if (finalDelivered) return
            try {
              const delivered = await deliverFinalResult()
              if (delivered) {
                stream.close()
                resolveOnce()
                return
              }
            } catch (err) {
              console.error(`[Main] result polling fallback failed for task ${taskId}:`, err)
            }
          }
          if (!finalDelivered) {
            console.warn(`[Main] Result polling fallback timed out for task ${taskId}`)
          }
        })()
      }

      const stream = createProgressStream({
        mcpHostUrl: this.rpcClient.getBaseUrl(),
        taskId,
        source: msg,
        onProgress: (steps: ProgressStep[]) => {
          if (!acceptProgressUpdates) return
          void editStatus(formatProgressUpdate(steps))
        },
        onSuspended: async suspended => {
          // Approval needed. Fetch the server-formatted notification (which
          // includes tool parameters) once. If the cache hasn't been written
          // yet (sub-ms micro-race), fall back to a generic notification.
          let notification =
            `Tool \`${suspended.toolName}\` requires approval. ` +
            (msg.channelType === 'slack'
              ? `Reply \\approve or \\deny to this message.`
              : msg.channelType === 'teams'
                ? `Reply approve or deny to this message.`
                : `Reply /approve or /deny to this message.`)
          try {
            const result = await this.rpcClient.getTaskResult(taskId, msg)
            if (
              result.success &&
              result.status === 'waiting_approval' &&
              result.approval?.notification
            ) {
              notification = result.approval.notification
            }
          } catch (err) {
            console.error(`[Main] Failed to fetch approval notification for task ${taskId}:`, err)
          }
          await deliverApprovalPrompt({
            requestId: suspended.requestId,
            userId: msg.sender,
            notification,
          })
          // Release handleMessages's for loop. The stream stays open; the next
          // tool_start/tool_complete/suspended/terminal events keep firing.
          resolveOnce()
        },
        onTerminal: async terminal => {
          if (finalDelivered) {
            stream.close()
            resolveOnce()
            return
          }
          if (terminal.status === 'cancelled') {
            acceptProgressUpdates = false
            finalDelivered = true
            await editStatus('Request cancelled.')
            this.clearPendingApprovalForTask(msg, taskId)
          } else if (terminal.status === 'failed' && terminal.error) {
            acceptProgressUpdates = false
            finalDelivered = true
            await editStatus(`Error: ${terminal.error.message}`)
            this.clearPendingApprovalForTask(msg, taskId)
          } else {
            // status === 'completed' (or unknown — treat as completed)
            try {
              const delivered = await deliverFinalResult()
              if (!delivered) {
                startResultPollingFallback()
                await editStatus(
                  formatFinalMessage(stream.steps, 'Final response is still syncing.')
                )
              }
            } catch (err) {
              console.error(`[Main] terminal(completed) result fetch failed:`, err)
              startResultPollingFallback()
              await editStatus(formatFinalMessage(stream.steps, 'Final response is still syncing.'))
            }
          }
          // Belt-and-braces close: the SSE IIFE closes itself on terminal
          // (progressClient.ts), but the test mock returns a static handle
          // that doesn't auto-close — and an explicit close here is harmless
          // (close() is idempotent) and matches the spec's "closes the stream"
          // language for onTerminal.
          stream.close()
          resolveOnce()
        },
        onError: async (error: string) => {
          console.error(`[Main] Progress stream error: ${error}`)
          // `task_not_found_or_expired` is NOT a transport failure: mcp-host is
          // healthy. It means the reporter was never registered within the 180s
          // wait (queue saturation \u2014 task may still be processing) or was evicted
          // by TTL >5min after completion (the result already exists). Mirror the
          // Desktop App (appService.ts) \u2014 reconcile against the stored result
          // instead of crying "Lost connection". (issue #581)
          if (error.includes('task_not_found_or_expired')) {
            try {
              // Path B: the answer is already computed + stored \u2192 deliver it.
              const delivered = await deliverFinalResult()
              if (delivered) {
                stream.close()
                resolveOnce()
                return
              }
              if (approvalPromptDelivered) {
                resolveOnce()
                return
              }
            } catch (err) {
              console.error(
                `[Main] reconcile after task_not_found_or_expired failed for task ${taskId}:`,
                err
              )
            }
            // Path A: still queued/processing \u2192 keep polling for the result,
            // don't mislabel it as a connection loss.
            await editStatus('Still processing \u2014 taking longer than usual\u2026')
            startResultPollingFallback()
            resolveOnce()
            return
          }
          // Genuine transport/network failure.
          await editStatus('\u26a0\ufe0f Lost connection to processing stream.')
          resolveOnce()
        },
      })
      // Webhook-origin Slack/Teams requests can lose the terminal SSE while still
      // receiving normal tool progress. Keep webhook-origin chats backed up by polling;
      // Telegram keeps the narrower existing fallbacks below.
      if (msg.channelType === 'slack' || msg.channelType === 'teams') {
        startResultPollingFallback()
      }
    })
  }

  /**
   * Handle /approve, /approve always, or /deny commands from the user.
   *
   * Since the SSE stream opened by handleMessageWithProgress is still running
   * (it stays open until the task's terminal event), this function only needs
   * to (a) submit the decision to mcp-host and (b) send a user-facing
   * acknowledgment. The SSE stream will surface subsequent state transitions
   * (multi-approval, completion) on its own.
   *
   * For cron tasks: results continue to arrive via pollCronResults on the next
   * poll cycle (cron has no message-thread SSE).
   */
  private async handleApprovalCommand(
    msg: Message,
    command: ToolApprovalDecision,
    actionToken?: string
  ): Promise<void> {
    const contextualKey = this.pendingApprovalKey(msg)
    const matched = actionToken
      ? this.pendingApprovalByActionToken(msg, actionToken)
      : this.pendingApprovals.has(contextualKey)
        ? ([contextualKey, this.pendingApprovals.get(contextualKey)!] as [
            string,
            PendingApprovalState,
          ])
        : null
    const approvalKey = matched?.[0] ?? contextualKey
    const pending = matched?.[1]

    if (!pending) {
      console.log(`[Main] No pending approval for ${approvalKey}`)
      await this.sendReply(
        msg,
        'No pending approval found. Send a message first that triggers a tool requiring approval.'
      )
      return
    }

    const { requestId, userId } = pending

    if (command === '/deny') {
      console.log(`[Main] User denied approval (request: ${requestId})`)
      const result = await this.rpcClient.sendDenial(
        userId,
        requestId,
        pending.channelType,
        pending.channelId
      )
      if (result.success) {
        this.pendingApprovals.delete(approvalKey)
        await pending.updateStatusAfterDecision?.('Denied. The tool will not be executed.')
        await this.sendReply(msg, 'Denied. The tool will not be executed.')
      } else {
        await this.sendReply(msg, `Failed to send denial: ${result.error ?? 'unknown error'}`)
      }
      return
    }

    // /approve or /approve always
    const alwaysApprove = command === '/approve always'
    console.log(`[Main] User approved (request: ${requestId}, always: ${alwaysApprove})`)

    const result = await this.rpcClient.sendApproval(
      userId,
      requestId,
      alwaysApprove,
      pending.channelType,
      pending.channelId
    )
    if (!result.success) {
      await this.sendReply(msg, `Failed to send approval: ${result.error ?? 'unknown error'}`)
      return
    }

    this.pendingApprovals.delete(approvalKey)
    const acknowledgement = alwaysApprove
      ? 'Approved (always for this tool). Processing...'
      : 'Approved. Processing...'
    await pending.updateStatusAfterDecision?.(acknowledgement)
    await this.sendReply(msg, acknowledgement)

    // The SSE stream opened by handleMessageWithProgress remains the primary
    // delivery path. The fallback starts only after approval, so a stream that
    // closes before terminal cannot strand a completed task result.
    pending.startResultPollingFallback?.()
  }

  /**
   * Poll mcp-host for pending cron task results and deliver them to channels.
   * Cron tasks bypass the approval gate, so mcp-host only emits completed results.
   */
  private async pollCronResults(): Promise<void> {
    try {
      const results = await this.rpcClient.getCronResults()
      for (const result of results) {
        const adapter = this.adapterForRuntimeSource(result.origin)
        if (!adapter) {
          console.warn(
            `[Main] No adapter for ${result.origin.channelType}, cannot deliver cron result ${result.id}`
          )
          continue
        }

        // Cron tasks bypass the approval gate, so mcp-host only ever emits completed
        // cron results (status === 'completed', no approval payload). Deliver and acknowledge.
        console.log(
          `[Main] Delivering cron result: ${result.cronJobName} → ${result.origin.channelType}:${result.origin.channelId}`
        )
        await adapter.sendMessage(
          result.origin.channelId,
          result.response,
          undefined,
          result.attachments
        )
        await this.rpcClient.acknowledgeCronResult(result.id, result.origin)
        console.log(`[Main] Cron result delivered and acknowledged: ${result.id}`)
      }
    } catch (err) {
      // Silent — cron results are best-effort, don't break poll loop
      console.error('[Main] Failed to poll cron results:', err)
    }
  }

  /**
   * Remove stale pending approval entries.
   */
  private cleanupStaleApprovals(): void {
    const now = Date.now()
    for (const [key, state] of this.pendingApprovals) {
      if (now - state.createdAt.getTime() > PENDING_APPROVAL_TTL_MS) {
        console.log(`[Main] Cleaning up stale approval: ${key}`)
        this.pendingApprovals.delete(key)
      }
    }
    for (const [key, processed] of this.processedProviderEvents) {
      if (now - processed.seenAt > PROVIDER_EVENT_DEDUPE_TTL_MS) {
        this.processedProviderEvents.delete(key)
      }
    }
    for (const [key, notice] of this.unresolvedNoticesSent) {
      if (now - notice.seenAt > UNRESOLVED_NOTICE_TTL_MS) {
        this.unresolvedNoticesSent.delete(key)
      }
    }
    // A later trip into the cap must warn again, so once eviction above drains
    // the map back under it, allow the next crossing to log.
    if (this.unresolvedNoticesSent.size < UNRESOLVED_NOTICE_GLOBAL_CAP) {
      this.unresolvedNoticeCapLogged = false
    }
  }

  /**
   * Send a reply back to the original channel.
   */
  async sendReply(
    originalMessage: Message,
    replyContent: string,
    attachments?: Attachment[],
    options?: SendMessageOptions
  ): Promise<void> {
    const adapter = this.adapterForMessage(originalMessage)
    if (!adapter) {
      console.warn(`[Main] No adapter found for ${originalMessage.channelType}, cannot send reply`)
      return
    }

    try {
      console.log(`[Main] Sending reply to ${originalMessage.channelType}...`)
      await adapter.sendMessage(
        this.replyChannelId(originalMessage),
        replyContent,
        this.replyTargetMessageId(originalMessage),
        attachments,
        options
      )
      console.log(`[Main] Reply sent successfully`)
    } catch (err) {
      console.error(`[Main] Failed to send reply:`, err)
    }
  }

  /**
   * Restart the reader with new channel configurations (production mode only).
   */
  async restart(): Promise<void> {
    if (config.devMode) return

    console.log('[Main] Restarting with new channel configurations...')

    // Shutdown existing adapters
    await this.shutdownAdapters()

    // Reload channels
    this.channels = this.watcher!.getChannels()

    if (this.channels.length === 0) {
      console.warn(`[Main] No CommunicationChannels found for hostRef "${config.hostRef}"`)
    } else {
      console.log(`[Main] Loaded ${this.channels.length} CommunicationChannel(s)`)
    }

    // Reinitialize adapters
    await this.initializeAdapters()

    this.needsRestart = false
    console.log('[Main] Restart complete')
  }

  private async startHandoffServer(): Promise<void> {
    if (this.handoffServer || !config.channelReaderHandoffToken) return

    this.handoffServer = createChannelReaderHandoffServer(this, config.channelReaderHandoffToken)
    await new Promise<void>((resolve, reject) => {
      this.handoffServer!.once('error', reject)
      this.handoffServer!.listen(config.channelReaderHandoffPort, '0.0.0.0', () => {
        this.handoffServer!.off('error', reject)
        console.log(
          `[Main] Channel-reader handoff server listening on ${config.channelReaderHandoffPort}`
        )
        resolve()
      })
    })
  }

  private async stopHandoffServer(): Promise<void> {
    const server = this.handoffServer
    if (!server) return
    this.handoffServer = null
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  /**
   * Start the reader. If no CommunicationChannels match the hostRef filter,
   * warns and continues — the CRD watcher will trigger a restart when
   * channels appear.
   */
  async start(): Promise<void> {
    console.log('[Main] Starting Clerum Channel Reader...')
    console.log(`[Main] Mode: ${config.devMode ? 'DEV' : 'PRODUCTION'}`)
    console.log(`[Main] Host ref: "${config.hostRef}"`)
    console.log(`[Main] Poll interval: ${config.pollIntervalSeconds}s`)

    await this.initialize()

    if (config.devMode) {
      // Dev mode: load from env var (throws if not configured)
      console.log('[Main] Dev mode: reading channel config from CLERUM_CHANNEL env var')
      this.channels = this.loadDevChannels()
    } else {
      // Production mode: watch Kubernetes CRDs
      console.log(`[Main] Production mode: watching K8s namespace "${config.namespace || 'all'}"`)
      this.channels = await this.watcher!.listChannels()

      if (this.channels.length === 0) {
        console.warn(
          `[Main] No CommunicationChannel CRDs found for hostRef "${config.hostRef}" in namespace "${config.namespace || 'all'}". ` +
            `Channel-reader will idle and pick up channels as they appear via the CRD watcher.`
        )
      } else {
        console.log(`[Main] Found ${this.channels.length} CommunicationChannel(s)`)
      }

      // Start watching for changes
      await this.watcher!.startWatch()
    }

    // Initialize adapters (idles if no channels configured yet)
    this.running = true
    this.lastChannelResyncAt = Date.now()

    await this.initializeAdapters()
    await this.startHandoffServer()

    // Polling loop
    while (this.running) {
      // Check if we need to restart due to CRD changes (production mode only)
      if (!config.devMode && this.needsRestart) {
        try {
          await this.restart()
        } catch (err) {
          console.error(
            '[Main] Restart failed (will retry on next cycle if CRD watch keeps needsRestart):',
            err instanceof Error ? err.message : err
          )
        }
      }

      // Periodic CommunicationChannel resync (production mode only).
      // Re-lists channels so a missed watch event self-heals within one
      // CHANNEL_RESYNC_INTERVAL_MS window, independent of onChange.
      if (
        !config.devMode &&
        this.watcher &&
        Date.now() - this.lastChannelResyncAt >= CHANNEL_RESYNC_INTERVAL_MS
      ) {
        console.log('[Main] Periodic CommunicationChannel resync...')
        await this.watcher.resyncChannels()
        this.lastChannelResyncAt = Date.now()
      }

      // Run poll cycle if we have channels
      if (this.channels.length > 0) {
        await this.pollCycle()
      }

      await this.sleep(config.pollIntervalSeconds * 1000)
    }
  }

  /**
   * Stop the reader.
   */
  async stop(): Promise<void> {
    console.log('[Main] Stopping...')
    this.running = false
    if (this.watcher) {
      this.watcher.stopWatch()
    }
    await this.stopHandoffServer()
    await this.shutdownAdapters()
    console.log('[Main] Stopped')
  }

  private sleep(ms: number): Promise<void> {
    return this.sleepImpl(ms)
  }
}

// Main entry point
async function main(): Promise<void> {
  const reader = new ChannelReader()

  // Handle shutdown signals
  process.on('SIGINT', async () => {
    await reader.stop()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await reader.stop()
    process.exit(0)
  })

  await reader.start()
}

if (require.main === module) {
  main().catch(error => {
    console.error('[Main] Fatal error:', error)
    process.exit(1)
  })
}
