/**
 * Compatibility facade for catalog-producer callers. Each responsibility has
 * a focused owner; existing imports remain stable while callers migrate.
 */
export {
  type BoundedKeyArm,
  boundedKeyUnionSql,
  catalogTextAfterSql,
  catalogTextOrderSql,
} from './catalogProducerArms.js'
export { catalogQuery } from './catalogProducerDatabase.js'
export { CatalogProducerContractError } from './catalogProducerErrors.js'
export { listBoundedProducerKeys } from './catalogProducerHead.js'
export { validateHydrationKeys } from './catalogProducerHydration.js'
export { operationalReadiness } from './catalogProducerReadiness.js'
