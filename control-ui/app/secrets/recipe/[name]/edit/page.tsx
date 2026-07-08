'use client'

import React, { Suspense, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { DashboardLayout } from '@components/DashboardLayout'
import { IconKey } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { IconX } from '@components/icons'
import {
  type RecipeSecretOwnership,
  getRecipeSecrets,
  getRecipes,
  updateRecipeSecret,
} from '@lib/api'
import { collectWorkflowRecipeSecretRefs } from '@lib/workflowRecipeSecretRefs'

type RecipeDraftRow = {
  secretKey: string
  value: string
  // saved: a value is stored in the K8s Secret for this key.
  saved: boolean
  // declared: the key is referenced by a recipe's envSecret spec. Declared
  // keys have a fixed name and must not be renamed from this form.
  declared: boolean
}

function EditRecipeSecretContent() {
  const router = useRouter()
  const params = useParams<{ name: string }>()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const secretName = useMemo(() => {
    const raw = params?.name
    const value = Array.isArray(raw) ? raw[0] : raw
    try {
      return decodeURIComponent(value ?? '')
    } catch {
      return value ?? ''
    }
  }, [params])
  const targetNamespace = useMemo(() => {
    const raw = searchParams.get('namespace')
    return raw && raw.trim().length > 0 ? raw.trim() : 'sandbox-recipes'
  }, [searchParams])

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [rows, setRows] = useState<RecipeDraftRow[]>([])
  const [initialKeys, setInitialKeys] = useState<string[]>([])
  const [ownership, setOwnership] = useState<RecipeSecretOwnership | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!secretName) {
      setLoadError('Missing secret name in URL.')
      setLoading(false)
      return
    }
    void (async () => {
      try {
        const [res, recipesRes] = await Promise.all([
          getRecipeSecrets(),
          // Recipe declarations are advisory here — if they can't be loaded we
          // still show the stored keys rather than failing the whole form.
          getRecipes().catch(() => ({ items: [] })),
        ])
        if (cancelled) return
        const match = (res.items ?? []).find(
          s => s.name === secretName && (s.namespace || 'sandbox-recipes') === targetNamespace
        )
        if (!match) {
          setNotFound(true)
          setLoading(false)
          return
        }
        const storedKeys = Array.isArray(match.keys) ? match.keys : []
        setOwnership(match.ownership ?? { kind: 'unlabeled' })

        // Collect every key this secret is expected to hold, from any recipe
        // that references it via envSecret or snippet secretRef.
        const declaredKeys = new Set<string>()
        for (const recipe of recipesRes.items ?? []) {
          const spec = (recipe.spec ?? {}) as Record<string, unknown>
          for (const ref of collectWorkflowRecipeSecretRefs(spec).values()) {
            if (ref.secretName !== secretName || ref.namespace !== targetNamespace) continue
            ref.keys.forEach(key => declaredKeys.add(key))
          }
        }

        setInitialKeys(storedKeys)
        const storedSet = new Set(storedKeys)
        const unfilledDeclared = [...declaredKeys]
          .filter(k => !storedSet.has(k))
          .sort((a, b) => a.localeCompare(b))
        const nextRows: RecipeDraftRow[] = [
          ...storedKeys.map(k => ({
            secretKey: k,
            value: '',
            saved: true,
            declared: declaredKeys.has(k),
          })),
          ...unfilledDeclared.map(k => ({
            secretKey: k,
            value: '',
            saved: false,
            declared: true,
          })),
        ]
        setRows(
          nextRows.length > 0
            ? nextRows
            : [{ secretKey: '', value: '', saved: false, declared: false }]
        )
        setLoading(false)
      } catch (e) {
        if (cancelled) return
        setLoadError(e instanceof Error ? e.message : 'Failed to load recipe secret')
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [secretName, targetNamespace])

  function backToList() {
    router.push('/secrets/recipe')
  }

  function updateRow(index: number, field: keyof RecipeDraftRow, value: string) {
    setRows(current => current.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  }

  function addRow() {
    setRows(current => [...current, { secretKey: '', value: '', saved: false, declared: false }])
  }

  function removeRow(index: number) {
    setRows(current => current.filter((_, i) => i !== index))
  }

  async function save() {
    const data = Object.fromEntries(
      rows
        .map(row => [row.secretKey.trim(), row.value.trim()])
        .filter(([k, v]) => k.length > 0 && v.length > 0)
    )
    const survivingKeys = new Set(rows.map(r => r.secretKey.trim()).filter(k => k.length > 0))
    const removeKeys = initialKeys.filter(k => !survivingKeys.has(k))

    if (Object.keys(data).length === 0 && removeKeys.length === 0) {
      setError('Edit at least one value, add a new key, or remove an existing key.')
      return
    }

    setSaving(true)
    setError('')
    try {
      await updateRecipeSecret(secretName, data, removeKeys, targetNamespace)
      showToast(`Secret ${secretName} updated.`, { tone: 'success' })
      backToList()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save recipe secret')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreatePageHeader
          icon={<IconKey />}
          title={`Edit recipe secret${secretName ? `: ${secretName}` : ''}`}
          subtitle={`Stored values are never returned by the API. This Secret is in ${targetNamespace}. Leave a value blank to keep it, type a new value to overwrite, or remove a row to delete that key.`}
          backLabel="Back to secrets"
          onBack={backToList}
          backDisabled={saving}
        />

        <div className="cu-create-panel">
          <div className="cu-create-content">
            {loading ? (
              <div className="cu-banner cu-banner--info">Loading recipe secret…</div>
            ) : loadError ? (
              <div className="cu-banner cu-banner--error">{loadError}</div>
            ) : notFound ? (
              <div className="cu-banner cu-banner--error">
                Recipe secret <code>{secretName}</code> was not found in{' '}
                <code>{targetNamespace}</code>.
              </div>
            ) : (
              <>
                {ownership ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      marginBottom: '0.75rem',
                    }}
                  >
                    <span style={{ fontSize: '0.8125rem', color: 'var(--cu-text-soft)' }}>
                      Ownership:
                    </span>
                    {ownership.kind === 'shared' ? (
                      <span className="cu-chip" title="Any recipe can reference this secret">
                        Shared
                      </span>
                    ) : ownership.kind === 'owner-recipe' ? (
                      <span
                        className="cu-chip"
                        title={`Only ${ownership.recipeName} can reference this secret`}
                      >
                        Owner: {ownership.recipeName}
                      </span>
                    ) : (
                      <span
                        className="cu-chip"
                        style={{
                          color: 'var(--cu-warn-text, var(--cu-text-soft))',
                          borderColor: 'var(--cu-warn-border, var(--cu-border-subtle))',
                        }}
                        title="Secret has no ownership label — WRC will refuse to project it into any recipe"
                      >
                        Unlabeled — WRC will refuse projection
                      </span>
                    )}
                  </div>
                ) : null}

                <div className="cu-banner cu-banner--info" style={{ marginBottom: '0.75rem' }}>
                  Rows marked <strong>saved</strong> already have a value stored — leave the value
                  blank to keep it, or type a new value to overwrite. Rows marked{' '}
                  <strong>unset</strong> are keys a recipe references but no value is stored yet;
                  fill in the ones your workloads need. Removing a row deletes that key on save.
                </div>

                {rows.map((row, index) => {
                  const unset = row.declared && !row.saved
                  return (
                    <div
                      className="cu-form-inline"
                      key={`recipe-edit-${index}`}
                      style={{ marginBottom: '0.5rem', alignItems: 'center', gap: '0.5rem' }}
                    >
                      <input
                        value={row.secretKey}
                        onChange={e => updateRow(index, 'secretKey', e.target.value)}
                        placeholder="API_KEY"
                        disabled={saving || row.saved || row.declared}
                        aria-label={
                          row.saved
                            ? `Existing key ${row.secretKey}`
                            : unset
                              ? `Unset recipe key ${row.secretKey}`
                              : 'New key name'
                        }
                      />
                      <input
                        value={row.value}
                        onChange={e => updateRow(index, 'value', e.target.value)}
                        placeholder={
                          row.saved
                            ? '•••••••• (saved — type to overwrite)'
                            : unset
                              ? 'referenced by recipe — enter value'
                              : 'secret value'
                        }
                        type="password"
                        autoComplete="off"
                        disabled={saving}
                      />
                      {row.saved ? (
                        <span
                          style={{
                            fontSize: '0.7rem',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '4px',
                            background: 'var(--cu-bg-soft, #eef)',
                            color: 'var(--cu-text-soft)',
                            whiteSpace: 'nowrap',
                          }}
                          title="A value is already stored for this key"
                        >
                          saved
                        </span>
                      ) : unset ? (
                        <span
                          className="cu-chip"
                          style={{
                            fontSize: '0.7rem',
                            padding: '0.15rem 0.4rem',
                            borderRadius: '4px',
                            color: 'var(--cu-warn-text, var(--cu-text-soft))',
                            borderColor: 'var(--cu-warn-border, var(--cu-border-subtle))',
                            whiteSpace: 'nowrap',
                          }}
                          title="This recipe references this key but no value is stored yet"
                        >
                          unset
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="cu-btn cu-btn--icon cu-btn--danger-icon"
                        onClick={() => removeRow(index)}
                        disabled={saving || rows.length === 1 || unset}
                        aria-label={`Remove key row ${index + 1}`}
                      >
                        <IconX width={16} height={16} />
                      </button>
                    </div>
                  )
                })}

                <div>
                  <button
                    type="button"
                    className="cu-btn cu-btn--ghost cu-btn--sm"
                    onClick={addRow}
                    disabled={saving}
                  >
                    Add key
                  </button>
                </div>
              </>
            )}

            {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}
          </div>

          <div className="cu-create-actions">
            <button
              type="button"
              className="cu-btn cu-btn--ghost"
              onClick={backToList}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="cu-btn cu-btn--primary"
              onClick={() => void save()}
              disabled={loading || saving || notFound || Boolean(loadError)}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </DashboardLayout>
    </AuthGate>
  )
}

export default function EditRecipeSecretPage() {
  return (
    <Suspense fallback={<div>Loading…</div>}>
      <EditRecipeSecretContent />
    </Suspense>
  )
}
