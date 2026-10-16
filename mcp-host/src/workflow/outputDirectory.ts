/** Where a workflow run writes its artifacts (/output); in chat, the former shared folder. */
import * as path from 'path'
import { config } from '../config'

// Accessor to the current Host CRD, injected by main (avoids a circular import).
// Re-read on every getOutputDir() call because `currentHost` is hydrated async
// after boot — caching the path at module load would freeze it to the fallback.
type WorkspaceHostAccessor = () =>
  | { spec?: { memory?: { workspacePath?: string } } }
  | null
  | undefined
let outputDirHostAccessor: WorkspaceHostAccessor | null = null

/** Wire the Host CRD accessor so chat-mode artifacts resolve to the workspace PVC. */
export function setOutputDirHostAccessor(accessor: WorkspaceHostAccessor): void {
  outputDirHostAccessor = accessor
}

// ─── Security helpers ────────────────────────────────────────────────
//
// Boundary primitives applied at the seam between LLM-supplied data
// and the generated artifact. They guard against XSS in HTML output,
// path traversal when reading user-named files, and formula injection
// in spreadsheet cells.

/**
 * Resolve `p` against `outputDir` and ensure the result stays inside
 * `outputDir`. Throws on traversal attempts (`../etc/passwd`, absolute
 * paths outside the dir, symlink-style escapes). Returns the absolute
 * resolved path.
 *
 * The caller decides whether the file must already exist; this helper
 * only enforces the path-containment invariant.
 */
export function validateOutputPath(p: string, outputDir: string): string {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('path must be a non-empty string')
  }
  const root = path.resolve(outputDir)
  const resolved = path.resolve(root, p)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path traversal blocked: ${p}`)
  }
  return resolved
}

/**
 * Resolve the directory for generated artifacts. Re-evaluated on every call.
 * Chat generation does not use it: each caller's files go to their own folder
 * (workspace/callerOutputs.ts), and in chat this only names the former shared
 * folder, counted once at startup.
 *
 * Resolution order:
 *   1. `CLERUM_OUTPUT_DIR` — explicit override (dev / tests / ad-hoc).
 *   2. Workflow mode (`CLERUM_WORKFLOW_ENABLED=true`) → `/output` (per-run PVC).
 *   3. Chat mode → `${workspacePath}/outputs`, where workspacePath comes from the
 *      Host CRD (via the injected accessor), else mirrors `config.memory.workspacePath`
 *      (`CLERUM_MEMORY_WORKSPACE_PATH`, dev-aware default). Reusing the durable
 *      workspace PVC (instead of the old `/tmp/clerum-output` emptyDir) is what
 *      keeps Download links working after a Host pod restart (D.2b).
 */
export function getOutputDir(): string {
  if (process.env.CLERUM_OUTPUT_DIR) return process.env.CLERUM_OUTPUT_DIR
  if (process.env.CLERUM_WORKFLOW_ENABLED === 'true') return '/output'
  // Mirror config.memory.workspacePath — the var that actually backs the
  // workspace PVC (where state.db / spillover also live), NOT CLERUM_WORKSPACE_PATH
  // (the native-tool sandbox root, config.ts:515). CRD accessor wins in prod; the
  // env/dev default only applies when running without a Host CRD.
  const workspacePath =
    outputDirHostAccessor?.()?.spec?.memory?.workspacePath ||
    process.env.CLERUM_MEMORY_WORKSPACE_PATH ||
    (config.devMode ? './workspace' : '/workspace')
  return path.join(workspacePath, 'outputs')
}
