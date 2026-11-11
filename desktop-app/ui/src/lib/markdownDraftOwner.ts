/**
 * Process-local owner for EvenDrive Markdown drafts.
 *
 * This store is intentionally synchronous. Its maps are authoritative for
 * event handlers which may run before React commits a render; subscribe() is
 * only the notification bridge for React. Nothing in this module persists.
 */

export const MARKDOWN_DRAFT_MAX_BYTES = 2 * 1024 * 1024

export type MarkdownDraftBinding = Readonly<{
  principalOwner: string
  scopeKey: string
  tabId: string
  gfsUri: string
}>

export type MarkdownDraftSnapshot = Readonly<{ content: string; version: number }>
export type MarkdownCapability = 'unknown' | 'positive' | 'denied'
export type MarkdownSaveFailure = 'failure' | 'ambiguous'
export type MarkdownSaveOutcome = MarkdownSaveFailure | 'success' | null

export type MarkdownReadToken = Readonly<{
  kind: 'read'
  binding: MarkdownDraftBinding
  ownerId: number
  scopeGeneration: number
  generation: number
}>

export type MarkdownCapabilityToken = Readonly<{
  kind: 'capability'
  binding: MarkdownDraftBinding
  ownerId: number
  scopeGeneration: number
  generation: number
}>

export type MarkdownSaveRequest = Readonly<{
  kind: 'save'
  id: number
  binding: MarkdownDraftBinding
  ownerId: number
  scopeGeneration: number
  expectedSessionGeneration: number | null
  submitted: string
  /** Deliberately absent: human Markdown saves use unconditional GFS replace. */
  ifMatch?: never
}>

export type MarkdownViewCandidate = Readonly<{
  requestId: number
  binding: MarkdownDraftBinding
  submitted: string
  version: number
}>

export type MarkdownDraftRecordSnapshot = Readonly<{
  binding: MarkdownDraftBinding
  ownerId: number
  scopeGeneration: number
  bindingSessionGeneration: number | null
  savedSnapshot: MarkdownDraftSnapshot | null
  lastWriteAck: MarkdownDraftSnapshot | null
  lastSaveOutcome: MarkdownSaveOutcome
  draft: string
  localBaseline: string | null
  observedVersion: number
  remoteAhead: boolean
  dirty: boolean
  sizeExceeded: boolean
  editing: boolean
  resumeEditPending: boolean
  readReady: boolean
  readPending: boolean
  capability: MarkdownCapability
  capabilityPending: boolean
  pendingSave: MarkdownSaveRequest | null
  viewCandidate: MarkdownViewCandidate | null
  closePrompt: boolean
  closeReserved: boolean
  closeAuthorizationPending: boolean
  closePermitId: string | null
}>

type RecordState = {
  binding: MarkdownDraftBinding
  key: string
  ownerId: number
  scopeGeneration: number
  bindingSessionGeneration: number | null
  savedSnapshot: MarkdownDraftSnapshot | null
  lastWriteAck: MarkdownDraftSnapshot | null
  lastSaveOutcome: MarkdownSaveOutcome
  draft: string
  localBaseline: string | null
  observedVersion: number
  remoteAhead: boolean
  sizeExceeded: boolean
  editing: boolean
  resumeEditPending: boolean
  readReady: boolean
  readPending: boolean
  readGeneration: number
  capability: MarkdownCapability
  capabilityPending: boolean
  capabilityGeneration: number
  pendingSave: MarkdownSaveRequest | null
  viewCandidate: MarkdownViewCandidate | null
  closePrompt: boolean
  closeReserved: boolean
  closeAuthorizationPending: boolean
  closePermitId: string | null
}

type ScopeTransition = {
  id: number
  fromScope: string
  renderCommitted: boolean
  mainSessionGeneration: number | null
}

type AuthTransition = {
  id: number
  principalOwner: string
  sessionGeneration: number | null
  rendererInitiated: boolean
  mainReserved: boolean
  neutralCommitted: boolean
  acknowledged: boolean
  forcedBlank: boolean
}

export type MarkdownCloseResult = 'missing' | 'blocked' | 'confirm' | 'reserved'
export type MarkdownAuthBarrierSnapshot = Readonly<{
  id: number
  principalOwner: string
  sessionGeneration: number | null
  rendererInitiated: boolean
  mainReserved: boolean
  neutralCommitted: boolean
  acknowledged: boolean
}>

function freezeBinding(binding: MarkdownDraftBinding): MarkdownDraftBinding {
  return Object.freeze({
    principalOwner: binding.principalOwner,
    scopeKey: binding.scopeKey,
    tabId: binding.tabId,
    gfsUri: binding.gfsUri,
  })
}

function keyFor(binding: MarkdownDraftBinding): string {
  return JSON.stringify([binding.principalOwner, binding.scopeKey, binding.tabId, binding.gfsUri])
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function freezeSnapshot(snapshot: MarkdownDraftSnapshot): MarkdownDraftSnapshot {
  return Object.freeze({ content: snapshot.content, version: snapshot.version })
}

export class MarkdownDraftOwner {
  private readonly records = new Map<string, RecordState>()
  private readonly listeners = new Set<() => void>()
  private nextOwnerId = 1
  private nextRequestId = 1
  private nextTransitionId = 1
  private scopeGeneration = 1
  private activePrincipalOwner: string | null = null
  private activeScopeKey: string | null = null
  private activeSessionGeneration: number | null = null
  private scopeTransition: ScopeTransition | null = null
  private authTransition: AuthTransition | null = null
  private terminated = false

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private getRecord(binding: MarkdownDraftBinding): RecordState | undefined {
    return this.records.get(keyFor(binding))
  }

  private recordsForTab(tabId: string, principalOwner?: string): RecordState[] {
    return [...this.records.values()].filter(
      record =>
        record.binding.tabId === tabId &&
        (principalOwner === undefined || record.binding.principalOwner === principalOwner)
    )
  }

  private isDirty(record: RecordState): boolean {
    return record.localBaseline !== null && record.draft !== record.localBaseline
  }

  private blockedByBarrier(): boolean {
    return this.terminated || this.scopeTransition !== null || this.authTransition !== null
  }

  hasPendingTransition(): boolean {
    return this.scopeTransition !== null || this.authTransition !== null
  }

  ownsScopeTransition(token: Readonly<{ id: number }>): boolean {
    return this.scopeTransition?.id === token.id && this.authTransition === null
  }

  private isCurrentScope(record: RecordState): boolean {
    return (
      record.binding.principalOwner === this.activePrincipalOwner &&
      record.binding.scopeKey === this.activeScopeKey
    )
  }

  private notifyEditResume(record: RecordState): void {
    if (
      record.resumeEditPending &&
      record.readReady &&
      !record.readPending &&
      record.capability === 'positive' &&
      !record.capabilityPending &&
      this.isCurrentScope(record) &&
      !this.blockedByBarrier()
    ) {
      record.editing = true
      record.resumeEditPending = false
    }
  }

  open(
    input: MarkdownDraftBinding,
    options: {
      savedSnapshot?: MarkdownDraftSnapshot | null
      sessionGeneration?: number | null
    } = {}
  ): MarkdownDraftRecordSnapshot | null {
    if (
      this.terminated ||
      !input.principalOwner ||
      !input.scopeKey ||
      !input.tabId ||
      !input.gfsUri
    )
      return null
    const binding = freezeBinding(input)
    const key = keyFor(binding)
    const existing = this.records.get(key)
    if (existing) return this.snapshotRecord(existing)

    if (this.activePrincipalOwner === null) this.activePrincipalOwner = binding.principalOwner
    if (this.activeScopeKey === null) this.activeScopeKey = binding.scopeKey
    if (this.activeSessionGeneration === null && options.sessionGeneration !== undefined)
      this.activeSessionGeneration = options.sessionGeneration

    const snapshot = options.savedSnapshot ? freezeSnapshot(options.savedSnapshot) : null
    const record: RecordState = {
      binding,
      key,
      ownerId: this.nextOwnerId++,
      scopeGeneration: this.scopeGeneration,
      bindingSessionGeneration: options.sessionGeneration ?? this.activeSessionGeneration,
      savedSnapshot: snapshot,
      lastWriteAck: snapshot,
      lastSaveOutcome: null,
      draft: snapshot?.content ?? '',
      localBaseline: snapshot?.content ?? null,
      observedVersion: snapshot?.version ?? 0,
      remoteAhead: false,
      sizeExceeded: byteLength(snapshot?.content ?? '') > MARKDOWN_DRAFT_MAX_BYTES,
      editing: false,
      resumeEditPending: false,
      readReady: snapshot !== null,
      readPending: false,
      readGeneration: 0,
      capability: 'unknown',
      capabilityPending: false,
      capabilityGeneration: 0,
      pendingSave: null,
      viewCandidate: null,
      closePrompt: false,
      closeReserved: false,
      closeAuthorizationPending: false,
      closePermitId: null,
    }
    this.records.set(key, record)
    this.emit()
    return this.snapshotRecord(record)
  }

  get(binding: MarkdownDraftBinding): MarkdownDraftRecordSnapshot | null {
    const record = this.getRecord(binding)
    return record ? this.snapshotRecord(record) : null
  }

  getForTab(tabId: string, principalOwner?: string): readonly MarkdownDraftRecordSnapshot[] {
    return Object.freeze(
      this.recordsForTab(tabId, principalOwner).map(record => this.snapshotRecord(record))
    )
  }

  getVisibleRecord(binding: MarkdownDraftBinding): MarkdownDraftRecordSnapshot | null {
    if (
      this.blockedByBarrier() ||
      this.activePrincipalOwner === null ||
      this.activeScopeKey === null
    )
      return null
    if (
      binding.principalOwner !== this.activePrincipalOwner ||
      binding.scopeKey !== this.activeScopeKey
    )
      return null
    const record = this.getRecord(binding)
    if (!record || !record.readReady || record.readPending || record.closeReserved) return null
    return record ? this.snapshotRecord(record) : null
  }

  getAuthBarrier(): MarkdownAuthBarrierSnapshot | null {
    const transition = this.authTransition
    return transition
      ? Object.freeze({
          id: transition.id,
          principalOwner: transition.principalOwner,
          sessionGeneration: transition.sessionGeneration,
          rendererInitiated: transition.rendererInitiated,
          mainReserved: transition.mainReserved,
          neutralCommitted: transition.neutralCommitted,
          acknowledged: transition.acknowledged,
        })
      : null
  }

  beginStableRead(binding: MarkdownDraftBinding): MarkdownReadToken | null {
    const record = this.getRecord(binding)
    if (!record || record.closeReserved || this.blockedByBarrier()) return null
    record.readPending = true
    const token = Object.freeze({
      kind: 'read' as const,
      binding: record.binding,
      ownerId: record.ownerId,
      scopeGeneration: record.scopeGeneration,
      generation: ++record.readGeneration,
    })
    this.emit()
    return token
  }

  completeStableRead(
    token: MarkdownReadToken,
    result: { content: string; version: number; stable: boolean }
  ): boolean {
    const record = this.records.get(keyFor(token.binding))
    if (
      !record ||
      record.ownerId !== token.ownerId ||
      record.scopeGeneration !== token.scopeGeneration ||
      record.readGeneration !== token.generation
    )
      return false
    record.readPending = false
    if (
      !result.stable ||
      !Number.isSafeInteger(result.version) ||
      result.version < 0 ||
      result.version < record.observedVersion
    ) {
      // Keep the last coherent snapshot usable during an ordinary refresh.
      // Scope re-entry already clears readReady before requesting its gated read.
      this.emit()
      return true
    }
    const firstRead = !record.readReady && record.savedSnapshot === null
    record.savedSnapshot = freezeSnapshot({ content: result.content, version: result.version })
    record.lastSaveOutcome = null
    record.observedVersion = Math.max(record.observedVersion, result.version)
    record.readReady = true
    record.remoteAhead =
      record.lastWriteAck !== null && result.version > record.lastWriteAck.version
    if (firstRead) {
      record.draft = result.content
      record.localBaseline = result.content
      record.sizeExceeded = byteLength(result.content) > MARKDOWN_DRAFT_MAX_BYTES
    }
    this.notifyEditResume(record)
    this.emit()
    return true
  }

  beginCapabilityRefresh(binding: MarkdownDraftBinding): MarkdownCapabilityToken | null {
    const record = this.getRecord(binding)
    if (!record || record.closeReserved || this.blockedByBarrier()) return null
    record.capabilityPending = true
    record.capability = 'unknown'
    const token = Object.freeze({
      kind: 'capability' as const,
      binding: record.binding,
      ownerId: record.ownerId,
      scopeGeneration: record.scopeGeneration,
      generation: ++record.capabilityGeneration,
    })
    this.emit()
    return token
  }

  completeCapabilityRefresh(token: MarkdownCapabilityToken, allowed: boolean): boolean {
    const record = this.records.get(keyFor(token.binding))
    if (
      !record ||
      record.ownerId !== token.ownerId ||
      record.scopeGeneration !== token.scopeGeneration ||
      record.capabilityGeneration !== token.generation
    )
      return false
    record.capabilityPending = false
    record.capability = allowed ? 'positive' : 'denied'
    this.notifyEditResume(record)
    this.emit()
    return true
  }

  beginEdit(binding: MarkdownDraftBinding): boolean {
    const record = this.getRecord(binding)
    if (
      !record ||
      !this.isCurrentScope(record) ||
      this.blockedByBarrier() ||
      record.closeReserved ||
      record.pendingSave ||
      !record.readReady ||
      record.readPending ||
      !record.savedSnapshot ||
      record.capability !== 'positive' ||
      record.capabilityPending ||
      record.observedVersion > record.savedSnapshot.version
    )
      return false
    if (!record.editing) {
      record.draft = record.savedSnapshot.content
      record.localBaseline = record.savedSnapshot.content
      record.sizeExceeded = byteLength(record.draft) > MARKDOWN_DRAFT_MAX_BYTES
      record.viewCandidate = null
      record.editing = true
    }
    this.emit()
    return true
  }

  type(binding: MarkdownDraftBinding, value: string): boolean {
    const record = this.getRecord(binding)
    if (
      !record ||
      !record.editing ||
      record.closeReserved ||
      this.blockedByBarrier() ||
      !this.isCurrentScope(record)
    )
      return false
    record.draft = value
    record.sizeExceeded = byteLength(value) > MARKDOWN_DRAFT_MAX_BYTES
    record.viewCandidate = null
    this.emit()
    return true
  }

  reserveSave(binding: MarkdownDraftBinding): MarkdownSaveRequest | null {
    const record = this.getRecord(binding)
    if (
      !record ||
      !record.editing ||
      !this.isCurrentScope(record) ||
      this.blockedByBarrier() ||
      record.closeReserved ||
      record.pendingSave ||
      !record.readReady ||
      record.readPending ||
      (record.draft === record.localBaseline && !record.remoteAhead)
    )
      return null
    record.sizeExceeded = byteLength(record.draft) > MARKDOWN_DRAFT_MAX_BYTES
    if (record.sizeExceeded) {
      this.emit()
      return null
    }
    const request: MarkdownSaveRequest = Object.freeze({
      kind: 'save',
      id: this.nextRequestId++,
      binding: record.binding,
      ownerId: record.ownerId,
      scopeGeneration: record.scopeGeneration,
      expectedSessionGeneration: record.bindingSessionGeneration,
      submitted: record.draft,
    })
    record.pendingSave = request
    this.emit()
    return request
  }

  completeSave(
    request: MarkdownSaveRequest,
    outcome: { kind: 'success'; version: number } | { kind: MarkdownSaveFailure }
  ): boolean {
    const record = this.records.get(keyFor(request.binding))
    if (!record || record.ownerId !== request.ownerId || record.pendingSave?.id !== request.id)
      return false
    record.pendingSave = null
    if (outcome.kind === 'success') {
      record.lastSaveOutcome = 'success'
      if (!Number.isSafeInteger(outcome.version) || outcome.version < 0) {
        this.emit()
        return false
      }
      record.lastWriteAck = freezeSnapshot({ content: request.submitted, version: outcome.version })
      record.observedVersion = Math.max(record.observedVersion, outcome.version)
      if (outcome.version >= record.observedVersion) {
        record.savedSnapshot = freezeSnapshot({
          content: request.submitted,
          version: outcome.version,
        })
        record.localBaseline = request.submitted
        record.remoteAhead = false
      } else {
        record.remoteAhead = true
        record.viewCandidate = null
      }
      if (
        !record.remoteAhead &&
        record.draft === request.submitted &&
        record.localBaseline === request.submitted
      ) {
        record.viewCandidate = Object.freeze({
          requestId: request.id,
          binding: request.binding,
          submitted: request.submitted,
          version: outcome.version,
        })
        record.resumeEditPending = false
      }
    } else record.lastSaveOutcome = outcome.kind
    this.emit()
    return true
  }

  commitSaveView(requestId: number, binding: MarkdownDraftBinding): boolean {
    const record = this.getRecord(binding)
    const candidate = record?.viewCandidate
    if (
      !record ||
      !candidate ||
      candidate.requestId !== requestId ||
      candidate.binding.gfsUri !== record.binding.gfsUri ||
      record.pendingSave ||
      record.draft !== candidate.submitted ||
      !this.isCurrentScope(record) ||
      this.blockedByBarrier() ||
      !record.readReady ||
      record.readPending ||
      record.savedSnapshot === null ||
      record.savedSnapshot.version < record.observedVersion
    )
      return false
    record.viewCandidate = null
    record.editing = false
    this.emit()
    return true
  }

  observeVersion(binding: MarkdownDraftBinding, version: number): boolean {
    const record = this.getRecord(binding)
    if (!record || !Number.isSafeInteger(version) || version < 0) return false
    record.observedVersion = Math.max(record.observedVersion, version)
    record.remoteAhead =
      record.lastWriteAck !== null && record.observedVersion > record.lastWriteAck.version
    if (record.viewCandidate && version > record.viewCandidate.version) record.viewCandidate = null
    this.emit()
    return true
  }

  discard(binding: MarkdownDraftBinding): boolean {
    const record = this.getRecord(binding)
    if (!record || record.pendingSave || record.closeReserved || !record.savedSnapshot) return false
    record.draft = record.savedSnapshot.content
    record.localBaseline = record.savedSnapshot.content
    record.sizeExceeded = byteLength(record.draft) > MARKDOWN_DRAFT_MAX_BYTES
    record.editing = false
    record.resumeEditPending = false
    record.viewCandidate = null
    record.closePrompt = false
    this.emit()
    return true
  }

  requestClose(tabId: string): MarkdownCloseResult {
    // Session retirement owns the neutral surface. Do not layer a dirty-draft
    // confirmation into logout or a main-initiated auth clear.
    if (this.authTransition) return 'blocked'
    const records = this.recordsForTab(tabId, this.activePrincipalOwner ?? undefined)
    if (records.length === 0) return 'missing'
    if (records.some(record => record.pendingSave || record.closeReserved)) return 'blocked'
    if (records.some(record => this.isDirty(record))) {
      for (const record of records) record.closePrompt = true
      this.emit()
      return 'confirm'
    }
    for (const record of records) {
      record.closeReserved = true
      record.closeAuthorizationPending = true
    }
    this.emit()
    return 'reserved'
  }

  resolveClose(tabId: string, choice: 'stay' | 'discard'): boolean {
    const records = this.recordsForTab(tabId, this.activePrincipalOwner ?? undefined)
    if (!records.length || !records.some(record => record.closePrompt)) return false
    if (records.some(record => record.pendingSave)) return false
    if (choice === 'stay') {
      for (const record of records) record.closePrompt = false
      this.emit()
      return true
    }
    for (const record of records) {
      record.closePrompt = false
      record.closeReserved = true
      record.closeAuthorizationPending = true
    }
    this.emit()
    return true
  }

  promoteCloseReservation(tabId: string, permitId: string): boolean {
    const records = this.recordsForTab(tabId, this.activePrincipalOwner ?? undefined)
    if (
      !permitId ||
      !records.length ||
      records.some(
        record => !record.closeReserved || !record.closeAuthorizationPending || record.pendingSave
      )
    )
      return false
    for (const record of records) {
      record.closeAuthorizationPending = false
      record.closePermitId = permitId
    }
    this.emit()
    return true
  }

  releaseCloseReservation(tabId: string): boolean {
    const records = this.recordsForTab(tabId, this.activePrincipalOwner ?? undefined)
    const provisional = records.filter(record => record.closeAuthorizationPending)
    if (!provisional.length) return false
    for (const record of provisional) {
      record.closePrompt = false
      record.closeReserved = false
      record.closeAuthorizationPending = false
      record.closePermitId = null
    }
    this.emit()
    return true
  }

  commitClose(tabId: string): boolean {
    const records = this.recordsForTab(tabId, this.activePrincipalOwner ?? undefined)
    if (
      !records.length ||
      !records.some(record => record.closeReserved) ||
      records.some(record => record.pendingSave || record.closeAuthorizationPending) ||
      records.some(record => !record.closePermitId) ||
      new Set(records.map(record => record.closePermitId)).size !== 1
    )
      return false
    for (const record of records) this.records.delete(record.key)
    this.emit()
    return true
  }

  setActiveScope(principalOwner: string, scopeKey: string, sessionGeneration: number | null): void {
    if (this.terminated) return
    if (
      this.activePrincipalOwner === principalOwner &&
      this.activeScopeKey === scopeKey &&
      this.activeSessionGeneration === sessionGeneration
    )
      return
    const previousPrincipalOwner = this.activePrincipalOwner
    const principalChanged =
      previousPrincipalOwner !== null && previousPrincipalOwner !== principalOwner
    this.activePrincipalOwner = principalOwner
    this.activeScopeKey = scopeKey
    this.activeSessionGeneration = sessionGeneration
    this.scopeGeneration += 1
    for (const record of this.records.values()) {
      if (record.binding.principalOwner !== principalOwner) continue
      record.readReady = false
      record.readGeneration += 1
      record.readPending = false
      record.capabilityGeneration += 1
      record.capability = 'unknown'
      record.capabilityPending = false
      if (!this.isCurrentScope(record) && record.editing) {
        record.editing = false
        record.resumeEditPending = record.draft !== record.localBaseline
      }
      if (record.binding.scopeKey === scopeKey) {
        record.scopeGeneration = this.scopeGeneration
        if (sessionGeneration !== null) record.bindingSessionGeneration = sessionGeneration
      }
    }
    if (principalChanged && previousPrincipalOwner)
      this.retirePrincipalRecords(previousPrincipalOwner)
    this.emit()
  }

  beginScopeTransition(): Readonly<{ id: number; fromScope: string | null }> | null {
    if (this.terminated || this.scopeTransition || this.authTransition) return null
    const transition: ScopeTransition = {
      id: this.nextTransitionId++,
      fromScope: this.activeScopeKey ?? '',
      renderCommitted: false,
      mainSessionGeneration: this.activeSessionGeneration,
    }
    this.scopeTransition = transition
    this.emit()
    return Object.freeze({ id: transition.id, fromScope: this.activeScopeKey })
  }

  commitScopeTransitionRender(token: Readonly<{ id: number }>): boolean {
    const transition = this.scopeTransition
    if (!transition || transition.id !== token.id || transition.renderCommitted) return false
    transition.renderCommitted = true
    for (const record of this.records.values()) {
      if (record.binding.scopeKey !== transition.fromScope) continue
      if (record.editing) {
        record.editing = false
        record.resumeEditPending = record.draft !== record.localBaseline
      }
      record.readReady = false
      record.readPending = false
      record.readGeneration += 1
      record.capability = 'unknown'
      record.capabilityPending = false
      record.capabilityGeneration += 1
    }
    this.emit()
    return true
  }

  installMainSession(token: Readonly<{ id: number }>, generation: number): boolean {
    const transition = this.scopeTransition
    if (!transition || transition.id !== token.id || !transition.renderCommitted) return false
    transition.mainSessionGeneration = generation
    return true
  }

  publishScope(
    token: Readonly<{ id: number }>,
    principalOwner: string,
    scopeKey: string,
    sessionGeneration: number
  ): boolean {
    const transition = this.scopeTransition
    if (
      !transition ||
      transition.id !== token.id ||
      !transition.renderCommitted ||
      this.authTransition ||
      (transition.mainSessionGeneration !== null &&
        transition.mainSessionGeneration !== sessionGeneration)
    )
      return false
    const principalChanged =
      this.activePrincipalOwner !== null && this.activePrincipalOwner !== principalOwner
    this.activePrincipalOwner = principalOwner
    this.activeScopeKey = scopeKey
    this.activeSessionGeneration = sessionGeneration
    this.scopeGeneration += 1
    this.scopeTransition = null
    for (const record of this.records.values()) {
      if (record.binding.principalOwner !== principalOwner) continue
      record.readReady = false
      record.readPending = false
      record.readGeneration += 1
      record.capability = 'unknown'
      record.capabilityPending = record.binding.scopeKey === scopeKey
      record.capabilityGeneration += 1
      if (record.binding.scopeKey !== scopeKey && record.editing) {
        record.editing = false
        record.resumeEditPending = record.draft !== record.localBaseline
      }
      if (record.binding.scopeKey === scopeKey) {
        record.scopeGeneration = this.scopeGeneration
        record.bindingSessionGeneration = sessionGeneration
      }
    }
    if (principalChanged) this.retirePrincipalRecords(principalOwner)
    this.emit()
    return true
  }

  reconcileScopeUnchanged(
    token: Readonly<{ id: number }>,
    principalOwner: string,
    scopeKey: string,
    sessionGeneration: number
  ): boolean {
    const transition = this.scopeTransition
    if (
      !transition ||
      transition.id !== token.id ||
      principalOwner !== this.activePrincipalOwner ||
      scopeKey !== this.activeScopeKey ||
      sessionGeneration !== this.activeSessionGeneration ||
      (transition.mainSessionGeneration !== null &&
        transition.mainSessionGeneration !== sessionGeneration)
    )
      return false
    this.scopeTransition = null
    this.scopeGeneration += 1
    for (const record of this.records.values()) {
      if (record.binding.principalOwner !== principalOwner || record.binding.scopeKey !== scopeKey)
        continue
      record.scopeGeneration = this.scopeGeneration
      record.readReady = false
      record.readPending = false
      record.readGeneration += 1
      record.capability = 'unknown'
      record.capabilityPending = false
      record.capabilityGeneration += 1
      if (record.draft !== record.localBaseline) {
        record.editing = false
        record.resumeEditPending = true
      }
    }
    this.emit()
    return true
  }

  beginAuthBarrier(
    principalOwner: string,
    sessionGeneration: number | null,
    rendererInitiated = false
  ): Readonly<{ id: number }> | null {
    if (this.terminated || this.authTransition) return null
    if (rendererInitiated && this.blockedByBarrier()) return null
    const transition: AuthTransition = {
      id: this.nextTransitionId++,
      principalOwner,
      sessionGeneration,
      rendererInitiated,
      mainReserved: !rendererInitiated,
      neutralCommitted: false,
      acknowledged: false,
      forcedBlank: false,
    }
    this.authTransition = transition
    this.scopeTransition = null
    for (const record of this.records.values()) {
      record.closePrompt = false
      if (record.closeAuthorizationPending) {
        record.closeReserved = false
        record.closeAuthorizationPending = false
        record.closePermitId = null
      }
    }
    this.emit()
    return Object.freeze({ id: transition.id })
  }

  reserveAuthBarrierFromMain(token: Readonly<{ id: number }>): boolean {
    const transition = this.authTransition
    if (
      !transition ||
      transition.id !== token.id ||
      (transition.rendererInitiated && !transition.neutralCommitted)
    )
      return false
    transition.mainReserved = true
    return true
  }

  commitAuthNeutralSurface(token: Readonly<{ id: number }>): boolean {
    const transition = this.authTransition
    if (!transition || transition.id !== token.id || transition.neutralCommitted) return false
    transition.neutralCommitted = true
    this.emit()
    return true
  }

  acknowledgeAuthNeutralSurface(token: Readonly<{ id: number }>): boolean {
    const transition = this.authTransition
    if (
      !transition ||
      transition.id !== token.id ||
      !transition.mainReserved ||
      !transition.neutralCommitted
    )
      return false
    transition.acknowledged = true
    return true
  }

  forceBlankForAuthBarrier(token: Readonly<{ id: number }>): boolean {
    const transition = this.authTransition
    if (!transition || transition.id !== token.id || transition.acknowledged) return false
    transition.neutralCommitted = true
    transition.forcedBlank = true
    this.emit()
    return true
  }

  retirePrincipalAfterAuthBarrier(token: Readonly<{ id: number }>): boolean {
    const transition = this.authTransition
    if (
      !transition ||
      transition.id !== token.id ||
      !transition.mainReserved ||
      !transition.neutralCommitted ||
      (!transition.acknowledged && !transition.forcedBlank)
    )
      return false
    this.retirePrincipalRecords(transition.principalOwner)
    if (this.activePrincipalOwner === transition.principalOwner) {
      this.activePrincipalOwner = null
      this.activeScopeKey = null
      this.activeSessionGeneration = null
    }
    this.authTransition = null
    this.emit()
    return true
  }

  restoreAfterAuthBarrier(token: Readonly<{ id: number }>, sessionGeneration: number): boolean {
    const transition = this.authTransition
    if (
      !transition ||
      transition.id !== token.id ||
      transition.forcedBlank ||
      transition.sessionGeneration !== sessionGeneration ||
      this.activeSessionGeneration !== sessionGeneration ||
      this.activePrincipalOwner !== transition.principalOwner
    )
      return false
    this.authTransition = null
    this.scopeGeneration += 1
    for (const record of this.records.values()) {
      if (record.binding.principalOwner !== transition.principalOwner) continue
      record.readReady = false
      record.readPending = false
      record.readGeneration += 1
      record.capability = 'unknown'
      record.capabilityPending = false
      record.capabilityGeneration += 1
      if (record.binding.scopeKey === this.activeScopeKey) {
        record.scopeGeneration = this.scopeGeneration
        if (record.draft !== record.localBaseline) {
          record.editing = false
          record.resumeEditPending = true
        }
      }
    }
    this.emit()
    return true
  }

  quit(): void {
    if (this.terminated) return
    this.terminated = true
    this.records.clear()
    this.scopeTransition = null
    this.authTransition = null
    this.emit()
  }

  private retirePrincipalRecords(principalOwner: string): void {
    for (const [key, record] of this.records) {
      if (record.binding.principalOwner === principalOwner) this.records.delete(key)
    }
  }

  private snapshotRecord(record: RecordState): MarkdownDraftRecordSnapshot {
    return Object.freeze({
      binding: record.binding,
      ownerId: record.ownerId,
      scopeGeneration: record.scopeGeneration,
      bindingSessionGeneration: record.bindingSessionGeneration,
      savedSnapshot: record.savedSnapshot,
      lastWriteAck: record.lastWriteAck,
      lastSaveOutcome: record.lastSaveOutcome,
      draft: record.draft,
      localBaseline: record.localBaseline,
      observedVersion: record.observedVersion,
      remoteAhead: record.remoteAhead,
      dirty: record.localBaseline !== null && record.draft !== record.localBaseline,
      sizeExceeded: record.sizeExceeded,
      editing: record.editing,
      resumeEditPending: record.resumeEditPending,
      readReady: record.readReady,
      readPending: record.readPending,
      capability: record.capability,
      capabilityPending: record.capabilityPending,
      pendingSave: record.pendingSave,
      viewCandidate: record.viewCandidate,
      closePrompt: record.closePrompt,
      closeReserved: record.closeReserved,
      closeAuthorizationPending: record.closeAuthorizationPending,
      closePermitId: record.closePermitId,
    })
  }
}
