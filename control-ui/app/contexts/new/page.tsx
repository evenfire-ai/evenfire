'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  CONTROL_CHAR_RE,
  DISPLAY_FIELD_MAX_LENGTH,
  validateDisplayField,
} from '@clerum/display-field'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { DashboardLayout } from '@components/DashboardLayout'
import { SelectionDropdown } from '@components/SelectionDropdown'
import { IconGroupWork } from '@components/Sidebar/icons'
import { Button, Field, TextAreaInput, TextInput } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import { createContext, getMcpServers } from '@lib/api'
import { RFC1123_MAX_LENGTH, isValidResourceSlug, toKebabCase } from '@lib/string'

const STEPS = ['Context', 'Connectors'] as const

// The exact free-text value the create call writes to spec.displayName. Only a
// non-empty trimmed name is sent (an empty one is omitted from the payload), so
// the display gate mirrors precisely what the server will validate.
function displayNameValue(rawName: string): string {
  return rawName.trim()
}

// True when the derived slug AND the displayName the server would receive are
// both acceptable. Mirrors the two server constraints client-side:
//   - slug: RFC1123 DNS label ≤63 (isValidResourceSlug, same as HostWizard).
//   - display: the shared @clerum/display-field rule (D4 — the RULE lives in the
//     package, the same one the server applies; here we only consume it). Empty
//     display is valid: it is omitted from the payload, and the empty case is
//     already blocked by the slug gate.
function contextNameIsValid(rawName: string): boolean {
  if (!isValidResourceSlug(rawName)) return false
  const display = displayNameValue(rawName)
  if (display.length === 0) return true
  return validateDisplayField(display, 'spec.displayName') === null
}

// Human-readable reason the derived slug fails the server RFC1123 constraint, or
// null when valid (or empty — the empty case is surfaced by the field's own
// "must contain letters or numbers" message). Matches HostWizard.slugConstraintMessage.
function slugConstraintMessage(rawName: string): string | null {
  const slug = toKebabCase(rawName)
  if (slug.length === 0) return null
  if (slug.length > RFC1123_MAX_LENGTH) return 'Identifier must be at most 63 characters.'
  if (!isValidResourceSlug(rawName)) return 'Identifier must be a valid RFC1123 identifier.'
  return null
}

// Human-readable reason the free-text spec.displayName value is rejected, or null
// when acceptable. The RULE of validity is owned by @clerum/display-field (the
// SAME rule the server applies, D4); this only maps the machine issue to a
// message. Empty is intentionally NOT surfaced here — it is omitted from the
// payload and the empty case is covered by the slug message.
function displayNamePreflightMessage(rawName: string): string | null {
  const value = displayNameValue(rawName)
  if (value.length === 0) return null
  if (!validateDisplayField(value, 'spec.displayName')) return null
  if (CONTROL_CHAR_RE.test(value))
    return "Context name can't contain control or formatting characters."
  if (value.trim().length > DISPLAY_FIELD_MAX_LENGTH)
    return `Context name is too long (max ${DISPLAY_FIELD_MAX_LENGTH} characters).`
  return null
}

const STEP_DETAILS = [
  {
    description: 'Name and describe it',
    title: 'Context identity',
    subtitle: 'Define the context that agents will reference.',
  },
  {
    description: 'Attach connector tools',
    title: 'Connector allowlist',
    subtitle: 'Choose the connectors this context can expose to agents.',
  },
] as const

export default function CreateContextPage() {
  const router = useRouter()

  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [loadingServers, setLoadingServers] = useState(true)
  const [error, setError] = useState('')
  const [contextName, setContextName] = useState('')
  const [description, setDescription] = useState('')
  const [availableServers, setAvailableServers] = useState<string[]>([])
  const [selectedServers, setSelectedServers] = useState<string[]>([])
  const connectorOptions = useMemo(
    () =>
      availableServers.map(serverName => ({
        value: serverName,
        label: serverName,
        description: 'Connector',
      })),
    [availableServers]
  )

  useEffect(() => {
    async function loadServers() {
      setLoadingServers(true)
      setError('')
      try {
        const response = await getMcpServers()
        const names = (response.items || [])
          .map(item => item.metadata?.name || '')
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b))
        setAvailableServers(names)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Failed to load connectors')
      } finally {
        setLoadingServers(false)
      }
    }

    void loadServers()
  }, [])

  // Gate on the FULL server rules, not just "derived slug non-empty": the slug
  // must be a valid RFC1123 label (≤63) AND the free-text displayName the server
  // will receive must satisfy @clerum/display-field. A name that only clears
  // "non-empty slug" — an over-long slug, or a bidi/control/over-120 display —
  // passes the client and the server then rejects it (invalid_name / display).
  const canSubmit = useMemo(() => contextNameIsValid(contextName) && !busy, [busy, contextName])
  const canContinue = step === 0 ? contextNameIsValid(contextName) : true

  function canSelectStep(targetStep: number) {
    if (targetStep <= step) return true
    return contextNameIsValid(contextName)
  }

  async function handleCreateContext() {
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      const nextName = toKebabCase(contextName)
      const trimmedDisplay = contextName.trim()
      // Hard guard (defense if the gate is bypassed): the displayName is free
      // text the server validates with @clerum/display-field (D4 — the RULE is
      // the package's, the same one the server applies). Fail before any write
      // instead of round-tripping a doomed create.
      if (trimmedDisplay && validateDisplayField(trimmedDisplay, 'spec.displayName')) {
        setError(displayNamePreflightMessage(contextName) || 'Context name is not valid.')
        return
      }
      await createContext({
        metadata: { name: nextName },
        spec: {
          contextId: nextName,
          // Store the free-text name the user typed as the visible display name;
          // metadata.name/contextId stay the derived RFC1123 slug.
          ...(trimmedDisplay ? { displayName: trimmedDisplay } : {}),
          description: description.trim(),
          mcpServers: selectedServers,
        },
      })
      router.replace(CONTROL_ROUTES.contexts.detail(nextName))
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create context')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreateFlowPanel
          header={
            <CreatePageHeader
              icon={<IconGroupWork />}
              title="Create context"
              subtitle="Define a new context and attach connectors."
              backLabel="Back to contexts"
              onBack={() => router.push(CONTROL_ROUTES.contexts.root)}
            />
          }
        >
          <CreateStepFlow
            ariaLabel="Create context steps"
            className="cu-create-step-flow--2"
            currentStep={step}
            onStepChange={setStep}
            canSelectStep={canSelectStep}
            steps={STEP_DETAILS}
            stepLabels={STEPS}
            titleId="create-context-step-title"
          >
            {step === 0 ? (
              <div className="cu-form-stack cu-agent-form-stack">
                <Field label="Context name" htmlFor="ctx-name" required>
                  <TextInput
                    id="ctx-name"
                    value={contextName}
                    onChange={event => setContextName(event.target.value)}
                    disabled={busy}
                    placeholder="Context 1"
                    autoFocus
                  />
                  {!toKebabCase(contextName) ? (
                    contextName.trim() ? (
                      <span className="cu-field__error">
                        Context name must contain letters or numbers.
                      </span>
                    ) : null
                  ) : slugConstraintMessage(contextName) ? (
                    <span className="cu-field__error">{slugConstraintMessage(contextName)}</span>
                  ) : displayNamePreflightMessage(contextName) ? (
                    <span className="cu-field__error">
                      {displayNamePreflightMessage(contextName)}
                    </span>
                  ) : (
                    <span className="cu-field__hint">
                      Identifier: <code>{toKebabCase(contextName)}</code>
                    </span>
                  )}
                </Field>

                <Field label="Description" htmlFor="ctx-description">
                  <TextAreaInput
                    id="ctx-description"
                    value={description}
                    onChange={event => setDescription(event.target.value)}
                    disabled={busy}
                    rows={3}
                    placeholder="Human-readable context description"
                  />
                </Field>
              </div>
            ) : null}

            {step === 1 ? (
              <div className="cu-form-stack cu-agent-form-stack">
                <Field label="Connectors">
                  {loadingServers ? (
                    <p className="cu-muted cu-muted-note--compact">Loading connectors...</p>
                  ) : availableServers.length === 0 ? (
                    <p className="cu-muted cu-muted-note--compact">No connectors found.</p>
                  ) : (
                    <SelectionDropdown
                      id="new-context-connectors"
                      inline
                      value={selectedServers}
                      onChange={setSelectedServers}
                      options={connectorOptions}
                      placeholder="Select connectors"
                      searchPlaceholder="Search connectors..."
                      selectionLabel="Selected connectors"
                      emptyLabel="No connectors match your search."
                      disabled={busy}
                    />
                  )}
                </Field>
              </div>
            ) : null}

            {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

            <div className="cu-create-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  step === 0 ? router.push(CONTROL_ROUTES.contexts.root) : setStep(step - 1)
                }
                disabled={busy}
              >
                {step === 0 ? 'Cancel' : 'Back'}
              </Button>
              {step < STEPS.length - 1 ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setStep(current => Math.min(STEPS.length - 1, current + 1))}
                  disabled={busy || !canContinue}
                >
                  Continue
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleCreateContext()}
                  disabled={!canSubmit}
                >
                  {busy ? 'Creating…' : 'Create context'}
                </Button>
              )}
            </div>
          </CreateStepFlow>
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}
