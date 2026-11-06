'use client'

import React from 'react'
import { remoteOAuthProvenanceBadge } from '@lib/oauthInstall'
import type { RemoteOAuthProvenanceBadgeProps } from './types'

export function RemoteOAuthProvenanceBadge(props: RemoteOAuthProvenanceBadgeProps) {
  const badge = remoteOAuthProvenanceBadge(props)
  return (
    <span
      className={`cu-registry-chip cu-registry-chip--quality-${badge.tone}`}
      title={badge.title}
    >
      {badge.label}
    </span>
  )
}
