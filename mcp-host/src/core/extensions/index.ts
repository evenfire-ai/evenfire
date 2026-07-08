/**
 * Extensions barrel file.
 *
 * Phase 6: LoopController decorators and extension points.
 */

export * from './approvalTypes'
export { ApprovalController } from './approvalController'
export { ApprovalResolver } from './approvalResolver'
export { NudgeController } from './nudgeController'
export { PressureContextManager, InLoopContextManager } from './contextManager'
export {
  UnifiedApprovalGateController,
  McpApprovalGateController,
  isMcpToolName,
  getMcpServerPrefix,
} from './mcpApprovalGateController'
export { validateApprovalConfig } from './approvalConfigValidation'
