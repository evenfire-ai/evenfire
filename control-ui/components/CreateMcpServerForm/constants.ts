import type { TransportOption } from './types'

export const MCP_SERVER_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

export const TRANSPORT_TYPES: readonly TransportOption[] = [
  { value: 'streamableHttp', label: 'StreamableHTTP' },
  { value: 'sse', label: 'SSE' },
  { value: 'stdio', label: 'stdio' },
]
