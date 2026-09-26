'use client'

import React from 'react'
import { Field, TextInput } from '@components/ui'
import { oauthProviderLabel } from '@constants/oauthProviders'
import type { GenericImmutableView } from '@lib/oauthGeneric.types'
import type { OAuthImmutableFieldsProps } from './types'

const GRANT_SCOPE_LABELS: Record<string, string> = {
  user: 'Per user',
  context: 'Shared (context)',
}

/**
 * Read-only display of an OAuth connector's immutable fields (D-B7). `id`,
 * `provider`, and `grantScope` are CEL-immutable on the mcpserver CRD — changing
 * one means delete + recreate — so the edit form surfaces them but never lets the
 * operator edit them. `scopes` is editable and lives elsewhere.
 */
export function OAuthImmutableFields({ oauth, credentialSecretName }: OAuthImmutableFieldsProps) {
  return (
    <section className="cu-form-section" aria-label="OAuth configuration">
      <div className="cu-form-section__header">
        <h3 className="cu-form-section__title">OAuth configuration</h3>
        <p className="cu-form-section__description">
          These values are fixed for this connector. Changing them requires reinstalling.
        </p>
      </div>

      <div className="cu-banner cu-banner--info" role="status">
        This connector authenticates with OAuth. Its client credential lives in the{' '}
        {credentialSecretName ? (
          <>
            OAuth client Secret <code>{credentialSecretName}</code>
          </>
        ) : (
          <>connector&apos;s OAuth client Secret</>
        )}{' '}
        and is read only by the broker, never mounted in the pod. Rotating it from this screen is
        not available yet — for now, rotate the keys on that Secret with <code>kubectl</code>.
      </div>

      <Field htmlFor="oauth-immutable-provider" label="Provider">
        <TextInput
          id="oauth-immutable-provider"
          value={oauthProviderLabel(oauth.provider)}
          readOnly
          disabled
        />
      </Field>

      <Field htmlFor="oauth-immutable-id" label="Callback id">
        <TextInput id="oauth-immutable-id" value={oauth.id} readOnly disabled monospace />
      </Field>

      <Field htmlFor="oauth-immutable-grant" label="Grant type">
        <TextInput
          id="oauth-immutable-grant"
          value={
            oauth.grantScope ? (GRANT_SCOPE_LABELS[oauth.grantScope] ?? oauth.grantScope) : '-'
          }
          readOnly
          disabled
        />
      </Field>

      {oauth.generic ? <GenericImmutableFields generic={oauth.generic} /> : null}
    </section>
  )
}

const YES_NO = (value: boolean): string => (value ? 'Yes' : 'No')

/**
 * The generic carril's endpoints and wire knobs, read-only. Every field is create-only
 * (GENERIC-IMM / GENERIC-SECRET-IMM): changing one means delete + recreate.
 */
function GenericImmutableFields({ generic }: { generic: GenericImmutableView }) {
  return (
    <>
      <Field htmlFor="oauth-immutable-client-mode" label="Client type">
        <TextInput
          id="oauth-immutable-client-mode"
          value={generic.clientMode === 'confidential' ? 'Confidential' : 'Public'}
          readOnly
          disabled
        />
      </Field>

      <Field htmlFor="oauth-immutable-auth-endpoint" label="Authorization endpoint">
        <TextInput
          id="oauth-immutable-auth-endpoint"
          value={generic.authorizationEndpoint || '-'}
          readOnly
          disabled
          monospace
        />
      </Field>

      <Field htmlFor="oauth-immutable-token-endpoint" label="Token endpoint">
        <TextInput
          id="oauth-immutable-token-endpoint"
          value={generic.tokenEndpoint || '-'}
          readOnly
          disabled
          monospace
        />
      </Field>

      {generic.refreshEndpoint ? (
        <Field htmlFor="oauth-immutable-refresh-endpoint" label="Refresh endpoint">
          <TextInput
            id="oauth-immutable-refresh-endpoint"
            value={generic.refreshEndpoint}
            readOnly
            disabled
            monospace
          />
        </Field>
      ) : null}

      {generic.resource ? (
        <Field htmlFor="oauth-immutable-resource" label="Resource">
          <TextInput
            id="oauth-immutable-resource"
            value={generic.resource}
            readOnly
            disabled
            monospace
          />
        </Field>
      ) : null}

      <Field htmlFor="oauth-immutable-token-format" label="Token request format">
        <TextInput
          id="oauth-immutable-token-format"
          value={generic.tokenRequestFormat || '-'}
          readOnly
          disabled
        />
      </Field>

      <Field htmlFor="oauth-immutable-auth-method" label="Client authentication method">
        <TextInput
          id="oauth-immutable-auth-method"
          value={generic.tokenAuthMethod || '-'}
          readOnly
          disabled
        />
      </Field>

      <Field htmlFor="oauth-immutable-scope-sep" label="Scope separator">
        <TextInput
          id="oauth-immutable-scope-sep"
          value={generic.scopeSeparator || '-'}
          readOnly
          disabled
        />
      </Field>

      <Field htmlFor="oauth-immutable-pkce" label="Use PKCE (S256)">
        <TextInput id="oauth-immutable-pkce" value={YES_NO(generic.usePkce)} readOnly disabled />
      </Field>

      <Field htmlFor="oauth-immutable-send-scope" label="Send scope">
        <TextInput
          id="oauth-immutable-send-scope"
          value={YES_NO(generic.sendScope)}
          readOnly
          disabled
        />
      </Field>

      <Field htmlFor="oauth-immutable-response-type" label="Include response_type">
        <TextInput
          id="oauth-immutable-response-type"
          value={YES_NO(generic.includeResponseType)}
          readOnly
          disabled
        />
      </Field>

      <Field htmlFor="oauth-immutable-supports-refresh" label="Issues refresh tokens">
        <TextInput
          id="oauth-immutable-supports-refresh"
          value={YES_NO(generic.supportsRefresh)}
          readOnly
          disabled
        />
      </Field>
    </>
  )
}
