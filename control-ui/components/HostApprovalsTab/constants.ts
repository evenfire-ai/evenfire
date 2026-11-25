import {
  FIRST_SAVE_POLICY_OPTIONS,
  RECONFIRM_NOT_SENT_MESSAGE,
} from '@components/HostApprovalSection/constants'
import type { ApprovalCeiling, FirstSavePolicy } from '@components/HostApprovalSection/types'
import type { EffectiveApproval } from '@lib/approvalEffective'
import {
  APPROVAL_CREATED_ELSEWHERE_MESSAGE,
  TOOLS_CHANGED_MESSAGE,
  type ToolsSaveOutcome,
  notStoredMessage,
} from '@lib/hostApprovalSave'
import type { ContinuationToast } from './types'

/** Spec §6.2: shown while the agent has no `spec.approval` of its own (Ruling 42; Task 21b moves it). */
export const INHERITING_BANNER_TEXT =
  'This agent has no approval settings of its own. It uses the cluster default, which this page cannot show. Your first save here replaces it for this agent.'

/** The status the tab shows while it loads an agent with nothing to show yet. */
export const LOADING_LABEL = 'Loading approval settings'

/** The tab's banner for its newest load's failure (spec §6.12), followed by Retry. */
export function loadErrorText(message: string): string {
  return `Could not load the approval settings: ${message}`
}

/** A load whose answer holds no Host of the agent asked for: shown like a failed load. */
export const NOT_THIS_AGENT_MESSAGE = "the answer did not hold this agent's settings."

// ── Approval modes (spec §6.2, §6.10) ──────────────────────────────────────

export const APPROVAL_MODES_TITLE = 'Approval modes'
export const HIGHEST_MODE_LABEL = 'Highest mode'

export const MODE_LABELS: Readonly<Record<ApprovalCeiling, string>> = {
  manual: 'Manual',
  auto: 'Auto',
  allow_all: 'Allow all',
}

/** Spec §6.2, verbatim. */
export const AUTO_DESCRIPTION =
  'Read-only shell runs after a model check. http_request runs with no card; unless your platform team set an HTTP allowlist, it can reach any public address.'

/** Spec §6.2, verbatim. */
export const ALLOW_ALL_DESCRIPTION =
  "Gated calls run with no card, including tools set to Required. cron_manage asks whenever Manual would; guardrail 'ask' rules still ask. For single-user agents."

/**
 * Spec §6.2's Manual description. `skip` is the Skip list; the tools that never
 * ask follow it in a list, from the same producer fixture as the off switch's
 * message (spec §6.11).
 */
export function manualDescription(skip: string): string {
  return `Gated tool calls ask, except tools set to Skip (${skip}), tools that never ask (listed below), and approvals chats already gave.`
}

/** The Skip list of an agent with approval settings and no Skip override. */
export const NO_SKIP_TEXT = 'none'

/**
 * The Skip list of an agent with no approval settings of its own: mcp-host
 * then reads the tools from the cluster default (spec §6.3 step 7's wording).
 */
export const CLUSTER_DEFAULT_SKIP_TEXT = 'any the cluster default sets to Skip, not shown here'

export function neverAskSummary(count: number): string {
  return `Tools that never ask (${count})`
}

/** Spec §6.10: PR A's shell judge row; shown only in Auto and Allow all. */
export const JUDGE_LABEL = 'Shell judge'
export const JUDGE_NOTE = 'Which model judges shell commands in Auto.'
/** The judge row's model when `shellClassifierModel` is absent. */
export const JUDGE_DEFAULT_MODEL = 'default'

export const CHANNEL_SWITCHES_LABEL = 'Channels that may change the mode'
/** Desktop chats change their mode in any case (spec §6.2). */
export const DESKTOP_SWITCH_TEXT = 'Desktop always'

/** The channel order of spec §6.2's layout. */
export const CHANNEL_ORDER = ['telegram', 'slack', 'teams', 'email'] as const

export const CHANNEL_LABELS: Readonly<Record<(typeof CHANNEL_ORDER)[number], string>> = {
  telegram: 'Telegram',
  slack: 'Slack',
  teams: 'Teams',
  email: 'Email',
}

export function onOff(value: boolean): string {
  return value ? 'on' : 'off'
}

// ── Who can raise the mode from a channel (spec §6.2) ──────────────────────

export const WHO_CAN_RAISE_TITLE = 'Who can raise the mode from a channel'
export const POLICY_LABEL = 'Policy'
/** The row that stands for every channel's approvers and `enabled` on an inheriting agent (spec §6.6). */
export const APPROVERS_LABEL = 'Approvers'
export const NO_APPROVERS_TEXT = 'No approvers listed'
/** Spec §6.2, verbatim: an email approver is matched on the From address. */
export const EMAIL_APPROVER_NOTE = 'Anyone who can send mail as this address counts.'
export const DESIGNATED_APPROVERS_LABEL = 'Listed approvers only'

function firstSavePolicyLabel(value: FirstSavePolicy): string {
  // Both policies have an option. Were one dropped, the raw value shows: a
  // wrong label never stands in for it.
  return FIRST_SAVE_POLICY_OPTIONS.find(option => option.value === value)?.label ?? value
}

/**
 * The policy as an admin reads it, with the first-save dialog's labels. An
 * unknown value refuses every channel approval in mcp-host, as `cli_only` does
 * (lib/approvalEffective).
 */
export function policyText(policy: EffectiveApproval['policy']): string {
  if (typeof policy === 'object') {
    return `Unknown policy "${policy.unknown}": nobody can approve from a channel`
  }
  if (policy === 'designated_approvers') return DESIGNATED_APPROVERS_LABEL
  return firstSavePolicyLabel(policy === 'open' ? 'channel_users' : 'cli_only')
}

// ── Toasts (spec §6.4 step 10, §6.5 "After unmount", C18) ──────────────────

/**
 * The success toast of a save in the tab that ran it. It names no agent: the
 * tab shows it. Only a continuation's toast names the agent, so a save that
 * reports in the tab after the tab is gone cannot pass for a continuation.
 */
export const TOOLS_SAVED_TOAST = 'Per-tool overrides saved.'

/** How long a continuation's warning or error stays: longer than a success, to be read. */
export const CONTINUATION_PROBLEM_DURATION_MS = 8000

function problem(message: string, tone: 'warning' | 'error' = 'error'): ContinuationToast {
  return { message, options: { tone, durationMs: CONTINUATION_PROBLEM_DURATION_MS } }
}

/** Why a save that stopped wrote nothing, as the section words it. */
function stopReason(
  outcome: Extract<
    ToolsSaveOutcome,
    { kind: 'conflict' | 'created_elsewhere' | 'refused' | 'error' | 'gave_up' }
  >
): string {
  switch (outcome.kind) {
    case 'conflict':
      return TOOLS_CHANGED_MESSAGE
    case 'created_elsewhere':
      return APPROVAL_CREATED_ELSEWHERE_MESSAGE
    case 'refused':
      return `The save was refused: ${outcome.errors
        .map(({ field, message }) => (field ? `${field}: ${message}` : message))
        .join('; ')}`
    case 'error':
    case 'gave_up':
      return outcome.message
  }
}

/**
 * The root toast for a save whose tab unmounted or now shows another agent
 * (spec §6.5): every outcome, named after the agent.
 */
export function continuationToast(host: string, outcome: ToolsSaveOutcome): ContinuationToast {
  switch (outcome.kind) {
    case 'saved':
      return {
        message: `Per-tool overrides saved for agent ${host}.`,
        options: { tone: 'success' },
      }
    case 'maybe':
      return problem(`Per-tool overrides for agent ${host}: ${outcome.message}`, 'warning')
    case 'reconfirm':
      return problem(`Per-tool overrides for agent ${host}: ${RECONFIRM_NOT_SENT_MESSAGE}`)
    case 'not_stored':
      return problem(`Per-tool overrides for agent ${host}: ${notStoredMessage(outcome.fields)}`)
    default:
      return problem(`Per-tool overrides for agent ${host} were not saved. ${stopReason(outcome)}`)
  }
}
