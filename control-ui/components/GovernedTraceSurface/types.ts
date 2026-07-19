import type { ReactNode } from 'react'
import type { GovernedEventFamily, GovernedTraceEvent } from '@lib/governedTrace'

export type GovernedTraceSurfaceProps = {
  family: GovernedEventFamily
  title: string
  subtitle: string
  readPath: string
  detail?: boolean
  detailAddon?: ReactNode
}

export type TraceDetailHrefInput = Pick<
  GovernedTraceEvent,
  'correlationRef' | 'eventFamily' | 'eventId' | 'hostRef' | 'recipeName' | 'recipeNamespace'
>
