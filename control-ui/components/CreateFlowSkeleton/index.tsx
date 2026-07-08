'use client'

import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { cn } from '@lib/cn'
import { CREATE_FLOW_SKELETON_ICONS } from './constants'
import type { CreateFlowLoadingScreenProps, CreateFlowSkeletonProps } from './types'

export function CreateFlowSkeleton({
  backDisabled = true,
  backLabel,
  className,
  iconKey,
  onBack = () => {},
  stepFlowClassName,
  steps,
  subtitle,
  title,
}: CreateFlowSkeletonProps) {
  return (
    <CreateFlowPanel
      className={className}
      header={
        <CreatePageHeader
          icon={CREATE_FLOW_SKELETON_ICONS[iconKey]}
          title={title}
          subtitle={subtitle}
          backLabel={backLabel}
          onBack={onBack}
          backDisabled={backDisabled}
        />
      }
    >
      <div
        className={cn('cu-agent-create-wizard cu-agent-create-skeleton', stepFlowClassName)}
        aria-label={`${title} loading`}
        aria-busy="true"
      >
        <aside className="cu-agent-step-rail" aria-hidden="true">
          {steps.map((label, index) => (
            <div
              key={label}
              className="cu-agent-step-rail__item cu-agent-step-rail__item--skeleton"
              data-state={index === 0 ? 'current' : 'upcoming'}
            >
              <span className="cu-agent-step-rail__number">{index + 1}</span>
              <span className="cu-agent-step-rail__copy">
                <span className="cu-skeleton cu-agent-create-skeleton__rail-title" />
                <span className="cu-skeleton cu-agent-create-skeleton__rail-copy" />
              </span>
            </div>
          ))}
        </aside>

        <section className="cu-agent-step-panel" aria-hidden="true">
          <div className="cu-agent-step-panel__header">
            <span className="cu-skeleton cu-agent-create-skeleton__title" />
            <span className="cu-skeleton cu-agent-create-skeleton__subtitle" />
          </div>
          <div className="cu-agent-step-panel__body">
            <div className="cu-form-stack cu-agent-form-stack">
              <span className="cu-skeleton cu-agent-create-skeleton__label" />
              <span className="cu-skeleton cu-agent-create-skeleton__input" />
              <span className="cu-skeleton cu-agent-create-skeleton__meta" />
              <div className="cu-agent-create-skeleton__info">
                <span className="cu-skeleton cu-agent-create-skeleton__icon" />
                <span className="cu-skeleton cu-agent-create-skeleton__info-line" />
                <span className="cu-skeleton cu-agent-create-skeleton__info-line cu-agent-create-skeleton__info-line--short" />
              </div>
            </div>
          </div>
          <div className="cu-agent-create-skeleton__actions">
            <span className="cu-skeleton cu-agent-create-skeleton__button" />
            <span className="cu-skeleton cu-agent-create-skeleton__button" />
          </div>
        </section>
      </div>
    </CreateFlowPanel>
  )
}

export function CreateFlowLoadingScreen(props: CreateFlowLoadingScreenProps) {
  return (
    <DashboardLayout isDetailPage>
      <CreateFlowSkeleton {...props} />
    </DashboardLayout>
  )
}
