import { useState } from 'react'
import { Button, EmptyState, StatusBanner, TabButton } from '@components/Common'
import { usePluginPermissionsController } from '@hooks/domain/usePluginPermissionsController'

const GRANTS_GRID_COLS = 'minmax(10rem, 1.2fr) minmax(12rem, 1.6fr) minmax(8rem, 0.7fr) 6rem'
const ACTIVITY_GRID_COLS =
  'minmax(9rem, 0.8fr) minmax(9rem, 0.9fr) minmax(9rem, 1fr) minmax(6rem, 0.5fr)'

function formatTimestamp(value: string | null): string {
  if (!value) return 'Never'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return 'Unknown'
  return parsed.toLocaleString()
}

function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case 'allowed':
      return 'Shared'
    case 'granted':
      return 'Granted'
    case 'denied':
      return 'Denied'
    case 'revoked':
      return 'Revoked'
    case 'revoked_mid_flight':
      return 'Revoked mid-request'
    case 'rate_limited':
      return 'Rate limited'
    default:
      return 'Error'
  }
}

/**
 * Settings → Plugin permissions (spec §11).
 *
 * Two views over the same trust decision: what a plugin currently holds, and
 * what it has actually been doing. Denials and rate-limits are deliberately
 * included in Activity — a plugin that keeps asking for things the user keeps
 * refusing is a pattern worth being able to notice.
 */
export function PluginPermissions() {
  const controller = usePluginPermissionsController()
  const [view, setView] = useState<'grants' | 'activity'>('grants')
  const [expanded, setExpanded] = useState<string | null>(null)

  return (
    <section className="page-card settings-card" aria-labelledby="settings-plugin-permissions">
      <div className="page-card__header">
        <div className="settings-card-title-row">
          <div>
            <h3 id="settings-plugin-permissions">Plugin permissions</h3>
            <p className="muted">
              Plugins can only see what you have explicitly allowed. Revoking takes effect
              immediately, even while a plugin is open.
            </p>
          </div>
        </div>
      </div>

      <div className="page-tabs" role="tablist" aria-label="Plugin permission views">
        <TabButton
          active={view === 'grants'}
          className="page-tab"
          role="tab"
          onClick={() => setView('grants')}
        >
          Permissions
        </TabButton>
        <TabButton
          active={view === 'activity'}
          className="page-tab"
          role="tab"
          onClick={() => setView('activity')}
        >
          Activity
        </TabButton>
      </div>

      {controller.error ? <StatusBanner tone="error">{controller.error}</StatusBanner> : null}

      {view === 'grants' ? (
        controller.loading ? (
          <EmptyState
            title="Loading permissions…"
            body="Reading what each plugin is allowed to see."
          />
        ) : controller.groups.length === 0 ? (
          <EmptyState
            title="No plugin has been granted access to your information."
            body="When a plugin asks for something, you will see a prompt naming exactly what it wants."
          />
        ) : (
          <div className="da-grid" style={{ '--da-grid-cols': GRANTS_GRID_COLS }}>
            <div className="da-grid__head">
              <span className="da-grid__col-header">Plugin</span>
              <span className="da-grid__col-header">Permissions</span>
              <span className="da-grid__col-header">Last used</span>
              <span className="da-grid__col-header da-grid__col-header--right">Actions</span>
            </div>
            <div className="da-grid__body">
              {controller.groups.map(group => (
                <div key={group.pluginId}>
                  <div className="da-grid__row da-grid__row--clickable">
                    <span className="da-grid__cell">
                      <Button
                        align="start"
                        block
                        onClick={() =>
                          setExpanded(current =>
                            current === group.pluginId ? null : group.pluginId
                          )
                        }
                        variant="text"
                      >
                        {group.pluginTitle}
                      </Button>
                    </span>
                    <span className="da-grid__cell">
                      {group.capabilities.map(grant => grant.title).join(' · ')}
                    </span>
                    <span className="da-grid__cell">{formatTimestamp(group.lastUsedAt)}</span>
                    <span className="da-grid__cell da-grid__cell--right">
                      <Button
                        color="danger"
                        disabled={controller.revoking}
                        onClick={() => controller.revoke(group.pluginId).catch(() => undefined)}
                        size="sm"
                        variant="ghost"
                      >
                        Revoke all
                      </Button>
                    </span>
                  </div>

                  {expanded === group.pluginId
                    ? group.capabilities.map(grant => (
                        <div
                          className="da-grid__row da-grid__row--compact"
                          key={`${grant.pluginId}:${grant.capability}`}
                        >
                          <span className="da-grid__cell muted">{grant.title}</span>
                          {/* The same sentence the consent prompt showed, verbatim —
                              the user re-reads what they agreed to, not a paraphrase. */}
                          <span className="da-grid__cell muted">{grant.dataDescription}</span>
                          <span className="da-grid__cell muted">
                            Granted {formatTimestamp(grant.grantedAt)}
                          </span>
                          <span className="da-grid__cell da-grid__cell--right">
                            <Button
                              color="danger"
                              disabled={controller.revoking}
                              onClick={() =>
                                controller
                                  .revoke(grant.pluginId, grant.capability)
                                  .catch(() => undefined)
                              }
                              size="sm"
                              variant="ghost"
                            >
                              Revoke
                            </Button>
                          </span>
                        </div>
                      ))
                    : null}
                </div>
              ))}
            </div>
          </div>
        )
      ) : controller.activity.length === 0 ? (
        <EmptyState
          title="No plugin activity recorded yet."
          body="Requests a plugin makes will be listed here."
        />
      ) : (
        <>
          <div className="da-grid" style={{ '--da-grid-cols': ACTIVITY_GRID_COLS }}>
            <div className="da-grid__head">
              <span className="da-grid__col-header">When</span>
              <span className="da-grid__col-header">Plugin</span>
              <span className="da-grid__col-header">Requested</span>
              <span className="da-grid__col-header">Result</span>
            </div>
            <div className="da-grid__body">
              {controller.activity.map((entry, index) => (
                <div
                  className="da-grid__row da-grid__row--compact"
                  key={`${entry.ts}-${entry.capability}-${index}`}
                >
                  <span className="da-grid__cell">{formatTimestamp(entry.ts)}</span>
                  <span className="da-grid__cell">{entry.pluginId.split('/').pop()}</span>
                  <span className="da-grid__cell">{entry.capability}</span>
                  <span className="da-grid__cell">{outcomeLabel(entry.outcome)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="settings-form">
            <Button
              color="neutral"
              disabled={controller.clearingActivity || controller.revoking}
              onClick={() => controller.clearActivity().catch(() => undefined)}
              size="sm"
              variant="ghost"
            >
              Clear activity log
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
