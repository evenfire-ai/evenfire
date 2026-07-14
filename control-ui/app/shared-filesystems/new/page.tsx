'use client'

import React, { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AuthGate } from '@components/AuthGate'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { DashboardLayout } from '@components/DashboardLayout'
import { IconFolder, IconSharedFiles } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { IconTrash } from '@components/icons'
import { Button, Field, SelectInput, TextInput } from '@components/ui'
import { type CreateSharedFileSystemInput, createSharedFileSystem } from '@lib/api'

type AccessMode = 'ReadWriteMany' | 'ReadWriteOnce'
type SizeUnit = 'Mi' | 'Gi' | 'Ti'

const SIZE_UNIT_OPTIONS: Array<{ value: SizeUnit; label: string }> = [
  { value: 'Mi', label: 'MB (Mi)' },
  { value: 'Gi', label: 'GB (Gi)' },
  { value: 'Ti', label: 'TB (Ti)' },
]

// #592: ReadWriteOnce is the default — it provisions on the RWO StorageClasses
// our clusters run. ReadWriteMany needs an RWX-capable StorageClass
// (NFS/Filestore) that is not deployed yet, so offering it as the default leaves
// the PVC stuck Pending.
const ACCESS_MODE_OPTIONS: Array<{ value: AccessMode; label: string; helper: string }> = [
  { value: 'ReadWriteOnce', label: 'Read Write Once', helper: 'recommended (default)' },
  {
    value: 'ReadWriteMany',
    label: 'Read Write Many',
    helper: 'requires an RWX StorageClass (NFS/Filestore) — not deployed yet',
  },
]

const RETAIN_ON_DELETE_TOOLTIP =
  'Keep the PVC (Persistent Volume Claim) and data after the SharedFileSystem CRD (Custom Resource Definition) is deleted.'

const STEPS = ['Storage', 'Access', 'Folders'] as const

const STEP_DETAILS = [
  {
    description: 'Name and size storage',
    title: 'Storage request',
    subtitle: 'Set the SharedFileSystem identity and requested capacity.',
  },
  {
    description: 'Choose storage behavior',
    title: 'Access and retention',
    subtitle: 'Pick the access mode, storage class, and deletion behavior.',
  },
  {
    description: 'Seed directories',
    title: 'Initial folders',
    subtitle: 'Optionally create starter folders when the filesystem is provisioned.',
  },
] as const

export default function CreateSharedFileSystemPage() {
  const router = useRouter()
  const { showToast } = useToast()
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [sizeValue, setSizeValue] = useState('5')
  const [sizeUnit, setSizeUnit] = useState<SizeUnit>('Gi')
  const [accessMode, setAccessMode] = useState<AccessMode>('ReadWriteOnce')
  const [storageClass, setStorageClass] = useState('')
  const [directories, setDirectories] = useState<string[]>([])
  const [directoryDraft, setDirectoryDraft] = useState('')
  const [retainOnDelete, setRetainOnDelete] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const parsedDirectoryDraft = useMemo(
    () =>
      directoryDraft
        .split(/[\n,]/)
        .map(s => s.trim())
        .filter(Boolean),
    [directoryDraft]
  )

  const canSubmit = useMemo(() => {
    const normalizedSize = sizeValue.trim()
    const numericSize = Number(normalizedSize)
    return (
      name.trim().length > 0 &&
      normalizedSize.length > 0 &&
      Number.isFinite(numericSize) &&
      numericSize > 0 &&
      !saving
    )
  }, [name, saving, sizeValue])
  const canContinue = step === 0 ? canSubmit : !saving
  function addDirectories() {
    if (parsedDirectoryDraft.length === 0) return

    setDirectories(current => Array.from(new Set([...current, ...parsedDirectoryDraft])))
    setDirectoryDraft('')
  }

  function directoriesForSubmit() {
    return Array.from(new Set([...directories, ...parsedDirectoryDraft]))
  }

  function canSelectStep(targetStep: number) {
    if (targetStep <= step) return true
    return canSubmit
  }

  function removeDirectory(directory: string) {
    setDirectories(current => current.filter(item => item !== directory))
  }

  async function handleCreateSharedFileSystem() {
    if (!canSubmit) return

    const normalizedName = name.trim()
    const normalizedSize = sizeValue.trim()
    const dirs = directoriesForSubmit()
    const input: CreateSharedFileSystemInput = {
      name: normalizedName,
      size: `${normalizedSize}${sizeUnit}`,
      accessModes: [accessMode],
      storageClassName: storageClass.trim() || undefined,
      directories: dirs.length > 0 ? dirs : undefined,
      retainOnDelete,
    }

    setSaving(true)
    setError('')
    try {
      await createSharedFileSystem(input)
      showToast(`Shared filesystem "${normalizedName}" created.`, { tone: 'success' })
      router.push('/shared-filesystems')
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : 'Failed to create SharedFileSystem'
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <AuthGate>
      <DashboardLayout isDetailPage>
        <CreateFlowPanel
          header={
            <CreatePageHeader
              icon={<IconSharedFiles />}
              title="Create SharedFileSystem"
              subtitle="Provision workspace storage that Contexts can mount read-only into agent pods."
              backLabel="Back to shared files"
              onBack={() => router.push('/shared-filesystems')}
              backDisabled={saving}
            />
          }
        >
          <CreateStepFlow
            ariaLabel="Create shared filesystem steps"
            className="cu-create-step-flow--3"
            currentStep={step}
            onStepChange={setStep}
            canSelectStep={canSelectStep}
            steps={STEP_DETAILS}
            stepLabels={STEPS}
            titleId="create-shared-filesystem-step-title"
          >
            {step === 0 ? (
              <div className="cu-form-stack cu-agent-form-stack">
                <Field
                  description="DNS-1123 label: lowercase letters, digits, hyphens."
                  htmlFor="shared-filesystem-name"
                  label="Name"
                  required
                >
                  <TextInput
                    id="shared-filesystem-name"
                    type="text"
                    placeholder="team-mission"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    disabled={saving}
                    autoFocus
                  />
                </Field>

                <Field
                  description={`Saved as Kubernetes quantity, e.g. ${sizeValue || '5'}${sizeUnit}.`}
                  label="Size"
                  required
                >
                  <div className="cu-size-control">
                    <TextInput
                      type="number"
                      min="1"
                      step="1"
                      inputMode="numeric"
                      value={sizeValue}
                      onChange={e => setSizeValue(e.target.value)}
                      disabled={saving}
                      aria-label="Shared filesystem size"
                    />
                    <SelectInput
                      value={sizeUnit}
                      onChange={e => setSizeUnit(e.target.value as SizeUnit)}
                      disabled={saving}
                      aria-label="Shared filesystem size unit"
                    >
                      {SIZE_UNIT_OPTIONS.map(option => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </SelectInput>
                  </div>
                </Field>
              </div>
            ) : null}

            {step === 1 ? (
              <div className="cu-form-stack cu-agent-form-stack">
                <Field htmlFor="shared-filesystem-access-mode" label="Access mode">
                  <SelectInput
                    id="shared-filesystem-access-mode"
                    value={accessMode}
                    onChange={e => setAccessMode(e.target.value as AccessMode)}
                    disabled={saving}
                  >
                    {ACCESS_MODE_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label} ({option.helper})
                      </option>
                    ))}
                  </SelectInput>
                </Field>

                <Field htmlFor="shared-filesystem-storage-class" label="Storage class (optional)">
                  <TextInput
                    id="shared-filesystem-storage-class"
                    type="text"
                    placeholder="leave empty for cluster default"
                    value={storageClass}
                    onChange={e => setStorageClass(e.target.value)}
                    disabled={saving}
                  />
                </Field>

                <label className="cu-checkbox-field cu-retain-field">
                  <input
                    type="checkbox"
                    checked={retainOnDelete}
                    onChange={e => setRetainOnDelete(e.target.checked)}
                    disabled={saving}
                  />
                  <span className="cu-checkbox-field__content">
                    <span className="cu-checkbox-field__label">Keep storage after deletion</span>
                  </span>
                  <span
                    className="cu-help-tooltip"
                    tabIndex={0}
                    aria-label={RETAIN_ON_DELETE_TOOLTIP}
                    data-tooltip={RETAIN_ON_DELETE_TOOLTIP}
                  >
                    ?
                  </span>
                </label>
              </div>
            ) : null}

            {step === 2 ? (
              <div className="cu-form-stack cu-agent-form-stack cu-agent-form-stack--wide">
                <Field
                  description="Click Add folder to list it now, or leave text here and Create will include it."
                  label="Initial directories"
                >
                  <div className="cu-folder-list" aria-label="Initial directories">
                    {directories.length > 0 ? (
                      <ul className="cu-folder-list__items">
                        {directories.map(directory => (
                          <li className="cu-folder-list__item" key={directory}>
                            <span className="cu-folder-list__icon" aria-hidden="true">
                              <IconFolder />
                            </span>
                            <span className="cu-folder-list__name">{directory}</span>
                            <button
                              type="button"
                              className="cu-btn cu-btn--icon cu-btn--ghost cu-folder-list__remove"
                              onClick={() => removeDirectory(directory)}
                              disabled={saving}
                              aria-label={`Remove ${directory}`}
                            >
                              <IconTrash width={14} height={14} />
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="cu-folder-list__empty">No folders added.</div>
                    )}
                    <div className="cu-folder-list__add">
                      <TextInput
                        type="text"
                        placeholder="docs"
                        value={directoryDraft}
                        onChange={e => setDirectoryDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addDirectories()
                          }
                        }}
                        disabled={saving}
                        aria-label="Directory name"
                      />
                      <Button
                        className="cu-folder-list__add-button"
                        size="sm"
                        variant="ghost"
                        onClick={addDirectories}
                        disabled={saving || parsedDirectoryDraft.length === 0}
                      >
                        Add folder
                      </Button>
                    </div>
                  </div>
                </Field>
              </div>
            ) : null}

            {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

            <div className="cu-create-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  step === 0 ? router.push('/shared-filesystems') : setStep(step - 1)
                }
                disabled={saving}
              >
                {step === 0 ? 'Cancel' : 'Back'}
              </Button>
              {step < STEPS.length - 1 ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setStep(current => Math.min(STEPS.length - 1, current + 1))}
                  disabled={saving || !canContinue}
                >
                  Continue
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleCreateSharedFileSystem()}
                  disabled={!canSubmit}
                >
                  {saving ? 'Creating…' : 'Create'}
                </Button>
              )}
            </div>
          </CreateStepFlow>
        </CreateFlowPanel>
      </DashboardLayout>
    </AuthGate>
  )
}
