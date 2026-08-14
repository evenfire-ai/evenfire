'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { RegistryEntryDetailSkeleton } from '@components/RegistryEntryDetailSkeleton'
import { IconStore } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { IconMoreHorizontal } from '@components/icons'
import { CONTROL_ROUTES } from '@constants/routes'
import { DEFAULT_WORKFLOW_RECIPE_NAMESPACE } from '@constants/workflowRecipes'
import {
  type RegistryEntry,
  type RegistryInstalledState,
  deleteRegistryEntry,
  getRegistryCatalog,
  installRecipeFromRegistry,
} from '@lib/api'
import { useRegistryCapability } from '@lib/hooks/useRegistryCapability'
import { trustBgColor, trustColor } from '@lib/trustLevel'
import RegistryEntryDetailLoading from './loading'

export const dynamic = 'force-dynamic'

function RegistryEntryActionsMenu({
  onEdit,
  onRemove,
  removing,
  sourceRepoUrl,
  canManage,
}: {
  onEdit: () => void
  onRemove: () => void
  removing: boolean
  sourceRepoUrl: string | null
  canManage: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleDocClick(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    function handleEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleDocClick)
    document.addEventListener('keydown', handleEsc)
    return () => {
      document.removeEventListener('mousedown', handleDocClick)
      document.removeEventListener('keydown', handleEsc)
    }
  }, [open])

  // Non-owners see management removed entirely (design spec §5.4); the source
  // repo link is discovery, so it stays. With neither, there is no menu.
  if (!canManage && !sourceRepoUrl) return null

  return (
    <div ref={ref} className="cu-kebab">
      <button
        type="button"
        aria-label="Marketplace entry actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="cu-btn cu-btn--icon cu-btn--ghost cu-kebab__trigger"
        onClick={() => setOpen(value => !value)}
      >
        <IconMoreHorizontal width={18} height={18} />
      </button>
      {open ? (
        <div className="cu-kebab__menu" role="menu">
          {sourceRepoUrl ? (
            <a
              className="cu-kebab__item"
              role="menuitem"
              href={sourceRepoUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
            >
              Source repo
            </a>
          ) : null}
          {canManage ? (
            <>
              <button
                type="button"
                className="cu-kebab__item"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  onEdit()
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="cu-kebab__item cu-kebab__item--danger"
                role="menuitem"
                disabled={removing}
                onClick={() => {
                  setOpen(false)
                  onRemove()
                }}
              >
                {removing ? 'Removing...' : 'Remove'}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default function RegistryEntryDetailPage() {
  return (
    <Suspense fallback={<RegistryEntryDetailLoading />}>
      <RegistryEntryDetailContent />
    </Suspense>
  )
}

function RegistryEntryDetailContent() {
  const router = useRouter()
  const params = useParams<{ name: string; version: string }>()
  const name = decodeURIComponent(params?.name ?? '')
  const version = decodeURIComponent(params?.version ?? '')

  const [entry, setEntry] = useState<RegistryEntry | null>(null)
  const [installed, setInstalled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [removing, setRemoving] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [actionError, setActionError] = useState('')
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()
  const { capability } = useRegistryCapability()
  // Management (edit/remove) belongs to the entry's owner, or to a curator who
  // administers the shared catalog (design spec §5.4). Ownership is derived from
  // the org-scope prefix on the entry name (publishes are stored as `@org/name`).
  const orgScope = capability?.scope ?? null
  const canManageEntry =
    !!entry &&
    (capability?.isCurator === true || (!!orgScope && entry.name.startsWith(`${orgScope}/`)))

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const catalog = await getRegistryCatalog({ limit: '500' })
      const match = catalog.data.find(e => e.name === name && e.version === version)
      if (!match) {
        setLoadError(`Entry "${name}" v${version} not found in Marketplace.`)
        setEntry(null)
        return
      }
      setEntry(match)
      setInstalled(computeInstalled(match, catalog.installed))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load Marketplace entry')
    } finally {
      setLoading(false)
    }
  }, [name, version])

  useEffect(() => {
    if (name && version) void load()
  }, [name, version, load])

  function backToCatalog() {
    router.push(
      entry?.entry_type === 'recipe'
        ? CONTROL_ROUTES.marketplace.plugins
        : CONTROL_ROUTES.marketplace.connectors
    )
  }

  function editEntry() {
    if (!entry) return
    router.push(CONTROL_ROUTES.marketplace.editEntry(entry.name, entry.version))
  }

  async function handleInstall() {
    if (!entry || installing) return
    if (entry.entry_type === 'recipe' && entry.recipe_meta?.recipeYaml) {
      setInstalling(true)
      setActionError('')
      try {
        const result = await installRecipeFromRegistry({
          registryEntryName: entry.name,
          registryEntryVersion: entry.version,
          recipeManifest: entry.recipe_meta.recipeYaml,
        })
        showToast(`Installed ${entry.name} v${entry.version}.`, { tone: 'success' })
        router.push(
          CONTROL_ROUTES.plugins.tab(
            DEFAULT_WORKFLOW_RECIPE_NAMESPACE,
            result.recipeName,
            'workloads'
          )
        )
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to install plugin')
        setInstalling(false)
      }
      return
    }
    if (entry.entry_type === 'mcp-server') {
      const params = new URLSearchParams({ entry: entry.name, version: entry.version })
      router.push(CONTROL_ROUTES.marketplace.install(Object.fromEntries(params)))
      return
    }
  }

  async function handleRemove() {
    if (!entry || removing) return
    const shouldRemove = await confirm({
      title: 'Remove Marketplace Entry',
      message: `Remove "${entry.name}" v${entry.version} from the Marketplace? Already-installed copies keep running.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!shouldRemove) return

    setRemoving(true)
    setActionError('')
    try {
      await deleteRegistryEntry(entry.name, entry.version)
      showToast(`Removed ${entry.name} v${entry.version} from the Marketplace.`, {
        tone: 'success',
      })
      backToCatalog()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to remove from Marketplace')
      setRemoving(false)
    }
  }

  const recipeYaml = entry?.entry_type === 'recipe' ? (entry.recipe_meta?.recipeYaml ?? '') : ''
  const sourceRepoUrl = useMemo(() => extractSourceRepoUrl(recipeYaml), [recipeYaml])
  const images = useMemo(() => extractImages(recipeYaml), [recipeYaml])

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreateFlowPanel
          className="cu-detail-flow-panel"
          header={
            <CreatePageHeader
              icon={<IconStore />}
              title={entry ? `${entry.name}` : 'Marketplace entry'}
              subtitle={
                entry
                  ? `v${entry.version} · by ${entry.author} · ${labelForType(entry.entry_type)}`
                  : 'Loading...'
              }
              backLabel="Back to Marketplace"
              onBack={backToCatalog}
              titleActions={
                entry ? (
                  <>
                    {entry.status === 'published' ? (
                      installed ? (
                        <button type="button" className="cu-btn cu-btn--sm" disabled>
                          Installed
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="cu-btn cu-btn--primary cu-btn--sm"
                          disabled={installing}
                          onClick={handleInstall}
                        >
                          {installing ? 'Installing...' : 'Install'}
                        </button>
                      )
                    ) : null}
                    <RegistryEntryActionsMenu
                      onEdit={editEntry}
                      onRemove={() => void handleRemove()}
                      removing={removing}
                      sourceRepoUrl={sourceRepoUrl}
                      canManage={canManageEntry}
                    />
                  </>
                ) : undefined
              }
            />
          }
        >
          {null}
        </CreateFlowPanel>

        {actionError ? (
          <div className="cu-banner cu-banner--error" role="alert">
            {actionError}
          </div>
        ) : null}

        {loading ? (
          <RegistryEntryDetailSkeleton />
        ) : loadError ? (
          <div className="cu-card">
            <div className="cu-card__body">
              <div className="cu-banner cu-banner--error">{loadError}</div>
            </div>
          </div>
        ) : entry ? (
          <div className="cu-card">
            <div className="cu-card__body cu-marketplace-detail">
              <div className="cu-expandable-detail cu-marketplace-detail__overview">
                <div className="cu-expandable-detail__fields">
                  <div className="cu-expandable-field">
                    <span className="cu-expandable-field__label">Version</span>
                    <span className="cu-code-text">{entry.version}</span>
                  </div>
                  <div className="cu-expandable-field">
                    <span className="cu-expandable-field__label">Visibility</span>
                    {entry.visibility ? (
                      <span
                        className={`cu-registry-chip cu-registry-chip--visibility-${entry.visibility}`}
                      >
                        {entry.visibility === 'public' ? 'Public' : 'Private'}
                      </span>
                    ) : (
                      <span className="cu-muted">—</span>
                    )}
                  </div>
                  <div className="cu-expandable-field">
                    <span className="cu-expandable-field__label">Downloads</span>
                    <span>{entry.downloads}</span>
                  </div>
                  <div className="cu-expandable-field">
                    <span>{entry.category || 'Uncategorized'}</span>
                  </div>
                  <div className="cu-expandable-field">
                    <span className="cu-expandable-field__label">Type</span>
                    <span className="cu-registry-type-meta">
                      {entry.server_mode
                        ? `${entry.server_mode}${entry.transport ? ` / ${entry.transport}` : ''}`
                        : entry.recipe_type || '—'}
                    </span>
                  </div>
                  <div className="cu-expandable-field">
                    <span className="cu-expandable-field__label">Trust</span>
                    <span
                      className="cu-registry-chip"
                      style={{
                        color: trustColor(entry.trust_level),
                        backgroundColor: trustBgColor(entry.trust_level),
                        borderColor: trustColor(entry.trust_level),
                      }}
                    >
                      {entry.trust_level.toUpperCase()}
                    </span>
                  </div>
                  <div className="cu-expandable-field">
                    <span className="cu-expandable-field__label">Verification</span>
                    <span
                      className={`cu-registry-chip cu-registry-chip--quality-${entry.quality_tier}`}
                    >
                      {entry.quality_tier}
                    </span>
                  </div>
                  {entry.tags.length > 0 && (
                    <div className="cu-expandable-field">
                      <span className="cu-expandable-field__label">Tags</span>
                      <div className="cu-expandable-tags">
                        {entry.tags.map(tag => (
                          <span key={tag} className="cu-registry-tag">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <p className="cu-expandable-detail__description">
                  {entry.description || 'No description provided.'}
                </p>
              </div>

              {images.length > 0 ? (
                <section className="cu-marketplace-detail__section">
                  <h3 className="cu-marketplace-detail__section-title">Container images</h3>
                  <p className="cu-marketplace-detail__hint">
                    Images this recipe pulls at install time. Verify each is publicly pullable
                    before installing.
                  </p>
                  <ul className="cu-marketplace-detail__image-list">
                    {images.map(img => {
                      const link = imageRegistryUrl(img)
                      return (
                        <li key={img} className="cu-marketplace-detail__image-item">
                          <span>{img}</span>
                          {link ? (
                            <a
                              className="cu-link"
                              href={link}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              View image
                            </a>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ) : null}

              {recipeYaml ? (
                <section className="cu-marketplace-detail__section">
                  <details className="cu-marketplace-detail__details">
                    <summary className="cu-marketplace-detail__summary-trigger">
                      <strong>Recipe YAML</strong>{' '}
                      <span className="cu-muted">(click to expand)</span>
                    </summary>
                    <pre className="cu-marketplace-detail__code">{recipeYaml}</pre>
                  </details>
                </section>
              ) : null}
            </div>
          </div>
        ) : null}
        {confirmDialog}
      </DashboardLayout>
    </AuthGate>
  )
}

function labelForType(t: string): string {
  if (t === 'mcp-server') return 'Connector'
  if (t === 'recipe') return 'Recipe'
  return t
}

function computeInstalled(entry: RegistryEntry, installedState: RegistryInstalledState): boolean {
  const key = `${entry.name}@${entry.version}`
  if (entry.entry_type === 'mcp-server') {
    return (
      installedState.catalogKeys.includes(key) || installedState.serverNames.includes(entry.name)
    )
  }
  if (entry.entry_type === 'recipe') {
    return installedState.recipeKeys.includes(key)
  }
  return false
}

/**
 * Pull a source repo URL out of the recipe YAML's metadata annotations.
 * Convention: `clerum.io/source-repo: https://…`. Returns null when the
 * annotation is absent — UI hides the CTA in that case.
 *
 * Regex-based, not a YAML parse, to keep the page bundle-free of yaml libs.
 */
function extractSourceRepoUrl(yaml: string): string | null {
  if (!yaml) return null
  // Match the annotation form, with or without quotes around the URL.
  const m =
    yaml.match(/clerum\.io\/source-repo:\s*["']?(https?:\/\/[^\s"']+)/) ??
    yaml.match(/['"]clerum\.io\/source-repo['"]\s*:\s*["']?(https?:\/\/[^\s"']+)/)
  return m ? m[1] : null
}

/**
 * Find every `image:` value under the recipe spec. Returns deduped, in
 * declaration order. Regex-based for the same bundle-size reason as the
 * source-repo extraction; YAML edge cases that defeat this (multi-doc,
 * unusual indentation) just produce a partial list, never wrong matches.
 */
function extractImages(yaml: string): string[] {
  if (!yaml) return []
  const seen = new Set<string>()
  const out: string[] = []
  // `image: foo/bar:tag` or `image: "foo/bar:tag"` or `image: 'foo/bar:tag'`.
  const re = /^\s*-?\s*image:\s*["']?([^\s"']+)/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(yaml)) !== null) {
    const v = m[1]
    if (!seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

/**
 * Best-effort link from an image reference to its registry's web view.
 * Recognizes Docker Hub (incl. the default `docker.io/`), ghcr.io, and
 * quay.io; falls back to null for everything else (custom private
 * registries can't be linked usefully without per-deploy config).
 */
function imageRegistryUrl(image: string): string | null {
  // Drop any digest / tag for the URL — Docker Hub treats them as fragments.
  const bare = image.split('@')[0].split(':')[0]
  // Normalise `docker.io/owner/name` → `owner/name`.
  const noDocker = bare.replace(/^docker\.io\//, '')
  if (bare.startsWith('ghcr.io/')) {
    const path = bare.slice('ghcr.io/'.length)
    // ghcr.io/<owner>/<name> → https://github.com/<owner>/<name>/pkgs/container/<name>
    const parts = path.split('/')
    if (parts.length >= 2) {
      const owner = parts[0]
      const pkg = parts[parts.length - 1]
      return `https://github.com/${owner}/${pkg}/pkgs/container/${pkg}`
    }
    return null
  }
  if (bare.startsWith('quay.io/')) {
    return `https://quay.io/repository/${bare.slice('quay.io/'.length)}`
  }
  // Heuristic: anything else with a `/` and no extra `.` in the first path
  // segment is treated as Docker Hub. Single-segment images (e.g. `nginx`)
  // are official Docker Hub library images.
  if (!noDocker.includes('/')) {
    return `https://hub.docker.com/_/${noDocker}`
  }
  const firstSegment = noDocker.split('/')[0]
  if (!firstSegment.includes('.')) {
    return `https://hub.docker.com/r/${noDocker}`
  }
  return null
}
