'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
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
import { toKebabCase, toKebabInput } from '@lib/string'

const STEPS = ['Context', 'Connectors'] as const

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

  const canSubmit = useMemo(() => contextName.trim().length > 0 && !busy, [busy, contextName])
  const canContinue = step === 0 ? contextName.trim().length > 0 : true

  function canSelectStep(targetStep: number) {
    if (targetStep <= step) return true
    return contextName.trim().length > 0
  }

  async function handleCreateContext() {
    if (!canSubmit) return
    setBusy(true)
    setError('')
    try {
      const nextName = toKebabCase(contextName)
      await createContext({
        metadata: { name: nextName },
        spec: {
          contextId: nextName,
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
                    onChange={event => setContextName(toKebabInput(event.target.value))}
                    disabled={busy}
                    placeholder="context1"
                    autoFocus
                  />
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
