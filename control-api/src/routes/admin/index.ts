import { Router } from 'express'
import { K8sGateway } from '../../k8s.js'
import { createAdminAgentsRouter } from './agents.js'
import { createAdminBudgetsRouter } from './budgets.js'
import { createAdminCodexSubscriptionRouter } from './codexSubscription.js'
import { createAdminContextRouter } from './context.js'
import { createAdminControlAdminsRouter } from './controlAdmins.js'
import { createAdminHostArtifactsRouter } from './hostArtifacts.js'
import { createAdminHostEnvRouter } from './hostEnv.js'
import { createAdminHostsOverviewRouter } from './hostsOverview.js'
import { createAdminLlmModelsRouter } from './llmModels.js'
import { createAdminLlmPricesRouter } from './llmPrices.js'
import { createAdminOutputsRouter } from './outputs.js'
import { createAdminPersonalizationRouter } from './personalization.js'
import { createAdminPluginWorkloadSdkRouter } from './pluginWorkloadSdk.js'
import { createAdminRecipeOauthRouter } from './recipeOauth.js'
import { createAdminRecipesRouter } from './recipes.js'
import { createAdminRegistryRouter } from './registry.js'
import { createRegistryConnectRouter } from './registryConnect.js'
import { createAdminResourcesRouter } from './resources.js'
import { createAdminSecretsRouter } from './secrets.js'
import { createAdminSharedFilesystemsRouter } from './sharedFilesystems.js'
import { createAdminTeamsRouter } from './teams.js'
import { createAdminTracingRouter } from './tracing/index.js'
import { createAdminUsageRouter } from './usage.js'
import { createAdminUsersRouter } from './users.js'

export function createAdminRouter(gateway: K8sGateway): Router {
  const router = Router()
  router.use(createAdminHostsOverviewRouter(gateway))
  router.use(createAdminControlAdminsRouter())
  router.use(createAdminHostArtifactsRouter(gateway))
  router.use(createAdminHostEnvRouter(gateway))
  router.use(createAdminOutputsRouter(gateway))
  router.use(createAdminSecretsRouter(gateway))
  router.use(createAdminResourcesRouter(gateway))
  router.use(createAdminRecipesRouter(gateway))
  router.use(createAdminRecipeOauthRouter(gateway))
  router.use(createAdminRegistryRouter(gateway))
  router.use(createRegistryConnectRouter())
  router.use(createAdminSharedFilesystemsRouter(gateway))
  router.use(createAdminUsersRouter(gateway))
  router.use(createAdminTeamsRouter(gateway))
  router.use(createAdminContextRouter())
  router.use(createAdminAgentsRouter())
  router.use(createAdminPersonalizationRouter(gateway))
  router.use(createAdminPluginWorkloadSdkRouter())
  router.use(createAdminUsageRouter())
  router.use(createAdminLlmPricesRouter())
  router.use(createAdminLlmModelsRouter(gateway))
  router.use(createAdminCodexSubscriptionRouter())
  router.use(createAdminBudgetsRouter())
  router.use(createAdminTracingRouter())
  return router
}
