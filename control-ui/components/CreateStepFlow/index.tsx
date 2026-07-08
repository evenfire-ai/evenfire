'use client'

import { cn } from '@lib/cn'
import type { CreateStepFlowProps } from './types'

export function CreateStepFlow({
  ariaLabel,
  children,
  className,
  currentStep,
  onStepChange,
  steps,
  stepLabels,
  titleId,
  canSelectStep = () => true,
  showHeader = true,
}: CreateStepFlowProps) {
  const currentStepDetails = steps[currentStep]

  return (
    <div className={cn('cu-agent-create-wizard', className)}>
      <aside className="cu-agent-step-rail" aria-label={ariaLabel}>
        {stepLabels.map((stepLabel, index) => {
          const selectable = canSelectStep(index)
          return (
            <button
              key={stepLabel}
              type="button"
              onClick={() => {
                if (selectable) onStepChange(index)
              }}
              disabled={!selectable}
              className="cu-agent-step-rail__item"
              data-state={
                index === currentStep ? 'current' : index < currentStep ? 'complete' : 'upcoming'
              }
            >
              <span className="cu-agent-step-rail__number">{index + 1}</span>
              <span className="cu-agent-step-rail__copy">
                <span className="cu-agent-step-rail__title">{stepLabel}</span>
                <span className="cu-agent-step-rail__description">
                  {steps[index]?.description ?? ''}
                </span>
              </span>
            </button>
          )
        })}
      </aside>

      <section
        className={cn('cu-agent-step-panel', !showHeader && 'cu-agent-step-panel--headerless')}
        {...(showHeader
          ? { 'aria-labelledby': titleId }
          : { 'aria-label': currentStepDetails.title })}
      >
        {showHeader ? (
          <div className="cu-agent-step-panel__header">
            <h3 id={titleId} className="cu-agent-step-panel__title">
              {currentStepDetails.title}
            </h3>
            <p className="cu-agent-step-panel__subtitle">{currentStepDetails.subtitle}</p>
          </div>
        ) : null}
        <div className="cu-agent-step-panel__body">{children}</div>
      </section>
    </div>
  )
}
