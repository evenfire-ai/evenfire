'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { SingleValueEditDialog } from '@clerum/frontend-components'
import { MarkdownContent } from '@components/MarkdownContent'
import { MarkdownEditor } from '@components/MarkdownEditor'
import { TabBar } from '@components/TabBar'
import { useToast } from '@components/Toast'
import { IconPencil, IconRefresh } from '@components/icons'
import { Button } from '@components/ui'
import { getHostPersonalization, updateHostPersonalization } from '@lib/api'
import { EMPTY_IDENTITY_FIELDS, FIELD_MAX_BYTES, IDENTITY_FIELDS } from './constants'
import type {
  HostIdentityTabProps,
  HostIdentityTabState,
  IdentityFieldKey,
  IdentityFields,
} from './types'

function fieldBytes(value: string): number {
  return new TextEncoder().encode(value).length
}

function fieldsFromPayload(payload: IdentityFields): IdentityFields {
  return {
    agents: payload.agents,
    identity: payload.identity,
    soul: payload.soul,
    user: payload.user,
  }
}

export function HostIdentityTab({ hostName, onActionsChange }: HostIdentityTabProps) {
  const { showToast } = useToast()
  const loadRequestId = useRef(0)
  const [state, setState] = useState<HostIdentityTabState>({
    activeField: 'identity',
    error: '',
    fields: { ...EMPTY_IDENTITY_FIELDS },
    initial: { ...EMPTY_IDENTITY_FIELDS },
    loading: true,
    reloadHint: false,
    resourceVersion: '',
    saving: false,
  })
  const [editing, setEditing] = useState(false)
  const [editBytes, setEditBytes] = useState(0)
  const stateRef = useRef(state)
  stateRef.current = state

  const activeConfig =
    IDENTITY_FIELDS.find(field => field.key === state.activeField) ?? IDENTITY_FIELDS[0]
  const activeValue = state.fields[activeConfig.key]

  const loadIdentityFiles = useCallback(async () => {
    const requestId = loadRequestId.current + 1
    loadRequestId.current = requestId
    setState(prev => ({ ...prev, error: '', loading: true, reloadHint: false }))
    try {
      const data = await getHostPersonalization(hostName)
      if (requestId !== loadRequestId.current) return
      const fields = fieldsFromPayload(data)
      setState(prev => ({
        ...prev,
        error: '',
        fields,
        initial: { ...fields },
        loading: false,
        reloadHint: false,
        resourceVersion: data.resourceVersion,
      }))
    } catch (error) {
      if (requestId !== loadRequestId.current) return
      const message = error instanceof Error ? error.message : 'Failed to load identity files'
      setState(prev => ({ ...prev, error: message, loading: false }))
      showToast(message, { tone: 'error' })
    }
  }, [hostName, showToast])

  useEffect(() => {
    void loadIdentityFiles()
    return () => {
      loadRequestId.current += 1
    }
  }, [loadIdentityFiles])

  useEffect(() => {
    onActionsChange?.(null)
    return () => onActionsChange?.(null)
  }, [onActionsChange])

  function openEditor() {
    setState(prev => ({ ...prev, error: '', reloadHint: false }))
    setEditBytes(fieldBytes(activeValue))
    setEditing(true)
  }

  function closeEditor() {
    if (state.saving) return
    setEditing(false)
    setState(prev => ({ ...prev, error: '', reloadHint: false }))
  }

  async function saveActiveField(value: string): Promise<void> {
    const current = stateRef.current
    const currentConfig =
      IDENTITY_FIELDS.find(field => field.key === current.activeField) ?? IDENTITY_FIELDS[0]
    if (value === current.fields[currentConfig.key] || fieldBytes(value) > FIELD_MAX_BYTES) return

    const nextFields = { ...current.fields, [currentConfig.key]: value }
    setState(prev => ({ ...prev, error: '', saving: true }))
    let result: { resourceVersion: string }
    try {
      result = await updateHostPersonalization(hostName, {
        agents: nextFields.agents,
        identity: nextFields.identity,
        resourceVersion: current.resourceVersion,
        soul: nextFields.soul,
        user: nextFields.user,
      })
    } catch (error) {
      const err = error as { message?: string; status?: number }
      const isConflict = err.status === 409 || /409/.test(err.message ?? '')
      const message = isConflict
        ? 'Someone else updated these identity files. Reload the latest version and reapply this draft.'
        : err.message || 'Save failed'
      setState(prev => ({
        ...prev,
        error: message,
        reloadHint: isConflict,
        saving: false,
      }))
      showToast(message, { tone: 'error' })
      return
    }

    try {
      const authoritative = await getHostPersonalization(hostName)
      const authoritativeFields = fieldsFromPayload(authoritative)
      setState(prev => ({
        ...prev,
        error: '',
        fields: authoritativeFields,
        initial: { ...authoritativeFields },
        reloadHint: false,
        resourceVersion: authoritative.resourceVersion,
        saving: false,
      }))
      setEditing(false)
      showToast(`${currentConfig.fileName} saved.`, { tone: 'success' })
    } catch (error) {
      const message =
        error instanceof Error
          ? `Document saved, but the latest identity files could not be reloaded: ${error.message}`
          : 'Document saved, but the latest identity files could not be reloaded.'
      setState(prev => ({
        ...prev,
        error: message,
        fields: nextFields,
        initial: { ...nextFields },
        reloadHint: false,
        resourceVersion: result.resourceVersion,
        saving: false,
      }))
      setEditing(false)
      showToast(message, { tone: 'error' })
    }
  }

  if (state.loading && !editing) {
    return (
      <div className="cu-identity-skeleton" aria-label="Loading identity files">
        <div className="cu-identity-skeleton__tabs" />
        <div className="cu-identity-skeleton__header" />
        <div className="cu-identity-skeleton__line" />
        <div className="cu-identity-skeleton__line cu-identity-skeleton__line--wide" />
        <div className="cu-identity-skeleton__box" />
      </div>
    )
  }

  return (
    <section className="cu-identity-panel" aria-label="Admin-managed identity files">
      <p className="cu-identity-panel__intro">
        Admin-managed identity files are readable by the agent but blocked from agent writes.
      </p>
      {state.error && !editing ? (
        <div className="cu-banner cu-banner--error" role="alert">
          {state.error}
          <Button
            className="cu-identity-reload"
            onClick={() => void loadIdentityFiles()}
            size="sm"
            variant="ghost"
          >
            <IconRefresh width={14} height={14} />
            Reload
          </Button>
        </div>
      ) : null}

      <TabBar<IdentityFieldKey>
        activeValue={state.activeField}
        ariaLabel="Identity file sections"
        className="cu-tabs--compact cu-identity-tabs"
        onChange={key => setState(prev => ({ ...prev, activeField: key, error: '' }))}
        options={IDENTITY_FIELDS.map(field => ({
          label: field.label,
          value: field.key,
        }))}
      />

      <div className="cu-identity-section">
        <div className="cu-identity-section__header">
          <div>
            <h3 className="cu-identity-section__title">{activeConfig.fileName}</h3>
            <p className="cu-identity-section__meta">{activeConfig.help}</p>
          </div>
          <Button onClick={openEditor} size="sm" type="button" variant="secondary">
            <IconPencil width={14} height={14} />
            Edit
          </Button>
        </div>

        <MarkdownContent
          ariaLabel={`Rendered ${activeConfig.label} document`}
          className="cu-identity-preview cu-gfs-markdown-preview__content"
          emptyMessage="This identity document is empty."
          source={activeValue}
        />
      </div>

      <SingleValueEditDialog
        closeButtonLabel={`Close ${activeConfig.fileName} editor`}
        description={activeConfig.help}
        discardLabel="Cancel"
        error={state.error || undefined}
        initialValue={activeValue}
        isValid={editBytes <= FIELD_MAX_BYTES && !state.reloadHint}
        onDismiss={closeEditor}
        onSave={value => void saveActiveField(value)}
        open={editing}
        pending={state.saving || state.loading}
        renderEditor={({ value, onChange, disabled }) => (
          <div className="cu-identity-dialog-editor">
            <MarkdownEditor
              ariaLabel={`${activeConfig.label} markdown`}
              className="cu-identity-editor__markdown"
              invalid={editBytes > FIELD_MAX_BYTES}
              onChange={next => {
                setEditBytes(fieldBytes(next))
                onChange(next)
              }}
              placeholder={activeConfig.placeholder}
              value={value}
            />
            <div className={editBytes > FIELD_MAX_BYTES ? 'cu-field__error' : 'cu-field__hint'}>
              {editBytes.toLocaleString()} bytes / {FIELD_MAX_BYTES.toLocaleString()} max
            </div>
            {state.reloadHint ? (
              <Button
                disabled={disabled}
                onClick={() => void loadIdentityFiles()}
                size="sm"
                type="button"
                variant="secondary"
              >
                <IconRefresh width={14} height={14} />
                Reload latest and reapply draft
              </Button>
            ) : null}
          </div>
        )}
        saveLabel="Save document"
        size="large"
        title={`Edit ${activeConfig.fileName}`}
      />
    </section>
  )
}
