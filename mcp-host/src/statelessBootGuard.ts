/**
 * D3 (stateless-agents) §1.3 — fail-loud boot guard for the stateless
 * lifecycle. When `CLERUM_STATELESS_LIFECYCLE=true` the session database IS
 * the agent's memory across pod restarts, so a misconfiguration that would
 * silently degrade durability (missing PVC-backed db dir, unrecognized
 * session store value, /tmp fallback) must abort boot instead.
 *
 * Pure functions — `main.ts` feeds them from `config` and exits non-zero on
 * `StatelessBootError`; unit tests drive them directly.
 */
import * as path from 'node:path'

export class StatelessBootError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StatelessBootError'
  }
}

export interface StatelessBootInputs {
  /** `CLERUM_STATELESS_LIFECYCLE` — the guard is a no-op when false. */
  statelessLifecycle: boolean
  /** Raw (lowercased) `CLERUM_SESSION_STORE` value, before fallback. */
  sessionStoreModeRaw: string
  /** `CLERUM_SESSION_DB_DIR` — PVC-backed directory for state.db. */
  sessionDbDir: string
  /** `CLERUM_SESSION_DB_PATH` — explicit state.db file path (legacy knob). */
  sessionDbPath: string
  /** Whether workspace memory is enabled (Host spec or config). */
  workspaceMemoryEnabled: boolean
  /** Workspace path used to derive `${workspacePath}/state.db`. */
  workspacePath: string
}

const RECOGNIZED_SESSION_STORES = new Set(['memory', 'sqlite', 'dual'])

/**
 * Abort boot (throws `StatelessBootError`) when the stateless lifecycle is
 * enabled but the configuration cannot guarantee durable session state:
 *
 *  (a) no PVC-backed session db path resolves — neither `CLERUM_SESSION_DB_DIR`
 *      nor `CLERUM_SESSION_DB_PATH` nor a workspace-based path is available,
 *      so the resolver would fall back to /tmp (total loss on restart);
 *  (b) `CLERUM_SESSION_STORE` carries an unrecognized value — the legacy
 *      parser silently falls back to 'memory', which would convert
 *      guaranteed-durable into total loss.
 *
 * No-op when `statelessLifecycle` is false (legacy behavior unchanged).
 */
export function assertStatelessBootConfig(inputs: StatelessBootInputs): void {
  if (!inputs.statelessLifecycle) return

  if (!RECOGNIZED_SESSION_STORES.has(inputs.sessionStoreModeRaw)) {
    throw new StatelessBootError(
      `CLERUM_STATELESS_LIFECYCLE=true but CLERUM_SESSION_STORE='${inputs.sessionStoreModeRaw}' ` +
        `is not recognized (expected 'memory' | 'sqlite' | 'dual'). The legacy silent fallback ` +
        `to 'memory' would lose every session on pod suspend — refusing to start.`
    )
  }

  const hasDbDir = inputs.sessionDbDir.trim().length > 0
  const hasExplicitPath = inputs.sessionDbPath.trim().length > 0
  const hasWorkspacePath = inputs.workspaceMemoryEnabled && inputs.workspacePath.trim().length > 0
  if (!hasDbDir && !hasExplicitPath && !hasWorkspacePath) {
    throw new StatelessBootError(
      `CLERUM_STATELESS_LIFECYCLE=true but no PVC-backed session db path resolves: ` +
        `CLERUM_SESSION_DB_DIR is unset, CLERUM_SESSION_DB_PATH is unset, and no workspace ` +
        `path is available (workspace memory disabled or empty path). The /tmp fallback is ` +
        `forbidden in stateless mode — refusing to start.`
    )
  }
}

export interface SessionDbPathInputs {
  statelessLifecycle: boolean
  sessionDbDir: string
  sessionDbPath: string
  workspaceMemoryEnabled: boolean
  workspacePath: string
  /** The ephemeral fallback for legacy (non-stateless) dev/test boots. */
  tmpFallbackPath: string
}

/**
 * Resolve the absolute path where `state.db` lives.
 *
 * Precedence (D3 §1.2): `CLERUM_SESSION_DB_DIR` (PVC mount injected by HCC)
 * → `CLERUM_SESSION_DB_PATH` (explicit legacy knob) → `${workspacePath}/state.db`
 * (workspace PVC) → tmp fallback, which is FORBIDDEN under the stateless
 * lifecycle (throws `StatelessBootError` instead — never /tmp).
 */
export function resolveSessionDbPathFrom(inputs: SessionDbPathInputs): string {
  if (inputs.sessionDbDir.trim().length > 0) {
    return path.join(inputs.sessionDbDir, 'state.db')
  }
  if (inputs.sessionDbPath.trim().length > 0) {
    return inputs.sessionDbPath
  }
  if (inputs.workspaceMemoryEnabled && inputs.workspacePath.trim().length > 0) {
    return path.join(inputs.workspacePath, 'state.db')
  }
  if (inputs.statelessLifecycle) {
    throw new StatelessBootError(
      `stateless lifecycle: no PVC-backed session db path resolves and the /tmp fallback is ` +
        `forbidden — set CLERUM_SESSION_DB_DIR (or CLERUM_SESSION_DB_PATH / workspace memory).`
    )
  }
  return inputs.tmpFallbackPath
}
