import * as fs from 'node:fs'
import { getJwtRuntimeBinding } from '../../workflow/mcpHostRuntimeJwt'
import { createMcpHostRuntimeAuthFromValues } from '../../workflow/runtimeAuthFactory'
import type { McpHostRuntimeAuth } from '../../workflow/userApprovalRequester'

export type EnvGetter = (key: string) => string | undefined

export const WORKFLOW_RECIPE_NAMESPACE = 'sandbox-recipes'

export type WorkflowCallerContext = {
  targetUserId?: string
  targetTeamId?: string
  conversationId?: string
  originChannelType?: 'rpc' | 'telegram' | 'slack' | 'teams'
  providerUserId?: string
  providerWorkspaceId?: string | null
  providerChannelId?: string
  providerEventId?: string
  sourceThreadId?: string
  sourceMessageId?: string
  sourceMessageContent?: string
}

export type WorkflowToolOptions = {
  getEnv?: EnvGetter
  workflowControlTokenProvider?: {
    getWorkflowControlToken(): Promise<string>
  }
  workflowCallerContext?: WorkflowCallerContext | null
}

export function defaultEnv(key: string): string | undefined {
  return process.env[key]
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function getString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  return typeof value === 'string' ? value.trim() : ''
}

export function getObject(
  params: Record<string, unknown>,
  key: string
): Record<string, unknown> | null {
  const value = params[key]
  return asRecord(value)
}

export function workflowTargetSchema(
  options: { exposeNamespace?: boolean; exposeTargetLabel?: boolean } = {}
): Record<string, unknown> {
  const exposeNamespace = options.exposeNamespace ?? true
  const properties: Record<string, unknown> = {
    name: {
      type: 'string',
      description: 'WorkflowRecipe name.',
    },
  }
  if (options.exposeTargetLabel) {
    properties.targetLabel = {
      type: 'string',
      description: 'Human target label returned by workflow_list, such as Personal or a team name.',
    }
  }
  if (exposeNamespace) {
    properties.namespace = {
      type: 'string',
      description: 'WorkflowRecipe namespace.',
    }
  }
  return {
    type: 'object',
    properties,
    required: exposeNamespace ? ['namespace', 'name'] : ['name'],
  }
}

export function requireWorkflowRef(
  params: Record<string, unknown>,
  defaultNamespace?: string
): {
  namespace: string
  name: string
} {
  const namespace = defaultNamespace ?? getString(params, 'namespace')
  const name =
    getString(params, 'name') ||
    getString(params, 'workflowName') ||
    getString(params, 'recipeName')
  if (!namespace || !name) {
    throw new Error(defaultNamespace ? 'name is required' : 'namespace and name are required')
  }
  return { namespace, name }
}

function workflowControlTokenFromEnvOrFile(getEnv: EnvGetter): string | undefined {
  const envToken = getEnv('MCP_HOST_WORKFLOW_CONTROL_TOKEN')?.trim()
  if (envToken) return envToken

  const tokenFile = getEnv('MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE')?.trim()
  if (!tokenFile) return undefined

  try {
    const fileToken = fs.readFileSync(tokenFile, 'utf8').trim()
    return fileToken || undefined
  } catch (error) {
    console.warn(
      '[WorkflowTools] Could not read MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE; continuing without a persisted workflow-control token.',
      error instanceof Error ? error.message : String(error)
    )
    // Approval requests can still fail closed through normal runtime auth checks.
    // This token is only preserved when rotated auth state is persisted after refresh.
    return undefined
  }
}

export function approvalAuth(getEnv: EnvGetter): McpHostRuntimeAuth {
  const accessToken = getEnv('MCP_HOST_RUNTIME_ACCESS_TOKEN')?.trim()
  const refreshToken = getEnv('MCP_HOST_RUNTIME_REFRESH_TOKEN')?.trim()
  const baseUrl = getEnv('MCP_HOST_GATEWAY_URL')?.trim()
  if (!accessToken || !refreshToken || !baseUrl) {
    throw new Error(
      'MCP_HOST_RUNTIME_ACCESS_TOKEN, MCP_HOST_RUNTIME_REFRESH_TOKEN, and MCP_HOST_GATEWAY_URL are required for workflow_trigger'
    )
  }

  const binding = getJwtRuntimeBinding(accessToken)
  if (!binding) {
    throw new Error(
      'MCP_HOST_RUNTIME_ACCESS_TOKEN must include hostRefs[0], recipeNamespace, and recipeName for workflow_trigger'
    )
  }

  const mcpHostControlToken = workflowControlTokenFromEnvOrFile(getEnv)
  return createMcpHostRuntimeAuthFromValues({
    accessToken,
    refreshToken,
    baseUrl: trimTrailingSlash(baseUrl),
    ...(mcpHostControlToken ? { mcpHostControlToken } : {}),
  })
}
