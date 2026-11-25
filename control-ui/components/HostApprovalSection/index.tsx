'use client'

import React, { useEffect, useId, useRef, useState } from 'react'
import { IconAlertTriangle, IconX } from '@components/icons'
import { Button, Field, SelectInput, TextInput } from '@components/ui'
import { approvalBlockOf, effectiveApproval } from '@lib/approvalEffective'
import { looseningItems } from '@lib/approvalLoosening'
import {
  APPROVAL_CREATED_ELSEWHERE_MESSAGE,
  TOOLS_CHANGED_MESSAGE,
  type ToolsSaveOutcome,
  notStoredMessage,
  saveTools,
} from '@lib/hostApprovalSave'
import { FirstSaveDialog } from './FirstSaveDialog'
import { LooseningDialog } from './LooseningDialog'
import {
  CLUSTER_DEFAULT_TEXT,
  CUSTOM_TOOL_HINT,
  EXPLICIT_REQUIRED_NOTES,
  NATIVE_TOOLS,
  NO_OVERRIDES_TEXT,
  UNSAVED_CHANGES_TEXT,
  looseningItemText,
} from './constants'
import { useApprovalToolsSection } from './hooks'
import type {
  AddCustomToolProps,
  EditRowProps,
  EditViewProps,
  FirstSavePolicy,
  HostApprovalSectionProps,
  OutcomeMessageProps,
  ReadRowProps,
  ReadViewProps,
  RowState,
  SaveRun,
  SectionDialog,
  ShownMessage,
} from './types'

const ROW_STATE_LABELS: Record<RowState, string> = {
  default: 'Default',
  required: 'Required',
  skip: 'Skip',
}

const NATIVE_BY_NAME = new Map(NATIVE_TOOLS.map(tool => [tool.name, tool]))
const CUSTOM_NAME_RE = /^[a-z][a-z0-9_]*$/

function validateCustomName(value: string, customNames: readonly string[]): string | null {
  if (!value.trim()) return null // empty is "not yet typed", not an error
  if (!CUSTOM_NAME_RE.test(value)) {
    return 'Use lower snake_case (start with a letter; letters, digits, underscore).'
  }
  if (NATIVE_BY_NAME.has(value)) {
    return `"${value}" is already in the tool list above. Set that row instead.`
  }
  if (customNames.includes(value)) {
    return `"${value}" is already in your custom rows. Remove that row to change it.`
  }
  return null
}

function rowStateOf(draft: Record<string, boolean>, name: string): RowState {
  if (!Object.hasOwn(draft, name)) return 'default'
  return draft[name] ? 'required' : 'skip'
}

/** What a `not_stored` field holds now, as the message names it. */
function liveText(field: string, value: unknown): string {
  if (field.startsWith('tools.')) {
    return value === true ? 'Required' : value === false ? 'Skip' : 'Default'
  }
  if (value === null || value === undefined) return 'not set'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function DesktopOnlyChip() {
  return (
    <span className="cu-chip" title="Registered only in Desktop chats.">
      Desktop only
    </span>
  )
}

/**
 * The per-tool overrides of one agent (spec §6.4): a read view of what is
 * stored, and an edit view that saves through the versioned protocol
 * (`lib/hostApprovalSave`). One save runs at a time per section instance;
 * while it runs, Save, Cancel and every row are disabled. The loosening
 * dialog, and on an agent with no approval settings of its own the policy
 * dialog, come before the save (spec §6.6). Every outcome that stops the save
 * shows here, with the focus on it; the tab hears every settled save through
 * `onSettled`, and owns loads, the success toast and the Host-changed notice.
 */
export function HostApprovalSection({
  host,
  stored,
  inherited,
  ceiling,
  onSettled,
  loadPending = false,
}: HostApprovalSectionProps) {
  const section = useApprovalToolsSection(stored, inherited)
  const { state, isDirty } = section
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<ShownMessage | null>(null)
  const [dialog, setDialog] = useState<SectionDialog | null>(null)
  const [shownHost, setShownHost] = useState(host)
  const savingRef = useRef(false)
  const mountedRef = useRef(true)
  const messageRef = useRef<HTMLDivElement | null>(null)
  // The values a continuation must check: what the section shows now.
  const hostRef = useRef(host)
  hostRef.current = host
  const stateRef = useRef(state)
  stateRef.current = state

  // A message or dialog belongs to the agent it was raised for.
  if (shownHost !== host) {
    setShownHost(host)
    setMessage(null)
    setDialog(null)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Spec §6.12: the focus goes to the message.
  useEffect(() => {
    if (message) messageRef.current?.focus()
  }, [message])

  function settle(outcome: ToolsSaveOutcome, run: SaveRun): void {
    // The tab hears every settled save, even when the section is gone or shows
    // another agent; a reconfirm has not settled, the dialog asks again.
    if (outcome.kind !== 'reconfirm') run.report(outcome)
    // Spec §6.5: only the instance that ran the save, still showing that agent,
    // shows its outcome.
    if (!mountedRef.current || hostRef.current !== run.input.host) return
    const current = stateRef.current
    const sameSession = current.editing && current.editSession === run.editSession
    switch (outcome.kind) {
      case 'saved':
        section.close(run.editSession)
        return
      case 'maybe':
        // The write may have landed, so this edit session's base is no longer
        // known: close it rather than let Save retry from it. The next Edit
        // starts from what the tab loads.
        section.close(run.editSession)
        setMessage({ outcome })
        return
      case 'reconfirm':
        if (sameSession) {
          setDialog({
            kind: 'loosening',
            items: outcome.items,
            run: { ...run, input: { ...run.input, confirmedItems: outcome.items } },
          })
        }
        return
      case 'error':
        // Nothing was written: Retry sends the same save again, while its
        // edit session is the open one.
        setMessage({ outcome, retry: sameSession ? run : undefined })
        return
      default:
        setMessage({ outcome })
    }
  }

  async function runSave(run: SaveRun): Promise<void> {
    // Spec §6.4 step 1: a raced second activation is refused with no state change.
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setMessage(null)
    let outcome: ToolsSaveOutcome
    try {
      outcome = await saveTools(run.input)
    } catch (error) {
      // saveTools throws only when its caller breaks its contract (a first-save
      // policy without an inheriting base, or the reverse). Shown, not dropped.
      outcome = { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    } finally {
      savingRef.current = false
      if (mountedRef.current) setSaving(false)
    }
    settle(outcome, run)
  }

  /** Builds the save from the edit session and sends it, after the loosening dialog when it has items. */
  function proceed(policy: FirstSavePolicy | undefined, report: SaveRun['report']): void {
    const { base, draft, editSession } = state
    const draftTools = { ...draft }
    const items = looseningItems({
      before: base.inherited ? undefined : { tools: base.tools },
      after: policy ? { defaultPolicy: policy, tools: draftTools } : { tools: draftTools },
      ceiling,
      firstSave: base.inherited,
    })
    const run: SaveRun = {
      input: {
        host,
        base: base.inherited ? undefined : base.tools,
        baseInherited: base.inherited,
        draftTools,
        ...(policy ? { firstSavePolicy: policy } : {}),
        confirmedItems: items,
      },
      editSession,
      report,
    }
    if (items.length > 0) {
      setDialog({ kind: 'loosening', items, run })
      return
    }
    void runSave(run)
  }

  function handleSave(): void {
    if (savingRef.current || !state.editing || !isDirty) return
    // The callback of this render names this save's agent (types.ts).
    if (state.base.inherited) {
      setDialog({ kind: 'first_save', editSession: state.editSession, report: onSettled })
      return
    }
    proceed(undefined, onSettled)
  }

  function handleEdit(): void {
    setMessage(null)
    section.edit()
  }

  function handleCancel(): void {
    setMessage(null)
    section.cancel()
  }

  const dialogOpen =
    dialog !== null &&
    state.editing &&
    state.editSession ===
      (dialog.kind === 'first_save' ? dialog.editSession : dialog.run.editSession)

  return (
    <div className="cu-host-approval-section">
      <div className="cu-host-approval-section__header">
        <h3 className="cu-host-approval-section__title">Per-tool overrides</h3>
        {!state.editing && state.stored.host !== null ? (
          <Button size="sm" variant="ghost" onClick={handleEdit}>
            Edit
          </Button>
        ) : null}
      </div>
      <p className="cu-muted cu-host-approval-section__description">
        Skip or require approval for individual tools when an agent calls them. Default keeps each
        tool&apos;s own setting.
      </p>

      {message ? (
        <OutcomeMessage
          message={message}
          messageRef={messageRef}
          onRetry={run => void runSave(run)}
          saving={saving}
        />
      ) : null}

      <div className="cu-host-approval-section__content">
        {state.stored.host === null ? (
          <div className="cu-empty" role="status" aria-label="Loading approval tools">
            Loading per-tool overrides…
          </div>
        ) : state.editing ? (
          <EditView
            draft={state.draft}
            saving={saving}
            onAddCustom={section.addCustom}
            onRemoveCustom={section.removeCustom}
            onSetRow={section.setRow}
          />
        ) : (
          <ReadView ceiling={ceiling} stored={state.stored} />
        )}
      </div>

      {state.editing ? (
        <div className="cu-host-approval-section__actions">
          {isDirty ? (
            <span className="cu-host-approval-section__dirty" role="status">
              {UNSAVED_CHANGES_TEXT}
            </span>
          ) : null}
          <Button disabled={saving} size="sm" variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            disabled={!isDirty || loadPending}
            loading={saving}
            variant="primary"
            onClick={handleSave}
          >
            Save
          </Button>
        </div>
      ) : null}

      {dialogOpen && dialog.kind === 'first_save' ? (
        <FirstSaveDialog
          open
          onCancel={() => setDialog(null)}
          onSave={policy => {
            setDialog(null)
            proceed(policy, dialog.report)
          }}
        />
      ) : null}
      {dialogOpen && dialog.kind === 'loosening' ? (
        <LooseningDialog
          open
          draft={dialog.run.input.draftTools}
          items={dialog.items}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null)
            void runSave(dialog.run)
          }}
        />
      ) : null}
    </div>
  )
}

function ReadView({ stored, ceiling }: ReadViewProps) {
  if (stored.inherited) return <div className="cu-empty">{CLUSTER_DEFAULT_TEXT}</div>
  const tools = effectiveApproval(approvalBlockOf(stored.host)).tools
  const names = Object.keys(tools).sort()
  if (names.length === 0) return <div className="cu-empty">{NO_OVERRIDES_TEXT}</div>
  return (
    <div>
      {names.map(name => (
        <ReadRow ceiling={ceiling} key={name} name={name} required={tools[name]} />
      ))}
    </div>
  )
}

function ReadRow({ name, required, ceiling }: ReadRowProps) {
  const native = NATIVE_BY_NAME.get(name)
  const note = required ? EXPLICIT_REQUIRED_NOTES[name] : undefined
  const label = required
    ? note
      ? `${ROW_STATE_LABELS.required} (explicit): ${note}`
      : ROW_STATE_LABELS.required
    : ROW_STATE_LABELS.skip
  // Whether this override lets calls run without a card where the tool's own
  // default asks: the loosening function against the code defaults.
  const [item] = looseningItems({
    before: undefined,
    after: { tools: { [name]: required } },
    ceiling,
    firstSave: false,
  })
  const mark = item ? (native?.riskHint ?? looseningItemText(item, { [name]: required })) : null
  return (
    <div
      className="cu-access-row"
      data-tool-row={name}
      data-tool-state={required ? 'required' : 'skip'}
    >
      <span className="cu-host-approval-row__heading">
        <span className="cu-host-approval-row__name">{name}</span>
        {native?.desktopOnly ? <DesktopOnlyChip /> : null}
      </span>
      <span className="cu-host-approval-row__state">
        {label}
        {mark ? (
          <span aria-label={mark} className="cu-host-approval-row__mark" role="img" title={mark}>
            <IconAlertTriangle />
          </span>
        ) : null}
      </span>
    </div>
  )
}

function EditView({ draft, saving, onSetRow, onAddCustom, onRemoveCustom }: EditViewProps) {
  const customNames = Object.keys(draft)
    .filter(name => !NATIVE_BY_NAME.has(name))
    .sort()
  return (
    <>
      <div>
        {NATIVE_TOOLS.map(tool => (
          <EditRow
            disabled={saving}
            key={tool.name}
            onChange={onSetRow}
            state={rowStateOf(draft, tool.name)}
            tool={tool}
          />
        ))}
      </div>
      {customNames.length > 0 ? (
        <div className="cu-host-approval-section__custom">
          {customNames.map(name => (
            <div
              className="cu-access-row"
              data-tool-row={name}
              data-tool-state={draft[name] ? 'required' : 'skip'}
              key={name}
            >
              <span className="cu-host-approval-row__name">{name}</span>
              <span className="cu-host-approval-row__state">
                {draft[name] ? ROW_STATE_LABELS.required : ROW_STATE_LABELS.skip}
                <Button
                  aria-label={`Remove ${name}`}
                  disabled={saving}
                  icon
                  size="sm"
                  variant="ghost-danger"
                  onClick={() => onRemoveCustom(name)}
                >
                  <IconX />
                </Button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <AddCustomTool customNames={customNames} disabled={saving} onAdd={onAddCustom} />
    </>
  )
}

function EditRow({ tool, state, disabled, onChange }: EditRowProps) {
  const id = `approval-${tool.name}`
  const defaultLabel = tool.conditional
    ? 'Default (varies)'
    : `Default (${tool.codeDefault === 'required' ? ROW_STATE_LABELS.required : ROW_STATE_LABELS.skip})`
  return (
    <div className="cu-access-row" data-tool-row={tool.name} data-tool-state={state}>
      <div className="cu-host-approval-row__copy">
        <span className="cu-host-approval-row__heading">
          <label className="cu-host-approval-row__name" htmlFor={id}>
            {tool.name}
          </label>
          {tool.desktopOnly ? <DesktopOnlyChip /> : null}
        </span>
        <span className="cu-host-approval-row__description">{tool.description}</span>
        {tool.conditional ? (
          <span className="cu-host-approval-row__description">{tool.conditional.conditions}</span>
        ) : null}
      </div>
      <SelectInput
        className="cu-host-approval-row__select"
        compact
        disabled={disabled}
        id={id}
        value={state}
        onChange={event => onChange(tool.name, event.target.value as RowState)}
      >
        <option value="default">{defaultLabel}</option>
        <option value="required">{ROW_STATE_LABELS.required}</option>
        <option value="skip">{ROW_STATE_LABELS.skip}</option>
      </SelectInput>
    </div>
  )
}

function AddCustomTool({ customNames, disabled, onAdd }: AddCustomToolProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [rowState, setRowState] = useState<'required' | 'skip'>('required')
  const contentId = useId()
  const inputId = useId()
  const errorId = useId()
  const error = validateCustomName(name, customNames)

  function add(): void {
    const trimmed = name.trim()
    if (error || !trimmed) return
    onAdd(trimmed, rowState)
    setName('')
    setRowState('required')
  }

  return (
    <div className="cu-host-approval-section__add">
      <Button
        aria-controls={contentId}
        aria-expanded={open}
        disabled={disabled}
        size="sm"
        variant="ghost"
        onClick={() => setOpen(value => !value)}
      >
        Add a tool by name
      </Button>
      {open ? (
        <div className="cu-host-approval-section__add-form" id={contentId}>
          <Field
            description={CUSTOM_TOOL_HINT}
            error={error}
            errorId={errorId}
            htmlFor={inputId}
            label="Tool name"
          >
            <TextInput
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
              disabled={disabled}
              id={inputId}
              invalid={Boolean(error)}
              placeholder="tool_name"
              value={name}
              onChange={event => setName(event.target.value)}
            />
          </Field>
          <div className="cu-host-approval-section__add-row">
            <SelectInput
              aria-label="Approval state for the new custom tool"
              compact
              disabled={disabled}
              value={rowState}
              onChange={event => setRowState(event.target.value === 'skip' ? 'skip' : 'required')}
            >
              <option value="required">{ROW_STATE_LABELS.required}</option>
              <option value="skip">{ROW_STATE_LABELS.skip}</option>
            </SelectInput>
            <Button
              disabled={disabled || Boolean(error) || !name.trim()}
              size="sm"
              variant="ghost"
              onClick={add}
            >
              Add
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function OutcomeMessage({ message, messageRef, saving, onRetry }: OutcomeMessageProps) {
  const { outcome, retry } = message
  let body: React.ReactNode
  switch (outcome.kind) {
    case 'conflict':
      body = TOOLS_CHANGED_MESSAGE
      break
    case 'created_elsewhere':
      body = APPROVAL_CREATED_ELSEWHERE_MESSAGE
      break
    case 'refused':
      body = (
        <>
          <p className="cu-host-approval-section__message-text">The save was refused:</p>
          <ul className="cu-host-approval-section__message-list">
            {outcome.errors.map(({ field, message: text }) => (
              <li key={`${field} ${text}`}>{field ? `${field}: ${text}` : text}</li>
            ))}
          </ul>
        </>
      )
      break
    case 'not_stored':
      body = (
        <>
          <p className="cu-host-approval-section__message-text">
            {notStoredMessage(outcome.fields)}
          </p>
          <p className="cu-host-approval-section__message-text">
            {`Stored now: ${outcome.fields
              .map(field => `${field}: ${liveText(field, outcome.live[field])}`)
              .join('; ')}`}
          </p>
        </>
      )
      break
    case 'error':
      body = (
        <>
          <p className="cu-host-approval-section__message-text">{outcome.message}</p>
          {retry ? (
            <Button disabled={saving} size="sm" variant="ghost" onClick={() => onRetry(retry)}>
              Retry
            </Button>
          ) : null}
        </>
      )
      break
    default:
      body = outcome.message
  }
  return (
    <div
      className="cu-banner cu-banner--error cu-host-approval-section__message"
      ref={messageRef}
      role="alert"
      tabIndex={-1}
    >
      {body}
    </div>
  )
}
