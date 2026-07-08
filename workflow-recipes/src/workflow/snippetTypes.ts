import type { SnippetRunSpec } from './types'

export interface SnippetResolvedWorkload {
  id: string
  type: string
  host: string
  port?: number
  namespace: string
  transport?: { type: string; path?: string }
}

export interface SnippetResolvedMcpServer {
  id: string
  url: string
  transport?: string
}

export interface SnippetRunInvocationRequest {
  workflowName: string
  stepId: string
  inputs?: Record<string, unknown>
  previousOutputs: Record<string, unknown>
  timeoutSeconds?: number
}

export interface SnippetExecuteRequest {
  workflowName: string
  stepId: string
  run: SnippetRunSpec
  inputs?: Record<string, unknown>
  previousOutputs: Record<string, unknown>
  timeoutSeconds?: number
  resolvedWorkloads: SnippetResolvedWorkload[]
  resolvedMcpServers: SnippetResolvedMcpServer[]
}

export interface SnippetExecuteResponse {
  stepId: string
  status: 'completed' | 'failed'
  output?: unknown
  artifacts?: Array<{
    name: string
    format: string
    sizeBytes: number
    path: string
    createdAt: string
  }>
  error?: string
}

export function snippetSecretEnvName(alias: string): string {
  return `CLERUM_SNIPPET_SECRET_${alias.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`
}
