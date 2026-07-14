'use client'

import React from 'react'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { TabBar } from '@components/TabBar'
import { cn } from '@lib/cn'
import type { DetailPageShellProps } from './types'

export function DetailPageShell<T extends string>({
  actions,
  activeTab,
  backDisabled,
  backLabel,
  children,
  className,
  contentClassName,
  contentMode = 'card',
  error,
  icon,
  notice,
  onBack,
  overlays,
  onTabChange,
  subtitle,
  tabAriaLabel,
  tabClassName,
  tabs,
  title,
  titleActions,
}: DetailPageShellProps<T>) {
  return (
    <DashboardLayout isDetailPage>
      <CreateFlowPanel
        className={cn('cu-detail-flow-panel', className)}
        header={
          <CreatePageHeader
            actions={actions}
            backDisabled={backDisabled}
            backLabel={backLabel}
            icon={icon}
            onBack={onBack}
            subtitle={subtitle}
            title={title}
            titleActions={titleActions}
          />
        }
      >
        {tabs ? (
          <TabBar<T>
            ariaLabel={tabAriaLabel}
            activeValue={activeTab}
            className={tabClassName}
            onChange={onTabChange}
            options={tabs}
          />
        ) : null}
      </CreateFlowPanel>

      {notice}
      {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

      {contentMode === 'plain' ? (
        <div className={cn('cu-detail-content-stack', contentClassName)}>{children}</div>
      ) : (
        <div className={cn('cu-card', contentClassName)}>
          <div className="cu-card__body">{children}</div>
        </div>
      )}
      {overlays}
    </DashboardLayout>
  )
}
