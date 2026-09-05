/**
 * MCP (Model Context Protocol) client module.
 */

export { McpClient, McpAuthError, staticTokenProvider } from './client'
export type { McpTokenProvider } from './client'
export {
  McpManager,
  SHARED_PRINCIPAL,
  userPrincipal,
  serializeClientKey,
  serverNameFromClientKey,
} from './manager'
export type { McpPrincipal, McpTokenProviderFactory } from './manager'
export {
  ServerStatusTracker,
  classifyConnectError,
  MCP_INIT_AUTH_FAILED_MESSAGE,
  MCP_NOT_READY_MESSAGE,
} from './serverStatus'
export type { McpServerState, McpServerFailureReason, McpServerStatusEntry } from './serverStatus'
