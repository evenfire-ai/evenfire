import type { ReactNode } from 'react'
import type { TourStepId } from '@hooks/domain/tourDeck'

/**
 * Everything the copy is allowed to name. Kept deliberately small: a step may
 * describe the environment, never the deployment behind it.
 */
export interface TourStepContext {
  /** The active environment's display name. */
  appName: string
  /** Agent display names, already resolved through `agentDisplayByName`. */
  agentLabels: string[]
}

export interface TourStepContent {
  title: string
  body: ReactNode
  illustration: ReactNode
}

export interface TourModalProps {
  context: TourStepContext
  onDismiss: () => void
}

export type { TourStepId }
