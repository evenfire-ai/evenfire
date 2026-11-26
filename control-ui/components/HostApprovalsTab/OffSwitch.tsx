'use client'

import React, { useSyncExternalStore } from 'react'
import { Button } from '@components/ui'
import { approvalBlockOf, effectiveApproval } from '@lib/approvalEffective'
import { skipOverrides } from '@lib/approvalToolCatalog'
import { isSettingManual, subscribeSettingManual } from '@lib/hostApprovalSave'
import { NeverAskList } from './ReadViews'
import { switchManifestWarning } from './banners'
import {
  ALREADY_MANUAL_TEXT,
  APPLIED_AT_NEXT_CALL_TEXT,
  APPROVALS_OFF_NOTE,
  CHATS_ALREADY_GAVE_TEXT,
  CLUSTER_DEFAULT_SKIP_CLAUSE,
  HOW_TO_CHANGE_LABEL,
  HOW_TO_CHANGE_URL,
  KILL_SWITCH_HOW_TO_URL,
  MANUAL_SAVED_TEXT,
  NEVER_ASK_LISTED_BELOW_TEXT,
  NO_EFFECT_WHEN_OFF_TEXT,
  NO_SKIP_TEXT,
  OFF_SWITCH_FALLBACK_INTRO,
  PER_TOOL_SECTION_ID,
  SETTING_MANUAL_LABEL,
  SET_MANUAL_LABEL,
  SKIP_TOOLS_TEXT,
  STILL_RUNNING_TEXT,
  offSwitchFailedText,
} from './constants'
import type { FailedResultProps, OffSwitchProps, SavedResultProps } from './types'

/**
 * Step 7's message, verbatim, for a run that stored Manual or found it. Its
 * Skip list comes from the switch's own read or write (`outcome.stored`),
 * never from the page, with every stored key set to Skip whatever its name
 * (spec §6.11). The cluster-default clause shows only when that Host has no
 * approval settings of its own, as the clause says (Ruling 48(a)): the test
 * the protocol's `inherited` makes, which also covers a `saved` run whose
 * last read found the block gone. The never-ask list, the producer fixture's
 * (spec §6.11), is "listed below", in the read view's disclosure (Ruling
 * 48(b)).
 */
function SavedMessage({ outcome }: SavedResultProps) {
  const block = approvalBlockOf(outcome.stored)
  const listed = skipOverrides(effectiveApproval(block).tools).join(', ') || NO_SKIP_TEXT
  const skip = block === undefined ? `${listed}; ${CLUSTER_DEFAULT_SKIP_CLAUSE}` : listed
  const lead = [
    MANUAL_SAVED_TEXT,
    ...(outcome.kind === 'already' ? [ALREADY_MANUAL_TEXT] : []),
    APPLIED_AT_NEXT_CALL_TEXT,
  ].join(' ')
  return (
    <p>
      {`${lead} `}
      <a className="cu-link" href={KILL_SWITCH_HOW_TO_URL} rel="noreferrer" target="_blank">
        {STILL_RUNNING_TEXT}
      </a>
      {': '}
      <a className="cu-link" href={`#${PER_TOOL_SECTION_ID}`}>
        {SKIP_TOOLS_TEXT}
      </a>
      {` (${skip}); ${NEVER_ASK_LISTED_BELOW_TEXT}; ${CHATS_ALREADY_GAVE_TEXT} ${NO_EFFECT_WHEN_OFF_TEXT}`}
    </p>
  )
}

/**
 * Step 7's manifest addition, worded as the manifest banner (spec §6.7,
 * Ruling 47), from the switch's own read before its write, or its write's
 * answer (`switchManifestWarning`, which the root toast also uses).
 */
function ManifestWarning({ outcome }: SavedResultProps) {
  const warning = switchManifestWarning(outcome)
  if (warning === null) return null
  return <p className="cu-host-approvals-tab__switch-manifest">{warning}</p>
}

/**
 * Step 6: a failed run's last error and the how-to's kubectl command. An
 * alert, which is announced as it appears.
 */
function FailedResult({ outcome }: FailedResultProps) {
  return (
    <div className="cu-banner cu-banner--error cu-host-approvals-tab__switch-result" role="alert">
      <p>{offSwitchFailedText(outcome.message)}</p>
      <p>{OFF_SWITCH_FALLBACK_INTRO}</p>
      <pre className="cu-code-block">{outcome.fallback}</pre>
    </div>
  )
}

/**
 * "Set to Manual now" (spec §6.3), with PR A's static line and its link
 * (spec §6.2, §6.10), and the outcome of the last run this tab showed (steps
 * 6 and 7).
 *
 * It needs no loaded data, so the tab renders it in every state, and it is
 * never disabled from the page's copy of the ceiling (C6). While a run goes
 * on for the agent, started in this tab or another, every tab that shows the
 * agent reads "Setting Manual…" and ignores a press (step 1, R19). The button
 * then has `aria-disabled`, not `disabled`, so the admin who pressed it keeps
 * the focus, as with the tab's Retry.
 *
 * The message's polite live region is mounted with the switch and stays
 * empty until a run settles here, so the message is announced as it appears
 * (review finding 1): a polite region inserted with its text already in it is
 * not reliably announced. It holds the message only. The never-ask disclosure
 * and the manifest warning sit beside it, so opening the disclosure re-reads
 * nothing. Their box takes the result's style only while it shows one. A
 * failure is an alert of its own.
 */
export function OffSwitch({ host, result, onSetManual }: OffSwitchProps) {
  const running = useSyncExternalStore(
    subscribeSettingManual,
    () => isSettingManual(host),
    () => false
  )
  const saved = result !== null && result.kind !== 'failed' ? result : null
  return (
    <div className="cu-host-approvals-tab__switch">
      <div className="cu-host-approvals-tab__switch-bar">
        <Button
          aria-disabled={running || undefined}
          size="sm"
          onClick={running ? undefined : onSetManual}
        >
          {running ? SETTING_MANUAL_LABEL : SET_MANUAL_LABEL}
        </Button>
        <p className="cu-host-approvals-tab__switch-note">
          <span>{APPROVALS_OFF_NOTE}</span>{' '}
          <a className="cu-link" href={HOW_TO_CHANGE_URL} rel="noreferrer" target="_blank">
            {HOW_TO_CHANGE_LABEL}
          </a>
        </p>
      </div>
      <div
        className={
          saved ? 'cu-banner cu-banner--info cu-host-approvals-tab__switch-result' : undefined
        }
      >
        <div aria-live="polite" role="status">
          {saved ? <SavedMessage outcome={saved} /> : null}
        </div>
        {saved ? (
          <>
            <NeverAskList />
            <ManifestWarning outcome={saved} />
          </>
        ) : null}
      </div>
      {result?.kind === 'failed' ? <FailedResult outcome={result} /> : null}
    </div>
  )
}
