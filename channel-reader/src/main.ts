import http from 'node:http'
import { validateCommunicationChannelConfig } from './channelConfigValidation'
import { EmailAdapter, SlackAdapter, TelegramAdapter } from './channels'
import { config } from './config'
import { CredentialsResolver, DevCredentialsResolver, ResolvedCredentials } from './credentials'
import {
  type SlackEnrollmentHandoff,
  type SlackHandoffRequest,
  type SlackHandoffResponse,
  type SlackMessageHandoff,
  createChannelReaderHandoffServer,
} from './handoffServer'
import type { NotificationDeliveryClient } from './notificationDeliveryClient'
import { createProgressStream } from './progressClient'
import { formatFinalMessage, formatProgressUpdate } from './progressFormatter'
import { type ChannelReaderRuntimeSource, MessageResponse, RPCClient } from './rpcClient'
import {
  Attachment,
  ChannelAdapter,
  CommunicationChannelCRD,
  CommunicationChannelSpec,
  Message,
  ProgressStep,
  ProviderTargetIdentity,
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
  channelType: 'telegram' | 'email' | 'slack'
  channelId: string
  originalMessage: Message
  createdAt: Date
  startResultPollingFallback?: () => void
}

/** Stale approval entries are cleaned up after this interval. */
const PENDING_APPROVAL_TTL_MS = 10 * 60 * 1000 // 10 minutes
const RESULT_POLL_FALLBACK_INTERVAL_MS = 2 * 1000
const RESULT_POLL_FALLBACK_TIMEOUT_MS = 30 * 60 * 1000
/** Telegram and Slack can redeliver the same provider event while poll offsets settle. */
const PROVIDER_EVENT_DEDUPE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const SLACK_VERIFICATION_SCAN_INTERVAL_MS = 60 * 1000
/**
 * Periodic CommunicationChannel resync interval (production mode only).
 * Even when no watch event fires, a re-list every 60 s self-heals missed
 * events from earlier reconnect gaps.
 */
export const CHANNEL_RESYNC_INTERVAL_MS = 60_000 // 60 seconds

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
  confirmSlackLinkSession?: RPCClient['confirmSlackLinkSession']
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
  /** Pending approvals keyed by "channelType:channelId:sender". */
  private pendingApprovals: Map<string, PendingApprovalState> = new Map()
  /** Recently processed provider events keyed by stable provider or channel message identity. */
  private processedProviderEvents: Map<string, number> = new Map()
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

    console.log(`[Main] needsTelegram: ${ccsWithTelegram.length > 0}`)
    console.log(`[Main] needsEmail: ${ccsWithEmail.length > 0}`)
    console.log(`[Main] needsSlack: ${ccsWithSlack.length > 0}`)

    if (ccsWithTelegram.length === 0 && ccsWithEmail.length === 0 && ccsWithSlack.length === 0) {
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

  async handleSlackHandoff(request: SlackHandoffRequest): Promise<SlackHandoffResponse> {
    if (request.kind === 'slack.message') {
      const message = this.slackMessageFromHandoff(request)
      if (!message) return { ok: false, status: 400, error: 'invalid_slack_message_handoff' }
      await this.handleMessages([message])
      return { ok: true }
    }

    if (request.kind === 'slack.enrollment') {
      return this.handleSlackEnrollmentHandoff(request)
    }

    return { ok: false, status: 400, error: 'unsupported_handoff_kind' }
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

    const result = await this.rpcClient.confirmSlackLinkSession({
      nonce: handoff.nonce,
      providerUserId: handoff.providerUserId,
      providerWorkspaceId: handoff.providerWorkspaceId,
      providerChannelId: handoff.providerChannelId,
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
      if (spec.telegram) {
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

      // Process Email groups
      if (spec.email) {
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
      if (providerEventKey) {
        this.processedProviderEvents.set(providerEventKey, Date.now())
      }

      if (
        msg.providerIdentity &&
        this.rpcClient.authorizeProviderMessage &&
        !(await this.rpcClient.authorizeProviderMessage(msg.providerIdentity))
      ) {
        console.warn(
          `[Main] Ignoring unauthorized ${msg.channelType} message from ${msg.sender} in ${msg.channelId}`
        )
        continue
      }

      // Check if this is an approval/denial command
      const runtimeContent = contentWithoutAddressedBotMention(msg)
      const runtimeMsg = runtimeContent === msg.content ? msg : { ...msg, content: runtimeContent }
      const trimmed = runtimeContent.trim().toLowerCase()
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
        await this.handleApprovalCommand(msg, trimmed.replace(/^\\/, '/'))
        continue
      }

      // Forward to mcp-host
      console.log('[Main] Forwarding message to mcp-host...')

      const adapter = this.adapterForMessage(msg)
      if (adapter && msg.channelType !== 'email') {
        // Telegram and Slack: use async progress flow with edit-in-place
        try {
          await this.handleMessageWithProgress(runtimeMsg, adapter)
        } catch (err) {
          console.error(`[Main] Progress flow failed, falling back:`, err)
          // Fall back to synchronous
          const response = await this.rpcClient.sendMessage(runtimeMsg)
          if (response.success && response.status === 'waiting_approval' && response.approval) {
            const { taskId, requestId, userId, notification } = response.approval
            console.log(`[Main] Tool approval needed (task: ${taskId}, request: ${requestId})`)
            const approvalKey = `${msg.channelType}:${msg.channelId}:${msg.sender}`
            this.pendingApprovals.set(approvalKey, {
              taskId,
              requestId,
              userId,
              channelType: msg.channelType,
              channelId: msg.channelId,
              originalMessage: msg,
              createdAt: new Date(),
            })
            await this.sendReply(msg, notification)
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
        const response = await this.rpcClient.sendMessage(runtimeMsg)

        if (response.success && response.status === 'waiting_approval' && response.approval) {
          const { taskId, requestId, userId, notification } = response.approval
          console.log(`[Main] Tool approval needed (task: ${taskId}, request: ${requestId})`)
          const approvalKey = `${msg.channelType}:${msg.channelId}:${msg.sender}`
          this.pendingApprovals.set(approvalKey, {
            taskId,
            requestId,
            userId,
            channelType: msg.channelType,
            channelId: msg.channelId,
            originalMessage: msg,
            createdAt: new Date(),
          })
          await this.sendReply(msg, notification)
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

  private replyTargetMessageId(msg: Message): string | undefined {
    if (msg.channelType === 'slack') return msg.threadId
    return msg.messageId
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
  private async handleMessageWithProgress(msg: Message, adapter: ChannelAdapter): Promise<void> {
    // 1. Send message with async=true
    const response = await this.rpcClient.sendMessage(msg, { async: true })

    if (!response.taskId) {
      console.log('[Main] No taskId returned from async send, falling back to sync')
      if (response.success && response.status === 'waiting_approval' && response.approval) {
        const { taskId, requestId, userId, notification } = response.approval
        console.log(`[Main] Tool approval needed (task: ${taskId}, request: ${requestId})`)
        const approvalKey = `${msg.channelType}:${msg.channelId}:${msg.sender}`
        this.pendingApprovals.set(approvalKey, {
          taskId,
          requestId,
          userId,
          channelType: msg.channelType,
          channelId: msg.channelId,
          originalMessage: msg,
          createdAt: new Date(),
        })
        await this.sendReply(msg, notification)
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

    // 2. Send initial processing message and capture messageId for editing.
    const statusMessageId = await adapter.sendMessage(
      msg.channelId,
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

      const editStatus = async (content: string) => {
        try {
          await adapter.editMessage(msg.channelId, statusMessageId, content)
        } catch (err) {
          console.error(`[Main] Failed to edit status message:`, err)
        }
      }

      let finalDelivered = false
      let resultPollingFallbackStarted = false

      const deliverFinalResult = async (): Promise<boolean> => {
        if (finalDelivered) return true

        const result = await this.rpcClient.getTaskResult(taskId, msg)
        if (result.status === 'pending' || result.status === 'waiting_approval') {
          return false
        }

        finalDelivered = true
        if (result.success && result.response) {
          const finalText = formatFinalMessage(stream.steps, result.response)
          await editStatus(finalText)
          if (result.attachments && result.attachments.length > 0) {
            await adapter.sendMessage(
              msg.channelId,
              '',
              this.replyTargetMessageId(msg),
              result.attachments
            )
          }
        } else if (result.error) {
          await editStatus(`Error: ${result.error.message ?? 'Unknown error'}`)
        } else {
          await editStatus(formatFinalMessage(stream.steps, 'Done.'))
        }
        return true
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
          void editStatus(formatProgressUpdate(steps))
        },
        onSuspended: async suspended => {
          // Approval needed. Fetch the server-formatted notification (which
          // includes tool parameters) once. If the cache hasn't been written
          // yet (sub-ms micro-race), fall back to a generic notification.
          const approvalKey = `${msg.channelType}:${msg.channelId}:${msg.sender}`
          let notification =
            `Tool \`${suspended.toolName}\` requires approval. ` +
            (msg.channelType === 'slack'
              ? `Reply \\approve or \\deny to this message.`
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
          console.log(
            `[Main] Tool approval needed (task: ${taskId}, request: ${suspended.requestId})`
          )
          this.pendingApprovals.set(approvalKey, {
            taskId,
            requestId: suspended.requestId,
            userId: msg.sender,
            channelType: msg.channelType,
            channelId: msg.channelId,
            originalMessage: msg,
            createdAt: new Date(),
            startResultPollingFallback,
          })
          await editStatus(notification)
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
            finalDelivered = true
            await editStatus('Request cancelled.')
          } else if (terminal.status === 'failed' && terminal.error) {
            finalDelivered = true
            await editStatus(`Error: ${terminal.error.message}`)
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
      // Webhook-origin Slack requests can lose the terminal SSE while still
      // receiving normal tool progress. Keep Slack backed up by polling;
      // Telegram keeps the narrower existing fallbacks below.
      if (msg.channelType === 'slack') {
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
  private async handleApprovalCommand(msg: Message, command: string): Promise<void> {
    const approvalKey = `${msg.channelType}:${msg.channelId}:${msg.sender}`
    const pending = this.pendingApprovals.get(approvalKey)

    if (!pending) {
      console.log(`[Main] No pending approval for ${approvalKey}`)
      await this.sendReply(
        msg,
        'No pending approval found. Send a message first that triggers a tool requiring approval.'
      )
      return
    }

    const { requestId, userId } = pending
    this.pendingApprovals.delete(approvalKey)

    if (command === '/deny') {
      console.log(`[Main] User denied approval (request: ${requestId})`)
      const result = await this.rpcClient.sendDenial(
        userId,
        requestId,
        msg.channelType,
        msg.channelId
      )
      if (result.success) {
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
      msg.channelType,
      msg.channelId
    )
    if (!result.success) {
      await this.sendReply(msg, `Failed to send approval: ${result.error ?? 'unknown error'}`)
      return
    }

    await this.sendReply(
      msg,
      alwaysApprove ? 'Approved (always for this tool). Processing...' : 'Approved. Processing...'
    )

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
    for (const [key, seenAt] of this.processedProviderEvents) {
      if (now - seenAt > PROVIDER_EVENT_DEDUPE_TTL_MS) {
        this.processedProviderEvents.delete(key)
      }
    }
  }

  /**
   * Send a reply back to the original channel.
   */
  async sendReply(
    originalMessage: Message,
    replyContent: string,
    attachments?: Attachment[]
  ): Promise<void> {
    const adapter = this.adapterForMessage(originalMessage)
    if (!adapter) {
      console.warn(`[Main] No adapter found for ${originalMessage.channelType}, cannot send reply`)
      return
    }

    try {
      console.log(`[Main] Sending reply to ${originalMessage.channelType}...`)
      await adapter.sendMessage(
        originalMessage.channelId,
        replyContent,
        this.replyTargetMessageId(originalMessage),
        attachments
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
