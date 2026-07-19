export interface StepMcpServerRef {
  name: string
  url: string
  authToken?: string
}

export interface AllowedToolsConfig {
  include?: string[]
}

export interface AgentStepRequest {
  stepId: string
  instruction: string
  mcpServers?: StepMcpServerRef[]
  allowedTools?: AllowedToolsConfig
  toolChoice?: 'auto' | 'none' | 'required'
  maxIterations?: number
  timeoutSeconds?: number
  contextVars?: Record<string, string>
  approvalBindingProof?: string
  requiresApproval?: {
    target: { userId?: string; teamId?: string }
    message: string
    timeoutSeconds?: number
  }
}

export interface AgentStepResult {
  stepId: string
  status: 'completed' | 'failed'
  output?: string
  error?: string
  toolsCalled?: Array<{
    serverName: string
    toolName: string
    args: Record<string, unknown>
    result: unknown
    durationMs: number
  }>
  durationMs: number
  tokensUsed?: { input: number; output: number; total: number }
  completedAt?: string
}
