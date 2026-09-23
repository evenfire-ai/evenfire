'use client'

import React from 'react'
import { Field, TextInput } from '@components/ui'
import { oauthProviderLabel } from '@constants/oauthProviders'
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
    </section>
  )
}
