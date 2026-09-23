import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { OAuthImmutableFields } from '../OAuthImmutableFields'

afterEach(cleanup)

describe('OAuthImmutableFields — immutables read-only in edit (D-B7)', () => {
  it('renders id, provider, and grantScope read-only and non-editable', () => {
    render(<OAuthImmutableFields oauth={{ id: 'acme', provider: 'google', grantScope: 'user' }} />)

    const provider = screen.getByLabelText('Provider') as HTMLInputElement
    const callbackId = screen.getByLabelText('Callback id') as HTMLInputElement
    const grant = screen.getByLabelText('Grant type') as HTMLInputElement

    // The immutable values are shown…
    expect(provider.value).toBe('Google')
    expect(callbackId.value).toBe('acme')
    expect(grant.value).toBe('Per user')

    // …but every one is read-only and disabled, so the operator cannot change a
    // CEL-immutable field (a change means delete + recreate).
    for (const input of [provider, callbackId, grant]) {
      expect(input).toHaveAttribute('readonly')
      expect(input).toBeDisabled()
    }
  })

  it('does not render an editable scopes control (scopes is not immutable, handled elsewhere)', () => {
    render(
      <OAuthImmutableFields oauth={{ id: 'acme', provider: 'slack', grantScope: 'context' }} />
    )
    expect(screen.queryByLabelText('Scopes')).toBeNull()
  })

  it('renders an accurate credential notice naming the Secret, without a false "nothing to rotate"', () => {
    render(
      <OAuthImmutableFields
        oauth={{ id: 'acme', provider: 'google', grantScope: 'user' }}
        credentialSecretName="acme-oauth-client"
      />
    )
    expect(screen.getByText(/authenticates with OAuth/i)).toBeInTheDocument()
    expect(screen.getByText('acme-oauth-client')).toBeInTheDocument()
    expect(screen.getByText(/not available yet/i)).toBeInTheDocument()
    expect(screen.queryByText(/nothing to rotate/i)).toBeNull()
  })
})
