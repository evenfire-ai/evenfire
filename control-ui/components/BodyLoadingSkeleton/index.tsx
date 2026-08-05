'use client'

import type { ReactNode } from 'react'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { cn } from '@lib/cn'

type FormSectionsSkeletonProps = {
  className?: string
  label: string
  primaryActionLabel: string
  secondaryActionLabel?: string
  sections?: number
}

type BodyLoadingSkeletonProps = {
  backLabel: string
  icon: ReactNode
  primaryActionLabel: string
  secondaryActionLabel?: string
  sections?: number
  subtitle: string
  title: string
  titleActions?: ReactNode
}

export function FormSectionsSkeleton({
  className,
  label,
  primaryActionLabel,
  secondaryActionLabel = 'Cancel',
  sections = 2,
}: FormSectionsSkeletonProps) {
  return (
    <div
      className={cn('cu-create-content cu-body-loading-skeleton', className)}
      role="status"
      aria-label={`${label} loading`}
      aria-busy="true"
    >
      {Array.from({ length: sections }, (_, sectionIndex) => (
        <section className="cu-body-loading-skeleton__section" key={sectionIndex}>
          <span className="cu-skeleton cu-body-loading-skeleton__heading" />
          <span className="cu-skeleton cu-body-loading-skeleton__line" />
          <div className="cu-body-loading-skeleton__fields">
            <span className="cu-skeleton cu-body-loading-skeleton__field" />
            <span className="cu-skeleton cu-body-loading-skeleton__field" />
          </div>
        </section>
      ))}
      <div className="cu-create-actions">
        <button type="button" className="cu-btn cu-btn--ghost" disabled>
          {secondaryActionLabel}
        </button>
        <button type="button" className="cu-btn cu-btn--primary" disabled>
          {primaryActionLabel}
        </button>
      </div>
    </div>
  )
}

export function BodyLoadingSkeleton({
  backLabel,
  icon,
  primaryActionLabel,
  secondaryActionLabel = 'Cancel',
  sections = 2,
  subtitle,
  title,
  titleActions,
}: BodyLoadingSkeletonProps) {
  return (
    <DashboardLayout isDetailPage>
      <CreateFlowPanel
        className="cu-detail-flow-panel"
        header={
          <CreatePageHeader
            icon={icon}
            title={title}
            subtitle={subtitle}
            backLabel={backLabel}
            backDisabled
            onBack={() => undefined}
            titleActions={titleActions}
          />
        }
      >
        {null}
      </CreateFlowPanel>
      <div className="cu-card">
        <FormSectionsSkeleton
          className="cu-card__body"
          label={title}
          primaryActionLabel={primaryActionLabel}
          secondaryActionLabel={secondaryActionLabel}
          sections={sections}
        />
      </div>
    </DashboardLayout>
  )
}
