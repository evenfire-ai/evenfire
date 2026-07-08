import type { Tool } from '../interfaces'
import {
  WorkflowHealthTool,
  WorkflowListTool,
  WorkflowResultTool,
  WorkflowStatusTool,
} from './workflowReadTools'
import { type WorkflowToolOptions, defaultEnv } from './workflowShared'
import { WorkflowTriggerTool } from './workflowTriggerTool'

export { WorkflowBrokerClient } from './workflowBrokerClient'
export {
  WorkflowHealthTool,
  WorkflowListTool,
  WorkflowResultTool,
  WorkflowStatusTool,
} from './workflowReadTools'
export { WorkflowTriggerTool } from './workflowTriggerTool'
export type { WorkflowToolOptions } from './workflowShared'

function canExposeWorkflowTrigger(options: WorkflowToolOptions): boolean {
  const getEnv = options.getEnv ?? defaultEnv
  return Boolean(
    getEnv('MCP_HOST_RUNTIME_ACCESS_TOKEN')?.trim() &&
    getEnv('MCP_HOST_RUNTIME_REFRESH_TOKEN')?.trim()
  )
}

function canExposeWorkflowResult(options: WorkflowToolOptions): boolean {
  const context = options.workflowCallerContext
  return Boolean(
    context?.conversationId?.trim() &&
    (context.targetUserId?.trim() || context.targetTeamId?.trim())
  )
}

export function createWorkflowTools(options: WorkflowToolOptions = {}): Tool[] {
  const tools: Tool[] = [
    new WorkflowListTool(options),
    new WorkflowStatusTool(options),
    new WorkflowHealthTool(options),
  ]
  if (canExposeWorkflowTrigger(options)) {
    tools.push(new WorkflowTriggerTool(options))
  }
  if (canExposeWorkflowResult(options)) {
    tools.push(new WorkflowResultTool(options))
  }
  return tools
}
