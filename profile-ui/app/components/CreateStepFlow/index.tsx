'use client'

import { cn } from '@lib/cn'
import type { CreateStepFlowProps } from './types'

export function CreateStepFlow({
  ariaLabel,
  canSelectStep = () => true,
  children,
  className,
  currentStep,
  onStepChange,
  showHeader = true,
  steps,
  stepLabels,
  titleId,
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
              className="cu-agent-step-rail__item"
              data-state={
                index === currentStep ? 'current' : index < currentStep ? 'complete' : 'upcoming'
              }
              disabled={!selectable}
              onClick={() => {
                if (selectable) onStepChange(index)
              }}
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
          : { 'aria-label': currentStepDetails?.title || 'Step' })}
      >
        {showHeader ? (
          <div className="cu-agent-step-panel__header">
            <h3 id={titleId} className="cu-agent-step-panel__title">
              {currentStepDetails?.title}
            </h3>
            <p className="cu-agent-step-panel__subtitle">{currentStepDetails?.subtitle}</p>
          </div>
        ) : null}
        <div className="cu-agent-step-panel__body">{children}</div>
      </section>
    </div>
  )
}
