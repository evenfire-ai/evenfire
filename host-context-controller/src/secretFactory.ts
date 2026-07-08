/**
 * Secret factories for HCC-managed mcpHost runtime tokens. Key names mirror WRC's
 * pattern so mcp-host can mount either provider's Secret unchanged.
 */
import * as k8s from '@kubernetes/client-node'
import { HOST_LABEL, MANAGED_BY_LABEL, MANAGED_BY_VALUE } from './constants'
import { HostCRD } from './types'

export const MCP_HOST_RUNTIME_TOKEN_SECRET_ACCESS_KEY = 'mcp-host-runtime-access-token'
export const MCP_HOST_RUNTIME_TOKEN_SECRET_REFRESH_KEY = 'mcp-host-runtime-refresh-token'
export const MCP_HOST_RUNTIME_TOKEN_SECRET_CONTROL_KEY = 'mcp-host-workflow-control-token'
export const MCP_HOST_GFS_TOKEN_SECRET_KEY = 'mcp-host-gfs-token'
export const MCP_HOST_RUNTIME_TOKEN_COMPONENT_LABEL = 'clerum.io/component'
export const MCP_HOST_RUNTIME_TOKEN_COMPONENT_VALUE = 'mcp-host-runtime-token'

export function mcpHostRuntimeTokenSecretName(host: HostCRD): string {
  return `host-${host.name}-mcp-host-runtime-tokens`
}

export function buildMcpHostRuntimeTokenSecret(
  host: HostCRD,
  accessToken: string,
  refreshToken: string,
  mcpHostControlToken: string,
  gfsToken?: string
): k8s.V1Secret {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: mcpHostRuntimeTokenSecretName(host),
      namespace: host.namespace,
      labels: {
        [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
        [HOST_LABEL]: host.name,
        [MCP_HOST_RUNTIME_TOKEN_COMPONENT_LABEL]: MCP_HOST_RUNTIME_TOKEN_COMPONENT_VALUE,
      },
    },
    type: 'Opaque',
    stringData: {
      [MCP_HOST_RUNTIME_TOKEN_SECRET_ACCESS_KEY]: accessToken,
      [MCP_HOST_RUNTIME_TOKEN_SECRET_REFRESH_KEY]: refreshToken,
      [MCP_HOST_RUNTIME_TOKEN_SECRET_CONTROL_KEY]: mcpHostControlToken,
      ...(gfsToken ? { [MCP_HOST_GFS_TOKEN_SECRET_KEY]: gfsToken } : {}),
    },
  }
}
