/** The workflow list, read and trigger tools, as internal tools. */
import { WorkflowListTool, WorkflowStatusTool } from '../core/tools/workflowReadTools'
import { WorkflowTriggerTool } from '../core/tools/workflowTriggerTool'
import type { InternalToolDefinition, InternalToolResult } from './types'

// ─── clerum__list_workflows ───────────────────────────────────────────

const listWorkflowTool = new WorkflowListTool()

export const listWorkflows: InternalToolDefinition = {
  name: 'clerum__list_workflows',
  description: listWorkflowTool.description(),
  parameters: listWorkflowTool.parametersSchema(),
  execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
    const result = await listWorkflowTool.execute(args)
    if (result.is_error) {
      return { success: false, error: result.content }
    }
    return { success: true, content: result.content }
  },
}

const readWorkflowTool = new WorkflowStatusTool()

export const readWorkflow: InternalToolDefinition = {
  name: 'clerum__read_workflow',
  description: readWorkflowTool.description(),
  parameters: readWorkflowTool.parametersSchema(),
  execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
    const result = await readWorkflowTool.execute(args)
    if (result.is_error) {
      return { success: false, error: result.content }
    }
    return { success: true, content: result.content }
  },
}

const triggerWorkflowTool = new WorkflowTriggerTool()

export const triggerWorkflow: InternalToolDefinition = {
  name: 'clerum__trigger_workflow',
  description: triggerWorkflowTool.description(),
  parameters: triggerWorkflowTool.parametersSchema(),
  execute: async (args: Record<string, unknown>): Promise<InternalToolResult> => {
    const result = await triggerWorkflowTool.execute(args)
    if (result.is_error) {
      return { success: false, error: result.content }
    }
    return { success: true, content: result.content }
  },
}
