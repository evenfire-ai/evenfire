'use client'

import React, { useState } from 'react'
import { Button, CheckboxField, Field, SelectInput, TextInput } from '@components/ui'
import { discoverGenericOAuth } from '@lib/api'
import { newExtraParamRow } from '@lib/oauthGeneric'
import type { GenericFieldOrigin, GenericTouchKey } from '@lib/oauthGeneric.types'
import { mapRemoteDiscoverError } from '@lib/remoteMcp'
import type { GenericEndpointsStepProps } from './types'

const ORIGIN_LABELS: Record<Exclude<GenericFieldOrigin, 'default'>, string> = {
  catalog: 'From catalog',
  detected: 'Detected',
  edited: 'Edited',
}

// A small provenance badge so the operator can audit where a value came from (S-4).
function OriginBadge({ origin }: { origin: GenericFieldOrigin }) {
  if (origin === 'default') return null
  return <span className="cu-chip cu-generic-origin">{ORIGIN_LABELS[origin]}</span>
}

/**
 * Endpoints + wire-knob step of the generic install wizard (S3-B4). Lives in its own
 * component so the baked path in OAuthInstallForm stays byte-identical (F1). Owns only
 * the local Detect input; every persistent value lives in the parent's form state.
 * Detect never mutates the form — it stores the result and the operator clicks Apply
 * (invariant 8).
 */
export function GenericEndpointsStep({
  state,
  issues,
  onEditString,
  onEditEnum,
  onEditBool,
  onExtraParamsChange,
  onDetected,
  onApply,
}: GenericEndpointsStepProps) {
  const [detectUrl, setDetectUrl] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [detectError, setDetectError] = useState('')

  const origin = (field: GenericTouchKey): GenericFieldOrigin => state.origin[field]

  async function handleDetect() {
    const url = detectUrl.trim()
    if (!url || detecting) return
    setDetecting(true)
    setDetectError('')
    try {
      const prefill = await discoverGenericOAuth(url)
      onDetected(prefill)
    } catch (error) {
      setDetectError(mapRemoteDiscoverError(error))
    } finally {
      setDetecting(false)
    }
  }

  function updateParam(id: string, patch: { key?: string; value?: string }) {
    onExtraParamsChange(
      state.extraAuthorizeParams.map(row => (row.id === id ? { ...row, ...patch } : row))
    )
  }
  function removeParam(id: string) {
    onExtraParamsChange(state.extraAuthorizeParams.filter(row => row.id !== id))
  }
  function addParam() {
    // newExtraParamRow() ids are a monotonic counter + randomUUID, collision-free even
    // for remove-then-add within one millisecond (a bare Date.now() id would not be).
    onExtraParamsChange([...state.extraAuthorizeParams, newExtraParamRow()])
  }

  const detected = state.detected

  return (
    <div className="cu-form-section">
      <div className="cu-form-section__header">
        <h3 className="cu-form-section__title">Authorization server endpoints</h3>
        <p className="cu-form-section__description">
          Point the broker at your OAuth 2.0 authorization server. Detect can read a public
          discovery document to suggest values — nothing is applied until you click Apply.
        </p>
      </div>

      {/* Detect (discovery-as-prefill). Never auto-applies (S-4, invariant 8). */}
      <Field
        htmlFor="oauth-generic-detect"
        label="Detect from issuer (optional)"
        description="An OAuth issuer or discovery URL (RFC 8414 / OpenID). We read its metadata over a validated, IP-pinned request."
      >
        <div className="cu-table-actions">
          <TextInput
            id="oauth-generic-detect"
            value={detectUrl}
            onChange={event => setDetectUrl(event.target.value)}
            placeholder="https://idp.example.com"
            monospace
            aria-label="Issuer or discovery URL"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleDetect}
            disabled={detecting || detectUrl.trim().length === 0}
          >
            {detecting ? 'Detecting…' : 'Detect'}
          </Button>
        </div>
      </Field>

      {detectError ? (
        <div className="cu-banner cu-banner--error" role="alert">
          {detectError}
        </div>
      ) : null}

      {detected ? (
        <div className="cu-banner cu-banner--info" role="status">
          <p>
            Detected authorization server <strong>{detected.issuer}</strong>. Review the suggested
            values, then apply them. Fields you have already edited are kept.
          </p>
          <section className="cu-summary-list" aria-label="Detected authorization server metadata">
            <div className="cu-summary-list__row">
              <span>Authorization endpoint</span>
              <strong>{detected.endpoints.authorization}</strong>
            </div>
            <div className="cu-summary-list__row">
              <span>Token endpoint</span>
              <strong>{detected.endpoints.token}</strong>
            </div>
            {detected.resource ? (
              <div className="cu-summary-list__row">
                <span>Resource</span>
                <strong>{detected.resource}</strong>
              </div>
            ) : null}
            <div className="cu-summary-list__row">
              <span>PKCE (S256)</span>
              <strong>
                {detected.capabilities.codeChallengeMethods.length > 0
                  ? detected.suggested.usePkce
                    ? 'Supported'
                    : 'Not advertised'
                  : 'No data'}
              </strong>
            </div>
            <div className="cu-summary-list__row">
              <span>Client auth method</span>
              <strong>
                {detected.capabilities.tokenEndpointAuthMethods.length > 0
                  ? detected.suggested.tokenAuthMethod
                  : 'No data'}
              </strong>
            </div>
            <div className="cu-summary-list__row">
              <span>Scopes</span>
              <strong>
                {detected.scopesSupported.length > 0 ? detected.scopesSupported.join(', ') : '—'}
              </strong>
            </div>
          </section>
          <div className="cu-table-actions">
            <Button type="button" variant="primary" size="sm" onClick={onApply}>
              Apply detected values
            </Button>
          </div>
        </div>
      ) : null}

      <Field
        htmlFor="oauth-generic-auth-endpoint"
        label="Authorization endpoint"
        description="The /authorize URL the browser is redirected to."
        required
        error={issues.authorizationEndpoint}
      >
        <div className="cu-generic-field-row">
          <TextInput
            id="oauth-generic-auth-endpoint"
            value={state.authorizationEndpoint}
            onChange={event => onEditString('authorizationEndpoint', event.target.value)}
            placeholder="https://idp.example.com/authorize"
            monospace
          />
          <OriginBadge origin={origin('authorizationEndpoint')} />
        </div>
      </Field>

      <Field
        htmlFor="oauth-generic-token-endpoint"
        label="Token endpoint"
        description="The /token URL the broker exchanges the code at."
        required
        error={issues.tokenEndpoint}
      >
        <div className="cu-generic-field-row">
          <TextInput
            id="oauth-generic-token-endpoint"
            value={state.tokenEndpoint}
            onChange={event => onEditString('tokenEndpoint', event.target.value)}
            placeholder="https://idp.example.com/token"
            monospace
          />
          <OriginBadge origin={origin('tokenEndpoint')} />
        </div>
      </Field>

      <Field
        htmlFor="oauth-generic-refresh-endpoint"
        label="Refresh endpoint (optional)"
        description="Leave blank to refresh at the token endpoint."
        error={issues.refreshEndpoint}
      >
        <div className="cu-generic-field-row">
          <TextInput
            id="oauth-generic-refresh-endpoint"
            value={state.refreshEndpoint}
            onChange={event => onEditString('refreshEndpoint', event.target.value)}
            placeholder="https://idp.example.com/token"
            monospace
          />
          <OriginBadge origin={origin('refreshEndpoint')} />
        </div>
      </Field>

      <Field
        htmlFor="oauth-generic-resource"
        label="Resource (optional, RFC 8707)"
        description="An absolute resource indicator, when your AS requires one."
        error={issues.resource}
      >
        <div className="cu-generic-field-row">
          <TextInput
            id="oauth-generic-resource"
            value={state.resource}
            onChange={event => onEditString('resource', event.target.value)}
            placeholder="https://api.example.com"
            monospace
          />
          <OriginBadge origin={origin('resource')} />
        </div>
      </Field>

      <Field
        htmlFor="oauth-generic-token-format"
        label="Token request format"
        description="How the token request body is encoded."
      >
        <div className="cu-generic-field-row">
          <SelectInput
            id="oauth-generic-token-format"
            value={state.tokenRequestFormat}
            onChange={event => onEditEnum('tokenRequestFormat', event.target.value)}
          >
            <option value="form">Form-encoded</option>
            <option value="json">JSON</option>
          </SelectInput>
          <OriginBadge origin={origin('tokenRequestFormat')} />
        </div>
      </Field>

      <Field
        htmlFor="oauth-generic-auth-method"
        label="Client authentication method"
        description="Basic requires a confidential client with a client secret."
        error={issues.tokenAuthMethod}
      >
        <div className="cu-generic-field-row">
          <SelectInput
            id="oauth-generic-auth-method"
            value={state.tokenAuthMethod}
            onChange={event => onEditEnum('tokenAuthMethod', event.target.value)}
          >
            <option value="body">Client secret in body (post)</option>
            <option value="basic">HTTP Basic (basic)</option>
          </SelectInput>
          <OriginBadge origin={origin('tokenAuthMethod')} />
        </div>
      </Field>

      <Field
        htmlFor="oauth-generic-scope-sep"
        label="Scope separator"
        description="How multiple scopes are joined in the authorize request."
      >
        <div className="cu-generic-field-row">
          <SelectInput
            id="oauth-generic-scope-sep"
            value={state.scopeSeparator}
            onChange={event => onEditEnum('scopeSeparator', event.target.value)}
          >
            <option value="space">Space</option>
            <option value="comma">Comma</option>
          </SelectInput>
          <OriginBadge origin={origin('scopeSeparator')} />
        </div>
      </Field>

      <div className="cu-generic-toggles">
        <CheckboxField
          id="oauth-generic-send-scope"
          checked={state.sendScope}
          onChange={event => onEditBool('sendScope', event.target.checked)}
          label="Send scope in the authorize request"
          description="Turn off only for an AS that rejects a scope parameter."
        />
        <CheckboxField
          id="oauth-generic-use-pkce"
          checked={state.usePkce}
          onChange={event => onEditBool('usePkce', event.target.checked)}
          label="Use PKCE (S256)"
          description="Recommended. Disable only for an AS that does not support PKCE."
        />
        <CheckboxField
          id="oauth-generic-response-type"
          checked={state.includeResponseType}
          onChange={event => onEditBool('includeResponseType', event.target.checked)}
          label="Include response_type=code"
        />
        <CheckboxField
          id="oauth-generic-supports-refresh"
          checked={state.supportsRefresh}
          onChange={event => onEditBool('supportsRefresh', event.target.checked)}
          label="Authorization server issues refresh tokens"
          description="When off, users re-consent as tokens expire."
        />
      </div>

      <Field
        label="Extra authorize parameters (optional)"
        description="Additional query params added to the authorize request. Up to 16."
        error={issues.extraAuthorizeParams}
      >
        <div className="cu-generic-params">
          {state.extraAuthorizeParams.map(row => (
            <div className="cu-generic-param-row" key={row.id}>
              <TextInput
                value={row.key}
                onChange={event => updateParam(row.id, { key: event.target.value })}
                placeholder="parameter"
                aria-label="Extra authorize parameter name"
                monospace
              />
              <TextInput
                value={row.value}
                onChange={event => updateParam(row.id, { value: event.target.value })}
                placeholder="value"
                aria-label="Extra authorize parameter value"
                monospace
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeParam(row.id)}
                aria-label="Remove extra authorize parameter"
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={addParam}
            disabled={state.extraAuthorizeParams.length >= 16}
          >
            Add parameter
          </Button>
        </div>
      </Field>
    </div>
  )
}
