import {
  type CanonicalActionTarget,
  canonicalActionTargetJson,
  hashActionTarget,
} from '@clerum/action-context-contracts'

export type ValidatedOperationTarget = Readonly<Record<string, string>> | null

export function stableOperationTarget(target: ValidatedOperationTarget): string {
  return JSON.stringify(
    target
      ? Object.fromEntries(
          Object.entries(target).sort(([left], [right]) => left.localeCompare(right))
        )
      : null
  )
}

export function stableActionOperationTarget(target: CanonicalActionTarget): string {
  return canonicalActionTargetJson(target)
}

export function actionOperationTargetHash(target: CanonicalActionTarget): string {
  return hashActionTarget(target)
}
