'use client'

import React from 'react'
import { RemoteOAuthProvenanceBadge } from '@components/RemoteOAuthProvenanceBadge'
import {
  remoteOAuthManualNotice,
  remoteOAuthSlotNotice,
  remoteOAuthSlotStatusText,
} from '@lib/remoteOAuthSlots'
import { safeHttpsHref } from '@lib/vanillaMarkdown'
import type {
  RemoteOAuthEntryBadgesProps,
  RemoteOAuthNotInstallableProps,
  RemoteOAuthSlotListProps,
} from './types'

export { useRemoteOAuthSlotActions } from './useRemoteOAuthSlotActions'

/** The install slots of a remote-OAuth entry: one line per allowed grant scope. */
export function RemoteOAuthSlotList({ rows, renderActions }: RemoteOAuthSlotListProps) {
  return (
    <ul className="cu-remote-oauth-slots" aria-label="Install slots">
      {rows.map(row => {
        const notice = remoteOAuthSlotNotice(row.status)
        const manualNotice = remoteOAuthManualNotice(row)
        return (
          <li key={row.scope} className="cu-remote-oauth-slots__row">
            <div className="cu-remote-oauth-slots__line">
              <span className="cu-remote-oauth-slots__label">{row.label}</span>
              <span
                className={`cu-remote-oauth-slots__status cu-remote-oauth-slots__status--${row.status.kind}`}
              >
                {remoteOAuthSlotStatusText(row.status)}
              </span>
              {renderActions ? (
                <span className="cu-remote-oauth-slots__actions">{renderActions(row)}</span>
              ) : null}
            </div>
            {notice ? <p className="cu-remote-oauth-slots__notice">{notice}</p> : null}
            {manualNotice ? (
              <p className="cu-remote-oauth-slots__notice" role="note">
                {manualNotice}
              </p>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The subtype chip and, for an entry that needs the operator's own OAuth app, the
 * registration chip. The provider console link is a registry value, so it renders only
 * when it is an absolute https URL; a non-curator entry never carries one.
 */
export function RemoteOAuthEntryBadges({
  view,
  showProvenance = false,
}: RemoteOAuthEntryBadgesProps) {
  // Only the curator's console is linked: control-api strips it from other entries, and
  // the UI does not rely on that alone to send an operator to an org-supplied page.
  const consoleHref =
    view.trusted &&
    view.block.expectedRegistration === 'pre-registered' &&
    view.block.providerConsoleUrl
      ? safeHttpsHref(view.block.providerConsoleUrl)
      : null
  return (
    <span className="cu-remote-oauth-badges">
      <span className="cu-registry-chip cu-registry-chip--remote-oauth">Remote OAuth</span>
      {showProvenance ? (
        <RemoteOAuthProvenanceBadge
          block={view.block}
          publisher={view.publisher}
          trusted={view.trusted}
        />
      ) : null}
      {view.block.expectedRegistration === 'pre-registered' ? (
        <span className="cu-registry-chip cu-registry-chip--quality-unverified">
          Requires your OAuth app
        </span>
      ) : null}
      {consoleHref ? (
        <a
          className="cu-link cu-remote-oauth-badges__console"
          href={consoleHref}
          rel="noopener noreferrer"
          target="_blank"
          onClick={event => event.stopPropagation()}
        >
          Open {new URL(consoleHref).hostname}
        </a>
      ) : null}
    </span>
  )
}

/** A remote-OAuth entry control-api refused: shown, never offered for install. */
export function RemoteOAuthNotInstallable({ reason }: RemoteOAuthNotInstallableProps) {
  return (
    <span className="cu-registry-chip cu-registry-chip--quality-unverified" title={reason}>
      Not installable
    </span>
  )
}
