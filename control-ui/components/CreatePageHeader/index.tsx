'use client'

import React from 'react'
import type { CreatePageHeaderProps } from './types'

export function CreatePageHeader({
  actions,
  backDisabled = false,
  backLabel,
  icon,
  onBack,
  subtitle,
  title,
  titleActions,
}: CreatePageHeaderProps) {
  return (
    <div className="cu-create-top">
      <div>
        <div className="cu-create-top__title-row">
          <h2 className="cu-title cu-heading-with-icon cu-create-title">
            <span className="cu-heading-with-icon__icon" aria-hidden="true">
              {icon}
            </span>
            {title}
          </h2>
          {titleActions ? <div className="cu-create-top__title-actions">{titleActions}</div> : null}
        </div>
        {subtitle ? <p className="cu-subtitle">{subtitle}</p> : null}
      </div>
      <div className="cu-create-top__controls">
        {actions ? <div className="cu-create-top__actions">{actions}</div> : null}
        <button
          type="button"
          className="cu-btn cu-btn--ghost cu-btn--sm cu-create-back-btn"
          onClick={onBack}
          disabled={backDisabled}
        >
          {backLabel}
        </button>
      </div>
    </div>
  )
}
