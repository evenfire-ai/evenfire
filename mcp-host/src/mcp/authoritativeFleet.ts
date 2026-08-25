import {
  type AuthTokenResponse,
  type ContextMapperClient,
  isContextMapperAuthorityRevocation,
} from '../contextMapperClient'
import type { McpServerInfo } from '../types'
import type { McpAdmissionControl, McpAdmissionOutcome } from './manager'

/**
 * Initialize MCP servers for the host's context using skill-mapper.
 */
export async function runAuthoritativeMcpInitialization(options: {
  client: Pick<ContextMapperClient, 'healthCheck' | 'listServersForHost'>
  replaceFleet: (servers: McpServerInfo[]) => Promise<void>
  isCurrent?: () => boolean
  sleep?: (milliseconds: number) => Promise<void>
  maxRetries?: number
}): Promise<void> {
  const maxRetries = options.maxRetries ?? 5
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds)))

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ready = await options.client.healthCheck()
    if (options.isCurrent?.() === false) return
    if (ready) {
      const servers = await options.client.listServersForHost()
      if (options.isCurrent?.() === false) return
      await options.replaceFleet(servers)
      return
    }

    console.log(`[Main] Waiting for Context Mapper... (${attempt}/${maxRetries})`)
    if (attempt < maxRetries) {
      await sleep(2000)
    }
  }

  throw new Error(`Context Mapper was not ready after ${maxRetries} attempts`)
}

interface AuthoritativeMcpFleetManager {
  addServer(
    server: McpServerInfo,
    authToken?: string,
    control?: McpAdmissionControl
  ): Promise<McpAdmissionOutcome>
  disconnectAll(): Promise<void>
  recordAdmissionFailure(server: McpServerInfo, error: unknown): void
}

export const DEFAULT_MCP_FLEET_RECONCILE_MAX_CONCURRENCY = 10
const DEFAULT_MCP_CLEANUP_TIMEOUT_MS = 30_000
const DEFAULT_MCP_ADMISSION_DRAIN_TIMEOUT_MS = 30_000

interface McpSnapshotLease {
  isCurrent(serverName: string): boolean
  isAbsentCurrent(serverName: string): boolean
  admissionEpoch(serverName: string): symbol | undefined
}

type McpAuthorityEntry = {
  fingerprint: string
  admissionEpoch: symbol
}

type McpAdmissionRequest = {
  epoch: symbol
  lease: McpSnapshotLease
  effect: (isCurrent: () => boolean) => Promise<void>
}

type McpScheduledAdmission = {
  request: McpAdmissionRequest
  started: boolean
  promise: Promise<void>
  cancelWaiting?: () => boolean
}

type McpAdmissionSlot = {
  scheduled?: McpScheduledAdmission
  pending?: McpAdmissionRequest
}

type McpPermitWaiter = {
  grant: () => void
}

/**
 * Coordinates overlapping initial discovery and authoritative polls.
 *
 * Every snapshot gets a new token. Identical desired admissions on the same
 * manager adopt their existing admission epoch so a poll coalesces onto the
 * in-flight connect; any status/config change, delete/recreate, manager swap,
 * or explicit invalidation creates a new epoch and makes the old candidate
 * fail its pre-commit guard.
 */
export class AuthoritativeMcpFleetCoordinator {
  private manager: object | null = null
  private managerEpoch = Symbol('initial-manager')
  private snapshotToken = Symbol('initial-snapshot')
  private fleetRevision = Symbol('initial-fleet')
  private desired = new Map<string, McpAuthorityEntry>()
  private admissions = new WeakMap<object, Map<string, McpAdmissionSlot>>()
  private admissionTasks = new Set<Promise<void>>()
  private admissionActive = 0
  private admissionWaiters: McpPermitWaiter[] = []
  private cleanupActive = 0
  private cleanupWaiters: McpPermitWaiter[] = []
  private cleanupTasks = new Set<Promise<void>>()
  private closedManagers = new WeakSet<object>()

  constructor(
    private readonly maxAdmissions = DEFAULT_MCP_FLEET_RECONCILE_MAX_CONCURRENCY,
    private readonly maxCleanups = DEFAULT_MCP_FLEET_RECONCILE_MAX_CONCURRENCY,
    private readonly backgroundReconciliation = false,
    private readonly cleanupTimeoutMs = DEFAULT_MCP_CLEANUP_TIMEOUT_MS,
    private readonly admissionDrainTimeoutMs = DEFAULT_MCP_ADMISSION_DRAIN_TIMEOUT_MS
  ) {
    resolveMcpFleetConcurrency(maxAdmissions)
    resolveMcpFleetConcurrency(maxCleanups)
    if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs < 1) {
      throw new Error('MCP cleanup timeout must be a positive finite number')
    }
    if (!Number.isFinite(admissionDrainTimeoutMs) || admissionDrainTimeoutMs < 1) {
      throw new Error('MCP admission drain timeout must be a positive finite number')
    }
  }

  get reconcilesInBackground(): boolean {
    return this.backgroundReconciliation
  }

  publishSnapshot(manager: object, servers: readonly McpServerInfo[]): McpSnapshotLease {
    if (this.closedManagers.has(manager)) {
      return {
        isCurrent: () => false,
        isAbsentCurrent: () => false,
        admissionEpoch: () => undefined,
      }
    }
    const managerChanged = this.manager !== manager
    if (managerChanged) {
      if (this.manager) {
        this.pruneObsoleteAdmissions(this.manager, new Map())
      }
      this.manager = manager
      this.managerEpoch = Symbol('manager')
      this.desired = new Map()
    }

    const capturedManagerEpoch = this.managerEpoch
    const capturedSnapshotToken = Symbol('snapshot')
    this.snapshotToken = capturedSnapshotToken
    const nextDesired = new Map<string, McpAuthorityEntry>()
    for (const server of servers) {
      const { credentialRevision: _legacyCredentialRevision, ...snapshot } = server
      const fingerprint = canonicalJson(snapshot)
      const previous = this.desired.get(server.name)
      nextDesired.set(server.name, {
        fingerprint,
        admissionEpoch:
          previous?.fingerprint === fingerprint ? previous.admissionEpoch : Symbol(server.name),
      })
    }
    const fleetChanged =
      managerChanged ||
      nextDesired.size !== this.desired.size ||
      [...nextDesired].some(
        ([name, entry]) => this.desired.get(name)?.fingerprint !== entry.fingerprint
      )
    if (fleetChanged) {
      this.fleetRevision = Symbol('fleet')
    }
    this.desired = nextDesired
    this.pruneObsoleteAdmissions(manager, nextDesired)
    const capturedEpochs = new Map(
      [...nextDesired].map(([name, entry]) => [name, entry.admissionEpoch])
    )

    return {
      isCurrent: serverName =>
        this.manager === manager &&
        this.managerEpoch === capturedManagerEpoch &&
        this.desired.get(serverName)?.admissionEpoch === capturedEpochs.get(serverName),
      isAbsentCurrent: serverName =>
        this.manager === manager &&
        this.managerEpoch === capturedManagerEpoch &&
        this.snapshotToken === capturedSnapshotToken &&
        !this.desired.has(serverName),
      admissionEpoch: serverName => capturedEpochs.get(serverName),
    }
  }

  closeManager(manager: object): void {
    this.closedManagers.add(manager)
    this.pruneObsoleteAdmissions(manager, new Map())
    if (this.manager !== manager) return
    this.managerEpoch = Symbol('invalidated-manager')
    this.snapshotToken = Symbol('invalidated-snapshot')
    this.desired.clear()
  }

  captureManagerRevision(manager: object): () => boolean {
    const capturedManagerEpoch = this.managerEpoch
    const capturedFleetRevision = this.fleetRevision
    return () =>
      this.manager === manager &&
      this.managerEpoch === capturedManagerEpoch &&
      this.fleetRevision === capturedFleetRevision
  }

  async runAdmission(
    manager: object,
    serverName: string,
    lease: McpSnapshotLease,
    effect: (isCurrent: () => boolean) => Promise<void>
  ): Promise<void> {
    const epoch = lease.admissionEpoch(serverName)
    if (!epoch || !lease.isCurrent(serverName)) return

    let byName = this.admissions.get(manager)
    if (!byName) {
      byName = new Map()
      this.admissions.set(manager, byName)
    }
    let slot = byName.get(serverName)
    if (!slot) {
      slot = {}
      byName.set(serverName, slot)
    }
    const request: McpAdmissionRequest = { epoch, lease, effect }
    const scheduled = slot.scheduled
    if (!scheduled) {
      await this.startAdmission(serverName, byName, slot, request)
      return
    }

    if (scheduled.request.epoch === epoch || slot.pending?.epoch === epoch) {
      return
    }

    // A permit-waiting request has not started any external effect, so adopt
    // the newest epoch in place instead of allocating another global waiter.
    if (!scheduled.started) {
      scheduled.request = request
      return
    }

    // At most one latest-wins successor is retained while the active request
    // is doing I/O. Further snapshots replace it without growing a stale FIFO.
    slot.pending = request
  }

  private startAdmission(
    serverName: string,
    byName: Map<string, McpAdmissionSlot>,
    slot: McpAdmissionSlot,
    request: McpAdmissionRequest
  ): Promise<void> {
    const scheduled: McpScheduledAdmission = {
      request,
      started: false,
      promise: Promise.resolve(),
    }
    const promise = this.withPermit(
      'admission',
      async () => {
        scheduled.started = true
        const latest = scheduled.request
        if (!latest.lease.isCurrent(serverName)) return
        await latest.effect(() => latest.lease.isCurrent(serverName))
      },
      cancelWaiting => {
        scheduled.cancelWaiting = cancelWaiting
      }
    ).finally(() => {
      if (slot.scheduled !== scheduled) return
      slot.scheduled = undefined
      const pending = slot.pending
      slot.pending = undefined
      if (pending?.lease.isCurrent(serverName)) {
        const next = this.startAdmission(serverName, byName, slot, pending)
        void next.catch(error => {
          console.error(`[Main] MCP queued admission failed: ${serverName}`, error)
        })
      } else {
        byName.delete(serverName)
      }
    })
    scheduled.promise = promise
    slot.scheduled = scheduled
    this.admissionTasks.add(promise)
    void promise
      .finally(() => {
        this.admissionTasks.delete(promise)
      })
      .catch(() => undefined)
    return promise
  }

  private pruneObsoleteAdmissions(
    manager: object,
    nextDesired: ReadonlyMap<string, McpAuthorityEntry>
  ): void {
    const byName = this.admissions.get(manager)
    if (!byName) return

    // Remove only work that has not acquired a permit. Active effects keep
    // their generation fence, while surviving waiters retain FIFO order.
    for (const [serverName, slot] of byName) {
      const nextEpoch = nextDesired.get(serverName)?.admissionEpoch
      if (slot.pending?.epoch !== nextEpoch) {
        slot.pending = undefined
      }

      const scheduled = slot.scheduled
      if (!scheduled) {
        byName.delete(serverName)
        continue
      }
      if (scheduled.request.epoch === nextEpoch || scheduled.started) {
        continue
      }
      if (scheduled.cancelWaiting?.() !== true) {
        continue
      }

      scheduled.cancelWaiting = undefined
      slot.scheduled = undefined
      byName.delete(serverName)
      this.admissionTasks.delete(scheduled.promise)
    }
  }

  scheduleCleanup(cleanup: () => Promise<void>): void {
    let task!: Promise<void>
    task = this.withPermit('cleanup', () => this.runCleanupWithTimeout(cleanup))
      .catch(error => {
        console.error('[Main] MCP detached client cleanup failed:', error)
      })
      .finally(() => {
        this.cleanupTasks.delete(task)
      })
    this.cleanupTasks.add(task)
  }

  async drainCleanups(): Promise<void> {
    while (this.cleanupTasks.size > 0) {
      await Promise.all([...this.cleanupTasks])
    }
  }

  async drainForShutdown(): Promise<void> {
    const admissionsDrained = this.drainAdmissions()
    const timedOut = Symbol('admission-drain-timeout')
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<typeof timedOut>(resolve => {
      timer = setTimeout(() => resolve(timedOut), this.admissionDrainTimeoutMs)
    })
    try {
      const result = await Promise.race([admissionsDrained, timeout])
      if (result === timedOut) {
        console.warn(
          `[Main] MCP admission drain exceeded ${this.admissionDrainTimeoutMs}ms; abandoning transport wait`
        )
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
    await this.drainCleanups()
  }

  private async drainAdmissions(): Promise<void> {
    while (this.admissionTasks.size > 0) {
      await Promise.allSettled([...this.admissionTasks])
    }
  }

  private async runCleanupWithTimeout(cleanup: () => Promise<void>): Promise<void> {
    const timedOut = Symbol('cleanup-timeout')
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanupResult = Promise.resolve()
      .then(cleanup)
      .then(() => undefined)
    const timeoutResult = new Promise<typeof timedOut>(resolve => {
      timer = setTimeout(() => resolve(timedOut), this.cleanupTimeoutMs)
    })
    try {
      const result = await Promise.race([cleanupResult, timeoutResult])
      if (result === timedOut) {
        console.warn(
          `[Main] MCP detached client cleanup exceeded ${this.cleanupTimeoutMs}ms; abandoning wait`
        )
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async withPermit(
    lane: 'admission' | 'cleanup',
    effect: () => Promise<void>,
    setCancelWaiting?: (cancelWaiting: (() => boolean) | undefined) => void
  ): Promise<void> {
    const activeKey = lane === 'admission' ? 'admissionActive' : 'cleanupActive'
    const waiters = lane === 'admission' ? this.admissionWaiters : this.cleanupWaiters
    const limit = lane === 'admission' ? this.maxAdmissions : this.maxCleanups
    if (this[activeKey] >= limit) {
      const acquired = await new Promise<boolean>(resolve => {
        const waiter: McpPermitWaiter = {
          grant: () => resolve(true),
        }
        waiters.push(waiter)
        setCancelWaiting?.(() => {
          const waiterIndex = waiters.indexOf(waiter)
          if (waiterIndex < 0) return false
          waiters.splice(waiterIndex, 1)
          resolve(false)
          return true
        })
      })
      setCancelWaiting?.(undefined)
      if (!acquired) return
    } else {
      this[activeKey] += 1
    }
    try {
      await effect()
    } finally {
      const next = waiters.shift()
      if (next) {
        next.grant()
      } else {
        this[activeKey] -= 1
      }
    }
  }
}

function resolveMcpFleetConcurrency(maxConcurrency?: number): number {
  const resolved = maxConcurrency ?? DEFAULT_MCP_FLEET_RECONCILE_MAX_CONCURRENCY
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error('MCP fleet reconciliation concurrency must be a positive integer')
  }
  return resolved
}

async function runMcpFleetEffects<T>(
  items: readonly T[],
  maxConcurrency: number,
  effect: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(maxConcurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex]
      nextIndex += 1
      await effect(item)
    }
  })
  await Promise.all(workers)
}

async function resolveRequiredMcpGrant(
  server: McpServerInfo,
  getAuthToken: (serverName: string) => Promise<AuthTokenResponse>
): Promise<AuthTokenResponse | undefined> {
  if (
    !server.enabled ||
    !server.status?.ready ||
    server.status.authoritative === false ||
    (server.authRequired !== true && !server.auth?.secretRef)
  ) {
    return undefined
  }

  const grant = await getAuthToken(server.name)
  if (!grant.credentialRevision || !grant.token) {
    throw new Error('Required MCP credential is unavailable')
  }
  return grant
}

/**
 * Apply an authoritative MCP fleet snapshot with per-server admission.
 *
 * On cold start, healthy and intentionally skipped servers are published
 * immediately while failed revisions remain retryable. When a prior manager
 * exists, replacement remains atomic: any admission failure rejects and
 * cleans up the candidate without retiring the live fleet.
 */
export async function replaceAuthoritativeMcpFleet<
  TManager extends AuthoritativeMcpFleetManager,
>(options: {
  servers: McpServerInfo[]
  previousManager: { disconnectAll(): Promise<void> } | null
  createManager: () => TManager
  getAuthToken: (serverName: string) => Promise<AuthTokenResponse>
  installFleet: (
    manager: TManager,
    serverState: Map<string, string>,
    grantState: Map<string, string>
  ) => void
  maxConcurrency?: number
  coordinator?: AuthoritativeMcpFleetCoordinator
  onColdStartPublished?: () => void
  isPreviousManagerCurrent?: () => boolean
  isFleetLifecycleCurrent?: () => boolean
}): Promise<void> {
  const maxConcurrency = resolveMcpFleetConcurrency(options.maxConcurrency)
  if (options.isFleetLifecycleCurrent?.() === false) return
  const nextManager = options.createManager()
  // A replacement candidate must not supersede the live manager's authority
  // epoch until its complete fleet has admitted and installFleet commits it.
  const coordinator = options.previousManager
    ? new AuthoritativeMcpFleetCoordinator(maxConcurrency, maxConcurrency)
    : (options.coordinator ?? new AuthoritativeMcpFleetCoordinator(maxConcurrency, maxConcurrency))
  const previousAuthorityIsCurrent =
    options.previousManager && options.coordinator
      ? options.coordinator.captureManagerRevision(options.previousManager)
      : undefined
  const lease = coordinator.publishSnapshot(nextManager, options.servers)
  const nextServerState = new Map<string, string>()
  const nextGrantState = new Map<string, string>()
  const admissionFailures: unknown[] = []
  const coldStart = options.previousManager === null

  try {
    // Publish the empty manager before cold-start admission begins. The agent
    // reads this manager by reference, so independently admitted healthy peers
    // become usable immediately instead of waiting for the slowest fleet
    // member. Replacements keep the prior manager installed until the complete
    // candidate succeeds below.
    if (coldStart) {
      if (options.isFleetLifecycleCurrent?.() === false) {
        throw new Error('MCP fleet initialization was superseded before publish')
      }
      options.installFleet(nextManager, nextServerState, nextGrantState)
      options.onColdStartPublished?.()
    }

    const admitServer = async (server: McpServerInfo, isCurrent: () => boolean): Promise<void> => {
      if (!isCurrent()) return
      let grant: AuthTokenResponse | undefined
      try {
        grant = await resolveRequiredMcpGrant(server, options.getAuthToken)
      } catch (error) {
        if (!isCurrent()) return
        // Auth discovery fails before addServer can own the status transition.
        nextManager.recordAdmissionFailure(server, error)
        admissionFailures.push(error)
        if (isContextMapperAuthorityRevocation(error)) {
          console.error('[Main] MCP credential admission rejected (reason=authority_revoked)')
        } else {
          console.error(`[Main] MCP server admission failed; will retry: ${server.name}`, error)
        }
        return
      }

      try {
        await nextManager.addServer(server, grant?.token ?? undefined, {
          isCurrent,
          onCommit: () => {
            if (isCurrent()) {
              nextServerState.set(server.name, JSON.stringify(server))
              if (grant) {
                nextGrantState.set(server.name, grant.credentialRevision)
              } else {
                nextGrantState.delete(server.name)
              }
            }
          },
          scheduleCleanup: cleanup => coordinator.scheduleCleanup(cleanup),
        })
      } catch (error) {
        if (!isCurrent()) return
        // addServer owns connection-failure status. Avoid recording the same
        // transition twice while keeping the desired revision retryable.
        admissionFailures.push(error)
        console.error(`[Main] MCP server admission failed; will retry: ${server.name}`, error)
      }
    }

    // Distinct McpServers own disjoint client/status/tool-map entries. Admit
    // them independently through a finite worker pool so one slow connection
    // cannot head-of-line block a healthy peer and a large fleet cannot create
    // an unbounded connection burst. Each failure remains retryable above.
    const reconciliation = runMcpFleetEffects(options.servers, maxConcurrency, server =>
      coordinator.runAdmission(nextManager, server.name, lease, isCurrent =>
        admitServer(server, () => isCurrent() && options.isFleetLifecycleCurrent?.() !== false)
      )
    )
    if (coldStart && coordinator.reconcilesInBackground) {
      void reconciliation.catch(error => {
        console.error('[Main] MCP background cold-start reconciliation failed:', error)
      })
      return
    }
    await reconciliation

    // Cold start may publish healthy peers so HCC readiness is independent of
    // full-fleet convergence. A live prior fleet is safer to preserve
    // atomically until its complete replacement candidate is admitted.
    if (options.previousManager) {
      if (admissionFailures.length > 0) {
        throw admissionFailures[0]
      }
      if (
        options.isFleetLifecycleCurrent?.() === false ||
        options.isPreviousManagerCurrent?.() === false ||
        previousAuthorityIsCurrent?.() === false
      ) {
        throw new Error('MCP fleet replacement candidate was superseded before commit')
      }
    }

    if (!coldStart) {
      options.installFleet(nextManager, nextServerState, nextGrantState)
      options.coordinator?.publishSnapshot(nextManager, options.servers)
    }
  } catch (error) {
    coordinator.closeManager(nextManager)
    try {
      await nextManager.disconnectAll()
    } catch (cleanupError) {
      console.error('[Main] Failed to clean up rejected MCP fleet candidate:', cleanupError)
    }
    throw error
  }

  // installFleet is the commit point. Once the accepted candidate is visible,
  // failure to retire stale connections must not invalidate or retry the
  // already-committed authoritative fleet.
  if (options.previousManager && options.previousManager !== nextManager) {
    try {
      await options.previousManager.disconnectAll()
    } catch (cleanupError) {
      console.error('[Main] Failed to retire previous MCP fleet after replacement:', cleanupError)
    }
  }
}

interface AuthoritativeMcpSnapshotManager {
  addServer(
    server: McpServerInfo,
    authToken?: string,
    control?: McpAdmissionControl
  ): Promise<McpAdmissionOutcome>
  replaceServer(
    server: McpServerInfo,
    authToken?: string,
    control?: McpAdmissionControl
  ): Promise<McpAdmissionOutcome>
  removeServer(serverName: string): Promise<void>
  detachServer?(serverName: string): () => Promise<void>
  getConnectedServers(): string[]
  getKnownServers(): string[]
  recordAdmissionFailure(server: McpServerInfo, error: unknown): void
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function mcpServerDesiredRevision(server: McpServerInfo): string {
  const {
    status: _observedStatus,
    credentialRevision: _legacyCredentialRevision,
    ...desired
  } = server
  return canonicalJson(desired)
}

/**
 * Apply one authoritative inventory snapshot without confusing transient
 * observed readiness with a desired server revision.
 */
export async function reconcileAuthoritativeMcpSnapshot(options: {
  servers: McpServerInfo[]
  manager: AuthoritativeMcpSnapshotManager
  serverState: Map<string, string>
  /** The runtime always supplies this; isolated legacy unit callers may omit it. */
  grantState?: Map<string, string>
  getAuthToken: (serverName: string) => Promise<AuthTokenResponse>
  maxConcurrency?: number
  coordinator?: AuthoritativeMcpFleetCoordinator
}): Promise<void> {
  const maxConcurrency = resolveMcpFleetConcurrency(options.maxConcurrency)
  const coordinator =
    options.coordinator ?? new AuthoritativeMcpFleetCoordinator(maxConcurrency, maxConcurrency)
  const grantState = options.grantState ?? new Map<string, string>()
  // Snapshot publication is synchronous and precedes every manager read or
  // network effect. It invalidates stale initial/poll candidates immediately.
  const lease = coordinator.publishSnapshot(options.manager, options.servers)
  const currentNames = new Set(options.servers.map(server => server.name))
  // Failed admission revisions intentionally stay out of serverState so an
  // identical later snapshot retries them. They are still manager-known
  // inventory/status entries and must participate in authoritative deletion,
  // otherwise a removed failed-only server remains ghosted forever.
  const previousNames = new Set([
    ...options.serverState.keys(),
    ...options.manager.getKnownServers(),
  ])
  const connectedNames = new Set(options.manager.getConnectedServers())

  // Revoke live exposure synchronously for every authoritative delete,
  // disabled server, or authoritative not-ready server before starting any
  // admission/cleanup I/O. Cleanup is scheduled through its own bounded lane,
  // so a hung disconnect cannot delay the rest of the snapshot.
  if (options.manager.detachServer) {
    for (const name of previousNames) {
      if (!currentNames.has(name) && lease.isAbsentCurrent(name)) {
        coordinator.scheduleCleanup(options.manager.detachServer(name))
        options.serverState.delete(name)
        grantState.delete(name)
      }
    }
    for (const server of options.servers) {
      const previousState = options.serverState.get(server.name)
      const desiredChanged =
        previousState !== undefined &&
        mcpServerDesiredRevision(JSON.parse(previousState) as McpServerInfo) !==
          mcpServerDesiredRevision(server)
      // Credential rotation is authorized by HCC's live pre/post Secret fence
      // on the scoped credential POST. The metadata-only inventory is never a
      // client-side credential authority barrier.
      const revokesLiveConnection =
        connectedNames.has(server.name) &&
        (!server.enabled ||
          (server.status?.authoritative !== false && server.status?.ready === false) ||
          (server.status?.authoritative === false && desiredChanged))
      if (revokesLiveConnection && lease.isCurrent(server.name)) {
        coordinator.scheduleCleanup(options.manager.detachServer(server.name))
        grantState.delete(server.name)
      }
    }
  }

  const resolveGrant = async (
    server: McpServerInfo,
    isCurrent: () => boolean
  ): Promise<AuthTokenResponse | undefined> => {
    try {
      return await resolveRequiredMcpGrant(server, options.getAuthToken)
    } catch (error) {
      if (isCurrent() && isContextMapperAuthorityRevocation(error)) {
        if (options.manager.detachServer) {
          coordinator.scheduleCleanup(options.manager.detachServer(server.name))
        } else if (connectedNames.has(server.name)) {
          await options.manager.removeServer(server.name)
        }
        options.serverState.delete(server.name)
        grantState.delete(server.name)
      }
      // Auth discovery fails before manager admission. Preserve a live
      // connection's status during replacement; otherwise publish the
      // admission failure exactly once.
      if (isCurrent() && !connectedNames.has(server.name)) {
        options.manager.recordAdmissionFailure(server, error)
      }
      throw error
    }
  }

  const reconcileServer = async (
    server: McpServerInfo,
    isCurrent: () => boolean
  ): Promise<void> => {
    if (!isCurrent()) return
    const previousState = options.serverState.get(server.name)
    const currentState = JSON.stringify(server)
    let grantRevisionToCommit: string | undefined
    const control: Required<McpAdmissionControl> = {
      isCurrent,
      onCommit: () => {
        if (isCurrent()) {
          options.serverState.set(server.name, currentState)
          if (grantRevisionToCommit) {
            grantState.set(server.name, grantRevisionToCommit)
          } else {
            grantState.delete(server.name)
          }
        }
      },
      scheduleCleanup: cleanup => coordinator.scheduleCleanup(cleanup),
    }

    if (!previousState) {
      const grant = await resolveGrant(server, isCurrent)
      grantRevisionToCommit = grant?.credentialRevision
      await options.manager.addServer(server, grant?.token ?? undefined, control)
      return
    }

    const previousServer = JSON.parse(previousState) as McpServerInfo
    const desiredChanged =
      mcpServerDesiredRevision(previousServer) !== mcpServerDesiredRevision(server)

    if (desiredChanged) {
      if (server.status?.authoritative === false) {
        await options.manager.removeServer(server.name)
        // Reuse the manager's fail-closed admission path to keep the expected
        // server visible as not_ready without opening a connection.
        await options.manager.addServer(server, undefined, control)
        return
      }

      if (!server.enabled || !server.status?.ready) {
        await options.manager.removeServer(server.name)
        await options.manager.addServer(server, undefined, control)
        return
      }

      // A ready authoritative desired revision is connected before commit.
      // Failure leaves the previous connection and recorded revision intact,
      // so an identical later snapshot retries it.
      const grant = await resolveGrant(server, isCurrent)
      grantRevisionToCommit = grant?.credentialRevision
      await options.manager.replaceServer(server, grant?.token ?? undefined, control)
      return
    }

    if (server.status?.authoritative === false) {
      // The producer explicitly could not establish status authority. Record
      // the snapshot, but never use it to open a connection. An existing live
      // connection remains valid until authoritative status or desired/delete
      // state says otherwise.
      if (isCurrent()) {
        options.serverState.set(server.name, currentState)
      }
      return
    }

    if (!server.status?.ready) {
      // Explicit authoritative ready=false and legacy ready=false both revoke.
      // Only the negotiated authoritative=false state preserves a live
      // connection; field absence must retain the legacy fail-closed contract.
      if (connectedNames.has(server.name)) {
        await options.manager.removeServer(server.name)
      }
      await options.manager.addServer(server, undefined, control)
      return
    }

    // A previously not-ready server was intentionally recorded without a
    // connection. Admit it once the authoritative snapshot reports it ready.
    if (!connectedNames.has(server.name) && server.enabled) {
      const grant = await resolveGrant(server, isCurrent)
      grantRevisionToCommit = grant?.credentialRevision
      await options.manager.addServer(server, grant?.token ?? undefined, control)
      return
    }

    if (connectedNames.has(server.name) && server.enabled) {
      // The directory is topology-only. Re-read the scoped HCC grant on every
      // healthy poll so Secret/server rotation is detected without accepting a
      // revision supplied by, or obtained from, the inventory caller.
      const grant = await resolveGrant(server, isCurrent)
      if (!grant) {
        if (isCurrent()) options.serverState.set(server.name, currentState)
        return
      }
      const previousGrantRevision = grantState.get(server.name)
      if (previousGrantRevision === grant.credentialRevision) {
        if (isCurrent()) options.serverState.set(server.name, currentState)
        return
      }
      if (!isCurrent()) return

      // detachServer revokes the bearer synchronously and only schedules the
      // physical close; the replacement cannot admit with the old bearer.
      if (options.manager.detachServer) {
        coordinator.scheduleCleanup(options.manager.detachServer(server.name))
      } else {
        await options.manager.removeServer(server.name)
      }
      if (!isCurrent()) return
      grantRevisionToCommit = grant.credentialRevision
      await options.manager.replaceServer(server, grant.token ?? undefined, control)
      return
    }

    // Status-only degradation is still an authoritative observation, but it
    // must not tear down a live connection that may remain healthy.
    if (isCurrent()) {
      options.serverState.set(server.name, currentState)
    }
  }

  const effects: Array<() => Promise<void>> = []
  // Authoritative absence is a revocation signal. Queue deletions before
  // admissions so a full budget of slow new peers cannot delay retiring
  // servers that are no longer desired.
  for (const name of previousNames) {
    if (!currentNames.has(name)) {
      if (options.manager.detachServer) continue
      effects.push(async () => {
        try {
          if (!lease.isAbsentCurrent(name)) return
          await options.manager.removeServer(name)
          if (lease.isAbsentCurrent(name)) {
            options.serverState.delete(name)
            grantState.delete(name)
          }
        } catch (error) {
          console.error(`[Main] MCP server deletion failed; will retry: ${name}`, error)
        }
      })
    }
  }
  for (const server of options.servers) {
    effects.push(async () => {
      try {
        await coordinator.runAdmission(options.manager, server.name, lease, isCurrent =>
          reconcileServer(server, isCurrent)
        )
      } catch (error) {
        console.error(`[Main] MCP server reconciliation failed; will retry: ${server.name}`, error)
      }
    })
  }

  // A coalesced poll owns one authoritative snapshot at a time. Within that
  // snapshot each server key is unique, and desired keys are disjoint from
  // deletion keys, so effects can progress independently under one bounded
  // fleet-wide budget without weakening same-server ordering.
  const reconciliation = runMcpFleetEffects(effects, maxConcurrency, effect => effect())
  if (coordinator.reconcilesInBackground) {
    void reconciliation.catch(error => {
      console.error('[Main] MCP background snapshot reconciliation failed:', error)
    })
    return
  }
  await reconciliation
}

export async function pollAuthoritativeMcpSnapshotIfCurrent(options: {
  poll: () => Promise<{ servers: McpServerInfo[] }>
  isCurrent: () => boolean
  reconcile: (servers: McpServerInfo[]) => Promise<void>
}): Promise<void> {
  const { servers } = await options.poll()
  if (!options.isCurrent()) return
  await options.reconcile(servers)
}
