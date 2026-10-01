import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  assertUuid,
  compareBinding,
  exists,
  privateDirectory,
  safePath,
  syncDirectory,
  validateBinding,
} from '../db/canonicalStore/paths'
import type { Binding } from '../db/canonicalStore/types'

export interface ConversationStoreMaintenanceStatus extends Binding {
  maintenanceId: string
  phase: 'quiescing' | 'fenced' | 'migrating' | 'completing' | 'completed' | 'released' | 'failed'
  startedAt?: string
  updatedAt?: string
}
export interface MaintenanceHostView {
  uid?: string
  status?: { conversationStore?: { maintenance?: ConversationStoreMaintenanceStatus } }
}
export interface QuiescedStore {
  mode: 'sqlite' | 'dual'
  dbPath: string
}
export interface RuntimeProcessIdentity {
  pid: number
  uid: number
  startTimeTicks: string
  executable: string
  script: string
}
export interface PreparedCanonicalRuntime {
  activate(): void
  discard(): Promise<void>
}
export interface CanonicalMaintenanceOptions {
  binding: Binding
  podUid: string
  stateDir: string
  quiesce: () => Promise<QuiescedStore>
  resume: () => Promise<PreparedCanonicalRuntime>
  onError?: (error: unknown) => void
  /** Unit-test adapter; production records the real Linux process identity. */
  processIdentity?: () => RuntimeProcessIdentity
}
export function linuxRuntimeProcessIdentity(): RuntimeProcessIdentity {
  const stat = fs.readFileSync('/proc/self/stat', 'utf8')
  const fields = stat
    .slice(stat.lastIndexOf(') ') + 2)
    .trim()
    .split(/\s+/)
  const startTimeTicks = fields[19]
  if (!/^\d+$/.test(startTimeTicks ?? '') || !process.getuid || !process.argv[1]) {
    throw new Error('CanonicalMaintenanceProcessIdentityUnavailable')
  }
  return {
    pid: process.pid,
    uid: process.getuid(),
    startTimeTicks,
    executable: fs.realpathSync(process.execPath),
    script: fs.realpathSync(path.resolve(process.argv[1])),
  }
}

/** Controller status is the authority. The local report only records physical quiescence. */
export class CanonicalStoreMaintenance {
  private fenced = false
  private maintenanceId: string | undefined
  private operation: Promise<void> | undefined
  private quiesced = false
  private observedKey: string | undefined
  private observedEpoch = 0
  private latestMaintenance: ConversationStoreMaintenanceStatus | undefined
  private invalidBinding = false
  constructor(private readonly options: CanonicalMaintenanceOptions) {
    validateBinding(options.binding)
    assertUuid(options.podUid)
    if (!path.isAbsolute(options.stateDir)) throw new Error('CanonicalMaintenanceStateDirInvalid')
  }
  isFenced(): boolean {
    return this.fenced
  }
  latch(host: MaintenanceHostView): void {
    const maintenance = host.status?.conversationStore?.maintenance
    const key = maintenance
      ? JSON.stringify([
          host.uid,
          maintenance.hostUid,
          maintenance.pvcUid,
          maintenance.maintenanceId,
          maintenance.phase,
        ])
      : JSON.stringify(['missing', host.uid])
    if (key !== this.observedKey) {
      this.observedKey = key
      this.observedEpoch++
    }
    this.latestMaintenance = undefined
    if (!maintenance) return
    try {
      if (host.uid !== this.options.binding.hostUid)
        throw new Error('CanonicalMaintenanceHostReplaced')
      compareBinding(maintenance, this.options.binding)
      assertUuid(maintenance.maintenanceId)
      if (
        ![
          'quiescing',
          'fenced',
          'migrating',
          'completing',
          'completed',
          'released',
          'failed',
        ].includes(maintenance.phase)
      ) {
        throw new Error('CanonicalMaintenancePhaseInvalid')
      }
    } catch (error) {
      this.fenced = true
      this.invalidBinding = true
      throw error
    }
    this.latestMaintenance = { ...maintenance }
    if (maintenance.phase === 'released') return
    if (this.maintenanceId !== maintenance.maintenanceId) this.quiesced = false
    this.maintenanceId = maintenance.maintenanceId
    this.fenced = true
  }
  observe(host: MaintenanceHostView): Promise<void> {
    try {
      this.latch(host)
    } catch (error) {
      this.options.onError?.(error)
      return Promise.reject(error)
    }
    const maintenance = this.latestMaintenance
    if (!maintenance) return Promise.resolve() // Missing authority cancels a pending release without lifting its latch.
    if (this.invalidBinding) return Promise.reject(new Error('CanonicalMaintenanceBindingInvalid'))
    if (maintenance.phase === 'released') {
      if (!this.fenced) return Promise.resolve()
      if (!this.quiesced || this.maintenanceId !== maintenance.maintenanceId) {
        return Promise.reject(new Error('CanonicalMaintenanceReleaseBeforeQuiescence'))
      }
      if (this.operation) return this.operation
      const epoch = this.observedEpoch
      const releasedId = maintenance.maintenanceId
      const operation = this.options
        .resume()
        .then(async prepared => {
          if (
            !prepared ||
            typeof prepared.activate !== 'function' ||
            typeof prepared.discard !== 'function'
          ) {
            throw new Error('CanonicalMaintenanceResumeProtocolInvalid')
          }
          const currentRelease = () =>
            this.observedEpoch === epoch &&
            !this.invalidBinding &&
            this.latestMaintenance?.phase === 'released' &&
            this.latestMaintenance.maintenanceId === releasedId &&
            this.maintenanceId === releasedId &&
            this.quiesced
          if (!currentRelease()) {
            await this.discardStaleRuntime(prepared)
            return
          }
          try {
            // Producer admission stays fenced through the synchronous commit.
            prepared.activate()
          } catch (error) {
            this.fenced = true
            await prepared.discard()
            throw error
          }
          if (!currentRelease()) {
            await this.discardStaleRuntime(prepared)
            return
          }
          this.fenced = false
          this.maintenanceId = undefined
          this.quiesced = false
        })
        .catch(error => {
          this.options.onError?.(error)
          throw error
        })
        .finally(() => {
          if (this.operation === operation) this.operation = undefined
        })
      this.operation = operation
      return operation
    }
    if (this.quiesced) return Promise.resolve()
    if (this.operation) return this.operation
    const operation = this.options
      .quiesce()
      .then(store => {
        const current = this.latestMaintenance
        if (!current || this.invalidBinding || this.maintenanceId !== current.maintenanceId) return
        this.writeReport(current.maintenanceId, store)
        this.quiesced = true
      })
      .catch(error => {
        this.options.onError?.(error)
        throw error
      })
      .finally(() => {
        if (this.operation === operation) this.operation = undefined
      })
    this.operation = operation
    return operation
  }
  private async discardStaleRuntime(prepared: PreparedCanonicalRuntime): Promise<void> {
    await prepared.discard()
    const current = this.latestMaintenance
    if (!current || this.invalidBinding || current.phase === 'released') return
    // The latest episode may have arrived while resume was preparing. Close
    // against that episode now instead of requiring another watch event.
    this.quiesced = false
    const store = await this.options.quiesce()
    const latest = this.latestMaintenance
    if (!latest || this.invalidBinding || this.maintenanceId !== latest.maintenanceId) return
    this.writeReport(latest.maintenanceId, store)
    this.quiesced = true
  }
  private writeReport(maintenanceId: string, store: QuiescedStore): void {
    if (!path.isAbsolute(store.dbPath) || !['sqlite', 'dual'].includes(store.mode)) {
      throw new Error('CanonicalMaintenanceSourceUnknown')
    }
    const processIdentity = (this.options.processIdentity ?? linuxRuntimeProcessIdentity)()
    const state = fs.realpathSync(this.options.stateDir)
    if (state !== this.options.stateDir) throw new Error('CanonicalMaintenanceStateDirInvalid')
    const directory = path.join(state, '.canonical-store', 'maintenance', maintenanceId)
    privateDirectory(state, directory)
    const file = path.join(directory, `${this.options.podUid}.json`)
    safePath(state, file, true)
    const report = {
      schemaVersion: 1,
      contractVersion: 1,
      ...this.options.binding,
      maintenanceId,
      podUid: this.options.podUid,
      process: processIdentity,
      source: store,
      closure: 'acknowledged-worker-exit',
      observedAt: new Date().toISOString(),
    }
    if (exists(file)) {
      const existing = JSON.parse(fs.readFileSync(safePath(state, file), 'utf8')) as typeof report
      if (
        JSON.stringify({ ...existing, observedAt: undefined }) !==
        JSON.stringify({ ...report, observedAt: undefined })
      ) {
        throw new Error('CanonicalMaintenanceReportCollision')
      }
      return
    }
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    )
    try {
      fs.writeFileSync(fd, `${JSON.stringify(report)}\n`)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    syncDirectory(state, directory)
  }
}
