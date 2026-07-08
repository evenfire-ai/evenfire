/**
 * MCP (Model Context Protocol) client module.
 */

export { McpClient } from './client'
export { McpManager } from './manager'
export {
  ServerStatusTracker,
  classifyConnectError,
  MCP_INIT_AUTH_FAILED_MESSAGE,
  MCP_NOT_READY_MESSAGE,
} from './serverStatus'
export type { McpServerState, McpServerFailureReason, McpServerStatusEntry } from './serverStatus'
