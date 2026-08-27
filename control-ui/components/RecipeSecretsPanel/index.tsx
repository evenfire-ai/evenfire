'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  type RecipeSecretItem,
  deleteRecipeSecret,
  getRecipe,
  getRecipeSecrets,
} from '../../lib/api'
import { llmChainRequiresSecret } from '../../lib/llm'
import { collectWorkflowRecipeSecretRefs } from '../../lib/workflowRecipeSecretRefs'
import { useConfirmDialog } from '../ConfirmDialog'
import { RowActionsMenu } from '../RowActionsMenu'
import { TablePanelHeader } from '../TablePanelHeader'
import { useToast } from '../Toast'
import { IconRefresh } from '../icons'

type RecipeSecretStatus = 'provisioned' | 'missing'

type RowOwnership =
  | { kind: 'shared' }
  | { kind: 'owner-recipe'; recipeName: string }
  | { kind: 'unlabeled' }
  | null

type Row = {
  name: string
  namespace: string
  keys: string[]
  status: RecipeSecretStatus
  ownership: RowOwnership
}

const DEFAULT_RECIPE_SECRET_NAMESPACE = 'sandbox-recipes'

/**
 * Recipe-secrets panel scoped to a single WorkflowRecipe. Lists every
 * API-key style Secret referenced by the recipe, joins against the
 * actually-provisioned recipe Secrets, and surfaces "missing" rows so the
 * operator sees which credentials still need to be created in the namespace
 * where the workload will read them.
 *
 * The full LLM/MCP/recipe lifecycle lives on the global Secrets page
 * (`/secrets/recipe`); this panel reuses the same Secret CRUD routes
 * (`/secrets/new?scope=recipe`, `/secrets/recipe/<name>/edit`) so a user
 * acting on a missing key ends up in the same flow.
 */
export function RecipeSecretsPanel({
  recipeName,
  onCountChange,
}: {
  recipeName: string
  onCountChange?: (n: number) => void
}) {
  const router = useRouter()
  const [rows, setRows] = useState<Row[]>([])
  const [brokerBackedAgent, setBrokerBackedAgent] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deletingName, setDeletingName] = useState<string | null>(null)
  const { confirm, confirmDialog } = useConfirmDialog()
  const { showToast } = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [secretsResult, recipe] = await Promise.all([getRecipeSecrets(), getRecipe(recipeName)])
      const secrets: RecipeSecretItem[] = secretsResult.items ?? []
      const provisionedByRef = new Map(
        secrets.map(s => [`${s.namespace || DEFAULT_RECIPE_SECRET_NAMESPACE}/${s.name}`, s])
      )

      const spec = (recipe.spec ?? {}) as Record<string, unknown>
      const refs = collectWorkflowRecipeSecretRefs(spec)
      const agent = (spec.agent ?? {}) as { provider?: string }
      setBrokerBackedAgent(
        typeof agent.provider === 'string' && !llmChainRequiresSecret(agent.provider)
      )

      const next: Row[] = []
      for (const ref of refs.values()) {
        const provisioned = provisionedByRef.get(`${ref.namespace}/${ref.secretName}`)
        if (provisioned) {
          next.push({
            name: ref.secretName,
            namespace: ref.namespace,
            keys: Array.isArray(provisioned.keys) ? provisioned.keys : [],
            status: 'provisioned',
            ownership: provisioned.ownership ?? { kind: 'unlabeled' },
          })
        } else {
          next.push({
            name: ref.secretName,
            namespace: ref.namespace,
            keys: Array.from(ref.keys).sort((a, b) => a.localeCompare(b)),
            status: 'missing',
            ownership: null,
          })
        }
      }
      next.sort((a, b) => {
        if (a.status !== b.status) return a.status === 'missing' ? -1 : 1
        return `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`)
      })
      setRows(next)
      onCountChange?.(next.length)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load recipe secrets')
    } finally {
      setLoading(false)
    }
  }, [recipeName, onCountChange])

  useEffect(() => {
    void load()
  }, [load])

  function navigateToEdit(name: string, namespace: string) {
    const qs = new URLSearchParams({ namespace })
    router.push(CONTROL_ROUTES.secrets.editRecipe(name, Object.fromEntries(qs)))
  }

  function navigateToCreate(secretName: string, namespace: string, keys: string[]) {
    const params = new URLSearchParams({
      scope: 'recipe',
      name: secretName,
      ownerRecipe: recipeName,
      namespace,
    })
    if (keys.length > 0) params.set('keys', keys.join(','))
    router.push(CONTROL_ROUTES.secrets.new(Object.fromEntries(params)))
  }

  function navigateToCreateBlank() {
    router.push(CONTROL_ROUTES.secrets.new({ scope: 'recipe' }))
  }

  async function deleteRow(name: string, namespace: string) {
    const shouldDelete = await confirm({
      title: 'Delete Recipe Secret',
      message: `Delete recipe secret ${name} from ${namespace}?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!shouldDelete) return

    const deleteKey = `${namespace}/${name}`
    setDeletingName(deleteKey)
    setError('')
    try {
      await deleteRecipeSecret(name, namespace)
      showToast(`Secret ${name} deleted.`, { tone: 'success' })
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete recipe secret')
    } finally {
      setDeletingName(null)
    }
  }

  const missingCount = useMemo(() => rows.filter(r => r.status === 'missing').length, [rows])

  return (
    <div className="cu-card">
      <TablePanelHeader
        title={loading && rows.length === 0 ? 'Secrets' : `Secrets (${rows.length})`}
        subtitle={
          <>
            Recipe-scope Secrets referenced by this recipe&apos;s API-key fields. Each row shows the
            namespace where the workload will read the Secret.
          </>
        }
        actions={
          <>
            <button
              type="button"
              className="cu-btn cu-btn--icon cu-btn--toolbar"
              onClick={() => void load()}
              disabled={loading}
              aria-label={loading ? 'Refreshing…' : 'Reload secrets'}
            >
              <IconRefresh className={loading ? 'cu-spin' : undefined} width={18} height={18} />
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--primary cu-btn--sm"
              onClick={navigateToCreateBlank}
            >
              Create secret
            </button>
          </>
        }
      />

      {error ? (
        <div className="cu-banner cu-banner--error" style={{ padding: '0.85rem 1rem 0' }}>
          {error}
        </div>
      ) : null}

      {loading && rows.length === 0 ? (
        <div className="cu-card__body">
          <span className="cu-muted">Loading secrets…</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="cu-empty">
          {brokerBackedAgent
            ? 'This recipe uses a broker-backed agent and does not require an LLM secret.'
            : 'This recipe declares no API-key Secret references.'}
        </div>
      ) : (
        <div className="cu-table-wrap">
          <table className="cu-table">
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ width: '50%' }}>Keys</th>
                <th style={{ width: '8rem', textAlign: 'right' }} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={`${row.status}:${row.namespace}:${row.name}`}>
                  <td>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span>{row.name}</span>
                      <span className="cu-chip" title={`Secret namespace: ${row.namespace}`}>
                        {row.namespace}
                      </span>
                      {row.status === 'missing' ? (
                        <span
                          className="cu-chip"
                          style={{
                            color: 'var(--cu-warn-text, var(--cu-text-soft))',
                            borderColor: 'var(--cu-warn-border, var(--cu-border-subtle))',
                          }}
                        >
                          Missing
                        </span>
                      ) : null}
                      {row.ownership?.kind === 'shared' ? (
                        <span className="cu-chip" title="Any recipe can reference this secret">
                          Shared
                        </span>
                      ) : null}
                      {row.ownership?.kind === 'owner-recipe' ? (
                        <span
                          className="cu-chip"
                          title={`Only ${row.ownership.recipeName} can reference this secret`}
                        >
                          Owner: {row.ownership.recipeName}
                        </span>
                      ) : null}
                      {row.ownership?.kind === 'unlabeled' ? (
                        <span
                          className="cu-chip"
                          style={{
                            color: 'var(--cu-warn-text, var(--cu-text-soft))',
                            borderColor: 'var(--cu-warn-border, var(--cu-border-subtle))',
                          }}
                          title="Secret has no ownership label — WRC will refuse to project it"
                        >
                          Unlabeled
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td style={{ color: 'var(--cu-text-soft)', fontSize: '0.8125rem' }}>
                    {row.keys.length > 0
                      ? row.keys.join(', ')
                      : row.status === 'missing'
                        ? 'No keys declared by recipe.'
                        : 'No keys defined.'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {row.status === 'missing' ? (
                      <button
                        type="button"
                        className="cu-btn cu-btn--primary cu-btn--sm"
                        onClick={() => navigateToCreate(row.name, row.namespace, row.keys)}
                        aria-label={`Add recipe secret ${row.name}`}
                      >
                        Add
                      </button>
                    ) : (
                      <RowActionsMenu
                        ariaLabel={`Actions for recipe secret ${row.name}`}
                        horizontalTrigger
                        actions={[
                          {
                            key: 'edit',
                            label: 'Update',
                            onClick: () => navigateToEdit(row.name, row.namespace),
                          },
                          {
                            key: 'delete',
                            label:
                              deletingName === `${row.namespace}/${row.name}`
                                ? 'Deleting…'
                                : 'Delete',
                            danger: true,
                            disabled: deletingName === `${row.namespace}/${row.name}`,
                            onClick: () => void deleteRow(row.name, row.namespace),
                          },
                        ]}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {missingCount > 0 ? (
        <div className="cu-card__body" style={{ paddingTop: '0.8rem' }}>
          <div className="cu-banner cu-banner--info">
            This recipe references {missingCount} secret{missingCount === 1 ? '' : 's'} that
            don&apos;t exist yet. Click <strong>Add</strong> on a Missing row to provision it in the
            namespace shown on that row.
          </div>
        </div>
      ) : null}
      {confirmDialog}
    </div>
  )
}
