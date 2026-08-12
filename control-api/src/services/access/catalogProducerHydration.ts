import type { CatalogFamily, CatalogRequestContext } from './catalogContracts.js'
import { CatalogProducerContractError } from './catalogProducerErrors.js'

/** Validates the ordered canonical keys passed to selected-ID hydration. */
export function validateHydrationKeys(input: {
  context: CatalogRequestContext
  family: CatalogFamily
  keys: readonly (readonly [string, CatalogFamily, string])[]
}): string[] {
  if (input.keys.length > input.context.budget.limits.keyCandidatesPerCall) {
    throw new CatalogProducerContractError('hydrate_key_count_exceeded')
  }
  const logicalIds: string[] = []
  for (const key of input.keys) {
    if (key[0] !== input.context.environmentId || key[1] !== input.family || !key[2]) {
      throw new CatalogProducerContractError('hydrate_key_mismatch')
    }
    if (logicalIds.at(-1) !== undefined && key[2] <= logicalIds.at(-1)!) {
      throw new CatalogProducerContractError('hydrate_keys_not_strictly_ordered')
    }
    logicalIds.push(key[2])
  }
  return logicalIds
}
