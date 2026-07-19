export type RpcScope =
  | 'mcp:servers:list'
  | 'mcp:server:invoke'
  | 'host:health:read'
  | 'host:status:read'
  | 'host:activity:read'
  | 'host:message:invoke'
  | 'host:wake:write'
  | 'host:task:read'
  | 'host:approval:write'
  | 'host:session:read'
  | 'host:model:write'
  | 'desktop:view'
  | 'sandbox:ui:view'
export type RpcTokenType = 'service' | 'user'
export type RpcAccessScope = 'service' | 'team' | 'user'

export type RpcAccessClaims = {
  sub: string
  typ: RpcTokenType
  accessScope: RpcAccessScope
  teamId: string | null
  scopes: RpcScope[]
  hostRefs: string[]
  jti: string
  iat: number
  exp: number
  service?: string
  role?: string
}

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: string | number | null
  method: string
  params?: unknown
}

export type JsonRpcSuccess = {
  jsonrpc: '2.0'
  id: string | number | null
  result: unknown
}

export type JsonRpcError = {
  jsonrpc: '2.0'
  id: string | number | null
  error: {
    code: number
    message: string
    data?: unknown
  }
}

export type McpServerAuth = {
  type: 'none' | 'bearer' | 'basic' | 'apiKey'
  secretRef?: string
  secretKey?: string
}

export type McpServerCRD = {
  metadata: {
    name: string
    namespace?: string
  }
  spec: {
    contextRef: string
    enabled?: boolean
    transport: {
      type: 'sse' | 'streamableHttp'
      url: string
      port?: number
    }
    auth?: McpServerAuth
  }
}

export type ContextCRD = {
  metadata: {
    name: string
    namespace?: string
  }
  spec: {
    contextId: string
    mcpServers: string[]
  }
}

export type ResolvedServerConnection = {
  name: string
  url: string
  headers: Record<string, string>
  attributionBindingStatus?: 'recorded' | 'unavailable'
}
