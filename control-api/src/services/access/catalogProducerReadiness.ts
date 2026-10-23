import { revisionOfValues } from './authorizationRevision.js'
import type {
  CatalogFamily,
  CatalogOperationalSourceState,
  CatalogRequestContext,
  SafeCatalogPartialError,
} from './catalogContracts.js'
import type { OperationalSourceFamily } from './operationalAccessProjection.js'

function sourceRevision(states: readonly CatalogOperationalSourceState[]): string {
  return revisionOfValues(
    states.map(state => [state.family, state.generation, state.resourceVersion, state.status])
  )
}

/** Reports whether required operational sources can authoritatively produce a family page. */
export function operationalReadiness(
  context: CatalogRequestContext,
  family: CatalogFamily,
  required: readonly OperationalSourceFamily[]
):
  | Readonly<{ status: 'current'; sourceRevision: string }>
  | Readonly<{
      status: 'partial'
      sourceRevision: string
      errors: readonly SafeCatalogPartialError[]
    }> {
  if (required.length === 0) return { status: 'current', sourceRevision: 'database' }
  const states = required.flatMap(source => {
    const value = context.sourceStates.get(source)
    return value ? [value] : []
  })
  const errors: SafeCatalogPartialError[] = []
  for (const source of required) {
    const state = context.sourceStates.get(source)
    if (!state || state.status !== 'current') {
      errors.push(
        Object.freeze({
          producer: family,
          code:
            state?.status === 'relisting'
              ? 'operational_source_relisting'
              : 'operational_source_unavailable',
          retryable: true,
        })
      )
    }
  }
  return errors.length === 0
    ? { status: 'current', sourceRevision: sourceRevision(states) }
    : { status: 'partial', sourceRevision: sourceRevision(states), errors: Object.freeze(errors) }
}
