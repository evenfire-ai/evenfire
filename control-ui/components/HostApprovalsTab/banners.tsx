'use client'

import React from 'react'
import { IconInfoCircle } from '@components/icons'
import type { HostResource } from '@lib/api'
import { effectiveApproval } from '@lib/approvalEffective'
import { type ManifestSignal } from '@lib/hostManifestSignal'
import {
  CHANNEL_LABELS,
  CHANNEL_ORDER,
  INHERITING_BANNER_TEXT,
  MANIFEST_VALUES_CAP,
  MODE_LABELS,
  manifestBannerText,
  onOff,
  policyText,
} from './constants'

export { manifestSignal, type ManifestSignal } from '@lib/hostManifestSignal'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function approverCount(count: number): string {
  return `${count} ${count === 1 ? 'approver' : 'approvers'}`
}

/**
 * The manifest's approval values as an admin reads them: only the keys the
 * manifest sets, with this page's labels. Approver IDs never show, only a
 * count per channel; per-tool overrides show as a count. A long text is cut
 * at `MANIFEST_VALUES_CAP` characters.
 */
export function manifestValuesText(values: Record<string, unknown>): string {
  const approval = effectiveApproval(values)
  const parts: string[] = []
  if (Object.hasOwn(values, 'modeCeiling')) {
    parts.push(`Highest mode: ${MODE_LABELS[approval.modeCeiling]}`)
  }
  if (Object.hasOwn(values, 'defaultPolicy')) parts.push(`Policy: ${policyText(approval.policy)}`)
  const channels = isRecord(values.channels) ? values.channels : {}
  for (const type of CHANNEL_ORDER) {
    if (!Object.hasOwn(channels, type)) continue
    const channel = approval.channels[type]
    const noun = approverCount(channel.approvers.length)
    parts.push(
      `${CHANNEL_LABELS[type]}: ${onOff(channel.enabled)}, mode change ${onOff(channel.allowModeChange)}, ${noun}`
    )
  }
  const toolCount = Object.keys(approval.tools).length
  if (toolCount > 0)
    parts.push(`${toolCount} per-tool ${toolCount === 1 ? 'override' : 'overrides'}`)
  if (approval.shellClassifierModel !== null) {
    parts.push(`Shell judge: ${approval.shellClassifierModel}`)
  }
  const text = parts.length > 0 ? parts.join('; ') : 'an empty approval block'
  return text.length > MANIFEST_VALUES_CAP ? `${text.slice(0, MANIFEST_VALUES_CAP - 1)}…` : text
}

/**
 * Spec §6.7: the manifest banner's text for the values `manifestSignal`
 * found, or for none (null).
 */
export function manifestWarningText(values: Record<string, unknown> | null): string {
  return manifestBannerText(values === null ? null : manifestValuesText(values))
}

/** Spec §6.2: the agent has no `spec.approval` of its own (absent or null; `{}` is its own). */
export function InheritingBanner() {
  return (
    <div className="cu-banner cu-banner--info cu-host-approvals-tab__banner">
      <IconInfoCircle aria-hidden height={16} width={16} />
      <span>{INHERITING_BANNER_TEXT}</span>
    </div>
  )
}

/** Spec §6.7: a manifest also sets the settings, so the next deploy puts them back. */
export function ManifestBanner({ values }: { values: Record<string, unknown> | null }) {
  return (
    <div className="cu-banner cu-banner--info cu-host-approvals-tab__banner">
      <IconInfoCircle aria-hidden height={16} width={16} />
      <span>{manifestWarningText(values)}</span>
    </div>
  )
}
