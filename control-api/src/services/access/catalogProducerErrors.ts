/** Typed contract failures shared by the catalog-producer boundaries. */
export class CatalogProducerContractError extends Error {
  constructor(readonly code: string) {
    super(`Catalog producer contract violation: ${code}`)
    this.name = 'CatalogProducerContractError'
  }
}
