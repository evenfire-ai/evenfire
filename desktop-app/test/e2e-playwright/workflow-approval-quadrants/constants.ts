export const CONTROL_API = process.env.CONTROL_API_BASE_URL || 'http://127.0.0.1:8090'
export const READER_API = process.env.WORKFLOW_APPROVAL_READER_BASE_URL || 'http://127.0.0.1:8098'
export const MCP_HOST_RUNTIME_API =
  process.env.MCP_HOST_RUNTIME_BASE_URL || process.env.MCP_HOST_BASE_URL || 'http://127.0.0.1:8080'

export const WORKFLOW_RECIPE_NS = 'sandbox-recipes'
export const MCP_SERVER_NS = 'mcp-server'
export const CHANNELS_NS = 'channels'
export const SHARED_MCP_HOST_NS = 'mcp-host'
export const SHARED_MCP_HOST_NAME = 'chatllm'
export const SHARED_MCP_HOST_REF = `${SHARED_MCP_HOST_NS}/${SHARED_MCP_HOST_NAME}`

export type Medium = 'telegram' | 'slack' | 'discord'

export type RuntimeTokens = {
  mcpHostAccessToken: string
  mcpHostControlToken: string
}
