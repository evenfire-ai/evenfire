/**
 * T1.5 — Tool-result spillover module.
 *
 * Public surface:
 *   - `SpilloverStorage`: write/load/sweep blobs on the workspace PVC.
 *   - `FsSpilloverResolver`: P.3 `SpilloverResolver` impl that swaps refs
 *     for blob bodies at resume, throws `ApprovalExpiredError` on miss.
 *   - `parseSpilloverRef`/`buildSpilloverRef`: URI helpers.
 *   - Prometheus instruments (re-exported from `storage.ts`).
 */
export {
  SpilloverStorage,
  clerumApprovalExpiredTotal,
  clerumSpilloverBytesTotal,
  clerumSpilloverGcBytesFreed,
  clerumSpilloverGcFilesDeleted,
  clerumSpilloverPersistedTotal,
  clerumSpilloverReadsTotal,
  clerumToolOutputBytes,
} from './storage'
export type { ResolveContext } from './fsResolver'
export { FsSpilloverResolver } from './fsResolver'
export type { ParsedSpilloverRef } from './refResolver'
export { buildSpilloverRef, parseSpilloverRef } from './refResolver'
export { generateStructureHint, inferContentType } from './structureHints'
export type {
  MaybePersistArgs,
  SpilloverBlob,
  SpilloverStorageOptions,
  SpilloverSummary,
  SweepResult,
} from './types'
