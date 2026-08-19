import type { ModelGrantReference, ModelHostReference } from '@lib/api'

export type ModelReferencesProps = {
  hostsAffected: ModelHostReference[]
  grantsAffected: ModelGrantReference[]
}
