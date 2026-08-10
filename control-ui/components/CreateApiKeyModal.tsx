'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CreateRegistryApiKeyInput } from '../lib/api'
import { Button, CheckboxField, Field, TextInput } from './ui'

const SCOPES: { id: string; label: string; help: string; danger?: boolean }[] = [
  { id: 'registry:read', label: 'read', help: 'View org entries' },
  { id: 'registry:publish', label: 'publish', help: 'Publish new versions to @org/*' },
  { id: 'registry:update', label: 'update', help: 'Edit existing org entries' },
  {
    id: 'registry:delete',
    label: 'delete',
    help: 'Permanently remove org entries (destructive)',
    danger: true,
  },
]
const QUICK_PICKS: { label: string; days: number | null }[] = [
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '365 days', days: 365 },
  { label: 'Never', days: null },
]

export default function CreateApiKeyModal({
  onCreate,
  onCancel,
}: {
  onCreate: (input: CreateRegistryApiKeyInput) => Promise<void>
  onCancel: () => void
}) {
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState<Set<string>>(
    new Set(['registry:read', 'registry:publish', 'registry:update'])
  )
  const [days, setDays] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const descRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    descRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const expiresPreview = useMemo(() => {
    const n = Number(days)
    if (!days || !Number.isInteger(n) || n < 1) return null
    const d = new Date()
    d.setDate(d.getDate() + n)
    return d.toLocaleDateString()
  }, [days])

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function submit() {
    setError(null)
    if (selected.size === 0) {
      setError('Select at least one scope.')
      return
    }
    if (description.length > 200) {
      setError('Description must be 200 characters or fewer.')
      return
    }
    const input: CreateRegistryApiKeyInput = {
      scopes: SCOPES.map(s => s.id).filter(id => selected.has(id)),
    }
    if (description.trim()) input.description = description.trim()
    if (days) {
      const n = Number(days)
      if (!Number.isInteger(n) || n < 1 || n > 3650) {
        setError('Expiry must be between 1 and 3650 days.')
        return
      }
      input.expiresInDays = n
    }
    setPending(true)
    try {
      await onCreate(input)
    } catch (e) {
      const code = (e as { code?: string }).code
      const status = (e as { status?: number }).status
      if (status === 429) {
        setError('Too many requests — try again shortly.')
      } else {
        setError(
          code === 'invalid_scope'
            ? 'Invalid scope selection.'
            : code === 'invalid_description'
              ? 'Invalid description.'
              : code === 'invalid_expiry'
                ? 'Invalid expiry.'
                : code === 'too_many_keys'
                  ? 'You have reached the 100-key limit. Revoke an unused key first.'
                  : 'Could not create the key. Please try again.'
        )
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="cu-modal-overlay" role="presentation">
      <div className="cu-modal" role="dialog" aria-modal="true" aria-labelledby="create-key-title">
        <h3 id="create-key-title" className="cu-modal-panel__title">
          Create API key
        </h3>
        <p className="cu-field__hint">The key value is shown only once, right after creation.</p>

        <Field htmlFor="key-desc" label="Description">
          {/* ref requires a native input element since TextInput does not use forwardRef */}
          <input
            id="key-desc"
            ref={descRef}
            className="cu-input"
            maxLength={200}
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="e.g. CI publisher"
          />
        </Field>

        <fieldset className="cu-scope-fieldset">
          <legend>Scopes</legend>
          {SCOPES.map(s => (
            <CheckboxField
              key={s.id}
              checked={selected.has(s.id)}
              onChange={() => toggle(s.id)}
              label={
                <>
                  <code>{s.id}</code> — {s.help}
                </>
              }
              description={
                s.danger && selected.has(s.id) ? (
                  <span className="cu-scope-danger-note">
                    Destructive — grants permanent removal of org entries.
                  </span>
                ) : undefined
              }
            />
          ))}
        </fieldset>

        <Field htmlFor="key-expiry" label="Expires in (days)">
          <div className="cu-quick-picks">
            {QUICK_PICKS.map(q => (
              <Button
                key={q.label}
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDays(q.days === null ? '' : String(q.days))}
              >
                {q.label}
              </Button>
            ))}
          </div>
          <TextInput
            id="key-expiry"
            type="number"
            min={1}
            max={3650}
            value={days}
            onChange={e => setDays(e.target.value)}
            placeholder="blank = never (max 3650)"
          />
          {expiresPreview ? <p className="cu-field__hint">Expires {expiresPreview}</p> : null}
        </Field>

        {error ? (
          <p className="cu-field__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="cu-modal-actions">
          <Button type="button" variant="primary" disabled={pending} onClick={submit}>
            {pending ? 'Creating…' : 'Create key'}
          </Button>
          <Button type="button" variant="ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}
