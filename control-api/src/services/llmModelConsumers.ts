/**
 * Every consumer of a `(provider, model)` pair: the references the impact gate
 * enumerates (`computeModelImpact`: Host primary / subset / fallback, grant
 * `allowed_models`) plus the three it leaves out, which decide whether a model
 * still needs the operator's attention or can be pruned:
 *
 *   - grant `prompt_targets[]` with this exact pair (explicit, merged into
 *     `impact.grantsAffected`, because it is a grant);
 *   - WorkflowRecipe references by model NAME (explicit): `spec.agent.model`,
 *     `steps[].agent.model`, and the promptBridge `allowedModels` of the recipe
 *     and of each snippet step. WRC resolves them against the global allowlist
 *     without going through a Host. Matching the name only can over-count a
 *     same-named model of another provider, which only leaves a model alone;
 *     under-counting would break a recipe;
 *   - the all-models Host (implicit): a Host whose `spec.allowedModels` is
 *     absent, empty or has no well-formed entry offers its selector EVERY
 *     enabled model of its `spec.model.provider`. Only evaluated for catalog
 *     providers: subscription and broker providers reach a Host through its
 *     connection, not through `spec.model.provider`.
 *
 * Composed over `computeModelImpact`, never a copy of it, so the impact gate and
 * this enumerator cannot drift on what a Host reference is. Fail-loud like it:
 * any LIST or query rejection propagates, because a partial answer would let the
 * prune disable, or the feed hide, a model somebody uses.
 *
 * SOURCES. Callers decide how fresh each LIST is: the attention feed and the
 * prune pre-filter wrap the gateway sources in `memoizeConsumerSources` once
 * and reuse them across models; the prune's locked phase builds fresh sources
 * per candidate, bound to its transaction. Within one call every namespace is
 * LISTed at most once whatever the caller passes.
 */
import type { DbClient } from '../db.js'
import { enumerateHostModelReferences } from '../routes/admin/hostModelReferences.js'
import { isPlainObject } from '../utils/isPlainObject.js'
import { CATALOG_PROVIDERS } from './llmAllowedModels.js'
import {
  type GrantModelReference,
  type ModelImpact,
  type ModelImpactSources,
  computeModelImpact,
  modelImpactSourcesFromGatewayTx,
} from './llmModelImpact.js'
import {
  type PluginWorkloadSdkGrant,
  listGrantsReferencingPromptTarget,
} from './pluginWorkloadSdkDb.js'

/** A K8s object reference to a Host or a WorkflowRecipe. */
export interface ObjectRef {
  namespace: string
  name: string
}

export interface ModelConsumerSources extends ModelImpactSources {
  /** Grants with a prompt target for exactly this pair. MUST reject on failure. */
  listPromptTargetGrants: (provider: string, model: string) => Promise<PluginWorkloadSdkGrant[]>
  /** The namespaces a WorkflowRecipe can occupy. */
  recipeNamespaces: string[]
  /** LIST WorkflowRecipes in ONE namespace. MUST reject on failure. */
  listRecipesInNamespace: (namespace: string) => Promise<unknown[]>
}

export interface ModelConsumers {
  /** Explicit Host references and every grant (`allowed_models` ∪ prompt targets). */
  impact: ModelImpact
  /** True when someone wrote the model name: a Host reference, a grant or a recipe. */
  explicit: boolean
  /** All-models Hosts that offer the model without naming it (not already in `impact`). */
  implicitHosts: ObjectRef[]
  /** Recipes that name the model; a per-run child counts as its parent recipe. */
  recipes: ObjectRef[]
}

interface ConsumerGateway {
  listResource: (plural: 'hosts' | 'workflowrecipes', namespace?: string) => Promise<unknown[]>
}

/**
 * The real producers: per-namespace Host and recipe LISTs through the gateway
 * (never the `'*'` sentinel, which swallows per-namespace errors) and both grant
 * queries, on `db` when given (a transaction holding the model lock) or on the
 * pool.
 */
export function modelConsumerSourcesFromGateway(
  gateway: ConsumerGateway,
  namespaces: { hostNamespaces: string[]; recipeNamespaces: string[] },
  db?: DbClient
): ModelConsumerSources {
  return {
    ...modelImpactSourcesFromGatewayTx(gateway, namespaces.hostNamespaces, db),
    listPromptTargetGrants: (provider, model) =>
      listGrantsReferencingPromptTarget(provider, model, db),
    recipeNamespaces: namespaces.recipeNamespaces,
    listRecipesInNamespace: namespace => gateway.listResource('workflowrecipes', namespace),
  }
}

function memoizeByNamespace(
  list: (namespace: string) => Promise<unknown[]>
): (namespace: string) => Promise<unknown[]> {
  // The promise is cached, not the array: a rejection is memoized too and
  // re-thrown on every await, so fail-loud survives the memo.
  const byNamespace = new Map<string, Promise<unknown[]>>()
  return namespace => {
    let cached = byNamespace.get(namespace)
    if (!cached) {
      cached = list(namespace)
      byNamespace.set(namespace, cached)
    }
    return cached
  }
}

/** Host and recipe LISTs run at most once per namespace for the wrapper's lifetime. */
export function memoizeConsumerSources(sources: ModelConsumerSources): ModelConsumerSources {
  return {
    ...sources,
    listHostsInNamespace: memoizeByNamespace(sources.listHostsInNamespace),
    listRecipesInNamespace: memoizeByNamespace(sources.listRecipesInNamespace),
  }
}

function refOf(object: Record<string, unknown>, namespace: string): ObjectRef {
  const metadata = isPlainObject(object.metadata) ? object.metadata : {}
  return {
    namespace: typeof metadata.namespace === 'string' ? metadata.namespace : namespace,
    name: typeof metadata.name === 'string' ? metadata.name : '',
  }
}

/**
 * Mirrors mcp-host's `hostSubsetAllowlistView`: an absent, empty or
 * all-malformed `allowedModels` means "the whole global allowlist". The
 * well-formedness test is the shared Host enumeration's (trimmed, non-empty
 * strings), a superset of mcp-host's truthiness check, so a Host can only be
 * counted as all-models more often than mcp-host treats it as one.
 */
function isAllModelsHostOf(spec: unknown, provider: string): boolean {
  if (!isPlainObject(spec) || !isPlainObject(spec.model)) return false
  const hostProvider = typeof spec.model.provider === 'string' ? spec.model.provider.trim() : ''
  if (hostProvider !== provider) return false
  return !enumerateHostModelReferences(spec).some(ref => ref.role === 'allowedModels')
}

function promptBridgeAllowedModels(holder: unknown): unknown[] {
  if (!isPlainObject(holder) || !isPlainObject(holder.pluginWorkloadSdk)) return []
  const promptBridge = holder.pluginWorkloadSdk.promptBridge
  if (!isPlainObject(promptBridge) || !Array.isArray(promptBridge.allowedModels)) return []
  return promptBridge.allowedModels
}

function agentModel(holder: unknown): unknown {
  return isPlainObject(holder) && isPlainObject(holder.agent) ? holder.agent.model : undefined
}

/** Every model name a WorkflowRecipe spec writes in a place WRC resolves it. */
function recipeModelNames(spec: unknown): string[] {
  if (!isPlainObject(spec)) return []
  const names: unknown[] = [agentModel(spec), ...promptBridgeAllowedModels(spec)]
  if (Array.isArray(spec.steps)) {
    for (const step of spec.steps) {
      names.push(agentModel(step))
      if (isPlainObject(step) && isPlainObject(step.run)) {
        names.push(...promptBridgeAllowedModels(step.run.capabilities))
      }
    }
  }
  return names.flatMap(name => (typeof name === 'string' && name.trim() ? [name.trim()] : []))
}

const PARENT_RECIPE_LABEL = 'clerum.io/parent-recipe'

/**
 * WRC spawns a child WorkflowRecipe per run, a copy of its parent's spec. A
 * child is reported as its parent so that the consumer keys of a scheduled
 * recipe stay stable from run to run; otherwise every run would reopen an
 * acknowledged item. The label is author-writable, so the child is mapped only
 * when it also has a controller ownerReference of kind WorkflowRecipe whose
 * name equals the label and whose uid equals the uid of that parent in the same
 * LIST. Anything else (parent missing, uid mismatch) keeps the child's own key:
 * that can only reopen an acknowledgement, never hide a consumer. WRC also
 * checks the workflow-run provenance in Postgres; that check is not repeated
 * here because it does not change the safe side.
 */
function recipeIdentity(
  recipe: Record<string, unknown>,
  namespace: string,
  uidByName: ReadonlyMap<string, string>
): ObjectRef {
  const own = refOf(recipe, namespace)
  const metadata = isPlainObject(recipe.metadata) ? recipe.metadata : {}
  const labels = isPlainObject(metadata.labels) ? metadata.labels : {}
  const parent = labels[PARENT_RECIPE_LABEL]
  if (typeof parent !== 'string' || !parent) return own
  const parentUid = uidByName.get(parent)
  if (!parentUid) return own
  const owners = Array.isArray(metadata.ownerReferences) ? metadata.ownerReferences : []
  const ownedByParent = owners.some(
    owner =>
      isPlainObject(owner) &&
      owner.controller === true &&
      owner.kind === 'WorkflowRecipe' &&
      owner.name === parent &&
      owner.uid === parentUid
  )
  return ownedByParent ? { namespace: own.namespace, name: parent } : own
}

/** name → uid of every recipe in one namespace LIST. */
function recipeUidsByName(recipes: unknown[]): Map<string, string> {
  const uids = new Map<string, string>()
  for (const recipe of recipes) {
    if (!isPlainObject(recipe) || !isPlainObject(recipe.metadata)) continue
    const { name, uid } = recipe.metadata
    if (typeof name === 'string' && typeof uid === 'string' && uid) uids.set(name, uid)
  }
  return uids
}

function refKey(ref: ObjectRef): string {
  return `${ref.namespace}/${ref.name}`
}

export async function computeModelConsumers(
  provider: string,
  model: string,
  sources: ModelConsumerSources
): Promise<ModelConsumers> {
  const memo = memoizeConsumerSources(sources)
  const base = await computeModelImpact(provider, model, memo)

  const grantIds = new Set(base.grantsAffected.map(grant => grant.id))
  const promptTargetGrants: GrantModelReference[] = []
  for (const grant of await memo.listPromptTargetGrants(provider, model)) {
    if (grantIds.has(grant.id)) continue
    grantIds.add(grant.id)
    promptTargetGrants.push({
      id: grant.id,
      recipeNamespace: grant.recipeNamespace,
      recipeName: grant.recipeName,
      capabilityFamily: grant.capabilityFamily,
    })
  }
  const impact: ModelImpact = {
    ...base,
    grantsAffected: [...base.grantsAffected, ...promptTargetGrants],
  }

  const implicitHosts: ObjectRef[] = []
  if (CATALOG_PROVIDERS.includes(provider)) {
    const explicitHosts = new Set(impact.hostsAffected.map(refKey))
    for (const namespace of memo.hostNamespaces) {
      for (const host of await memo.listHostsInNamespace(namespace)) {
        if (!isPlainObject(host) || !isAllModelsHostOf(host.spec, provider)) continue
        const ref = refOf(host, namespace)
        if (explicitHosts.has(refKey(ref))) continue
        implicitHosts.push(ref)
      }
    }
  }

  const recipes: ObjectRef[] = []
  const seenRecipes = new Set<string>()
  for (const namespace of memo.recipeNamespaces) {
    const listed = await memo.listRecipesInNamespace(namespace)
    const uidByName = recipeUidsByName(listed)
    for (const recipe of listed) {
      if (!isPlainObject(recipe) || !recipeModelNames(recipe.spec).includes(model)) continue
      const ref = recipeIdentity(recipe, namespace, uidByName)
      if (seenRecipes.has(refKey(ref))) continue
      seenRecipes.add(refKey(ref))
      recipes.push(ref)
    }
  }

  const explicit =
    impact.hostsAffected.length > 0 || impact.grantsAffected.length > 0 || recipes.length > 0
  return { impact, explicit, implicitHosts, recipes }
}

/** True when the prune must leave the model alone: an explicit consumer or an all-models Host. */
export function modelHasConsumers(consumers: ModelConsumers): boolean {
  return consumers.explicit || consumers.implicitHosts.length > 0
}

/**
 * The fingerprint an acknowledgement is bound to: explicit consumers only, by
 * identity and without role, so moving a model from primary to fallback in the
 * same Host does not reopen a reviewed item, and a new all-models Host does not
 * either. Sorted and deduplicated so it is comparable as a set.
 */
export function explicitConsumerKeys(consumers: ModelConsumers): string[] {
  const keys = new Set<string>()
  for (const host of consumers.impact.hostsAffected) keys.add(`host:${refKey(host)}`)
  for (const grant of consumers.impact.grantsAffected) keys.add(`grant:${grant.id}`)
  for (const recipe of consumers.recipes) keys.add(`recipe:${refKey(recipe)}`)
  return [...keys].sort()
}
