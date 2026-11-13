import { rootLogger } from '../../../observability/logger.js'
import type { WorkflowAuthorityBinding } from '../../../services/workflows/workflowAuthorityBindingService.js'

export const workflowReadAuditLogger = rootLogger.child({ module: 'external-workflows' })

/**
 * WF-14: delegated reads persist no authority binding (bindings are kept only
 * for effects: trigger, decide, resume, delete). A successful V2 read leaves
 * one structured audit line with the binding's attribution instead.
 */
export function auditAuthorizedWorkflowRead(
  authority: WorkflowAuthorityBinding,
  entity: Readonly<{ entityType: string; entityId: string }>
): void {
  const binding = authority.binding
  workflowReadAuditLogger.info(
    {
      event: 'workflow_authorized_read',
      operationId: binding.operationId,
      entityType: entity.entityType,
      entityId: entity.entityId,
      userId: binding.userId,
      sid: binding.sid,
      sessionVersion: binding.sessionVersion,
      delegationJti: binding.delegationJti,
      accessPathId: binding.accessPathId,
      authorizationRevision: binding.authorizationRevision,
      pathKind: binding.pathKind,
      effectiveTeamId: binding.effectiveTeamId,
      bindingHash: authority.bindingHash,
    },
    'Workflow delegated read authorized'
  )
}
