import fs from 'node:fs/promises'
import {
  loadPersistedWorkflowControlToken,
  persistRuntimeAuthTokens,
} from '../../workflow/mcpHostJwtState'
import { createMcpHostRuntimeAuthFromValues } from '../../workflow/runtimeAuthFactory'
import { refreshWithRecovery } from '../../workflow/userApprovalRequester'
import type { EnvGetter } from './workflowShared'

export type WorkflowControlTokenProvider = {
  getWorkflowControlToken(): Promise<string>
  refreshWorkflowControlToken?(): Promise<string>
}

export class WorkflowTokenConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowTokenConfigurationError'
  }
}

export function createWorkflowControlTokenProvider(
  getEnv: EnvGetter
): WorkflowControlTokenProvider {
  async function readFallbackWorkflowControlToken(): Promise<string> {
    const tokenFile = getEnv('MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE')?.trim()
    if (tokenFile) {
      let raw: string
      try {
        raw = await fs.readFile(tokenFile, 'utf8')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new WorkflowTokenConfigurationError(
          `MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE is unreadable: ${message}`
        )
      }
      const token = raw.trim()
      if (!token) {
        throw new WorkflowTokenConfigurationError('MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE is empty')
      }
      return token
    }

    const envToken = getEnv('MCP_HOST_WORKFLOW_CONTROL_TOKEN')?.trim()
    if (!envToken) {
      throw new WorkflowTokenConfigurationError(
        'MCP_HOST_WORKFLOW_CONTROL_TOKEN_FILE is required for workflow broker tools'
      )
    }
    return envToken
  }

  return {
    async getWorkflowControlToken(): Promise<string> {
      return loadPersistedWorkflowControlToken(await readFallbackWorkflowControlToken())
    },

    async refreshWorkflowControlToken(): Promise<string> {
      const accessToken = getEnv('MCP_HOST_RUNTIME_ACCESS_TOKEN')?.trim()
      const refreshToken = getEnv('MCP_HOST_RUNTIME_REFRESH_TOKEN')?.trim()
      const baseUrl = getEnv('MCP_HOST_GATEWAY_URL')?.trim()
      if (!accessToken || !refreshToken || !baseUrl) {
        throw new WorkflowTokenConfigurationError(
          'MCP_HOST_RUNTIME_ACCESS_TOKEN, MCP_HOST_RUNTIME_REFRESH_TOKEN, and MCP_HOST_GATEWAY_URL are required to refresh workflow broker credentials'
        )
      }

      const fallbackControlToken = await readFallbackWorkflowControlToken()
      const auth = createMcpHostRuntimeAuthFromValues({
        accessToken,
        refreshToken,
        baseUrl,
        mcpHostControlToken: fallbackControlToken,
      })
      await refreshWithRecovery(auth)
      if (!auth.mcpHostControlToken) {
        throw new WorkflowTokenConfigurationError(
          'Workflow auth refresh did not return mcpHostControlToken'
        )
      }
      await persistRuntimeAuthTokens({
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        mcpHostControlToken: auth.mcpHostControlToken,
      })
      return auth.mcpHostControlToken
    },
  }
}
