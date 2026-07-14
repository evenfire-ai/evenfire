import { describe, expect, it, vi } from 'vitest'
import { wireWorkflowApprovalRuntimeRoutes } from './runtimeApprovalRouteWiring'
import type { WorkflowApprovalRuntimeRouteHandlers } from './runtimeApprovalRouteWiring'

describe('wireWorkflowApprovalRuntimeRoutes', () => {
  it('registers provider approval and notification routes for workflow runtime mcp-hosts', () => {
    const server = {
      onProviderMessageAuthorization: vi.fn(),
      onProviderWorkflowApprovalDecision: vi.fn(),
      onProviderWorkflowApprovalResolve: vi.fn(),
      onWorkflowApprovalNotificationClaim: vi.fn(),
      onWorkflowApprovalNotificationTerminal: vi.fn(),
      onWorkflowApprovalMediumEnrollment: vi.fn(),
      onTelegramWorkflowApprovalVerification: vi.fn(),
    }
    const handlers = {
      providerMessageAuthorization: vi.fn(),
      providerWorkflowApprovalDecision: vi.fn(),
      providerWorkflowApprovalResolve: vi.fn(),
      workflowApprovalNotificationClaim: vi.fn(),
      workflowApprovalNotificationTerminal: vi.fn(),
      workflowApprovalMediumEnrollment: vi.fn(),
      telegramWorkflowApprovalVerification: vi.fn(),
    } as unknown as WorkflowApprovalRuntimeRouteHandlers

    wireWorkflowApprovalRuntimeRoutes(server, handlers)

    expect(server.onProviderMessageAuthorization).toHaveBeenCalledWith(
      handlers.providerMessageAuthorization
    )
    expect(server.onProviderWorkflowApprovalDecision).toHaveBeenCalledWith(
      handlers.providerWorkflowApprovalDecision
    )
    expect(server.onProviderWorkflowApprovalResolve).toHaveBeenCalledWith(
      handlers.providerWorkflowApprovalResolve
    )
    expect(server.onWorkflowApprovalNotificationClaim).toHaveBeenCalledWith(
      handlers.workflowApprovalNotificationClaim
    )
    expect(server.onWorkflowApprovalNotificationTerminal).toHaveBeenCalledWith(
      handlers.workflowApprovalNotificationTerminal
    )
    expect(server.onWorkflowApprovalMediumEnrollment).toHaveBeenCalledWith(
      handlers.workflowApprovalMediumEnrollment
    )
    expect(server.onTelegramWorkflowApprovalVerification).toHaveBeenCalledWith(
      handlers.telegramWorkflowApprovalVerification
    )
  })
})
