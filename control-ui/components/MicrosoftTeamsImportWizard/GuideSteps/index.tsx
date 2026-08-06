'use client'

import { GuideImageTooltip } from '@components/GuideImageTooltip'
import { IconCopy } from '@components/icons'
import { Button, CheckboxField, Field, TextInput } from '@components/ui'
import { MICROSOFT_GRAPH_PERMISSIONS, MICROSOFT_GUIDE_ROOT } from '../constants'
import type { MicrosoftSetupGuideStepsProps } from '../types'

export function MicrosoftSetupGuideSteps({
  step,
  draft,
  fallbackIntegrationName,
  callbackUrl,
  clientSecret,
  hasClientSecret,
  saving,
  authorized,
  canAuthorize,
  onDraftChange,
  onClientSecretChange,
  onBegin,
  onAuthorize,
}: MicrosoftSetupGuideStepsProps) {
  if (step === 0) {
    return (
      <div className="cu-form-stack cu-agent-form-stack--wide cu-ms-import__intro">
        <img src="/brand/microsoft-teams.svg" alt="Microsoft Teams" width={48} height={48} />
        <p>
          This integration uses a new app registration owned by your organization in the Microsoft
          Entra admin center. We will guide you through every required setting.
        </p>
        <a
          className="cu-btn cu-btn--secondary cu-ms-import__entra-link"
          href="https://entra.microsoft.com/#home"
          target="_blank"
          rel="noreferrer"
        >
          Open Microsoft Entra admin center
        </a>
        <Field label="Integration name" htmlFor="microsoft-integration-name" required>
          <TextInput
            id="microsoft-integration-name"
            value={draft.displayName || fallbackIntegrationName}
            onChange={event => onDraftChange({ displayName: event.target.value })}
            disabled={saving}
          />
        </Field>
        <div className="cu-create-actions">
          <Button variant="primary" onClick={onBegin} disabled={saving}>
            {saving ? 'Starting...' : "I'm ready"}
          </Button>
        </div>
      </div>
    )
  }

  if (step === 1) {
    return (
      <div className="cu-form-stack cu-agent-form-stack--wide">
        <ol className="cu-ms-import__instructions">
          <li>
            Open <strong>App registrations</strong>. You can find it with the Entra search bar.
            <GuideImageTooltip
              image={`${MICROSOFT_GUIDE_ROOT}/app_registration_01.png`}
              alt="Microsoft Entra App registrations search result"
            />
          </li>
          <li>
            Click <strong>New registration</strong>.
            <GuideImageTooltip
              image={`${MICROSOFT_GUIDE_ROOT}/app_registration_02.png`}
              alt="New registration action in Microsoft Entra"
            />
          </li>
          <li>
            Enter a <strong>Name</strong> and choose the supported account type for the organization
            whose members you want to import.
            <GuideImageTooltip
              image={`${MICROSOFT_GUIDE_ROOT}/app_registration_03.png`}
              alt="Microsoft app registration name and account type"
            />
          </li>
          <li>
            Under <strong>Redirect URI</strong>, select <strong>Web</strong> and paste the URL
            below.
            <GuideImageTooltip
              image={`${MICROSOFT_GUIDE_ROOT}/app_registration_04.png`}
              alt="Microsoft app registration Web redirect URI"
            />
            <div className="cu-ms-import__copy-field">
              <TextInput value={callbackUrl} readOnly monospace aria-label="OAuth callback URL" />
              <button
                type="button"
                className="cu-btn cu-btn--icon cu-btn--toolbar"
                aria-label="Copy OAuth callback URL"
                title="Copy OAuth callback URL"
                onClick={() => void navigator.clipboard.writeText(callbackUrl)}
              >
                <IconCopy width={17} height={17} />
              </button>
            </div>
          </li>
          <li>
            Click <strong>Register</strong>.
          </li>
        </ol>
        <CheckboxField
          checked={draft.appRegistrationCreated === true}
          onChange={event => onDraftChange({ appRegistrationCreated: event.currentTarget.checked })}
          label="I created the app registration"
        />
      </div>
    )
  }

  if (step === 2) {
    return (
      <div className="cu-form-stack cu-agent-form-stack--wide">
        <ol className="cu-ms-import__instructions">
          <li>
            From the new application, open <strong>Certificates &amp; secrets</strong>, select
            <strong> Client secrets</strong>, and click <strong>New client secret</strong>.
            <GuideImageTooltip
              image={`${MICROSOFT_GUIDE_ROOT}/secrets_01.png`}
              alt="Microsoft Entra client secret creation screen"
            />
          </li>
          <li>
            Set a <strong>Description</strong> and <strong>Expiration</strong>, then click
            <strong> Add</strong>.
          </li>
          <li>
            Copy the secret <strong>Value</strong> immediately and paste it below. Do not use the
            secret ID.
          </li>
        </ol>
        <Field label="Client secret value" htmlFor="microsoft-client-secret" required>
          <TextInput
            id="microsoft-client-secret"
            type="password"
            value={clientSecret}
            onChange={event => onClientSecretChange(event.target.value)}
            placeholder={hasClientSecret ? '••••••••••••••••' : ''}
            autoComplete="new-password"
            disabled={saving}
          />
        </Field>
      </div>
    )
  }

  if (step === 3) {
    return (
      <div className="cu-form-stack cu-agent-form-stack--wide">
        <ol className="cu-ms-import__instructions">
          <li>
            Open <strong>API permissions</strong> and click <strong>Add a permission</strong>.
            <GuideImageTooltip
              image={`${MICROSOFT_GUIDE_ROOT}/permissions_01.png`}
              alt="Microsoft Entra API permissions page"
            />
          </li>
          <li>
            Select <strong>Microsoft Graph</strong>.
            <GuideImageTooltip
              image={`${MICROSOFT_GUIDE_ROOT}/permissions_02.png`}
              alt="Microsoft Graph permission source"
            />{' '}
            Then select <strong>Delegated permissions</strong>.
            <GuideImageTooltip
              image={`${MICROSOFT_GUIDE_ROOT}/permissions_03.png`}
              alt="Microsoft Graph delegated permissions"
            />
          </li>
          <li>
            Search for and add these permissions, then click <strong>Add permissions</strong>.
            <ul className="cu-ms-import__permission-list">
              {MICROSOFT_GRAPH_PERMISSIONS.map(permission => (
                <li key={permission}>
                  <code>{permission}</code>
                </li>
              ))}
            </ul>
          </li>
          <li>
            Click <strong>Grant admin consent for your organization</strong>, then click
            <strong> Yes</strong> to confirm.
            <GuideImageTooltip
              image={`${MICROSOFT_GUIDE_ROOT}/permissions_06.png`}
              alt="Grant admin consent confirmation"
            />
          </li>
        </ol>
        <CheckboxField
          checked={draft.permissionsGranted === true}
          onChange={event => onDraftChange({ permissionsGranted: event.currentTarget.checked })}
          label="I granted the required delegated permissions"
        />
      </div>
    )
  }

  if (step === 4) {
    return (
      <div className="cu-form-stack cu-agent-form-stack--wide">
        <ol className="cu-ms-import__instructions">
          <li>
            Open <strong>Overview</strong> and copy the values shown below.
            <GuideImageTooltip
              image={`${MICROSOFT_GUIDE_ROOT}/values_01.png`}
              alt="Microsoft Entra application Overview identifiers"
            />
          </li>
        </ol>
        <Field label="Application (client) ID" htmlFor="microsoft-client-id" required>
          <TextInput
            id="microsoft-client-id"
            value={draft.clientId || ''}
            onChange={event => onDraftChange({ clientId: event.target.value })}
            placeholder="00000000-0000-0000-0000-000000000000"
            monospace
          />
        </Field>
        <Field label="Directory (tenant) ID" htmlFor="microsoft-tenant-id" required>
          <TextInput
            id="microsoft-tenant-id"
            value={draft.tenantId || ''}
            onChange={event => onDraftChange({ tenantId: event.target.value })}
            placeholder="00000000-0000-0000-0000-000000000000"
            monospace
          />
        </Field>
      </div>
    )
  }

  if (step === 5) {
    return (
      <div className="cu-form-stack cu-agent-form-stack--wide cu-ms-import__authorize">
        <img src="/brand/microsoft.svg" alt="Microsoft" width={42} height={42} />
        <p>
          Microsoft will ask an administrator to authorize Evenfire and grant consent on behalf of
          this organization.
        </p>
        <Button
          variant="primary"
          block
          disabled={saving || authorized || !canAuthorize}
          onClick={onAuthorize}
        >
          <img src="/brand/microsoft.svg" alt="" width={20} height={20} aria-hidden="true" />
          {authorized ? '✓ Authorized' : saving ? 'Opening Microsoft...' : 'Authorize'}
        </Button>
      </div>
    )
  }

  return null
}
