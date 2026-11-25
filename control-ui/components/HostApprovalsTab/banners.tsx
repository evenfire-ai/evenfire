'use client'

import React from 'react'
import { IconInfoCircle } from '@components/icons'
import type { HostResource } from '@lib/api'
import { effectiveApproval } from '@lib/approvalEffective'
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

/** What `manifestSignal` found: no manifest, or one, with its approval values when it left them. */
export type ManifestSignal =
  | { managed: false }
  | { managed: true; values: Record<string, unknown> | null }

const LAST_APPLIED_ANNOTATION = 'kubectl.kubernetes.io/last-applied-configuration'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The `spec.approval` a client-side apply recorded, or undefined when it recorded none. */
function lastAppliedApproval(
  annotation: unknown
): { found: false } | { found: true; values: Record<string, unknown> | null } {
  if (typeof annotation !== 'string') return { found: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(annotation)
  } catch {
    // Dropped on purpose: an annotation that is not JSON is not a manifest's
    // record (nothing in it can be read as spec.approval), and this banner is
    // advice, so it never blocks the page. A server-side apply entry in
    // managedFields can still show the banner.
    return { found: false }
  }
  const spec = isRecord(parsed) ? parsed.spec : undefined
  if (!isRecord(spec) || !Object.hasOwn(spec, 'approval')) return { found: false }
  return { found: true, values: isRecord(spec.approval) ? spec.approval : null }
}

/** Whether a managedFields entry is a server-side apply that owns `spec.approval`. */
function appliesApproval(entry: unknown): boolean {
  if (!isRecord(entry) || entry.operation !== 'Apply') return false
  const fields = isRecord(entry.fieldsV1) ? entry.fieldsV1['f:spec'] : undefined
  return isRecord(fields) && Object.hasOwn(fields, 'f:approval')
}

/**
 * Spec §6.7: whether a deployment manifest manages this agent's approval
 * settings. Either signal counts: a `last-applied-configuration` annotation
 * that holds `spec.approval` (client-side apply; its values show), or a
 * managedFields entry of operation `Apply` that owns `f:spec.f:approval`
 * (server-side apply; no values). `Update` entries never count, so a Host
 * edited through this UI or by `kubectl patch` shows nothing.
 */
export function manifestSignal(host: HostResource): ManifestSignal {
  const metadata: Record<string, unknown> = isRecord(host.metadata) ? host.metadata : {}
  const annotations = metadata.annotations
  const applied = lastAppliedApproval(
    isRecord(annotations) ? annotations[LAST_APPLIED_ANNOTATION] : undefined
  )
  if (applied.found) return { managed: true, values: applied.values }
  const fields = metadata.managedFields
  if (Array.isArray(fields) && fields.some(appliesApproval)) return { managed: true, values: null }
  return { managed: false }
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
