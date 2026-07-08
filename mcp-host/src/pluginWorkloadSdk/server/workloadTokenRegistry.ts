import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CALLER_KEY_PREFIX = 'caller-'
const CALLER_REF_RE = /^[a-zA-Z0-9_.-]{1,63}$/

function registerWorkloadToken(
  registry: Map<string, string>,
  token: string,
  callerRef: string
): void {
  const existingCaller = registry.get(token)
  if (existingCaller !== undefined && existingCaller !== callerRef) {
    console.error(
      `[PluginWorkloadSdk] duplicate workload bearer token for callers "${existingCaller}" and "${callerRef}"; keeping "${existingCaller}"`
    )
    return
  }
  registry.set(token, callerRef)
}

/**
 * Load token → callerRef bindings from the recipe Secret volume (one file per
 * allowed caller). Filenames must be `caller-<workloadId>`; file contents are
 * the raw bearer token workloads present on requests.
 */
export function loadWorkloadTokenRegistryFromDir(dir: string): Map<string, string> {
  const registry = new Map<string, string>()
  if (!dir.trim() || !existsSync(dir)) return registry

  for (const name of readdirSync(dir)) {
    if (!name.startsWith(CALLER_KEY_PREFIX)) continue
    const callerRef = name.slice(CALLER_KEY_PREFIX.length)
    if (!CALLER_REF_RE.test(callerRef)) continue
    const token = readFileSync(join(dir, name), 'utf8').trim()
    if (!token) continue
    registerWorkloadToken(registry, token, callerRef)
  }
  return registry
}

/** Dev / legacy single-token mode: bind one bearer token to exactly one caller. */
export function loadWorkloadTokenRegistryFromPair(
  token: string,
  callerRef: string
): Map<string, string> {
  const registry = new Map<string, string>()
  if (token.trim() && CALLER_REF_RE.test(callerRef)) {
    registerWorkloadToken(registry, token.trim(), callerRef)
  }
  return registry
}
