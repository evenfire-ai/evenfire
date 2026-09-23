import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import * as api from '../../lib/api'
import type { CatalogOAuthBlock } from '../../lib/oauthInstall.types'
import { NOTION_GENERIC_PREFILL } from '../../test/fixtures/genericDiscoveryPrefill'
import { OAuthInstallForm } from '../OAuthInstallForm'
import { ToastProvider } from '../Toast'

// The credential manifest fixture is the exact shape control-api's
// GET /admin/oauth/providers/:id/credential-manifest returns for a baked
// provider — verified against CONFIDENTIAL_CLIENT_MANIFEST in
// control-api/src/oauth/providers.ts (T1: derived from the real producer, not
// invented). All 8 baked providers share this shape.
const MANIFEST = {
  provider: 'google',
  fields: [
    { name: 'client_id', label: 'Client ID', secret: false, required: true },
    { name: 'client_secret', label: 'Client Secret', secret: true, required: true },
  ],
}

// The generic credential manifest fixture is the exact shape control-api's
// GET /admin/oauth/providers/generic/credential-manifest returns (confidential mode) —
// verified against GENERIC_CREDENTIAL_MANIFEST in control-api/src/oauth/providers.ts.
const GENERIC_MANIFEST = {
  provider: 'generic',
  fields: [
    {
      name: 'client_id',
      label: 'Client ID',
      secret: false,
      required: true,
      help: 'Confidential client only.',
    },
    {
      name: 'client_secret',
      label: 'Client Secret',
      secret: true,
      required: true,
      help: 'Confidential client only.',
    },
  ],
}

vi.mock('../../lib/api', () => ({
  apiSend: vi.fn().mockResolvedValue({}),
  getOAuthCredentialManifest: vi.fn(),
  listMcpSecrets: vi.fn(),
  discoverGenericOAuth: vi.fn(),
  installFromRegistry: vi.fn().mockResolvedValue({ serverName: 'acme', namespace: 'mcp-server' }),
}))

const ENTRY = {
  id: '1',
  name: 'acme',
  version: '1.0.0',
  entry_type: 'mcp-server',
  description: 'Acme OAuth connector',
  mcp_server_meta: {},
} as api.RegistryEntry

function render(children: ReactNode) {
  return rtlRender(<ToastProvider>{children}</ToastProvider>)
}

function renderForm(catalogOAuth: CatalogOAuthBlock) {
  return render(
    <OAuthInstallForm
      entry={ENTRY}
      catalogOAuth={catalogOAuth}
      onCancel={vi.fn()}
      onInstalled={vi.fn()}
      onViewConnectors={vi.fn()}
    />
  )
}

async function waitForLoaded(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled())
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_CONTROL_API_OAUTH_CALLBACK_BASE_URL', 'https://oauth.example.com')
  vi.mocked(api.getOAuthCredentialManifest).mockResolvedValue(MANIFEST)
  vi.mocked(api.listMcpSecrets).mockResolvedValue({ items: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('OAuthInstallForm — scopes reach the submit (Fam A(3)/E-19.3)', () => {
  it('sends the operator-edited scopes in body.oauth.scopes', async () => {
    renderForm({ provider: 'google', grantScope: 'user', scopes: ['a.read'] })
    await waitForLoaded()

    // Provider → Credentials
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.change(screen.getByLabelText('Client ID', { exact: false }), {
      target: { value: 'cid' },
    })
    fireEvent.change(screen.getByLabelText('Client Secret', { exact: false }), {
      target: { value: 'csecret' },
    })

    // Credentials → Scopes and install
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Scopes/i }), {
      target: { value: 'a.read b.write' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Install connector' }))

    await waitFor(() => expect(api.installFromRegistry).toHaveBeenCalledTimes(1))
    const req = vi.mocked(api.installFromRegistry).mock.calls[0][0]
    expect(req.oauth?.scopes).toEqual(['a.read', 'b.write'])
    expect(req.oauth?.grantScope).toBe('user')
    // oauth.id is never sent — control-api derives it (D-B5).
    expect(req.oauth).not.toHaveProperty('id')
  })
})

describe('OAuthInstallForm — empty scope prefill forces scopes (GAP-6)', () => {
  it('blocks Install until at least one scope is entered', async () => {
    renderForm({ provider: 'google', grantScope: 'user', scopes: [] })
    await waitForLoaded()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.change(screen.getByLabelText('Client ID', { exact: false }), {
      target: { value: 'cid' },
    })
    fireEvent.change(screen.getByLabelText('Client Secret', { exact: false }), {
      target: { value: 'csecret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    // Empty scopes: Install disabled + explicit guidance.
    const install = screen.getByRole('button', { name: 'Install connector' })
    expect(install).toBeDisabled()
    expect(screen.getByText(/Add at least one OAuth scope/i)).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: /Scopes/i }), {
      target: { value: 'offline_access' },
    })
    expect(screen.getByRole('button', { name: 'Install connector' })).not.toBeDisabled()
  })
})

describe('OAuthInstallForm — reference mode pre-check (Fam B(1))', () => {
  it('warns and blocks continue when the referenced key does not exist', async () => {
    vi.mocked(api.listMcpSecrets).mockResolvedValue({
      items: [{ name: 'gh-oauth', keys: ['client_id', 'client_secret'] }],
    })
    renderForm({ provider: 'google', grantScope: 'user', scopes: ['a.read'] })
    await waitForLoaded()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.change(screen.getByLabelText('Secret source'), { target: { value: 'reference' } })

    // Pick the existing Secret but a key it does not carry.
    fireEvent.change(screen.getByLabelText('Existing Secret', { exact: false }), {
      target: { value: 'gh-oauth' },
    })
    fireEvent.change(screen.getByLabelText('Client Secret key', { exact: false }), {
      target: { value: 'nope' },
    })

    expect(screen.getByText(/missing key\(s\): nope/i)).toBeInTheDocument()
    // Continue to the install step is blocked while the reference is invalid.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()

    // Fixing the key clears the warning and unblocks continue.
    fireEvent.change(screen.getByLabelText('Client Secret key', { exact: false }), {
      target: { value: 'client_secret' },
    })
    expect(screen.getByText(/Secret and keys verified/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()
  })
})

describe('OAuthInstallForm — manifest load failure blocks the managed gate', () => {
  it('keeps Continue disabled on the credentials step when the manifest fails to load', async () => {
    vi.mocked(api.getOAuthCredentialManifest).mockRejectedValue(new Error('manifest boom'))
    renderForm({ provider: 'google', grantScope: 'user', scopes: ['a.read'] })
    await waitForLoaded()

    // Provider → Credentials
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    // The load error is surfaced and no credential fields render…
    expect(await screen.findByText('manifest boom')).toBeInTheDocument()
    expect(screen.queryByLabelText('Client ID', { exact: false })).toBeNull()
    // …so the empty manifest must NOT vacuously satisfy the managed gate.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })
})

describe('OAuthInstallForm — callback base URL not configured', () => {
  it('shows the not-configured notice and disables install', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTROL_API_OAUTH_CALLBACK_BASE_URL', '')
    renderForm({ provider: 'google', grantScope: 'user', scopes: ['a.read'] })
    await waitForLoaded()

    // Step 0 shows the not-configured warning instead of a (broken) redirect URI.
    expect(screen.getByText(/public OAuth callback URL is not configured/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.change(screen.getByLabelText('Client ID', { exact: false }), {
      target: { value: 'cid' },
    })
    fireEvent.change(screen.getByLabelText('Client Secret', { exact: false }), {
      target: { value: 'csecret' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    // Even with complete credentials and scopes, install is blocked.
    expect(screen.getByRole('button', { name: 'Install connector' })).toBeDisabled()
  })

  it('does NOT show the config error when only the name is empty (config is fine)', async () => {
    // Base URL IS configured (beforeEach), so an empty name must not masquerade
    // as a configuration error.
    renderForm({ provider: 'google', grantScope: 'user', scopes: ['a.read'] })
    await waitForLoaded()

    fireEvent.change(screen.getByLabelText('Connector name'), { target: { value: '' } })

    expect(screen.queryByText(/is not configured/i)).toBeNull()
    expect(
      screen.getByText(/Enter a connector name above to generate the redirect URI/i)
    ).toBeInTheDocument()
    // No id derivable from a blank name, so Continue is blocked.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })
})

describe('OAuthInstallForm — reference mode submit body', () => {
  it('sends a reference secret with the chosen Secret name and keys', async () => {
    vi.mocked(api.listMcpSecrets).mockResolvedValue({
      items: [{ name: 'gh-oauth', keys: ['client_id', 'client_secret'] }],
    })
    renderForm({ provider: 'google', grantScope: 'context', scopes: ['a.read'] })
    await waitForLoaded()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.change(screen.getByLabelText('Secret source'), { target: { value: 'reference' } })
    fireEvent.change(screen.getByLabelText('Existing Secret', { exact: false }), {
      target: { value: 'gh-oauth' },
    })
    // Default keys (client_id / client_secret) already match the Secret.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install connector' }))

    await waitFor(() => expect(api.installFromRegistry).toHaveBeenCalledTimes(1))
    const req = vi.mocked(api.installFromRegistry).mock.calls[0][0]
    expect(req.oauth?.secret).toEqual({
      mode: 'reference',
      secretName: 'gh-oauth',
      clientIdKey: 'client_id',
      clientSecretKey: 'client_secret',
    })
    expect(req.oauth?.grantScope).toBe('context')
  })
})

describe('OAuthInstallForm — client_secret confidentiality (S-2, UI side)', () => {
  it('never leaves the typed client_secret in the DOM after submit and never logs it', async () => {
    const SECRET = 'super-secret-value-42'
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
    ]

    renderForm({ provider: 'google', grantScope: 'user', scopes: ['a.read'] })
    await waitForLoaded()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.change(screen.getByLabelText('Client ID', { exact: false }), {
      target: { value: 'cid' },
    })
    fireEvent.change(screen.getByLabelText('Client Secret', { exact: false }), {
      target: { value: SECRET },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Install connector' }))

    // The secret rides the submit body once…
    await waitFor(() => expect(api.installFromRegistry).toHaveBeenCalledTimes(1))
    const req = vi.mocked(api.installFromRegistry).mock.calls[0][0]
    expect(req.oauth?.secret).toMatchObject({ mode: 'managed', clientSecret: SECRET })

    // …then the success view renders and the secret is gone from the DOM.
    await screen.findByRole('heading', { name: 'OAuth connector installed' })
    expect(screen.queryByDisplayValue(SECRET)).toBeNull()
    expect(document.body.textContent).not.toContain(SECRET)

    // And it was never written to any console channel.
    for (const spy of consoleSpies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SECRET)
      }
      spy.mockRestore()
    }
  })
})

// ── Generic carril (S3-B4) ───────────────────────────────────────────────────

async function waitForContinueEnabled(): Promise<void> {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled())
}

describe('OAuthInstallForm — baked path is byte-identical (F1 guard)', () => {
  it('renders the 3-step baked wizard with no generic-only markers', async () => {
    const { container } = renderForm({ provider: 'google', grantScope: 'user', scopes: ['a.read'] })
    await waitForContinueEnabled()

    // Baked keeps the 3-step rail and never shows an Endpoints step or generic controls.
    expect(container.querySelector('.cu-create-step-flow--3')).not.toBeNull()
    expect(container.querySelector('.cu-create-step-flow--4')).toBeNull()
    expect(screen.queryByText('Endpoints')).toBeNull()
    expect(screen.queryByText('Authorization server endpoints')).toBeNull()
    expect(container.firstChild).toMatchSnapshot()
  })
})

describe('OAuthInstallForm — generic public install (S3-B4, DA-1)', () => {
  it('submits body.oauth.generic with no secret and the derived client_id note', async () => {
    renderForm({
      provider: 'generic',
      grantScope: 'user',
      scopes: ['openid'],
      genericConfig: {
        authorizationEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: 'https://idp.example.com/token',
      },
    })
    await waitForContinueEnabled()

    // A public generic client surfaces the client_id to register (DA-1).
    expect(screen.getByText(/register a client with client id/i)).toBeInTheDocument()

    // Provider → Endpoints → Credentials → Install (4 steps).
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // → Endpoints
    expect(screen.getByText('Authorization server endpoints')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // → Credentials
    // Public client: no credential fields, and the manifest is never fetched.
    expect(api.getOAuthCredentialManifest).not.toHaveBeenCalled()
    expect(screen.getByText(/Public client selected/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // → Install

    fireEvent.click(screen.getByRole('button', { name: 'Install connector' }))
    await waitFor(() => expect(api.installFromRegistry).toHaveBeenCalledTimes(1))

    const req = vi.mocked(api.installFromRegistry).mock.calls[0][0]
    expect(req.oauth?.secret).toBeUndefined()
    expect(req.oauth?.scopes).toEqual(['openid'])
    expect(req.oauth?.grantScope).toBe('user')
    expect(req.oauth?.generic).toMatchObject({
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      tokenAuthMethod: 'body',
      usePkce: true,
      sendScope: true,
    })
    // Never carries a provider or oauth.id (control-api derives it).
    expect(req.oauth).not.toHaveProperty('id')
    expect(req.oauth?.generic).not.toHaveProperty('provider')
  })
})

describe('OAuthInstallForm — generic confidential/basic (S-2, forced confidential)', () => {
  it('forces confidential for basic auth and keeps the client_secret out of the DOM after submit', async () => {
    vi.mocked(api.getOAuthCredentialManifest).mockResolvedValue(GENERIC_MANIFEST)
    const SECRET = 'generic-secret-99'
    renderForm({
      provider: 'generic',
      grantScope: 'context',
      scopes: ['openid'],
      genericConfig: {
        authorizationEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: 'https://idp.example.com/token',
        tokenAuthMethod: 'basic',
      },
    })
    await waitForContinueEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // → Endpoints
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // → Credentials

    // Basic auth forces a confidential client: the client-type select is disabled.
    const clientType = screen.getByLabelText('Client type') as HTMLSelectElement
    expect(clientType.value).toBe('confidential')
    expect(clientType).toBeDisabled()
    expect(api.getOAuthCredentialManifest).toHaveBeenCalledWith('generic')

    fireEvent.change(screen.getByLabelText('Client ID', { exact: false }), {
      target: { value: 'cid' },
    })
    fireEvent.change(screen.getByLabelText('Client Secret', { exact: false }), {
      target: { value: SECRET },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // → Install
    fireEvent.click(screen.getByRole('button', { name: 'Install connector' }))

    await waitFor(() => expect(api.installFromRegistry).toHaveBeenCalledTimes(1))
    const req = vi.mocked(api.installFromRegistry).mock.calls[0][0]
    expect(req.oauth?.secret).toMatchObject({ mode: 'managed', clientSecret: SECRET })
    expect(req.oauth?.generic?.tokenAuthMethod).toBe('basic')

    // S-2: the secret is gone from the DOM after the success view renders.
    await screen.findByRole('heading', { name: 'OAuth connector installed' })
    expect(screen.queryByDisplayValue(SECRET)).toBeNull()
    expect(document.body.textContent).not.toContain(SECRET)
  })
})

describe('OAuthInstallForm — manually selecting Basic auth forces confidential and stays submittable', () => {
  it('does not deadlock the install when Basic is chosen on a public/body-seeded form', async () => {
    // Regression: selecting Basic disables the client-type toggle (forced confidential);
    // if clientMode stayed 'public' the form would validate forever-false with the only
    // fix control disabled. editEnumKnob upholds basic⇒confidential so the flow proceeds.
    vi.mocked(api.getOAuthCredentialManifest).mockResolvedValue(GENERIC_MANIFEST)
    renderForm({
      provider: 'generic',
      grantScope: 'user',
      scopes: ['openid'],
      genericConfig: {
        authorizationEndpoint: 'https://idp.example.com/authorize',
        tokenEndpoint: 'https://idp.example.com/token',
      },
    })
    await waitForContinueEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // → Endpoints
    // Manually pick Basic auth (the form was seeded public/body). This flips the client
    // to confidential and triggers the generic manifest load, so wait for it to settle.
    fireEvent.change(screen.getByLabelText('Client authentication method', { exact: false }), {
      target: { value: 'basic' },
    })
    await waitForContinueEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // → Credentials

    // The client type is forced confidential and its toggle is disabled…
    const clientType = (await screen.findByLabelText('Client type')) as HTMLSelectElement
    expect(clientType.value).toBe('confidential')
    expect(clientType).toBeDisabled()

    // …and entering the confidential credentials makes Install reachable (not deadlocked).
    fireEvent.change(await screen.findByLabelText('Client ID', { exact: false }), {
      target: { value: 'cid' },
    })
    fireEvent.change(screen.getByLabelText('Client Secret', { exact: false }), {
      target: { value: 'sh' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // → Install
    expect(screen.getByRole('button', { name: 'Install connector' })).not.toBeDisabled()
  })
})

describe('OAuthInstallForm — generic Detect never auto-applies (invariant 8)', () => {
  it('leaves the form unchanged after Detect and keeps an edited field on Apply', async () => {
    vi.mocked(api.discoverGenericOAuth).mockResolvedValue(NOTION_GENERIC_PREFILL)
    renderForm({ provider: 'generic', grantScope: 'user', scopes: [] })
    await waitForContinueEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' })) // → Endpoints

    const authInput = screen.getByLabelText('Authorization endpoint', {
      exact: false,
    }) as HTMLInputElement
    const tokenInput = screen.getByLabelText('Token endpoint', { exact: false }) as HTMLInputElement
    expect(authInput.value).toBe('')

    // Detect stores a result…
    fireEvent.change(screen.getByLabelText('Issuer or discovery URL'), {
      target: { value: 'https://mcp.notion.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Detect' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Apply detected values/i })).toBeInTheDocument()
    )
    // …but the form has NOT changed (invariant 8).
    expect(authInput.value).toBe('')
    expect(tokenInput.value).toBe('')

    // The operator edits the authorization endpoint (marks it touched)…
    fireEvent.change(authInput, { target: { value: 'https://manual.example.com/authorize' } })
    // …then applies the detected values.
    fireEvent.click(screen.getByRole('button', { name: /Apply detected values/i }))

    // Manual wins: the edited field is kept; the un-edited token endpoint takes the
    // detected value (T4: assert the input values, not internal state).
    expect(
      (screen.getByLabelText('Authorization endpoint', { exact: false }) as HTMLInputElement).value
    ).toBe('https://manual.example.com/authorize')
    expect(
      (screen.getByLabelText('Token endpoint', { exact: false }) as HTMLInputElement).value
    ).toBe('https://mcp.notion.com/token')
  })
})
