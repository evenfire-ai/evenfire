import type { ReactNode } from 'react'

export type CreateStepFlowStep = {
  description: string
  title: string
  subtitle: string
}

export type CreateStepFlowProps = {
  ariaLabel: string
  children: ReactNode
  className?: string
  currentStep: number
  onStepChange: (step: number) => void
  steps: readonly CreateStepFlowStep[]
  stepLabels: readonly string[]
  titleId: string
  canSelectStep?: (step: number) => boolean
  showHeader?: boolean
}
