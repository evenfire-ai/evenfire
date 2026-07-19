import type { GovernedTraceSessionSummaryV1 } from '@lib/governedTrace'

export type SessionDecisionActorProps = {
  actorSub: string | null
  fallback: string
  human: GovernedTraceSessionSummaryV1['human']
}
