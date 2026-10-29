import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { Alert, Button, Empty, Flex, Select, Tag, Tooltip } from 'antd'
import type { HostModelOption } from '@hooks/useChatStore'
import { useHostModels } from '@hooks/useHostModels'
import { isBrokerBackedProvider } from '@lib/hostModelSelectionStore'

export interface ModelSelectorProps {
  /** The agent IS the hostRef for desktop chats (mirrors ContextWindowIndicator). */
  agentRef: string
  chatId: string
  /** Placement follows the owning surface; Ant Design positions the popup. */
  placement?: 'down' | 'up'
}

/** How long the "applies to your next message" confirmation badge stays up. */
const APPLIED_BADGE_MS = 4000

/** Broker-backed hosts have no static default; the operator must name a model. */
const SELECT_MODEL_LABEL = 'Select model'

function isOfferedForNewPick(option: HostModelOption, sessionModel: string | null): boolean {
  const isCurrent = Boolean(sessionModel) && option.name === sessionModel
  if (isCurrent) return true
  return !option.stale && !option.disabled
}

/** Human label for a model: operator `displayName` if set, else the raw name. */
function modelLabel(name: string, options: HostModelOption[]): string {
  const match = options.find(option => option.name === name)
  return match?.displayName?.trim() || name
}

/**
 * Per-session model selector for the chat indicators row, beside the agent
 * title and context-window control. The hook remains the state and request
 * owner; Ant Design owns the selector, popup, options, notices, and focus.
 */
export function ModelSelector({ agentRef, chatId, placement = 'down' }: ModelSelectorProps) {
  const {
    data,
    saving,
    error,
    selectModel,
    clearError,
    refresh,
    effectiveModel,
    pending,
    conflicted,
    imageInput,
    state,
    loadError,
  } = useHostModels(agentRef, chatId)
  const [open, setOpen] = useState(false)
  const [applied, setApplied] = useState(false)
  const imageHintId = useId()
  const unavailableHintId = useId()

  // Reset transient UI when the chat/agent changes. The hook is mounted
  // un-keyed, so an open popup or confirmation must not carry between chats.
  useEffect(() => {
    setOpen(false)
    setApplied(false)
  }, [agentRef, chatId])

  useEffect(() => {
    if (!applied) return
    const timeoutId = window.setTimeout(() => setApplied(false), APPLIED_BADGE_MS)
    return () => window.clearTimeout(timeoutId)
  }, [applied])

  const effectiveLabel = useMemo(() => {
    if (!data) return ''
    if (!effectiveModel && isBrokerBackedProvider(data.provider)) return SELECT_MODEL_LABEL
    return modelLabel(effectiveModel, data.models)
  }, [data, effectiveModel])
  const offeredModels = useMemo(
    () =>
      data ? data.models.filter(option => isOfferedForNewPick(option, data.sessionModel)) : [],
    [data]
  )
  const options = useMemo(() => {
    const available = offeredModels.map(option => ({
      value: option.name,
      label: option.displayName?.trim() || option.name,
      disabled: saving,
    }))
    // Preserve a visible saved/default label even when an older server omits
    // that value from its current catalog. It remains unavailable for picking.
    if (effectiveModel && !offeredModels.some(option => option.name === effectiveModel)) {
      available.unshift({ value: effectiveModel, label: effectiveLabel, disabled: true })
    }
    return available
  }, [effectiveLabel, effectiveModel, offeredModels, saving])

  const imageHint =
    imageInput.state === 'supported'
      ? undefined
      : imageInput.state === 'unsupported'
        ? 'This model cannot receive images.'
        : 'Image input is not verified for this model yet.'

  const handleSelect = useCallback(
    async (model: string) => {
      setOpen(false)
      if (model === effectiveModel) return
      const ok = await selectModel(model)
      if (ok) setApplied(true)
    },
    [effectiveModel, selectModel]
  )

  if (!data && state === 'error') {
    return (
      <Button
        aria-label="Models unavailable — retry loading the model list"
        title={loadError ?? 'The model list could not be loaded. Retry.'}
        icon={<span className="model-selector-chip-glyph" aria-hidden="true" />}
        onClick={() => void refresh()}
      >
        Models unavailable
      </Button>
    )
  }

  // undefined means the first fetch is in progress; null means this host
  // predates the model endpoint. Neither state presents a false empty list.
  if (!data) return null

  const placementValue = placement === 'up' ? 'topLeft' : 'bottomLeft'
  const caretPointsUp = placement === 'up' ? !open : open
  const caretPath = caretPointsUp ? 'm4.5 10 3.5-3.5L11.5 10' : 'm4.5 6 3.5 3.5L11.5 6'
  const selectControl = (
    <Select
      aria-describedby={data.degraded ? unavailableHintId : imageHint ? imageHintId : undefined}
      aria-label={
        data.degraded
          ? `Model ${effectiveLabel} (selection unavailable)`
          : `Model — ${effectiveLabel}`
      }
      data-model-id={effectiveModel}
      data-testid="selected-chat-model"
      disabled={data.degraded}
      loading={saving}
      menuItemSelectedIcon={
        <svg
          className="model-selector-item-check"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <path d="m3.5 8.5 3 3 6-6" />
        </svg>
      }
      notFoundContent={
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No models are available for this agent."
        />
      }
      onChange={value => void handleSelect(String(value))}
      onOpenChange={nextOpen => {
        setOpen(nextOpen)
        if (!nextOpen) return
        clearError()
        void refresh()
      }}
      open={open}
      options={options}
      placement={placementValue}
      popupMatchSelectWidth={false}
      placeholder={effectiveLabel || SELECT_MODEL_LABEL}
      suffixIcon={
        <svg
          className="model-selector-chip-caret"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
        >
          <path d={caretPath} />
        </svg>
      }
      popupRender={menu => (
        <>
          {data.sessionModelBlocked ? (
            <Alert
              showIcon
              type="warning"
              title={
                <>
                  Your previous model <strong>{data.sessionModelBlocked}</strong> is no longer
                  allowed; the default is in use.
                </>
              }
            />
          ) : null}
          {conflicted ? (
            <Alert
              showIcon
              type="warning"
              title="This chat’s model changed elsewhere; re-checking the current selection."
              role="status"
            />
          ) : null}
          {error ? <Alert showIcon type="error" title={error} /> : null}
          {menu}
        </>
      )}
      status={data.sessionModelBlocked ? 'warning' : undefined}
      value={effectiveModel || undefined}
      aria-invalid={Boolean(error)}
    />
  )

  return (
    <Flex align="center" gap="small" data-testid={`model-selector-${placement}`}>
      <span className="model-selector-chip-glyph" aria-hidden="true" />
      {imageHint ? (
        <span id={imageHintId} hidden>
          {imageHint}
        </span>
      ) : null}
      {data.degraded ? (
        <>
          <Tooltip title="Model selection is unavailable right now; using the host default.">
            <span>{selectControl}</span>
          </Tooltip>
          <span id={unavailableHintId} hidden>
            Model selection is unavailable right now; using the host default.
          </span>
        </>
      ) : (
        selectControl
      )}
      {applied || pending ? (
        <Tag color="processing" role="status" aria-live="polite">
          Applies to your next message
        </Tag>
      ) : null}
    </Flex>
  )
}
