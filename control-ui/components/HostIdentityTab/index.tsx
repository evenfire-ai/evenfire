'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { MarkdownEditor } from '@components/MarkdownEditor'
import { TabBar } from '@components/TabBar'
import { useToast } from '@components/Toast'
import { IconCheck, IconRefresh } from '@components/icons'
import { Button } from '@components/ui'
import { getHostPersonalization, updateHostPersonalization } from '@lib/api'
import {
  EMPTY_IDENTITY_FIELDS,
  FIELD_MAX_BYTES,
  IDENTITY_FIELDS,
  IDENTITY_FIELD_ORDER,
} from './constants'
import type { HostIdentityTabState, IdentityFieldKey, IdentityFields } from './types'

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

export function HostIdentityTab({ hostName }: { hostName: string }) {
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

  const activeConfig =
    IDENTITY_FIELDS.find(field => field.key === state.activeField) ?? IDENTITY_FIELDS[0]
  const activeValue = state.fields[activeConfig.key]
  const activeBytes = fieldBytes(activeValue)
  const activeDirty = activeValue !== state.initial[activeConfig.key]
  const activeTooLarge = activeBytes > FIELD_MAX_BYTES
  const anyDirty = IDENTITY_FIELD_ORDER.some(key => state.fields[key] !== state.initial[key])

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

  function setActiveField(key: IdentityFieldKey) {
    setState(prev => ({ ...prev, activeField: key }))
  }

  function setField(key: IdentityFieldKey, value: string) {
    setState(prev => ({
      ...prev,
      fields: { ...prev.fields, [key]: value },
    }))
  }

  function discardEdits() {
    setState(prev => ({
      ...prev,
      fields: { ...prev.initial },
      error: prev.reloadHint ? prev.error : '',
    }))
  }

  async function saveActiveField() {
    if (!activeDirty || activeTooLarge || state.reloadHint) return

    setState(prev => ({ ...prev, error: '', saving: true }))
    try {
      const result = await updateHostPersonalization(hostName, {
        agents: state.fields.agents,
        identity: state.fields.identity,
        resourceVersion: state.resourceVersion,
        soul: state.fields.soul,
        user: state.fields.user,
      })
      setState(prev => ({
        ...prev,
        initial: { ...prev.fields },
        resourceVersion: result.resourceVersion,
        saving: false,
      }))
      showToast('Identity files saved.', { tone: 'success' })
    } catch (error) {
      const err = error as { message?: string; status?: number }
      const isConflict = err.status === 409 || /409/.test(err.message ?? '')
      const message = isConflict
        ? 'Someone else updated these identity files. Reload before saving again.'
        : err.message || 'Save failed'
      setState(prev => ({
        ...prev,
        error: message,
        reloadHint: isConflict,
        saving: false,
      }))
      showToast(message, { tone: 'error' })
    }
  }

  if (state.loading) {
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
      <div className="cu-identity-panel__intro">
        <p className="cu-muted cu-muted-note--compact">
          Admin-managed identity files are readable by the agent but blocked from agent writes.
        </p>
        <div aria-hidden={!anyDirty} className="cu-identity-dirty-actions" data-hidden={!anyDirty}>
          <Button
            disabled={!activeDirty || activeTooLarge || state.saving || state.reloadHint}
            onClick={() => void saveActiveField()}
            size="sm"
            type="button"
            variant="primary"
          >
            <IconCheck width={14} height={14} />
            {state.saving ? 'Saving' : 'Save'}
          </Button>
          <Button
            disabled={state.saving}
            onClick={discardEdits}
            size="sm"
            type="button"
            variant="ghost"
          >
            Discard all
          </Button>
        </div>
      </div>

      {state.error && state.reloadHint ? (
        <div className="cu-banner cu-banner--error">
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
        onChange={setActiveField}
        options={IDENTITY_FIELDS.map(field => ({
          label: field.label,
          value: field.key,
        }))}
      />

      <div className="cu-identity-section">
        <div className="cu-identity-section__header">
          <div className="cu-identity-section__title-row">
            <h3 className="cu-identity-section__title">{activeConfig.fileName}</h3>
            <span aria-hidden={!anyDirty} className="cu-identity-dirty" data-hidden={!anyDirty}>
              Unsaved edits
            </span>
          </div>
        </div>

        <p className="cu-field__hint">{activeConfig.help}</p>

        <div className="cu-identity-editor">
          <MarkdownEditor
            ariaLabel={`${activeConfig.label} markdown`}
            className="cu-identity-editor__markdown"
            invalid={activeTooLarge}
            onChange={value => setField(activeConfig.key, value)}
            value={activeValue}
          />
          <div className={activeTooLarge ? 'cu-field__error' : 'cu-field__hint'}>
            {activeBytes.toLocaleString()} bytes / {FIELD_MAX_BYTES.toLocaleString()} max
          </div>
        </div>
      </div>
    </section>
  )
}
