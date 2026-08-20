import React from 'react'
import { IconCopy } from '../icons'
import type { HostOverviewTabProps } from './types'

function UsersIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="8" r="3.2" />
      <path d="M2.8 19.4c.4-3 2.9-5.2 6.2-5.2s5.8 2.2 6.2 5.2" />
      <circle cx="17" cy="6.5" r="2.4" />
      <path d="M21.2 17c-.3-2.2-2-3.7-4.2-3.7" />
    </svg>
  )
}

function TeamIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="6" width="17" height="13" rx="2" />
      <path d="M3.5 10.5h17" />
      <path d="M8 6V4.5h8V6" />
      <path d="M9 14h6" />
    </svg>
  )
}

const STATUS_DOT_CLASS: Record<HostOverviewTabProps['statusTone'], string> = {
  active: 'cu-host-overview-status__dot--active',
  inactive: 'cu-host-overview-status__dot--inactive',
  unknown: 'cu-host-overview-status__dot--unknown',
}

function StatusDot({ tone }: { tone: HostOverviewTabProps['statusTone'] }) {
  return (
    <span className={`cu-host-overview-status__dot ${STATUS_DOT_CLASS[tone]}`} aria-hidden="true" />
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="cu-host-overview-section-label">{children}</p>
}

function initialsFor(name: string): string {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0]?.[0] || ''
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] || '' : ''
  return (first + last).toUpperCase() || '?'
}

function ConfigRow({ setting, value }: { setting: string; value: React.ReactNode }) {
  return (
    <div className="cu-host-overview-config__row">
      <div className="cu-host-overview-config__setting">{setting}</div>
      <div className="cu-host-overview-config__value">{value || '—'}</div>
    </div>
  )
}

export function HostOverviewTab({
  hostName,
  displayName,
  statusLabel,
  statusTone,
  contextRef,
  contextMcpServers,
  contextMcpTotal,
  contextHref,
  modelPrimary,
  modelProviderLine,
  modelAllowlistLine,
  accessSummary,
  uid,
  createdAt,
  lastUpdated,
}: HostOverviewTabProps) {
  const shownName = displayName.trim() || hostName
  const contextLabel = contextRef.trim() || '—'
  const hasContext = Boolean(contextRef.trim())
  const allowlist = modelAllowlistLine.trim() || '—'

  return (
    <div className="cu-host-overview">
      <section className="cu-host-overview-identity" aria-label="Agent identity">
        <div className="cu-host-overview-identity__avatar" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width="44"
            height="44"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="5" y="7" width="14" height="12" rx="3" />
            <path d="M9 4h6" />
            <circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none" />
            <circle cx="15" cy="13" r="1.2" fill="currentColor" stroke="none" />
            <path d="M12 16v3" />
            <path d="M9 19h6" />
          </svg>
        </div>
        <div className="cu-host-overview-identity__name">{shownName}</div>
        <div className="cu-host-overview-identity__slug">{hostName}</div>
        <div className="cu-host-overview-identity__status">
          <StatusDot tone={statusTone} />
          <span>{statusLabel}</span>
        </div>

        <div className="cu-host-overview-identity__divider" />

        <SectionLabel>Access</SectionLabel>
        <div className="cu-host-overview-identity__counts">
          <div>
            <div className="cu-host-overview-identity__count-value">
              {accessSummary.memberCount}
            </div>
            <div className="cu-host-overview-identity__count-label">
              {accessSummary.memberCount === 1 ? 'member' : 'members'}
            </div>
          </div>
          <div className="cu-host-overview-identity__count-sep" aria-hidden="true" />
          <div>
            <div className="cu-host-overview-identity__count-value">{accessSummary.teamCount}</div>
            <div className="cu-host-overview-identity__count-label">
              {accessSummary.teamCount === 1 ? 'team' : 'teams'}
            </div>
          </div>
        </div>

        <div className="cu-host-overview-identity__divider" />

        <SectionLabel>Context</SectionLabel>
        {hasContext ? (
          <a
            href={contextHref}
            className="cu-chip cu-host-overview-context-chip"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M3 10h18" />
              <path d="M9 4v16" />
            </svg>
            {contextLabel}
          </a>
        ) : (
          <span className="cu-muted" style={{ fontSize: '0.875rem' }}>
            —
          </span>
        )}

        <div className="cu-host-overview-identity__divider" />

        <SectionLabel>Agent ID</SectionLabel>
        <div className="cu-host-overview-identity__uid">
          <span className="cu-host-overview-identity__uid-text">{uid || '—'}</span>
          {uid ? (
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--ghost cu-btn--sm"
              aria-label="Copy agent ID"
              title="Copy agent ID"
              onClick={() => {
                if (typeof navigator !== 'undefined' && navigator.clipboard) {
                  void navigator.clipboard.writeText(uid)
                }
              }}
            >
              <IconCopy width={14} height={14} />
            </button>
          ) : null}
        </div>
        <dl className="cu-host-overview-identity__meta">
          <dt>Created</dt>
          <dd>{createdAt || '—'}</dd>
          <dt>Last updated</dt>
          <dd>{lastUpdated || '—'}</dd>
        </dl>
      </section>

      <div className="cu-host-overview-right">
        <section className="cu-card" aria-label="Configuration">
          <div className="cu-card__body">
            <p className="cu-host-overview-section-label">Configuration</p>
            <div className="cu-host-overview-config">
              <ConfigRow setting="Primary model" value={modelPrimary} />
              <ConfigRow setting="Provider · Model" value={modelProviderLine} />
              <ConfigRow setting="Per-host model allowlist" value={allowlist} />
              <ConfigRow setting="Assigned context" value={contextLabel} />
            </div>
          </div>
        </section>

        <section className="cu-card" aria-label="Access summary">
          <div className="cu-card__body">
            <p className="cu-host-overview-section-label">Access</p>

            <div className="cu-host-overview-access__group">
              <div className="cu-host-overview-access__head">
                <span className="cu-host-overview-access__head-icon" aria-hidden="true">
                  <UsersIcon />
                </span>
                <span className="cu-host-overview-access__head-label">Members</span>
                <span className="cu-host-overview-access__head-count">
                  {accessSummary.memberCount}
                </span>
              </div>
              {accessSummary.memberNames.length > 0 ? (
                <ul className="cu-host-overview-access__people">
                  {accessSummary.memberNames.map(name => (
                    <li key={name} className="cu-host-overview-access__person">
                      <span className="cu-host-overview-access__avatar" aria-hidden="true">
                        {initialsFor(name)}
                      </span>
                      <span className="cu-host-overview-access__person-name">{name}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="cu-host-overview-access__empty">No members yet.</p>
              )}
            </div>

            <div className="cu-host-overview-access__group">
              <div className="cu-host-overview-access__head">
                <span className="cu-host-overview-access__head-icon" aria-hidden="true">
                  <TeamIcon />
                </span>
                <span className="cu-host-overview-access__head-label">Teams</span>
                <span className="cu-host-overview-access__head-count">
                  {accessSummary.teamCount}
                </span>
              </div>
              {accessSummary.teamNames.length > 0 ? (
                <ul className="cu-host-overview-access__people">
                  {accessSummary.teamNames.map(name => (
                    <li key={name} className="cu-host-overview-access__person">
                      <span className="cu-host-overview-access__avatar" aria-hidden="true">
                        {initialsFor(name)}
                      </span>
                      <span className="cu-host-overview-access__person-name">{name}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="cu-host-overview-access__empty">No teams yet.</p>
              )}
            </div>
          </div>
        </section>

        <section className="cu-card" aria-label="MCP servers">
          <div className="cu-card__body">
            <div className="cu-host-overview-mcp__head">
              <p className="cu-host-overview-section-label" style={{ margin: 0 }}>
                MCP servers
              </p>
              <span className="cu-agent-context-mcp-summary__head" style={{ margin: 0 }}>
                <span>{contextMcpTotal}</span>
              </span>
            </div>
            {contextMcpServers.length > 0 ? (
              <ul className="cu-host-overview-mcp__list">
                {contextMcpServers.map(server => (
                  <li key={server} className="cu-host-overview-mcp__chip" title={server}>
                    <span className="cu-host-overview-mcp__dot" aria-hidden="true" />
                    {server}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="cu-muted" style={{ margin: '0.5rem 0 0', fontSize: '0.875rem' }}>
                {hasContext ? 'No MCP servers attached.' : 'No context selected.'}
              </p>
            )}
            {hasContext ? (
              <a className="cu-host-overview-mcp__link" href={contextHref}>
                View all MCP servers
                <span aria-hidden="true">→</span>
              </a>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
