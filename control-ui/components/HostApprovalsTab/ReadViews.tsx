'use client'

import React, { useId } from 'react'
import { CLUSTER_DEFAULT_TEXT } from '@components/HostApprovalSection/constants'
import type { ApprovalCeiling } from '@components/HostApprovalSection/types'
import type { HostResource } from '@lib/api'
import { type EffectiveApproval, approvalBlockOf, effectiveApproval } from '@lib/approvalEffective'
import { neverAskTools, skipOverrides } from '@lib/approvalToolCatalog'
import { getProviderDisplayLabel } from '@lib/llm'
import {
  ALLOW_ALL_DESCRIPTION,
  APPROVAL_MODES_TITLE,
  APPROVERS_LABEL,
  AUTO_DESCRIPTION,
  CHANNELS_ENABLED_LABEL,
  CHANNEL_LABELS,
  CHANNEL_ORDER,
  CHANNEL_SWITCHES_LABEL,
  CLUSTER_DEFAULT_SKIP_TEXT,
  DESKTOP_SWITCH_TEXT,
  EMAIL_APPROVER_NOTE,
  HIGHEST_MODE_LABEL,
  JUDGE_DEFAULT_MODEL,
  JUDGE_LABEL,
  JUDGE_NOTE,
  MODE_LABELS,
  NO_APPROVERS_TEXT,
  NO_SKIP_TEXT,
  POLICY_LABEL,
  WHO_CAN_RAISE_TITLE,
  manualDescription,
  neverAskSummary,
  onOff,
  policyText,
} from './constants'
import type { ApprovalModesViewProps, ReadRowProps, ReadViewProps } from './types'

/** Every tool chat registers that runs without a card (the producer fixture, spec §6.11). */
const NEVER_ASK_TOOLS = neverAskTools()

function ReadRow({ label, value, notes = [], children }: ReadRowProps) {
  return (
    <div className="cu-host-approvals-tab__row">
      <dt className="cu-host-approvals-tab__label">{label}</dt>
      <dd className="cu-host-approvals-tab__detail">
        <span className="cu-host-approvals-tab__value">{value}</span>
        {notes.map(note => (
          <p className="cu-host-approvals-tab__note" key={note}>
            {note}
          </p>
        ))}
        {children}
      </dd>
    </div>
  )
}

/**
 * What the ceiling lets run (spec §6.2). Manual names the Skip overrides; an
 * agent with no approval settings of its own takes its tools from the cluster
 * default, which the page cannot show.
 */
function modeDescription(
  ceiling: ApprovalCeiling,
  inherited: boolean,
  tools: EffectiveApproval['tools']
): string {
  if (ceiling === 'auto') return AUTO_DESCRIPTION
  if (ceiling === 'allow_all') return ALLOW_ALL_DESCRIPTION
  if (inherited) return manualDescription(CLUSTER_DEFAULT_SKIP_TEXT)
  return manualDescription(skipOverrides(tools).join(', ') || NO_SKIP_TEXT)
}

function NeverAskList() {
  return (
    <details className="cu-advanced-details cu-host-approvals-tab__never-ask">
      <summary>{neverAskSummary(NEVER_ASK_TOOLS.length)}</summary>
      <ul className="cu-host-approvals-tab__tools">
        {NEVER_ASK_TOOLS.map(tool => (
          <li key={tool.name}>
            <code className="cu-host-approvals-tab__tool">{tool.name}</code>
            {tool.conditions ? (
              <span className="cu-host-approvals-tab__tool-conditions">{tool.conditions}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  )
}

/**
 * The Host's chat provider and its stored judge model (spec §6.10, PR A: no
 * badge). An absent provider is OpenAI, as the Models & creds tab reads it.
 */
function judgeText(host: HostResource, model: string | null): string {
  const provider = host.spec?.model?.provider
  const label = getProviderDisplayLabel(
    typeof provider === 'string' && provider.trim() ? provider.trim() : 'openai'
  )
  return `${label} · ${model ?? JUDGE_DEFAULT_MODEL}`
}

function channelSwitchesText(channels: EffectiveApproval['channels']): string {
  return [
    DESKTOP_SWITCH_TEXT,
    ...CHANNEL_ORDER.map(
      type => `${CHANNEL_LABELS[type]} ${onOff(channels[type].allowModeChange)}`
    ),
  ].join(' · ')
}

/**
 * Spec §6.2 "Approval modes": the ceiling and what it lets run, the shell
 * judge in Auto and Allow all, and the channels whose chats may change their
 * mode. An agent with no approval settings of its own is Manual: mcp-host
 * reads the ceiling and the channel switches from the agent's own block only.
 * Its heading, the tab's first, takes the focus from code only (Ruling 46).
 */
export function ApprovalModesView({ host, headingRef }: ApprovalModesViewProps) {
  const titleId = useId()
  const block = approvalBlockOf(host)
  const approval = effectiveApproval(block)
  const ceiling = approval.modeCeiling
  return (
    <section aria-labelledby={titleId} className="cu-host-approvals-tab__group">
      <h3 className="cu-host-approvals-tab__title" id={titleId} ref={headingRef} tabIndex={-1}>
        {APPROVAL_MODES_TITLE}
      </h3>
      <dl className="cu-host-approvals-tab__rows">
        <ReadRow
          label={HIGHEST_MODE_LABEL}
          notes={[modeDescription(ceiling, block === undefined, approval.tools)]}
          value={MODE_LABELS[ceiling]}
        >
          {ceiling === 'manual' ? <NeverAskList /> : null}
        </ReadRow>
        {ceiling === 'auto' || ceiling === 'allow_all' ? (
          <ReadRow
            label={JUDGE_LABEL}
            notes={[JUDGE_NOTE]}
            value={judgeText(host, approval.shellClassifierModel)}
          />
        ) : null}
        <ReadRow label={CHANNEL_SWITCHES_LABEL} value={channelSwitchesText(approval.channels)} />
      </dl>
    </section>
  )
}

/**
 * Spec §6.2 "Who can raise the mode from a channel": the policy, and each
 * channel's `enabled` (on or off) and approvers (approvers match by exact
 * string). An agent with no approval settings of its own takes the policy,
 * the approvers and `enabled` from the cluster default, one row each (spec
 * §6.6).
 */
export function WhoCanRaiseView({ host }: ReadViewProps) {
  const titleId = useId()
  const block = approvalBlockOf(host)
  const approval = effectiveApproval(block)
  return (
    <section aria-labelledby={titleId} className="cu-host-approvals-tab__group">
      <h3 className="cu-host-approvals-tab__title" id={titleId}>
        {WHO_CAN_RAISE_TITLE}
      </h3>
      <dl className="cu-host-approvals-tab__rows">
        {block === undefined ? (
          <>
            <ReadRow label={POLICY_LABEL} value={CLUSTER_DEFAULT_TEXT} />
            <ReadRow label={APPROVERS_LABEL} value={CLUSTER_DEFAULT_TEXT} />
            <ReadRow label={CHANNELS_ENABLED_LABEL} value={CLUSTER_DEFAULT_TEXT} />
          </>
        ) : (
          <>
            <ReadRow label={POLICY_LABEL} value={policyText(approval.policy)} />
            {CHANNEL_ORDER.map(type => {
              const { approvers, enabled } = approval.channels[type]
              const notes = [approvers.join(', ') || NO_APPROVERS_TEXT]
              if (type === 'email' && approvers.length > 0) notes.push(EMAIL_APPROVER_NOTE)
              return (
                <ReadRow
                  key={type}
                  label={CHANNEL_LABELS[type]}
                  notes={notes}
                  value={onOff(enabled)}
                />
              )
            })}
          </>
        )}
      </dl>
    </section>
  )
}
