import { useState } from 'react'
import { Button, SelectableOption, StatusBanner } from '@components/Common'
import { describeGfsGrantError } from '@lib/gfsGrantErrors'
import { GfsSubjectBatchError } from '@lib/gfsSubjectBatch'
import { GfsPermissionDropdown } from '@/gfs/GfsPermissionDropdown'
import { GFS_AGENT_GRANTABLE_PERMISSIONS, GFS_HOST_SUBJECT_KEY_PREFIX } from './constants'
import type { GfsAgentAccessSectionProps } from './types'

/**
 * Desktop per-agent GFS delegation — a manage_acl holder grants read/write on
 * this resource to one or more of THEIR OWN agents. Presentational only:
 * eligibility (own-agent directory) and the read/write cap are enforced
 * server-side; hiding controls here is usability, never the security boundary.
 *
 * The inherit toggle is directory-only and defaults ON — a folder grant with
 * inherit=false does not cover contained files, which would silently break the
 * agent-reads-file journey. Files always send inherit=false.
 */

export function GfsAgentAccessSection({
  agents,
  agentsLoading = false,
  agentsError = null,
  isDirectory,
  onGrantAgents,
}: GfsAgentAccessSectionProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bits, setBits] = useState<string[]>(['read'])
  const [inherit, setInherit] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleAgent = (id: string) => {
    setSelectedIds(current =>
      current.includes(id) ? current.filter(item => item !== id) : [...current, id]
    )
  }

  const grant = async () => {
    setError(null)
    setBusy(true)
    try {
      await onGrantAgents(
        selectedIds.map(id => `${GFS_HOST_SUBJECT_KEY_PREFIX}${id}`),
        bits,
        isDirectory ? inherit : false
      )
      setSelectedIds([])
    } catch (grantError) {
      // Keep only the failed agents selected so a retry targets exactly them.
      if (grantError instanceof GfsSubjectBatchError) {
        const failedIds = new Set(
          grantError.failedSubjectKeys.map(key =>
            key.startsWith(GFS_HOST_SUBJECT_KEY_PREFIX)
              ? key.slice(GFS_HOST_SUBJECT_KEY_PREFIX.length)
              : key
          )
        )
        setSelectedIds(current => current.filter(id => failedIds.has(id)))
      }
      setError(describeGfsGrantError(grantError).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="da-gfs-agent-access">
      <div className="da-gfs-manage-section__header">
        <div>
          <h4>Agents</h4>
          <p className="muted">Let your own agents read or edit this resource.</p>
        </div>
      </div>
      {agentsLoading ? (
        <p className="muted">Loading your agents…</p>
      ) : agentsError ? (
        <StatusBanner tone="error" text={agentsError} />
      ) : agents.length === 0 ? (
        <p className="muted">You have no agents that can be granted access.</p>
      ) : (
        <>
          <div className="da-gfs-agent-access__options" role="group" aria-label="My agents">
            {agents.map(agent => (
              <SelectableOption
                disabled={busy}
                key={agent.id}
                onClick={() => toggleAgent(agent.id)}
                selected={selectedIds.includes(agent.id)}
                size="sm"
              >
                {agent.name}
              </SelectableOption>
            ))}
          </div>
          <div className="da-gfs-agent-access__composer">
            <GfsPermissionDropdown
              disabled={busy}
              onChange={setBits}
              permissions={[...GFS_AGENT_GRANTABLE_PERMISSIONS]}
              value={bits}
            />
            {isDirectory ? (
              <label className="da-gfs-agent-access__inherit">
                <input
                  checked={inherit}
                  disabled={busy}
                  onChange={event => setInherit(event.target.checked)}
                  type="checkbox"
                />
                <span>Include contents of this folder</span>
              </label>
            ) : null}
          </div>
          <div className="da-gfs-agent-access__actions">
            <Button
              disabled={busy || selectedIds.length === 0 || bits.length === 0}
              loading={busy}
              onClick={() => void grant()}
              type="button"
            >
              Grant agent access
            </Button>
          </div>
        </>
      )}
      {error !== null && <StatusBanner tone="error" text={error} />}
    </div>
  )
}

export type { GfsAgentAccessSectionProps } from './types'
