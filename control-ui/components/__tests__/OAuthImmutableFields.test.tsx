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

  it('renders the generic carril endpoints and knobs read-only (D-B7)', () => {
    render(
      <OAuthImmutableFields
        oauth={{
          id: 'idp-abc',
          provider: 'generic',
          grantScope: 'user',
          generic: {
            authorizationEndpoint: 'https://idp.example.com/authorize',
            tokenEndpoint: 'https://idp.example.com/token',
            refreshEndpoint: '',
            resource: '',
            tokenRequestFormat: 'form',
            tokenAuthMethod: 'basic',
            scopeSeparator: 'space',
            sendScope: true,
            usePkce: true,
            includeResponseType: true,
            supportsRefresh: true,
            clientMode: 'confidential',
            extraAuthorizeParams: [],
          },
        }}
      />
    )
    // The synthetic provider label plus the generic endpoints/knobs are shown…
    expect((screen.getByLabelText('Provider') as HTMLInputElement).value).toBe(
      'Custom OAuth 2.0 provider'
    )
    const authEndpoint = screen.getByLabelText('Authorization endpoint') as HTMLInputElement
    const authMethod = screen.getByLabelText('Client authentication method') as HTMLInputElement
    const clientType = screen.getByLabelText('Client type') as HTMLInputElement
    expect(authEndpoint.value).toBe('https://idp.example.com/authorize')
    expect(authMethod.value).toBe('basic')
    expect(clientType.value).toBe('Confidential')

    // …and every one is read-only + disabled (a change means delete + recreate).
    for (const input of [authEndpoint, authMethod, clientType]) {
      expect(input).toHaveAttribute('readonly')
      expect(input).toBeDisabled()
    }

    // An empty optional endpoint is not rendered as a field.
    expect(screen.queryByLabelText('Refresh endpoint')).toBeNull()
    expect(screen.queryByLabelText('Resource')).toBeNull()
  })

  it('renders the remote carril fields read-only with the confidential-referenced posture (IMM-6)', () => {
    render(
      <OAuthImmutableFields
        oauth={{
          id: 'client-conf',
          provider: 'remote',
          grantScope: 'user',
          remote: {
            clientMode: 'confidential',
            authorizationEndpoint: 'https://as.example.com/authorize',
            tokenEndpoint: 'https://as.example.com/token',
            registrationEndpoint: 'https://as.example.com/register',
            issuer: 'https://as.example.com',
            resource: 'https://mcp.example.com',
            issForCallback: 'https://as.example.com',
            bearerInBody: true,
            supportsRefresh: false,
            secretPosture: 'referenced',
          },
        }}
      />
    )
    // The synthetic remote provider label plus the discovered endpoints/knobs are shown…
    expect((screen.getByLabelText('Provider') as HTMLInputElement).value).toBe(
      'Remote MCP server (auto-discovered)'
    )
    const issuer = screen.getByLabelText('Issuer') as HTMLInputElement
    const authEndpoint = screen.getByLabelText('Authorization endpoint') as HTMLInputElement
    const registration = screen.getByLabelText('Registration endpoint') as HTMLInputElement
    const clientType = screen.getByLabelText('Client type') as HTMLInputElement
    const bearer = screen.getByLabelText('Bearer token in body') as HTMLInputElement
    expect(issuer.value).toBe('https://as.example.com')
    expect(authEndpoint.value).toBe('https://as.example.com/authorize')
    expect(registration.value).toBe('https://as.example.com/register')
    expect(clientType.value).toBe('Confidential (referenced Secret)')
    expect(bearer.value).toBe('Yes')

    // …and every one is read-only + disabled (a change means delete + recreate).
    for (const input of [issuer, authEndpoint, registration, clientType, bearer]) {
      expect(input).toHaveAttribute('readonly')
      expect(input).toBeDisabled()
    }

    // scopes stays editable (D-B6), so no scopes control appears here.
    expect(screen.queryByLabelText('Scopes')).toBeNull()
  })

  it('labels a public remote client and omits absent optional endpoints', () => {
    render(
      <OAuthImmutableFields
        oauth={{
          id: 'client-pub',
          provider: 'remote',
          grantScope: 'user',
          remote: {
            clientMode: 'public',
            authorizationEndpoint: 'https://as.example.com/authorize',
            tokenEndpoint: 'https://as.example.com/token',
            registrationEndpoint: '',
            issuer: 'https://as.example.com',
            resource: 'https://mcp.example.com',
            issForCallback: '',
            bearerInBody: false,
            supportsRefresh: true,
            secretPosture: 'public',
          },
        }}
      />
    )
    expect((screen.getByLabelText('Client type') as HTMLInputElement).value).toBe(
      'Public (no client secret)'
    )
    // Optional endpoints that the connector did not carry are not rendered as fields.
    expect(screen.queryByLabelText('Registration endpoint')).toBeNull()
    expect(screen.queryByLabelText('Callback issuer (iss)')).toBeNull()
  })
})
