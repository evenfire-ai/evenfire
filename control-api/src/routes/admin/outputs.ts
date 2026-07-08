import { Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import type { K8sGateway } from '../../k8s.js'
import {
  getAuthorizedRecipeResources,
  getResourceName,
  getResourceNamespace,
} from '../../services/workflows/workflowRecipeAccessService.js'
import { listWorkflowRunArtifacts } from '../../services/workflows/workflowRunArtifactService.js'
import { listCanonicalRuns } from '../../services/workflows/workflowRunReadService.js'
import { requireAdminWorkflowCaller } from '../workflows/shared/auth.js'
import { listHostArtifactsForHost } from './hostArtifacts.js'

function isVisibleRecipe(resource: Record<string, unknown>): boolean {
  const metadata = (resource.metadata ?? {}) as {
    deletionTimestamp?: string
    labels?: Record<string, string>
  }
  if (metadata.deletionTimestamp) return false
  if (metadata.labels?.['clerum.io/workflow-run-id']) return false
  return true
}

const OUTPUTS_RECIPE_LIMIT = 50
const OUTPUTS_RUNS_PER_RECIPE_LIMIT = 20
const OUTPUTS_TOTAL_RUN_ARTIFACT_QUERY_LIMIT = 200

export function createAdminOutputsRouter(gateway: K8sGateway): Router {
  const router = Router()

  router.get(
    '/admin/outputs',
    asyncHandler(async (req, res) => {
      const caller = await requireAdminWorkflowCaller(req, res)
      if (!caller) return

      const [recipes, hosts] = await Promise.all([
        getAuthorizedRecipeResources(caller, gateway),
        gateway.listResource('hosts', config.hostsNamespace),
      ])

      const warnings: string[] = []
      const workflowOutputs: Array<{
        recipeName: string
        namespace: string
        runId: string
        fileName: string
        format: string
        sizeBytes: number
        completedAt: string
      }> = []
      const visibleRecipes = recipes.filter(isVisibleRecipe)
      const recipesToInspect = visibleRecipes.slice(0, OUTPUTS_RECIPE_LIMIT)
      if (visibleRecipes.length > recipesToInspect.length) {
        warnings.push(
          `Workflow outputs limited to ${OUTPUTS_RECIPE_LIMIT} of ${visibleRecipes.length} visible recipes.`
        )
      }

      let runArtifactQueryCount = 0
      let runArtifactLimitReached = false
      for (const recipe of recipesToInspect) {
        if (runArtifactQueryCount >= OUTPUTS_TOTAL_RUN_ARTIFACT_QUERY_LIMIT) {
          runArtifactLimitReached = true
          break
        }

        const name = getResourceName(recipe)
        const namespace = getResourceNamespace(recipe) || config.sandboxNamespace
        if (!name) continue

        try {
          const runs = await listCanonicalRuns(
            namespace,
            name,
            OUTPUTS_RUNS_PER_RECIPE_LIMIT,
            caller
          )
          const remainingRunQueries = OUTPUTS_TOTAL_RUN_ARTIFACT_QUERY_LIMIT - runArtifactQueryCount
          const runsToInspect = runs.slice(0, remainingRunQueries)
          if (runs.length > runsToInspect.length) {
            runArtifactLimitReached = true
          }
          runArtifactQueryCount += runsToInspect.length

          const artifactResults = await Promise.allSettled(
            runsToInspect.map(async run => {
              const artifacts = await listWorkflowRunArtifacts({
                gateway,
                caller,
                recipeNamespace: namespace,
                recipeName: name,
                runId: run.id,
              })
              return artifacts.map(artifact => ({
                recipeName: name,
                namespace,
                runId: run.id,
                fileName: artifact.name,
                format: artifact.format,
                sizeBytes: artifact.sizeBytes,
                completedAt: artifact.createdAt || run.completedAt || run.startedAt || '',
              }))
            })
          )
          workflowOutputs.push(
            ...artifactResults.flatMap(result =>
              result.status === 'fulfilled' ? result.value : []
            )
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          warnings.push(`Skipped workflow outputs for ${namespace}/${name}: ${message}`)
        }
      }
      if (runArtifactLimitReached) {
        warnings.push(
          `Workflow artifact scan limited to ${OUTPUTS_TOTAL_RUN_ARTIFACT_QUERY_LIMIT} run artifact queries.`
        )
      }

      const chatResults = await Promise.allSettled(
        (hosts as Array<{ metadata?: { name?: string } }>).map(async host => {
          const hostRef = String(host.metadata?.name || '').trim()
          if (!hostRef) return []
          const result = await listHostArtifactsForHost(gateway, hostRef)
          return result.artifacts.map(artifact => ({
            hostRef,
            fileName: artifact.name,
            format: artifact.format,
            sizeBytes: artifact.sizeBytes,
            createdAt: artifact.createdAt,
          }))
        })
      )

      res.status(200).json({
        workflowOutputs,
        chatArtifacts: chatResults.flatMap(result =>
          result.status === 'fulfilled' ? result.value : []
        ),
        ...(warnings.length > 0 ? { warnings } : {}),
      })
    })
  )

  return router
}
