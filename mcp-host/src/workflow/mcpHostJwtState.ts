import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  type RuntimeJwtBinding,
  getJwtExpiry,
  getJwtIssuedAt,
  getJwtRuntimeBinding,
} from './mcpHostRuntimeJwt'
import type { McpHostRuntimeAuth } from './userApprovalRequester'

export const INTERNAL_WORKFLOW_STATE_DIR = '.clerum-state'
const MCP_HOST_JWT_STATE_FILE = 'approval-auth.json'
const DEFAULT_WORKFLOW_AUTH_STATE_DIR = '/var/run/clerum/workflow-auth'

type PersistedMcpHostJwtState = {
  accessToken: string
  refreshToken: string
  mcpHostControlToken?: string
}

export function isInternalWorkflowArtifactName(name: string): boolean {
  return name === INTERNAL_WORKFLOW_STATE_DIR
}

export function getMcpHostJwtStateDir(): string {
  return (
    process.env.MCP_HOST_RUNTIME_AUTH_STATE_DIR?.trim() ||
    process.env.CLERUM_WORKFLOW_AUTH_STATE_DIR?.trim() ||
    DEFAULT_WORKFLOW_AUTH_STATE_DIR
  )
}

export function getMcpHostJwtStateFilePath(stateDir = getMcpHostJwtStateDir()): string {
  return path.join(stateDir, MCP_HOST_JWT_STATE_FILE)
}

function sameRuntimeBinding(left: RuntimeJwtBinding, right: RuntimeJwtBinding): boolean {
  return (
    left.hostRef === right.hostRef &&
    left.recipeNamespace === right.recipeNamespace &&
    left.recipeName === right.recipeName
  )
}

// Persisted tokens are a restart optimization after an in-pod token rotation.
// They must never override the pod identity minted into the mounted Secret. A
// minikube/profile sync can rotate the Secret/signing key while leaving the
// runtime state file on disk; in that case the mounted token pair is newer and
// is the only safe source of truth for the pod's current identity.
function shouldPreferPersistedTokens(
  fallback: Pick<McpHostRuntimeAuth, 'accessToken' | 'refreshToken'>,
  persisted: Pick<PersistedMcpHostJwtState, 'accessToken' | 'refreshToken'>
): boolean {
  const fallbackAccessExpiry = getJwtExpiry(fallback.accessToken)
  const persistedAccessExpiry = getJwtExpiry(persisted.accessToken)
  const fallbackRefreshExpiry = getJwtExpiry(fallback.refreshToken)
  const persistedRefreshExpiry = getJwtExpiry(persisted.refreshToken)
  const fallbackAccessIssuedAt = getJwtIssuedAt(fallback.accessToken)
  const persistedAccessIssuedAt = getJwtIssuedAt(persisted.accessToken)
  const fallbackRefreshIssuedAt = getJwtIssuedAt(fallback.refreshToken)
  const persistedRefreshIssuedAt = getJwtIssuedAt(persisted.refreshToken)

  // If the persisted refresh token is already expired, it has no recovery
  // value — fall back to the K8s Secret-mounted tokens even when the env
  // token is malformed. Prevents a corrupted persisted file from stranding
  // the pod on an unusable token until manual restart.
  const nowSecs = Math.floor(Date.now() / 1000)
  if (persistedRefreshExpiry !== null && persistedRefreshExpiry <= nowSecs) {
    return false
  }

  if (
    fallbackAccessIssuedAt !== null &&
    persistedAccessIssuedAt !== null &&
    fallbackAccessIssuedAt > persistedAccessIssuedAt
  ) {
    return false
  }

  if (
    fallbackRefreshIssuedAt !== null &&
    persistedRefreshIssuedAt !== null &&
    fallbackRefreshIssuedAt > persistedRefreshIssuedAt
  ) {
    return false
  }

  if (persistedAccessExpiry !== null) {
    if (fallbackAccessExpiry === null) {
      return true
    }
    if (persistedAccessExpiry !== fallbackAccessExpiry) {
      return persistedAccessExpiry > fallbackAccessExpiry
    }
  }

  if (persistedRefreshExpiry !== null) {
    if (fallbackRefreshExpiry === null) {
      return true
    }
    return persistedRefreshExpiry > fallbackRefreshExpiry
  }

  return false
}

/**
 * Best-effort sweep of orphaned `.tmp-*` writer files in the state directory.
 *
 * The atomic write in {@link persistRuntimeAuthTokens} uses `writeFile` +
 * `rename` with a per-call temp path. If the process is killed between those
 * two steps (SIGKILL, OOM) the `finally` cleanup never runs and a stale
 * `.tmp-<pid>-<ts>` file stays on disk indefinitely.
 *
 * We sweep at load time (invoked once per workflow startup). Only files older
 * than `STALE_TEMP_THRESHOLD_MS` are removed so a concurrent in-flight write
 * from another process cannot be clobbered.
 */
const STALE_TEMP_THRESHOLD_MS = 5 * 60 * 1000
function sweepOrphanedTempFiles(stateDir: string): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(stateDir)
  } catch {
    return
  }
  const cutoff = Date.now() - STALE_TEMP_THRESHOLD_MS
  const tempPrefix = `${MCP_HOST_JWT_STATE_FILE}.tmp-`
  for (const name of entries) {
    // Only sweep OUR atomic-write temp files. `.includes(".tmp-")` would
    // also match unrelated dotfiles a future caller drops in this dir.
    if (!name.startsWith(tempPrefix)) continue
    const entryPath = path.join(stateDir, name)
    try {
      const stat = fs.statSync(entryPath)
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        fs.rmSync(entryPath, { force: true })
      }
    } catch {
      // Ignore — race with concurrent rename or permission error.
    }
  }
}

export function loadPersistedRuntimeAuth(
  fallback: McpHostRuntimeAuth,
  stateDir = getMcpHostJwtStateDir()
): McpHostRuntimeAuth {
  const filePath = getMcpHostJwtStateFilePath(stateDir)
  sweepOrphanedTempFiles(stateDir)
  if (!fs.existsSync(filePath)) {
    return fallback
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PersistedMcpHostJwtState>
    if (typeof parsed.accessToken !== 'string' || typeof parsed.refreshToken !== 'string') {
      return fallback
    }

    const persistedTokens: PersistedMcpHostJwtState = {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
    }

    const persistedBinding = getJwtRuntimeBinding(persistedTokens.accessToken)
    if (!persistedBinding) {
      return fallback
    }

    const fallbackBinding = getJwtRuntimeBinding(fallback.accessToken)
    if (fallbackBinding && !sameRuntimeBinding(fallbackBinding, persistedBinding)) {
      return fallback
    }

    if (!shouldPreferPersistedTokens(fallback, persistedTokens)) {
      return fallback
    }

    return {
      ...fallback,
      accessToken: persistedTokens.accessToken,
      refreshToken: persistedTokens.refreshToken,
      ...(typeof parsed.mcpHostControlToken === 'string' && parsed.mcpHostControlToken.trim()
        ? { mcpHostControlToken: parsed.mcpHostControlToken.trim() }
        : {}),
      ...persistedBinding,
    }
  } catch (err) {
    console.warn(
      '[WorkflowService] Failed to read persisted mcp-host JWT state:',
      err instanceof Error ? err.message : String(err)
    )
    return fallback
  }
}

export function refreshRuntimeAuthFromPersistedState(
  auth: McpHostRuntimeAuth,
  stateDir = getMcpHostJwtStateDir()
): boolean {
  const next = loadPersistedRuntimeAuth(auth, stateDir)
  if (
    next.accessToken === auth.accessToken &&
    next.refreshToken === auth.refreshToken &&
    next.mcpHostControlToken === auth.mcpHostControlToken &&
    next.hostRef === auth.hostRef &&
    next.recipeNamespace === auth.recipeNamespace &&
    next.recipeName === auth.recipeName
  ) {
    return false
  }

  auth.accessToken = next.accessToken
  auth.refreshToken = next.refreshToken
  auth.hostRef = next.hostRef
  auth.recipeNamespace = next.recipeNamespace
  auth.recipeName = next.recipeName
  if (next.mcpHostControlToken) {
    auth.mcpHostControlToken = next.mcpHostControlToken
  }
  return true
}

export function loadPersistedWorkflowControlToken(
  fallbackToken: string,
  stateDir = getMcpHostJwtStateDir()
): string {
  const fallback = fallbackToken.trim()
  const filePath = getMcpHostJwtStateFilePath(stateDir)
  sweepOrphanedTempFiles(stateDir)
  if (!fs.existsSync(filePath)) return fallback

  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PersistedMcpHostJwtState>
    const persisted = parsed.mcpHostControlToken?.trim()
    if (!persisted) return fallback

    const persistedBinding = getJwtRuntimeBinding(persisted)
    if (!persistedBinding) return fallback

    const fallbackBinding = fallback ? getJwtRuntimeBinding(fallback) : null
    if (fallbackBinding && !sameRuntimeBinding(fallbackBinding, persistedBinding)) {
      return fallback
    }

    const nowSecs = Math.floor(Date.now() / 1000)
    const persistedExpiry = getJwtExpiry(persisted)
    if (persistedExpiry !== null && persistedExpiry <= nowSecs) return fallback

    const fallbackIssuedAt = fallback ? getJwtIssuedAt(fallback) : null
    const persistedIssuedAt = getJwtIssuedAt(persisted)
    if (
      fallbackIssuedAt !== null &&
      persistedIssuedAt !== null &&
      fallbackIssuedAt > persistedIssuedAt
    ) {
      return fallback
    }

    const fallbackExpiry = fallback ? getJwtExpiry(fallback) : null
    if (fallbackExpiry !== null && persistedExpiry !== null) {
      return persistedExpiry > fallbackExpiry ? persisted : fallback
    }

    return persisted
  } catch {
    return fallback
  }
}

export async function persistRuntimeAuthTokens(
  tokens: Pick<McpHostRuntimeAuth, 'accessToken' | 'refreshToken'> & {
    mcpHostControlToken?: string
  },
  stateDir = getMcpHostJwtStateDir()
): Promise<void> {
  const filePath = getMcpHostJwtStateFilePath(stateDir)
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`

  await fs.promises.mkdir(stateDir, { recursive: true })
  try {
    await fs.promises.writeFile(
      tempPath,
      JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        ...(tokens.mcpHostControlToken ? { mcpHostControlToken: tokens.mcpHostControlToken } : {}),
      }),
      { encoding: 'utf-8', mode: 0o600 }
    )
    await fs.promises.rename(tempPath, filePath)
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined)
  }
}
