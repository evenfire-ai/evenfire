import type { Tool } from '../interfaces'
import type { ToolOutput } from '../types'
import { WorkflowBrokerClient } from './workflowBrokerClient'
import {
  type EnvGetter,
  type WorkflowCallerContext,
  type WorkflowToolOptions,
  defaultEnv,
} from './workflowShared'
import {
  type WorkflowControlTokenProvider,
  createWorkflowControlTokenProvider,
} from './workflowTokenProvider'

export abstract class WorkflowTool implements Tool {
  protected readonly getEnv: EnvGetter
  protected readonly client: WorkflowBrokerClient
  protected readonly workflowControlTokenProvider: WorkflowControlTokenProvider
  protected readonly workflowCallerContext: WorkflowCallerContext | null

  constructor(options: WorkflowToolOptions = {}) {
    this.getEnv = options.getEnv ?? defaultEnv
    this.workflowCallerContext = options.workflowCallerContext ?? null
    this.workflowControlTokenProvider =
      options.workflowControlTokenProvider ?? createWorkflowControlTokenProvider(this.getEnv)
    this.client = new WorkflowBrokerClient(this.getEnv, this.workflowControlTokenProvider)
  }

  abstract name(): string
  abstract description(): string
  abstract parametersSchema(): Record<string, unknown>
  abstract run(params: Record<string, unknown>): Promise<unknown>

  protected metadataForResult(_data: unknown): Record<string, unknown> | undefined {
    return undefined
  }

  requiresSanitization(): boolean {
    return false
  }

  requiresApproval(): boolean {
    return false
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    try {
      const data = await this.run(params)
      return {
        content: JSON.stringify(data, null, 2),
        duration_ms: Date.now() - start,
        is_error: false,
        metadata: this.metadataForResult(data),
      }
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        duration_ms: Date.now() - start,
        is_error: true,
      }
    }
  }
}
