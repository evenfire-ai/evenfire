import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { McpHostTarget, ReaderConfig } from './config.js'
import type { ReaderDecisionCommand } from './decisionHandler.js'

const WORKFLOW_RECIPE_NAMESPACE = 'sandbox-recipes'
const WORKFLOW_RUNTIME_HOST_REF_RE = /^sandbox-recipes\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/
const WORKFLOW_RUNTIME_ALIAS_REF_RE = /^sandbox-recipes\/~([0-9a-f]{16})$/
const AGENT_HOST_REF_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

function assertWorkflowRuntimeTarget(target: McpHostTarget): McpHostTarget {
  const hostRef = target.hostRef.trim()
  const baseUrl = target.baseUrl.trim()
  if (!hostRef || !baseUrl) {
    throw new Error('WORKFLOW_APPROVAL_READER_MCP_HOST_TARGETS entries require hostRef and baseUrl')
  }
  if (!WORKFLOW_RUNTIME_HOST_REF_RE.test(hostRef)) {
    if (WORKFLOW_RUNTIME_ALIAS_REF_RE.test(hostRef)) return { hostRef, baseUrl }
    throw new Error(
      `workflow approval reader mcp-host target must be sandbox-recipes/<recipe>: ${hostRef}`
    )
  }
  return { hostRef, baseUrl }
}

export function parseMcpHostTargets(
  raw: string | undefined,
  fallback?: McpHostTarget
): McpHostTarget[] {
  const byHost = new Map<string, McpHostTarget>()
  if (fallback?.hostRef && fallback.baseUrl) {
    const target = assertWorkflowRuntimeTarget(fallback)
    byHost.set(target.hostRef, target)
  }

  for (const entry of (raw || '').split(';')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) {
      throw new Error(`invalid workflow approval reader mcp-host target: ${trimmed}`)
    }
    const hostRef = trimmed.slice(0, idx).trim()
    const baseUrl = trimmed.slice(idx + 1).trim()
    const target = assertWorkflowRuntimeTarget({ hostRef, baseUrl })
    byHost.set(target.hostRef, target)
  }

  return Array.from(byHost.values())
}

export function configuredMcpHostTargets(cfg: ReaderConfig): McpHostTarget[] {
  const file = cfg.mcpHostTargetsFile?.trim()
  if (!file) return cfg.mcpHostTargets
  try {
    const raw = readFileSync(file, 'utf8')
    return parseMcpHostTargets(raw)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return cfg.mcpHostTargets
    throw err
  }
}

function workflowMcpHostServiceName(recipeName: string): string {
  const prefix = 'wf-'
  const suffix = '-mcp-host'
  const safeRecipeName =
    recipeName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'workflow'
  const direct = `${prefix}${safeRecipeName}${suffix}`
  if (direct.length <= 63) return direct

  const hash = createHash('sha256').update(recipeName).digest('hex').slice(0, 8)
  const reservedLen = prefix.length + suffix.length + hash.length + 1
  const maxStemLen = Math.max(1, 63 - reservedLen)
  const stem =
    safeRecipeName.slice(0, maxStemLen).replace(/-+$/g, '') ||
    safeRecipeName.slice(0, maxStemLen)

  return `${prefix}${stem}-${hash}${suffix}`
}

function workflowTargetFromHostRef(hostRef: string): McpHostTarget | null {
  const alias = hostRef.match(WORKFLOW_RUNTIME_ALIAS_REF_RE)
  if (alias) {
    return {
      hostRef,
      baseUrl: `http://wf-${alias[1]}-mcp-host.${WORKFLOW_RECIPE_NAMESPACE}.svc.cluster.local:8080`,
    }
  }

  const [namespace, recipeName, ...rest] = hostRef.split('/')
  if (rest.length > 0 || !namespace || !recipeName) return null
  if (namespace !== WORKFLOW_RECIPE_NAMESPACE) return null
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace)) return null
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(recipeName)) return null
  return {
    hostRef,
    baseUrl: `http://${workflowMcpHostServiceName(recipeName)}.${namespace}.svc.cluster.local:8080`,
  }
}

function agentTargetFromHostRef(hostRef: string): McpHostTarget | null {
  if (!AGENT_HOST_REF_RE.test(hostRef)) return null
  return {
    hostRef,
    baseUrl: `http://${hostRef}.mcp-host.svc.cluster.local:8080`,
  }
}

export function targetForHostRef(cfg: ReaderConfig, hostRef: string): McpHostTarget | null {
  const normalized = hostRef.trim()
  if (!normalized) return null
  const configured = configuredMcpHostTargets(cfg).find(target => target.hostRef === normalized)
  if (configured) return configured
  if (normalized === cfg.mcpHostRef && workflowTargetFromHostRef(normalized)) {
    return { hostRef: cfg.mcpHostRef, baseUrl: cfg.mcpHostBaseUrl }
  }
  return workflowTargetFromHostRef(normalized) ?? agentTargetFromHostRef(normalized)
}

export function targetForProviderHostRef(
  cfg: ReaderConfig,
  hostRef: string
): McpHostTarget | null {
  const normalized = hostRef.trim()
  if (!normalized) return null
  const configured = configuredMcpHostTargets(cfg).find(target => target.hostRef === normalized)
  if (configured) return configured
  if (normalized === cfg.mcpHostRef && cfg.mcpHostBaseUrl) {
    return { hostRef: cfg.mcpHostRef, baseUrl: cfg.mcpHostBaseUrl }
  }
  return workflowTargetFromHostRef(normalized) ?? agentTargetFromHostRef(normalized)
}

export function targetsForDecision(
  cfg: ReaderConfig,
  approvalRequestId: string,
  command: ReaderDecisionCommand
): { targets: McpHostTarget[]; explicit: boolean } {
  if (!approvalRequestId.trim()) return { targets: [], explicit: false }
  const hostRef = command.mcpHostRef?.trim()
  if (hostRef) {
    // Provider callback route hints are not authorization. They are only a DNS
    // routing hint to a workflow runtime; the runtime mcp-host control token still
    // has to match control-api's approval caller binding.
    const target = targetForHostRef(cfg, hostRef)
    return { targets: target ? [target] : [], explicit: true }
  }

  return { targets: [], explicit: false }
}
