import {
  FIRST_SAVE_POLICY_OPTIONS,
  RECONFIRM_NOT_SENT_MESSAGE,
} from '@components/HostApprovalSection/constants'
import type { ApprovalCeiling, FirstSavePolicy } from '@components/HostApprovalSection/types'
import type { EffectiveApproval } from '@lib/approvalEffective'
import {
  APPROVAL_CREATED_ELSEWHERE_MESSAGE,
  type OffSwitchOutcome,
  TOOLS_CHANGED_MESSAGE,
  type ToolsSaveOutcome,
  notStoredMessage,
} from '@lib/hostApprovalSave'
import type { ContinuationToast } from './types'

/** Spec §6.2: shown while the agent has no `spec.approval` of its own (Ruling 42). */
export const INHERITING_BANNER_TEXT =
  'This agent has no approval settings of its own. It uses the cluster default, which this page cannot show. Your first save here replaces it for this agent.'

/** Spec §6.7: what the banner says of the values when only the manifest's existence is known (server-side apply). */
export const MANIFEST_VALUES_NOT_SHOWN = 'set by a manifest (values not shown)'

/** The longest values text the manifest banner shows; a larger block ends in an ellipsis. */
export const MANIFEST_VALUES_CAP = 200

/**
 * Spec §6.7's manifest banner. `values` is the manifest's approval values as
 * text (see `manifestValuesText`), or null when the manifest left none to read
 * (server-side apply): that sentence keeps §6.7's phrase (Ruling 47).
 */
export function manifestBannerText(values: string | null): string {
  if (values === null) {
    return `A deployment manifest also sets these settings. The next deploy puts them back; they are ${MANIFEST_VALUES_NOT_SHOWN}. Change the manifest too.`
  }
  return `A deployment manifest also sets these settings. The next deploy puts back: ${values}. Change the manifest too.`
}

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
/** On an inheriting agent, the row that stands for every channel's approvers (spec §6.6). */
export const APPROVERS_LABEL = 'Approvers'
/**
 * On an inheriting agent, the row that stands for every channel's `enabled`
 * (spec §6.6), which the channel rows show as on or off.
 */
export const CHANNELS_ENABLED_LABEL = 'Channels on or off'
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

// ── Set to Manual now (spec §6.3) ──────────────────────────────────────────

export const SET_MANUAL_LABEL = 'Set to Manual now'
/** Spec §6.3 step 1: the switch's text in every tab of the agent while a run goes on. */
export const SETTING_MANUAL_LABEL = 'Setting Manual…'

/** Spec §6.2 and §6.10, verbatim: PR A's static line under the switch. */
export const APPROVALS_OFF_NOTE =
  'Has no effect if your platform team turned approvals off for the cluster.'
export const HOW_TO_CHANGE_LABEL = 'How to change these'

/**
 * The approvals how-to. Its text is Task 24's, which keeps these anchors. The
 * link is on `main`, as `TEAMS_SETUP_GUIDE_URL` is (app/constants/teams.ts).
 */
const APPROVALS_HOW_TO_URL =
  'https://github.com/evenfire-ai/evenfire/blob/main/docs/how-to/configure-approvals.md'
/** "How to change these": the how-to's Approval modes section, which sets each of them on the Host. */
export const HOW_TO_CHANGE_URL = `${APPROVALS_HOW_TO_URL}#approval-modes`
/** Spec §6.3 step 7: the how-to's kill-switch section, which says what the switch does not stop. */
export const KILL_SWITCH_HOW_TO_URL = `${APPROVALS_HOW_TO_URL}#kill-switch`

/** The per-tool section's anchor, which the switch's message links to. */
export const PER_TOOL_SECTION_ID = 'approval-per-tool-overrides'

// Spec §6.3 step 7, verbatim, in the order the message reads. The tab puts
// the lists between them and links two of them.
export const MANUAL_SAVED_TEXT = 'Manual is saved.'
/** Only for "Already Manual": no attempt of the run may have written. */
export const ALREADY_MANUAL_TEXT = 'It was already Manual.'
export const APPLIED_AT_NEXT_CALL_TEXT = 'Running chats apply it at their next tool call.'
export const STILL_RUNNING_TEXT = 'Still running without a card'
export const SKIP_TOOLS_TEXT = 'tools set to Skip'
/** Only for an agent with no approval settings of its own, which it names (Ruling 48(a)). */
export const CLUSTER_DEFAULT_SKIP_CLAUSE = `on an agent without its own settings, also ${CLUSTER_DEFAULT_SKIP_TEXT}`
/**
 * Step 7's never-ask list is "listed below", in the read view's disclosure
 * (Ruling 48(b), as Ruling 44(d) for the Manual row): about 50 tools, each
 * with its conditions, do not read well inline.
 */
export const NEVER_ASK_LISTED_BELOW_TEXT = 'tools that never ask (listed below)'
export const CHATS_ALREADY_GAVE_TEXT =
  "approvals chats already gave: 'Always allow' for every tool except shell, in every chat; 'Always allow' for shell and approvals for the rest of a task on shell_exec and http_request, in chats that were already in Manual; cron_manage approvals, in every chat; and scheduled tasks (on stateless agents they still ask before creating or enabling another schedule)."
export const NO_EFFECT_WHEN_OFF_TEXT =
  'This has no effect if your platform team turned approvals off for the cluster.'

/** `text` ending its own sentence: a full stop is added only when it has none. */
function asSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

/** Spec §6.3 step 6: a failed switch with its last error, in the tab that ran it (no agent named, C18). */
export function offSwitchFailedText(message: string): string {
  return `Manual was not saved. ${asSentence(message)}`
}

/** Spec §6.3 step 6: what comes before the how-to's kubectl command. */
export const OFF_SWITCH_FALLBACK_INTRO = 'To set Manual by hand, run:'

// ── Toasts (spec §6.4 step 10, §6.5 "After unmount", C18) ──────────────────

/**
 * The success toast of a save in the tab that ran it. It names no agent: the
 * tab shows it. Only a continuation's toast names the agent, so a save that
 * reports in the tab after the tab is gone cannot pass for a continuation.
 */
export const TOOLS_SAVED_TOAST = 'Per-tool overrides saved.'

/**
 * How long a per-tool continuation's warning or error, and a failed switch's
 * toast in the tab that ran it, stay: longer than a success, to be read. A
 * switch's failure continuation stays longer still (below).
 */
export const CONTINUATION_PROBLEM_DURATION_MS = 8000

/**
 * How long the root toast of a switch that failed after its tab was left
 * stays (review minor 5). It carries the kubectl fallback, which no tab shows
 * then, so it stays long enough to copy; Toast has no persistent mode.
 */
export const SWITCH_FAILURE_CONTINUATION_DURATION_MS = 30_000

/**
 * How long the root toast of a switch that saved Manual, or found it, after
 * its tab was left stays (ruling 81). It carries step 7's caveat on what still
 * runs without a card and, on an agent a manifest sets, the manifest warning,
 * which Toast's 3.5 s default leaves no time to read.
 */
export const SWITCH_SUCCESS_CONTINUATION_DURATION_MS = 15_000

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

/**
 * Spec §6.3 step 7: a failed switch always also goes to the root toast. In the
 * tab that ran it, which shows the failure itself, the toast names no agent.
 */
export function offSwitchFailedToast(message: string): ContinuationToast {
  return problem(offSwitchFailedText(message))
}

/**
 * Spec §6.3 step 7, short for a toast: what Manual still lets run without a
 * card, every kind step 7 lists, and where the agent's tools are listed. A
 * success never reads as "nothing runs unattended now" (review I-1).
 */
export const SWITCH_TOAST_STILL_RUNNING_TEXT = `${STILL_RUNNING_TEXT}: ${SKIP_TOOLS_TEXT}, tools that never ask, approvals chats already gave and scheduled tasks; the agent's Approvals tab lists the tools.`

/**
 * Spec §6.3 step 7: the root toast for a switch whose tab unmounted or now
 * shows another agent: every outcome, named after the agent. A success says
 * what still runs without a card, and adds the manifest warning
 * (`switchManifestWarning`) when a manifest sets the agent's settings, so it
 * stays longer than other successes (`SWITCH_SUCCESS_CONTINUATION_DURATION_MS`).
 * A failure carries the kubectl fallback, since no tab shows it, and stays
 * longer than other problems (`SWITCH_FAILURE_CONTINUATION_DURATION_MS`).
 */
export function offSwitchContinuationToast(
  host: string,
  outcome: OffSwitchOutcome,
  manifestWarning: string | null
): ContinuationToast {
  const after = [SWITCH_TOAST_STILL_RUNNING_TEXT, ...(manifestWarning ? [manifestWarning] : [])]
  switch (outcome.kind) {
    case 'saved':
      return {
        message: [`Manual is saved for agent ${host}.`, APPLIED_AT_NEXT_CALL_TEXT, ...after].join(
          ' '
        ),
        options: { tone: 'success', durationMs: SWITCH_SUCCESS_CONTINUATION_DURATION_MS },
      }
    case 'already':
      return {
        message: [
          `Manual is saved for agent ${host}.`,
          ALREADY_MANUAL_TEXT,
          APPLIED_AT_NEXT_CALL_TEXT,
          ...after,
        ].join(' '),
        options: { tone: 'success', durationMs: SWITCH_SUCCESS_CONTINUATION_DURATION_MS },
      }
    case 'failed':
      return {
        message: `Manual was not saved for agent ${host}. ${asSentence(outcome.message)} ${OFF_SWITCH_FALLBACK_INTRO} ${outcome.fallback}`,
        options: { tone: 'error', durationMs: SWITCH_FAILURE_CONTINUATION_DURATION_MS },
      }
  }
}
