import React from 'react'
import { IconRobot } from '../Sidebar/icons'
import { IconCheck, IconPencil, IconX } from '../icons'
import type { HostOverviewTabProps, HostTabKey } from './types'

const DESCRIPTION_MAX_LENGTH = 100

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

// Clickable section header inside an Overview card. The optional `count`
// badge sits inline with the label so the count reads as part of the
// section title rather than a separate row.
function NavHeader({
  label,
  tab,
  count,
  onNavigate,
}: {
  label: string
  tab?: HostTabKey
  count?: number
  onNavigate: (tab: HostTabKey) => void
}) {
  return (
    <button
      type="button"
      className="cu-host-overview-nav-header"
      onClick={tab ? () => onNavigate(tab) : undefined}
      disabled={!tab}
      aria-label={tab ? `Open ${label}` : undefined}
    >
      <span className="cu-host-overview-nav-header__label">{label}</span>
      {typeof count === 'number' ? (
        <span className="cu-host-overview-nav-header__count">{count}</span>
      ) : null}
      <span className="cu-host-overview-nav-header__chev" aria-hidden="true">
        ›
      </span>
    </button>
  )
}

function ConfigRow({ setting, value }: { setting: string; value: React.ReactNode }) {
  return (
    <div className="cu-host-overview-config__row">
      <div className="cu-host-overview-config__setting">{setting}</div>
      <div className="cu-host-overview-config__value">{value || '—'}</div>
    </div>
  )
}

function formatTimestamp(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const month = date.toLocaleString('en-US', { month: 'long' })
  const day = date.getDate()
  const year = date.getFullYear()
  let hours = date.getHours()
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const meridiem = hours >= 12 ? 'PM' : 'AM'
  hours = hours % 12 || 12
  return `${month} ${day}, ${year} • ${hours}:${minutes} ${meridiem}`
}

function truncateDescription(value: string): string {
  const description = value.trim()
  if (description.length <= DESCRIPTION_MAX_LENGTH) return description
  return `${description.slice(0, DESCRIPTION_MAX_LENGTH - 1).trimEnd()}…`
}

export function HostOverviewTab({
  hostName,
  displayName,
  description,
  statusLabel,
  statusTone,
  contextRef,
  contextMcpServers,
  contextMcpTotal,
  modelPrimary,
  modelProviderLine,
  stateless,
  lifecycleState,
  lifecycleReason,
  statelessRejectionMessage,
  accessSummary,
  editingName,
  nameDraft,
  onCancelNameEdit,
  onNameDraftChange,
  onNavigate,
  onSaveDisplayName,
  onSaveLifecycle,
  onStartNameEdit,
  createdAt,
}: HostOverviewTabProps) {
  const shownName = displayName.trim() || hostName
  const [savingName, setSavingName] = React.useState(false)
  const [editingLifecycle, setEditingLifecycle] = React.useState(false)
  const [lifecycleDraft, setLifecycleDraft] = React.useState(stateless)
  const [savingLifecycle, setSavingLifecycle] = React.useState(false)
  const hasContext = Boolean(contextRef.trim())
  const trimmedDescription = description.trim()
  const shownDescription = truncateDescription(trimmedDescription) || 'No description provided.'

  React.useEffect(() => {
    if (!editingLifecycle) setLifecycleDraft(stateless)
  }, [editingLifecycle, stateless])

  async function saveName() {
    const nextName = nameDraft.trim()
    if (!nextName || savingName) return

    setSavingName(true)
    try {
      await onSaveDisplayName(nextName)
    } finally {
      setSavingName(false)
    }
  }

  async function saveLifecycle() {
    if (savingLifecycle) return

    setSavingLifecycle(true)
    try {
      if (await onSaveLifecycle(lifecycleDraft)) setEditingLifecycle(false)
    } finally {
      setSavingLifecycle(false)
    }
  }

  function cancelLifecycleEdit() {
    setLifecycleDraft(stateless)
    setEditingLifecycle(false)
  }

  return (
    <>
      {statelessRejectionMessage ? (
        <div className="cu-banner cu-banner--warning" style={{ marginBottom: '1rem' }}>
          <strong>Stateless mode rejected:</strong> {statelessRejectionMessage}
        </div>
      ) : null}
      <div className="cu-host-overview">
        <section className="cu-host-overview-identity" aria-label="Agent identity">
          <div className="cu-host-overview-identity__name-row">
            {editingName ? (
              <div className="cu-host-overview-identity__name-editor">
                <span className="cu-host-overview-identity__icon" aria-hidden="true">
                  <IconRobot />
                </span>
                <input
                  className="cu-input cu-host-overview-identity__name-input"
                  value={nameDraft}
                  onChange={event => onNameDraftChange(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void saveName()
                    if (event.key === 'Escape') onCancelNameEdit()
                  }}
                  aria-label="Agent name"
                  disabled={savingName}
                  autoFocus
                />
                <button
                  type="button"
                  className="cu-btn cu-btn--icon cu-btn--toolbar"
                  onClick={() => void saveName()}
                  disabled={savingName || !nameDraft.trim()}
                  aria-label="Save agent name"
                  title="Save agent name"
                >
                  <IconCheck width={16} height={16} />
                </button>
                <button
                  type="button"
                  className="cu-btn cu-btn--icon cu-btn--ghost"
                  onClick={onCancelNameEdit}
                  disabled={savingName}
                  aria-label="Cancel editing agent name"
                  title="Cancel editing agent name"
                >
                  <IconX width={16} height={16} />
                </button>
              </div>
            ) : (
              <>
                <div className="cu-host-overview-identity__name">
                  <span className="cu-host-overview-identity__icon" aria-hidden="true">
                    <IconRobot />
                  </span>
                  {shownName}
                </div>
                <button
                  type="button"
                  className="cu-btn cu-btn--icon cu-btn--ghost cu-host-overview-identity__edit"
                  onClick={onStartNameEdit}
                  disabled={savingName}
                  aria-label="Edit agent name"
                  title="Edit agent name"
                >
                  <IconPencil width={16} height={16} />
                </button>
              </>
            )}
          </div>
          <div
            className="cu-host-overview-identity__description"
            title={trimmedDescription || undefined}
          >
            {shownDescription}
          </div>
          <div className="cu-host-overview-identity__status">
            <StatusDot tone={statusTone} />
            <span>{statusLabel}</span>
          </div>
          {stateless && lifecycleState ? (
            <span className="cu-chip">
              {`Lifecycle: ${lifecycleState}${lifecycleReason ? ` — ${lifecycleReason}` : ''}`}
            </span>
          ) : null}

          <div className="cu-host-overview-identity__divider" />

          <NavHeader label="Access" tab="access" onNavigate={onNavigate} />
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
              <div className="cu-host-overview-identity__count-value">
                {accessSummary.teamCount}
              </div>
              <div className="cu-host-overview-identity__count-label">
                {accessSummary.teamCount === 1 ? 'team' : 'teams'}
              </div>
            </div>
          </div>

          <div className="cu-host-overview-identity__divider" />

          <NavHeader label="Connectors" tab="connectors" onNavigate={onNavigate} />
          <div className="cu-host-overview-identity__counts">
            <div>
              <div className="cu-host-overview-identity__count-value">
                {contextMcpServers.length}
              </div>
              <div className="cu-host-overview-identity__count-label">
                {contextMcpServers.length === 1 ? 'connector' : 'connectors'}
              </div>
            </div>
          </div>

          <div className="cu-host-overview-identity__divider" />

          <dl className="cu-host-overview-identity__meta">
            <dt>Created</dt>
            <dd>{formatTimestamp(createdAt) || '—'}</dd>
          </dl>
        </section>

        <div className="cu-host-overview-right">
          <section className="cu-card" aria-label="Lifecycle">
            <div className="cu-card__body">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                }}
              >
                <div>
                  <h3 className="cu-section-title" style={{ margin: 0 }}>
                    Lifecycle
                  </h3>
                  <p className="cu-muted" style={{ margin: '0.35rem 0 0', fontSize: '0.8125rem' }}>
                    Choose whether this agent stays running or suspends when idle.
                  </p>
                </div>
                {!editingLifecycle ? (
                  <button
                    type="button"
                    className="cu-btn cu-btn--ghost cu-btn--sm"
                    onClick={() => {
                      setLifecycleDraft(stateless)
                      setEditingLifecycle(true)
                    }}
                    disabled={savingLifecycle}
                  >
                    Edit lifecycle
                  </button>
                ) : null}
              </div>
              <div className="cu-field" style={{ marginTop: '1rem', marginBottom: 0 }}>
                <label htmlFor="host-agent-type">Type</label>
                {editingLifecycle ? (
                  <>
                    <select
                      id="host-agent-type"
                      value={lifecycleDraft ? 'stateless' : 'stateful'}
                      onChange={event => setLifecycleDraft(event.target.value === 'stateless')}
                      disabled={savingLifecycle}
                    >
                      <option value="stateful">Stateful (always on)</option>
                      <option value="stateless">Stateless (suspends when idle)</option>
                    </select>
                    <span className="cu-field__hint">
                      Stateless agents suspend after the idle window and wake on demand.
                      Communication channels may keep them always-on.
                    </span>
                    <div className="cu-create-actions" style={{ marginTop: '0.75rem' }}>
                      <button
                        type="button"
                        className="cu-btn cu-btn--ghost cu-btn--sm"
                        onClick={cancelLifecycleEdit}
                        disabled={savingLifecycle}
                      >
                        Cancel lifecycle
                      </button>
                      <button
                        type="button"
                        className="cu-btn cu-btn--primary"
                        onClick={() => void saveLifecycle()}
                        disabled={savingLifecycle}
                      >
                        {savingLifecycle ? 'Saving…' : 'Save lifecycle'}
                      </button>
                    </div>
                  </>
                ) : (
                  <div id="host-agent-type" className="cu-field__readonly">
                    {stateless ? 'Stateless (suspends when idle)' : 'Stateful (always on)'}
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="cu-card" aria-label="Configuration">
            <div className="cu-card__body">
              <NavHeader label="Configuration" tab="model" onNavigate={onNavigate} />
              <div className="cu-host-overview-config">
                <ConfigRow setting="Primary model" value={modelPrimary} />
                <ConfigRow setting="Provider · Model" value={modelProviderLine} />
              </div>
            </div>
          </section>

          <section className="cu-card" aria-label="Access summary">
            <div className="cu-card__body">
              <NavHeader label="Access" tab="access" onNavigate={onNavigate} />

              <div className="cu-host-overview-access__columns">
                <div className="cu-host-overview-access__group">
                  <div className="cu-host-overview-access__head">
                    <span className="cu-host-overview-access__head-label">Members</span>
                    <span className="cu-host-overview-access__head-count">
                      {accessSummary.memberCount}
                    </span>
                  </div>
                  {accessSummary.memberNames.length > 0 ? (
                    <ul className="cu-host-overview-access__people">
                      {accessSummary.memberNames.map(name => (
                        <li key={name} className="cu-host-overview-access__person">
                          <span className="cu-host-overview-access__dot" aria-hidden="true" />
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
                    <span className="cu-host-overview-access__head-label">Teams</span>
                    <span className="cu-host-overview-access__head-count">
                      {accessSummary.teamCount}
                    </span>
                  </div>
                  {accessSummary.teamNames.length > 0 ? (
                    <ul className="cu-host-overview-access__people">
                      {accessSummary.teamNames.map(name => (
                        <li key={name} className="cu-host-overview-access__person">
                          <span className="cu-host-overview-access__dot" aria-hidden="true" />
                          <span className="cu-host-overview-access__person-name">{name}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="cu-host-overview-access__empty">No teams yet.</p>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="cu-card" aria-label="Connectors">
            <div className="cu-card__body">
              <NavHeader
                label="Connectors"
                tab="connectors"
                count={contextMcpTotal}
                onNavigate={onNavigate}
              />
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
                  {hasContext ? 'No connectors attached.' : 'No connectors attached yet.'}
                </p>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  )
}
