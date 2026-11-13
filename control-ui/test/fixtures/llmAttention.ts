/**
 * Producer fixture — the body control-api's `GET /admin/attention` returns.
 *
 * control-api is not importable from this package, so this comes from the wire
 * file control-api generates against real PostgreSQL with the real catalog sync,
 * route and Host reference producer:
 * control-api/test/contracts.llmAttention.wire.realPostgres.integration.test.ts →
 * control-api/test/fixtures/wire/llmAttention.wire.json. Only models somebody uses
 * are flagged: it holds two `stale_model_referenced` items (one named by a Host,
 * one offered only through an all-models Host, role `implicit`) and one
 * `deprecated_model_enabled` with its references. Every item carries `episode`
 * and `consumerKeys`. Never build an item by hand: a state the file lacks is
 * added to the generator.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type AttentionWire = {
  items: Array<Record<string, unknown> & { kind: string; provider: string; model: string }>
  generatedAt: string
}

const WIRE = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../control-api/test/fixtures/wire/llmAttention.wire.json'),
    'utf8'
  )
) as AttentionWire

/** The raw generated body. A copy, so a test that mutates it cannot leak. */
export function attentionWireBody(): AttentionWire {
  return structuredClone(WIRE)
}

/** The raw body keeping only items of the given kinds. */
export function attentionWireBodyOf(...kinds: string[]): AttentionWire {
  const body = attentionWireBody()
  return { ...body, items: body.items.filter(item => kinds.includes(item.kind)) }
}

type AttentionWireItem = AttentionWire['items'][number]

/**
 * A generated item as the feed returns it with `includeAcknowledged=1` once the
 * operator acknowledged it: the producer only adds `acknowledged: true` to the
 * item it would otherwise omit (llmAttention.ts `itemFor`), every other field is
 * unchanged. The wire file is generated without acknowledgements, so this is the
 * one field derived here; extend the generator to replace it.
 */
export function acknowledgedWireItem(item: AttentionWireItem): AttentionWireItem {
  return { ...structuredClone(item), acknowledged: true }
}

/**
 * A generated item for a model a WorkflowRecipe also names: the producer adds
 * `recipesAffected` (an array of `{ namespace, name }`) only when the list is
 * non-empty (llmAttention.ts `itemFor`), and a recipe is an explicit consumer,
 * so its `recipe:<namespace>/<name>` key also joins the sorted, deduplicated
 * `consumerKeys` (llmModelConsumers.ts `explicitConsumerKeys`). The generator has
 * no recipe consumer yet, so both fields are derived here; extend the generator
 * to replace it.
 */
export function withRecipesWireItem(
  item: AttentionWireItem,
  recipes: Array<{ namespace: string; name: string }>
): AttentionWireItem {
  const clone = structuredClone(item)
  const consumerKeys = [
    ...new Set([
      ...(clone.consumerKeys as string[]),
      ...recipes.map(recipe => `recipe:${recipe.namespace}/${recipe.name}`),
    ]),
  ].sort()
  return { ...clone, recipesAffected: recipes, consumerKeys }
}
