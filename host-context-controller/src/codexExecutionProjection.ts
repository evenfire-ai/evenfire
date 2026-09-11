export {
  CODEX_EXECUTE_SCOPE,
  CODEX_PROVIDER,
  CODEX_UNASSIGNED_CONNECTION_KEY,
  assignedCodexConnectionKey as assignedHostCodexConnectionRef,
  collectCodexTargets,
  isCodexUnassignedConnectionKey as isCodexUnassignedConnectionRef,
  projectCodexExecution,
} from '@clerum/codex-catalog-projection'
export type {
  CodexCatalogSnapshot,
  CodexEligibility,
  CodexExecutionProjection,
  CodexHostSpec,
  CodexSnapshotError,
  CodexTarget,
  CodexTargetSource,
} from '@clerum/codex-catalog-projection'
