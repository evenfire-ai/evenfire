import { Router } from 'express'
import type { K8sGateway } from '../../k8s.js'
import { createExternalAccessRouter } from './access.js'
import { createExternalAuthRouter } from './auth.js'
import { createExternalUserApprovalDecisionsRouter } from './decisions.routes.js'
import { createExternalDirectoryRouter } from './directory.js'
import { createExternalGfsRouter } from './gfs.js'
import { createExternalGfsWatchRouter } from './gfsWatch.routes.js'
import { createExternalInvitationsRouter } from './invitations.js'
import { createExternalMembersRouter } from './members.js'
import { createExternalNotificationsRouter } from './notifications.routes.js'
import { createExternalOauthGrantsRouter } from './oauthGrants.js'
import { createExternalOidcDesktopSignInRouter } from './oidcDesktopSignIn.js'
import { createExternalOidcProfileFlowRouter } from './oidcProfileFlow.js'
import { createExternalRpcDelegationsRouter } from './rpcDelegations.js'
import { createExternalSharedFilesystemsRouter } from './sharedFilesystems.js'
import { createExternalTeamsRouter } from './teams.js'
import { createExternalUsersRouter } from './users.js'
import { createExternalWorkflowApprovalMediumsRouter } from './workflow-approval-mediums.routes.js'
import { createExternalWorkflowsRouter } from './workflows/index.js'

export function createExternalRouter(gateway: K8sGateway): Router {
  const router = Router()
  router.use(createExternalAccessRouter())
  router.use(createExternalAuthRouter(gateway))
  router.use(createExternalRpcDelegationsRouter(gateway))
  router.use(createExternalUsersRouter(gateway))
  router.use(createExternalTeamsRouter(gateway))
  router.use(createExternalInvitationsRouter())
  router.use(createExternalMembersRouter())
  router.use(createExternalDirectoryRouter())
  router.use(createExternalSharedFilesystemsRouter(gateway))
  // Ahead of the GFS router, which answers every path outside its operation
  // matrix with 404 after running its session and authority chain.
  router.use(createExternalGfsWatchRouter())
  router.use(createExternalGfsRouter(gateway))
  router.use(createExternalNotificationsRouter())
  router.use(createExternalUserApprovalDecisionsRouter(gateway))
  router.use(createExternalWorkflowApprovalMediumsRouter(gateway))
  router.use(createExternalWorkflowsRouter(gateway))
  router.use(createExternalOauthGrantsRouter())
  router.use(createExternalOidcProfileFlowRouter())
  router.use(createExternalOidcDesktopSignInRouter())
  return router
}
