import * as k8s from '@kubernetes/client-node'
import { isDeepStrictEqual } from 'node:util'
import { CRD_GROUP, CRD_VERSION, WORKFLOWRECIPE_PLURAL } from '../reconciler/crdConstants.js'
import type { ChildRecipeRef, DbRunRow } from '../reconciler/dbRunProcessor.js'
import { getErrorCode } from '../reconciler/k8sErrors.js'
import type { WorkflowRecipeGfsIntentSpec } from '../types.js'
import {
  INHERITED_PARENT_RESOURCES_ANNOTATION,
  type ParentRecipe,
  buildChildRecipe,
  buildDbRunChildName,
} from './childRecipeFactory.js'
import { CODEX_CONNECTION_REF_ANNOTATION } from './llmAllowedModelsSnapshot.js'
import { WORKFLOW_TEAM_ID_LABEL } from './schedulingHandler.js'

export const RUN_ID_LABEL = 'clerum.io/workflow-run-id'
export const RUN_TEAM_ID_LABEL = WORKFLOW_TEAM_ID_LABEL
export const RUN_ACTOR_ID_LABEL = 'clerum.io/workflow-actor-id'
export const RUN_ACTOR_TYPE_LABEL = 'clerum.io/workflow-actor-type'
export const RUN_OUTPUT_OVERRIDES_ANNOTATION = 'clerum.io/run-output-overrides'
export const RUN_INTERMEDIATE_PARAMS_ANNOTATION = 'clerum.io/run-intermediate-parameters'

const WORKFLOW_RECIPE_API_VERSION = `${CRD_GROUP}/${CRD_VERSION}`
const WORKFLOW_RECIPE_KIND = 'WorkflowRecipe'
const PARENT_RECIPE_LABEL = 'clerum.io/parent-recipe'

type ParentRecipeResponse = {
  apiVersion?: string
  kind?: string
  metadata?: {
    name?: string
    namespace?: string
    uid?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    ownerReferences?: Array<{
      apiVersion?: string
      kind?: string
      name?: string
      uid?: string
      controller?: boolean
    }>
  }
  spec?: {
    contextRef?: string
    security?: Record<string, unknown>
    inputs?: Record<string, unknown>
    inputContract?: Record<string, unknown>
    computed?: unknown[]
    coordinatorImage?: string
    steps?: unknown[]
    agent?: unknown
    mcpServers?: unknown[]
    workloads?: unknown[]
    resources?: unknown[]
    runtimeEgress?: Record<string, unknown>
    gfs?: WorkflowRecipeGfsIntentSpec
    output?: unknown
  }
}

function isExpectedExistingChild(
  existing: ParentRecipeResponse,
  expected: {
    name: string
    namespace: string
    runId: string
    parentName: string
    parentUid: string
    spec: ParentRecipeResponse['spec']
  }
): boolean {
  const controllerOwners =
    existing.metadata?.ownerReferences?.filter(owner => owner.controller === true) ?? []
  const controllerOwner = controllerOwners.length === 1 ? controllerOwners[0] : undefined

  return (
    existing.apiVersion === WORKFLOW_RECIPE_API_VERSION &&
    existing.kind === WORKFLOW_RECIPE_KIND &&
    existing.metadata?.name === expected.name &&
    existing.metadata?.namespace === expected.namespace &&
    existing.metadata?.labels?.[RUN_ID_LABEL] === expected.runId &&
    existing.metadata?.labels?.[PARENT_RECIPE_LABEL] === expected.parentName &&
    existing.metadata?.annotations?.[INHERITED_PARENT_RESOURCES_ANNOTATION] === 'true' &&
    controllerOwner?.apiVersion === WORKFLOW_RECIPE_API_VERSION &&
    controllerOwner.kind === WORKFLOW_RECIPE_KIND &&
    controllerOwner.name === expected.parentName &&
    controllerOwner.uid === expected.parentUid &&
    isDeepStrictEqual(existing.spec, expected.spec)
  )
}

export async function createDbRunChildRecipe(
  customApi: k8s.CustomObjectsApi,
  run: DbRunRow
): Promise<ChildRecipeRef> {
  // Adapter from the durable workflow_runs row to the child WorkflowRecipe
  // execution artifact. The DB row remains authoritative for identity,
  // idempotency, approval binding, and run status.
  const response = (await customApi.getNamespacedCustomObject({
    group: CRD_GROUP,
    version: CRD_VERSION,
    namespace: run.recipe_namespace,
    plural: WORKFLOWRECIPE_PLURAL,
    name: run.recipe_name,
  })) as ParentRecipeResponse

  const parentName = response.metadata?.name
  const parentNamespace = response.metadata?.namespace
  const parentUid = response.metadata?.uid
  if (!parentName || !parentNamespace || !parentUid) {
    throw new Error('Parent WorkflowRecipe missing metadata required for child creation')
  }

  const triggerKind: 'schedule' | 'onDemand' =
    run.trigger_source === 'schedule' ? 'schedule' : 'onDemand'
  const childName = buildDbRunChildName(parentName, run.run_id)
  const usageTeamId = run.usage_team_id
  const parentRecipe: ParentRecipe = {
    metadata: {
      name: parentName,
      namespace: parentNamespace,
      uid: parentUid,
    },
    spec: {
      contextRef: response.spec?.contextRef,
      security: response.spec?.security,
      inputs: response.spec?.inputs,
      inputContract: response.spec?.inputContract,
      computed: response.spec?.computed,
      coordinatorImage: response.spec?.coordinatorImage,
      steps: response.spec?.steps,
      agent: response.spec?.agent,
      mcpServers: response.spec?.mcpServers,
      workloads: response.spec?.workloads,
      resources: response.spec?.resources,
      runtimeEgress: response.spec?.runtimeEgress,
      gfs: response.spec?.gfs,
      output: response.spec?.output,
    },
  }

  const childRecipe = buildChildRecipe(parentRecipe, 0, new Date(), {
    triggerKind,
    stableName: childName,
    inputs: {
      ...(response.spec?.inputs ?? {}),
      ...(run.inputs ?? {}),
    },
    outputOverrides: run.output_overrides ?? undefined,
    labels: {
      'clerum.io/trigger-source': run.trigger_source,
      [RUN_ID_LABEL]: run.run_id,
      ...(usageTeamId ? { [RUN_TEAM_ID_LABEL]: usageTeamId } : {}),
      ...(run.actor_type === 'user' || run.actor_type === 'admin'
        ? { [RUN_ACTOR_TYPE_LABEL]: run.actor_type }
        : {}),
      ...(run.actor_type === 'user' || run.actor_type === 'admin'
        ? run.actor_id
          ? { [RUN_ACTOR_ID_LABEL]: run.actor_id }
          : {}
        : {}),
    },
    annotations: {
      ...(run.output_overrides
        ? { [RUN_OUTPUT_OVERRIDES_ANNOTATION]: JSON.stringify(run.output_overrides) }
        : {}),
      ...(run.intermediate_parameters
        ? {
            [RUN_INTERMEDIATE_PARAMS_ANNOTATION]: JSON.stringify(run.intermediate_parameters),
          }
        : {}),
      // The Codex grant identity is inherited by copy: the trusted controller
      // stamps the parent's chosen connection key on the child so control-api
      // can attest the grant by reading the child recipe named in hostRef.
      // A parent without the annotation stays fail-closed (`unassigned`).
      ...(response.metadata?.annotations?.[CODEX_CONNECTION_REF_ANNOTATION]?.trim()
        ? {
            [CODEX_CONNECTION_REF_ANNOTATION]:
              response.metadata.annotations[CODEX_CONNECTION_REF_ANNOTATION].trim(),
          }
        : {}),
    },
  })
  // Match the JSON representation persisted by Kubernetes: buildChildRecipe
  // retains undefined keys in memory, while the API payload omits them.
  const expectedChildSpec = JSON.parse(
    JSON.stringify(childRecipe.spec)
  ) as ParentRecipeResponse['spec']

  try {
    await customApi.createNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace: parentNamespace,
      plural: WORKFLOWRECIPE_PLURAL,
      body: childRecipe,
    })
  } catch (err) {
    if (getErrorCode(err) !== 409) throw err

    const existing = (await customApi.getNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace: parentNamespace,
      plural: WORKFLOWRECIPE_PLURAL,
      name: childName,
    })) as ParentRecipeResponse

    if (
      !isExpectedExistingChild(existing, {
        name: childName,
        namespace: parentNamespace,
        runId: run.run_id,
        parentName,
        parentUid,
        spec: expectedChildSpec,
      })
    ) {
      throw new Error(
        `Child recipe "${parentNamespace}/${childName}" already exists but does not match the expected workflow run child identity and inherited intent`
      )
    }
  }

  return { name: childName, namespace: parentNamespace }
}
