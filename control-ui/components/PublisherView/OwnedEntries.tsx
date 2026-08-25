'use client'

import React, { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { IconChevronRight } from '@components/icons'
import { MARKETPLACE_ENTRY_TYPE_LABELS } from '@constants/marketplaceEntryTypes'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type OwnedRegistryEntry,
  deleteRegistryEntry,
  getOwnedRegistryEntries,
  getRegistryCatalog,
} from '../../lib/api'
import { useConfirmDialog } from '../ConfirmDialog'
import { type RowAction, RowActionsMenu } from '../RowActionsMenu'
import { SectionLoadingSkeleton } from '../SectionLoadingSkeleton'
import { TableHeaderRow } from '../TableHeaderRow'
import type { TableHeaderColumn } from '../TableHeaderRow/types'
import { TablePanelHeader } from '../TablePanelHeader'
import { useToast } from '../Toast'
import { Button } from '../ui'
import { GrantAccessModal } from './GrantAccessModal'
import { RetryBanner } from './RetryBanner'

type GrantTarget = {
  entryName: string
  opener: HTMLButtonElement
}

const COLUMNS: TableHeaderColumn[] = [
  { key: 'expand', ariaLabel: 'Expand versions' },
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'version', label: 'Version' },
  { key: 'visibility', label: 'Visibility' },
  { key: 'status', label: 'Status' },
  { key: 'actions', ariaLabel: 'Actions', align: 'right' },
]

function entryKey(e: OwnedRegistryEntry): string {
  return `${e.name}@${e.version}`
}

// Descending semver-ish sort so the latest version leads each group. Falls back
// to a reverse lexical compare when a segment isn't numeric.
function compareVersionDesc(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.parseInt(pa[i] ?? '0', 10)
    const y = Number.parseInt(pb[i] ?? '0', 10)
    if (Number.isNaN(x) || Number.isNaN(y)) return b.localeCompare(a)
    if (x !== y) return y - x
  }
  return b.localeCompare(a)
}

// Collapse same-named entries into one group. `latest` leads the collapsed row;
// `versions` holds every version (latest first) so the expanded row can offer
// the previous ones individually.
function groupByName(
  entries: OwnedRegistryEntry[]
): { latest: OwnedRegistryEntry; versions: OwnedRegistryEntry[] }[] {
  const byName = new Map<string, OwnedRegistryEntry[]>()
  for (const e of entries) {
    const list = byName.get(e.name)
    if (list) list.push(e)
    else byName.set(e.name, [e])
  }
  return Array.from(byName.values()).map(list => {
    const versions = [...list].sort((a, b) => compareVersionDesc(a.version, b.version))
    return { latest: versions[0], versions }
  })
}

// The registry's owned-entries payload carries `serverMode` but not `entry_type`
// (mcp-servers always have a serverMode; recipes don't). Prefer an explicit
// entry_type if the registry ever starts sending it, else infer from serverMode.
// "Connector" / "Plugin" mirror the labels in PublishToRegistryForm.
function ownedEntryKind(e: OwnedRegistryEntry): string {
  // Wire field is `entryType` (camelCase); `entry_type` kept as a fallback.
  return e.entryType ?? e.entry_type ?? (e.serverMode != null ? 'mcp-server' : 'recipe')
}

function entryTypeLabel(e: OwnedRegistryEntry): string {
  const kind = ownedEntryKind(e)
  if (kind === 'mcp-server') return 'Connector'
  if (kind === 'llm-hook') return 'Guardrail hook'
  return 'Plugin'
}

/**
 * The org's own published entries — the home for the edit/remove that discovery
 * surfaces no longer offer (design spec §5.4). Sharing is capability-gated:
 *
 * - `canShare` (the deployment holds `registry:grant`) → offer the Share control.
 * - `sharingUnavailable` (a self-hosted org can never share cross-org) → state
 *   the limit once rather than offering a control that would be refused (§1.2).
 *
 * Both derive from the parent's inbound-grants probe, so no extra fetch is made.
 */
export function OwnedEntries({
  orgScope,
  canShare = true,
  sharingUnavailable = false,
}: {
  orgScope: string
  canShare?: boolean
  sharingUnavailable?: boolean
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const [entries, setEntries] = useState<OwnedRegistryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [grantTarget, setGrantTarget] = useState<GrantTarget | null>(null)
  const [expandedNames, setExpandedNames] = useState<Set<string>>(new Set())
  // Installed cluster resources (same source the catalog uses to show
  // "Installed"). Best-effort: a catalog fetch failure just means no entry is
  // marked installed, never an error on the entries list.
  const [installedCatalogKeys, setInstalledCatalogKeys] = useState<Set<string>>(new Set())
  const [installedServerNames, setInstalledServerNames] = useState<Set<string>>(new Set())
  const [installedRecipeKeys, setInstalledRecipeKeys] = useState<Set<string>>(new Set())
  const [installedHookKeys, setInstalledHookKeys] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const [{ data }, catalog] = await Promise.all([
        getOwnedRegistryEntries(),
        getRegistryCatalog({ limit: '500' }).catch(() => null),
      ])
      setEntries(data)
      if (catalog) {
        setInstalledCatalogKeys(new Set(catalog.installed.catalogKeys))
        setInstalledServerNames(new Set(catalog.installed.serverNames))
        setInstalledRecipeKeys(new Set(catalog.installed.recipeKeys))
        setInstalledHookKeys(new Set(catalog.installed.hookKeys ?? []))
      }
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleRemove = useCallback(
    async (e: OwnedRegistryEntry) => {
      const ok = await confirm({
        title: 'Remove from Marketplace',
        message: `Remove ${e.name} v${e.version} from the Marketplace? Already-installed copies stay running. This cannot be undone.`,
        confirmLabel: 'Remove',
        tone: 'danger',
      })
      if (!ok) return
      try {
        await deleteRegistryEntry(e.name, e.version)
        showToast(`Removed ${e.name} v${e.version} from the Marketplace.`, { tone: 'success' })
        await load()
      } catch {
        showToast(`Could not remove ${e.name}.`, { tone: 'error' })
      }
    },
    [confirm, showToast, load]
  )

  const toggleExpanded = useCallback((name: string) => {
    setExpandedNames(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  function isInstalled(e: OwnedRegistryEntry): boolean {
    const kind = ownedEntryKind(e)
    const key = `${e.name}@${e.version}`
    if (kind === 'mcp-server') {
      return installedCatalogKeys.has(key) || installedServerNames.has(e.name)
    }
    if (kind === 'llm-hook') return installedHookKeys.has(key)
    return installedRecipeKeys.has(key)
  }

  function renderInstall(e: OwnedRegistryEntry) {
    return isInstalled(e) ? (
      <Button type="button" variant="ghost" size="sm" disabled>
        Installed
      </Button>
    ) : (
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={() =>
          router.push(CONTROL_ROUTES.marketplace.install({ entry: e.name, version: e.version }))
        }
      >
        Install
      </Button>
    )
  }

  // `?type=` narrows the list to a single entry kind — this is how "Add hook"
  // on an agent lands here showing only guardrail hooks. An unrecognised value
  // filters nothing, so a stale or hand-edited link degrades to the full list
  // instead of an empty one.
  const typeFilter = searchParams?.get('type') ?? null
  const activeTypeLabel = typeFilter ? MARKETPLACE_ENTRY_TYPE_LABELS[typeFilter] : undefined
  const visibleEntries = useMemo(
    () => (activeTypeLabel ? entries.filter(e => ownedEntryKind(e) === typeFilter) : entries),
    [entries, typeFilter, activeTypeLabel]
  )

  // Deliberately org-wide, not `visibleEntries`: the notice describes what
  // cross-org sharing does to this org's private entries, so a `?type=` filter
  // that happens to hide them all must not make it disappear.
  const hasPrivateEntries = entries.some(e => e.visibility === 'private')
  // Collapse same-named entries into one row (latest leads); expanding a row
  // reveals the previous versions, each individually installable.
  const grouped = groupByName(visibleEntries)

  return (
    <section>
      <div className="cu-card cu-card--viewport-fill">
        <TablePanelHeader
          title="Published entries"
          subtitle={
            sharingUnavailable && hasPrivateEntries
              ? 'Cross-org sharing isn’t available on this deployment, so private entries stay visible only to your org.'
              : undefined
          }
        />
        <div className="cu-card__body">
          {loading ? <SectionLoadingSkeleton label="Loading published entries" /> : null}
          {error ? (
            <RetryBanner
              message="Could not load your published entries."
              onRetry={() => void load()}
            />
          ) : null}
          {!loading && !error && activeTypeLabel ? (
            <p className="cu-banner cu-banner--info">
              Showing {activeTypeLabel.toLowerCase()} only.{' '}
              <button
                type="button"
                className="cu-link"
                onClick={() => router.replace(CONTROL_ROUTES.marketplace.orgEntries)}
              >
                Show all entries
              </button>
            </p>
          ) : null}
          {!loading && !error && entries.length === 0 ? (
            <p>You haven’t published any registry entries yet.</p>
          ) : null}
          {!loading && !error && entries.length > 0 && visibleEntries.length === 0 ? (
            <p>No {activeTypeLabel?.toLowerCase() ?? 'entries'} published yet.</p>
          ) : null}
          {!loading && !error && visibleEntries.length > 0 ? (
            <>
              <div className="cu-table-wrap">
                <table className="cu-table">
                  <thead>
                    <TableHeaderRow columns={COLUMNS} />
                  </thead>
                  <tbody>
                    {grouped.map(({ latest: e, versions }) => {
                      const isPrivate = e.visibility === 'private'
                      const isGranting = grantTarget?.entryName === e.name
                      const expanded = expandedNames.has(e.name)
                      const hasPrevious = versions.length > 1
                      const rowActions: RowAction[] = [
                        {
                          key: 'edit',
                          label: 'Edit',
                          onClick: () =>
                            router.push(CONTROL_ROUTES.marketplace.editEntry(e.name, e.version)),
                        },
                        {
                          key: 'remove',
                          label: 'Remove from Marketplace',
                          danger: true,
                          onClick: () => void handleRemove(e),
                        },
                      ]
                      return (
                        <Fragment key={e.name}>
                          <tr
                            className={
                              hasPrevious
                                ? 'cu-table__row cu-table__row--clickable cu-expandable-row'
                                : undefined
                            }
                            onClick={hasPrevious ? () => toggleExpanded(e.name) : undefined}
                            onKeyDown={
                              hasPrevious
                                ? event => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                      event.preventDefault()
                                      toggleExpanded(e.name)
                                    }
                                  }
                                : undefined
                            }
                            tabIndex={hasPrevious ? 0 : undefined}
                            aria-expanded={hasPrevious ? expanded : undefined}
                          >
                            <td className="cu-expandable-row__chevron" aria-hidden="true">
                              {hasPrevious ? (
                                <IconChevronRight
                                  className={expanded ? 'is-expanded' : undefined}
                                  width={18}
                                  height={18}
                                />
                              ) : null}
                            </td>
                            <td>
                              <code>{e.name}</code>
                            </td>
                            <td>{entryTypeLabel(e)}</td>
                            <td>
                              {e.version}
                              {hasPrevious ? (
                                <span className="cu-muted"> +{versions.length - 1} more</span>
                              ) : null}
                            </td>
                            <td>
                              <span
                                className={`cu-registry-chip cu-registry-chip--visibility-${e.visibility}`}
                              >
                                {e.visibility}
                              </span>
                            </td>
                            <td>{e.status}</td>
                            <td
                              onClick={hasPrevious ? event => event.stopPropagation() : undefined}
                              onKeyDown={hasPrevious ? event => event.stopPropagation() : undefined}
                            >
                              <div className="cu-table-actions">
                                {renderInstall(e)}
                                {isPrivate && canShare ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    aria-haspopup="dialog"
                                    aria-expanded={isGranting}
                                    onClick={event =>
                                      setGrantTarget({
                                        entryName: e.name,
                                        opener: event.currentTarget,
                                      })
                                    }
                                  >
                                    Share access
                                  </Button>
                                ) : null}
                                <RowActionsMenu
                                  ariaLabel={`Actions for ${e.name} v${e.version}`}
                                  actions={rowActions}
                                />
                              </div>
                            </td>
                          </tr>
                          {expanded && hasPrevious ? (
                            <tr className="cu-expandable-detail-row">
                              <td colSpan={COLUMNS.length}>
                                <div className="cu-expandable-detail">
                                  <div className="cu-marketplace-versions">
                                    <span className="cu-expandable-field__label">
                                      Previous versions
                                    </span>
                                    {versions.slice(1).map(v => (
                                      <div
                                        key={entryKey(v)}
                                        className="cu-table-actions"
                                        style={{ justifyContent: 'space-between' }}
                                      >
                                        <code className="cu-code-text">
                                          {v.version}
                                          {isInstalled(v) ? (
                                            <span className="cu-muted"> · installed</span>
                                          ) : null}
                                        </code>
                                        {renderInstall(v)}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      </div>
      {grantTarget ? (
        <GrantAccessModal
          entryName={grantTarget.entryName}
          orgScope={orgScope}
          opener={grantTarget.opener}
          onClose={() => setGrantTarget(null)}
        />
      ) : null}
      {confirmDialog}
    </section>
  )
}
