import { McpManager } from './manager'
import type { McpProxyHostAuthorization } from './proxyAuth'

export interface McpManagerConfiguration {
  proxyEnabled: boolean
  proxyUrl: string
  hostAuthorization?: McpProxyHostAuthorization
}

/**
 * Keep manager construction in one place so production startup and the
 * in-pod protocol harness cannot silently diverge on proxy mode or Host-bearer
 * wiring.
 */
export function createMcpManagerForHost(configuration: McpManagerConfiguration): McpManager {
  return new McpManager(
    configuration.proxyEnabled ? configuration.proxyUrl : undefined,
    undefined,
    configuration.hostAuthorization
  )
}
