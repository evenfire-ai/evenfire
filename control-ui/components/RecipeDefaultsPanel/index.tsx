'use client'

import React from 'react'
import { CheckboxField, Field, FormSection, SelectInput, TextInput } from '@/components/ui'
import type { OperatorDefaults } from '@/lib/recipeTypes'
import type { RecipeDefaultsPanelProps } from './types'

export function RecipeDefaultsPanel({ defaults, onChange }: RecipeDefaultsPanelProps) {
  function set<S extends keyof OperatorDefaults, K extends keyof OperatorDefaults[S]>(
    section: S,
    key: K,
    value: OperatorDefaults[S][K]
  ) {
    const next = {
      ...defaults,
      [section]: {
        ...defaults[section],
        [key]: value,
      },
    } as OperatorDefaults
    onChange(next)
  }

  return (
    <div className="cu-form-grid">
      <p className="cu-muted" style={{ margin: 0 }}>
        These parameters are injected/validated by the operator before deploying. External recipe
        developers cannot override them.
      </p>

      <FormSection title="Security">
        <Field label="Allowed Linux Capabilities (comma-separated)">
          <TextInput
            value={defaults.security.allowedCapabilities.join(', ')}
            onChange={e =>
              set(
                'security',
                'allowedCapabilities',
                e.target.value
                  .split(',')
                  .map(s => s.trim().toUpperCase())
                  .filter(Boolean)
              )
            }
          />
        </Field>

        <Field label="Max runAsUser UID (0 = root, rejected)">
          <TextInput
            type="number"
            min={1}
            value={defaults.security.maxRunAsUser}
            onChange={e => set('security', 'maxRunAsUser', parseInt(e.target.value, 10) || 1)}
          />
        </Field>

        <CheckboxField
          id="requireNonRoot"
          label="Require non-root (enforces runAsNonRoot: true)"
          checked={defaults.security.requireNonRoot}
          onChange={e => set('security', 'requireNonRoot', e.target.checked)}
        />
      </FormSection>

      <FormSection title="Storage">
        <Field label="Default Storage Class">
          <TextInput
            value={defaults.storage.defaultStorageClass}
            onChange={e => set('storage', 'defaultStorageClass', e.target.value)}
          />
        </Field>

        <Field label="Default Access Mode">
          <SelectInput
            value={defaults.storage.defaultAccessMode}
            onChange={e => set('storage', 'defaultAccessMode', e.target.value)}
          >
            <option value="ReadWriteOnce">ReadWriteOnce</option>
            <option value="ReadWriteMany">ReadWriteMany</option>
            <option value="ReadOnlyMany">ReadOnlyMany</option>
          </SelectInput>
        </Field>

        <Field label="Max PVC Size (Gi)">
          <TextInput
            type="number"
            min={1}
            value={defaults.storage.maxPvcSizeGi}
            onChange={e => set('storage', 'maxPvcSizeGi', parseInt(e.target.value, 10) || 1)}
          />
        </Field>

        <Field label="Output Path">
          <TextInput
            value={defaults.storage.outputPath}
            onChange={e => set('storage', 'outputPath', e.target.value)}
          />
        </Field>
      </FormSection>

      <FormSection
        title="Default Resources"
        description="Injected when the workload has no explicit resource block."
      >
        <div className="cu-form-grid cu-form-grid--2">
          <Field label="CPU Request">
            <TextInput
              value={defaults.resources.defaultCpuRequest}
              onChange={e => set('resources', 'defaultCpuRequest', e.target.value)}
            />
          </Field>
          <Field label="Memory Request">
            <TextInput
              value={defaults.resources.defaultMemoryRequest}
              onChange={e => set('resources', 'defaultMemoryRequest', e.target.value)}
            />
          </Field>
          <Field label="CPU Limit">
            <TextInput
              value={defaults.resources.defaultCpuLimit}
              onChange={e => set('resources', 'defaultCpuLimit', e.target.value)}
            />
          </Field>
          <Field label="Memory Limit">
            <TextInput
              value={defaults.resources.defaultMemoryLimit}
              onChange={e => set('resources', 'defaultMemoryLimit', e.target.value)}
            />
          </Field>
        </div>
      </FormSection>

      <FormSection title="Target Namespaces">
        <Field label="MCP Workloads Namespace">
          <TextInput
            value={defaults.namespaces.mcpWorkloads}
            onChange={e => set('namespaces', 'mcpWorkloads', e.target.value)}
          />
        </Field>

        <Field label="Non-MCP Workloads Namespace">
          <TextInput
            value={defaults.namespaces.nonMcpWorkloads}
            onChange={e => set('namespaces', 'nonMcpWorkloads', e.target.value)}
          />
        </Field>
      </FormSection>

      <FormSection title="Container Registry">
        <Field label="Registry Prefix (prepended to bare image names)">
          <TextInput
            value={defaults.registry.prefix}
            onChange={e => set('registry', 'prefix', e.target.value)}
          />
        </Field>

        <Field label="imagePullSecrets (comma-separated secret names)">
          <TextInput
            value={defaults.registry.imagePullSecrets.join(', ')}
            onChange={e =>
              set(
                'registry',
                'imagePullSecrets',
                e.target.value
                  .split(',')
                  .map(s => s.trim())
                  .filter(Boolean)
              )
            }
          />
        </Field>
      </FormSection>
    </div>
  )
}
