'use client'

import React, { useEffect, useRef, useState } from 'react'
import { CreateFlowPanel } from '@components/CreateFlowPanel'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { RemoteOAuthProvenanceBadge } from '@components/RemoteOAuthProvenanceBadge'
import { RemoteOAuthSetupGuide } from '@components/RemoteOAuthSetupGuide'
import { useToast } from '@components/Toast'
import { IconCopy } from '@components/icons'
import { Button, CheckboxField, Field, SelectInput, TextInput } from '@components/ui'
import { isSilentApiError } from '@lib/api'
import { copyTextToClipboard } from '@lib/clipboard'
import {
  buildCatalogRemoteInstallRequest,
  buildRemoteInstallRequest,
  describeCatalogTransportDead,
  describeTransportProbe,
  discoverCatalogRemoteServer,
  discoverRemoteServer,
  displayClientMode,
  getEntraTenantIdError,
  getRemoteBaseUrlError,
  getRemoteServerNameError,
  installModeForRegistration,
  installRemoteServer,
  isCatalogSlotTakenError,
  mapRemoteDiscoverError,
  mapRemoteInstallError,
  parseRemoteScopesInput,
  remoteCallbackBlocker,
  remotePreRegisteredRedirectUri,
  remoteScopesOverride,
  requiresPreRegisteredCredentials,
  shouldWarnNoRefresh,
  tenantAuthority,
  tenantRequiredDetail,
  transportBlocksContinue,
  unverifiedScopesFromInstallError,
} from '@lib/remoteMcp'
import type {
  RemoteCallbackPreview,
  RemoteCatalogDrift,
  RemoteDetected,
  RemoteGrantScope,
  RemoteTenantRequiredDetail,
  RemoteTransportProbe,
} from '@lib/remoteMcp.types'
import {
  CATALOG_EXPECTED_REGISTRATION_LABEL,
  GRANT_SCOPE_OPTIONS,
  REGISTRATION_MODE_HINT,
  REGISTRATION_MODE_LABEL,
  REMOTE_SCOPES_MAX,
  REMOTE_WIZARD_STEPS,
  REMOTE_WIZARD_STEP_DETAILS,
} from './constants'
import type {
  AddRemoteServerWizardProps,
  AsEndpointHostsSummaryProps,
  CatalogDriftNoticeProps,
  InstalledRedirectUri,
  RedirectUriCopyProps,
} from './types'

const STEP_TITLE_ID = 'add-remote-server-step-title'

export function AddRemoteServerWizard({
  pageHeader,
  onInstalled,
  onCancel,
  catalog,
  onSlotTaken,
}: AddRemoteServerWizardProps) {
  const { showToast } = useToast()

  const [step, setStep] = useState(0)

  // Step 0 — identity. In catalog mode the URL is the entry's (display only) and the
  // name is whatever control-api's discover assigns to the slot.
  const [baseUrl, setBaseUrl] = useState(catalog?.baseUrl ?? '')
  const [serverName, setServerName] = useState('')
  const [catalogDrift, setCatalogDrift] = useState<RemoteCatalogDrift | null>(null)

  // Detection. Editing the URL clears `detected` (see the baseUrl onChange), so
  // a present `detected` always corresponds to the current URL (D-4: the pinned
  // config is authoritative — a re-detect is forced whenever the URL changes).
  const [detecting, setDetecting] = useState(false)
  const [discoverError, setDiscoverError] = useState('')
  const [detected, setDetected] = useState<RemoteDetected | null>(null)
  // MCP transport probe result for the current URL. A `dead` probe clears
  // `detected` and holds the wizard on step 0; the others never block.
  const [transport, setTransport] = useState<RemoteTransportProbe | null>(null)
  // Callback preview for the current detection; undefined on an older control-api.
  const [callback, setCallback] = useState<RemoteCallbackPreview | undefined>(undefined)
  // Set when the server signs in through Entra's multi-tenant authority: the operator
  // must name the tenant before discovery can pin an issuer. Survives a failed
  // re-detect so a wrong tenant can be corrected in place.
  const [tenantPrompt, setTenantPrompt] = useState<RemoteTenantRequiredDetail | null>(null)
  const [tenantId, setTenantId] = useState('')
  // Authorization server used by the discover that produced `detected`; sent again at
  // install so control-api re-discovers against the same tenant.
  const [detectedAuthorizationServer, setDetectedAuthorizationServer] = useState<
    string | undefined
  >(undefined)

  // Step 1 — configuration
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [grantScope, setGrantScope] = useState<RemoteGrantScope>(catalog?.grantScope ?? 'user')
  const [scopesInput, setScopesInput] = useState('')

  // Step 2 — install
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState('')
  // A pre-registered install holds here so the operator can copy the redirect URI
  // the AS must hold before leaving the wizard.
  const [installed, setInstalled] = useState<InstalledRedirectUri | null>(null)
  // Scopes whose API control-api cannot tie to this server. The confirmation covers
  // exactly this list: replacing the list always clears it.
  const [unverifiedToConfirm, setUnverifiedToConfirm] = useState<string[]>([])
  const [unverifiedConfirmed, setUnverifiedConfirmed] = useState(false)

  const serverNameError = serverName.length > 0 ? getRemoteServerNameError(serverName) : ''
  const trimmedBaseUrl = baseUrl.trim()
  const baseUrlError = baseUrl.length > 0 ? getRemoteBaseUrlError(trimmedBaseUrl) : ''
  const identifiersValid =
    (catalog !== undefined || getRemoteBaseUrlError(trimmedBaseUrl) === '') &&
    getRemoteServerNameError(serverName) === ''
  // In catalog mode the name only exists once discover assigns it, so Detect never waits on it.
  const canDetect = catalog !== undefined || identifiersValid
  const tenantIdError = getEntraTenantIdError(tenantId)
  const tenantReady = !tenantPrompt || tenantIdError === ''
  // An entry that names Entra as its authorization server shows the tenant field before
  // the first discover answers; the authority template still comes from that answer.
  const showTenantField =
    Boolean(tenantPrompt) || catalog?.block.authorizationServerHint === 'entra-v2'

  const installMode = detected ? installModeForRegistration(detected.registrationMode) : null
  const needsCredentials = installMode ? requiresPreRegisteredCredentials(installMode) : false
  const noRefresh = detected ? shouldWarnNoRefresh(detected) : false

  const deadTransport = transport?.status === 'dead' ? transport : null
  const suggestedBaseUrl = deadTransport?.suggestedBaseUrl
  const inconclusiveTransport = transport?.status === 'inconclusive' ? transport : null
  const aliveTransport = transport?.status === 'alive' ? transport : null

  const callbackBlocker = detected ? remoteCallbackBlocker({ detected, callback }) : ''
  const preRegisteredRedirectUri = needsCredentials
    ? remotePreRegisteredRedirectUri(callback, serverName)
    : null
  // control-api already strips both from any entry not proven to be the curator's; the
  // wizard holds the same line in case a response ever carries them anyway.
  const catalogGuide = catalog?.trusted ? catalog.block.setupGuide : undefined
  const catalogConsoleUrl = catalog?.trusted ? catalog.block.providerConsoleUrl : undefined
  const asEndpointHosts = detected?.asEndpointHosts

  // control-api requires the scopes for any authorization-server profile, not only
  // Entra's; `entraProfile` only picks Entra-specific copy.
  const hasAsProfile = Boolean(detected?.asProfile)
  const entraProfile = detected?.asProfile === 'entra-v2'
  // Without a profile, the advertised list is accepted as typed even when it breaks
  // RFC 6749, so a server with non-conforming scopes is not blocked here. With a profile
  // the list is always sent and control-api enforces the charset, so validate it.
  const scopeTokens = scopesInput.trim().split(/\s+/).filter(Boolean)
  const scopesAsAdvertised =
    detected !== null &&
    !hasAsProfile &&
    scopeTokens.length === detected.scopes.length &&
    scopeTokens.every((scope, i) => scope === detected.scopes[i])
  const parsedScopes = scopesAsAdvertised
    ? { scopes: scopeTokens }
    : parseRemoteScopesInput(scopesInput, REMOTE_SCOPES_MAX)
  const scopesError = 'error' in parsedScopes ? parsedScopes.error : ''
  const scopesOverride =
    detected && 'scopes' in parsedScopes
      ? remoteScopesOverride(parsedScopes.scopes, detected.scopes)
      : undefined
  const effectiveScopes = scopesOverride ?? detected?.scopes ?? []

  const credentialsComplete =
    !needsCredentials || (clientId.trim().length > 0 && clientSecret.length > 0)
  const step1Valid =
    Boolean(detected) &&
    identifiersValid &&
    credentialsComplete &&
    callbackBlocker === '' &&
    scopesError === ''
  const confirmationPending = unverifiedToConfirm.length > 0 && !unverifiedConfirmed

  function canSelectStep(target: number): boolean {
    // Once installed, going back would offer a second install of the same server.
    if (installed) return target === 2
    if (target === 0) return true
    if (target === 1) return Boolean(detected) && identifiersValid
    return step1Valid
  }

  function clearUnverifiedConfirmation() {
    setUnverifiedToConfirm([])
    setUnverifiedConfirmed(false)
  }

  function resetDetection() {
    setDetected(null)
    setTransport(null)
    setCallback(undefined)
    setDiscoverError('')
    setDetectedAuthorizationServer(undefined)
    setScopesInput('')
    clearUnverifiedConfirmation()
  }

  // A new URL may be a different server, so the tenant asked for the old one is dropped.
  function changeBaseUrl(value: string) {
    setBaseUrl(value)
    // Editing the URL invalidates a prior detection or transport probe.
    if (detected || transport) resetDetection()
    setTenantPrompt(null)
    setTenantId('')
  }

  function goToStep(target: number) {
    if (target === 2 && step !== 2) {
      // The backend's discover-time list only holds for the scopes it advertised; for
      // edited scopes the install answers with the list to confirm.
      setUnverifiedToConfirm(scopesOverride === undefined ? (detected?.unverifiedScopes ?? []) : [])
      setUnverifiedConfirmed(false)
    } else if (target < 2) {
      clearUnverifiedConfirmation()
    }
    setStep(target)
  }

  async function copyRedirectUri(uri: string) {
    const ok = await copyTextToClipboard(uri)
    showToast(ok ? 'Redirect URI copied.' : 'Copy failed — select and copy the URI manually.', {
      tone: ok ? 'success' : 'error',
    })
  }

  function discoverWith(authorizationServer: string | undefined) {
    if (catalog) {
      return discoverCatalogRemoteServer({
        catalogEntry: catalog.entry,
        grantScope: catalog.grantScope,
        authorizationServer,
      })
    }
    return authorizationServer === undefined
      ? discoverRemoteServer(trimmedBaseUrl)
      : discoverRemoteServer(trimmedBaseUrl, authorizationServer)
  }

  async function runDetect() {
    const tenantTyped = showTenantField && tenantIdError === ''
    let authorizationServer =
      tenantPrompt && tenantTyped
        ? tenantAuthority(tenantPrompt.tenantAuthorityTemplate, tenantId)
        : undefined
    setDetecting(true)
    setDiscoverError('')
    setTransport(null)
    setCallback(undefined)
    try {
      let response: Awaited<ReturnType<typeof discoverWith>>
      try {
        response = await discoverWith(authorizationServer)
      } catch (first) {
        // A tenant typed before control-api named the authority template (an entry
        // hinting Entra shows the field up front) is sent as soon as the template
        // arrives, instead of asking the operator to press Detect again.
        const required = tenantRequiredDetail(first)
        if (!required || authorizationServer !== undefined || !tenantTyped) throw first
        setTenantPrompt(required)
        authorizationServer = tenantAuthority(required.tenantAuthorityTemplate, tenantId)
        response = await discoverWith(authorizationServer)
      }
      const {
        detected: nextDetected,
        transport: nextTransport,
        callback: nextCallback,
        serverName: assignedServerName,
        catalogDrift: nextCatalogDrift,
      } = response
      if (catalog) {
        setServerName(assignedServerName ?? '')
        setCatalogDrift(nextCatalogDrift ?? null)
      }
      if (transportBlocksContinue(nextTransport)) {
        // Dead MCP transport: never install a URL the probe proved dead. Hold on
        // step 0, surface the reason (and any canonical URL suggestion), and keep
        // the primary action as "Detect" (no `detected` → no "Continue").
        setDetected(null)
        setTransport(nextTransport ?? null)
        return
      }
      setDetected(nextDetected)
      setTransport(nextTransport ?? null)
      setCallback(nextCallback)
      setDetectedAuthorizationServer(authorizationServer)
      const suggestedScopes = catalog?.block.scopes?.length
        ? catalog.block.scopes
        : nextDetected.scopes
      setScopesInput(suggestedScopes.join(' '))
      // Catalog mode stays on Identify so the operator sees the entry's URL, the
      // assigned name and its provenance badge before moving on.
      if (!catalog) setStep(1)
    } catch (e) {
      if (isSilentApiError(e)) return
      setDetected(null)
      const tenantRequired = tenantRequiredDetail(e)
      if (tenantRequired) {
        // The tenant prompt replaces the error banner: this is a question, not a failure.
        setTenantPrompt(tenantRequired)
        setDiscoverError('')
        return
      }
      setDiscoverError(mapRemoteDiscoverError(e))
    } finally {
      setDetecting(false)
    }
  }

  // Catalog mode detects as soon as it opens; the ref keeps a double-invoked effect from
  // sending a second discover.
  const autoDetected = useRef(false)
  useEffect(() => {
    if (!catalog || autoDetected.current) return
    autoDetected.current = true
    void runDetect()
    // Runs once per mount: the catalog target is fixed for the wizard's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function runInstall() {
    if (!detected || !installMode || confirmationPending) return
    setInstalling(true)
    setInstallError('')
    try {
      const shared = {
        mode: installMode,
        clientId: needsCredentials ? clientId : undefined,
        clientSecret: needsCredentials ? clientSecret : undefined,
        // With a profile control-api requires the list, so the one on screen is always
        // sent rather than letting a re-discovery decide what gets installed.
        scopes: hasAsProfile ? effectiveScopes : scopesOverride,
        authorizationServer: detectedAuthorizationServer,
        confirmedUnverifiedScopes: unverifiedConfirmed ? unverifiedToConfirm : undefined,
      }
      const body = catalog
        ? buildCatalogRemoteInstallRequest({ target: catalog, ...shared })
        : buildRemoteInstallRequest({
            serverName,
            baseUrl: trimmedBaseUrl,
            grantScope,
            ...shared,
          })
      const res = await installRemoteServer(body)
      showToast(
        catalog
          ? `Remote server ${res.serverName} installed. Give agents access from its Marketplace card whenever you’re ready.`
          : `Remote server ${res.serverName} installed. Give agents access from the Installed Connectors list whenever you’re ready.`,
        { tone: 'success' }
      )
      if (res.registrationMode === 'pre-registered' && res.redirectUri) {
        setInstalled({
          redirectUri: res.redirectUri,
          changedSincePreview:
            preRegisteredRedirectUri !== null && preRegisteredRedirectUri !== res.redirectUri,
        })
        return
      }
      onInstalled()
    } catch (e) {
      if (isSilentApiError(e)) return
      const toConfirm = unverifiedScopesFromInstallError(e)
      if (toConfirm) {
        setUnverifiedToConfirm(toConfirm)
        setUnverifiedConfirmed(false)
        return
      }
      const message = mapRemoteInstallError(e, {
        callbackVariant: callback?.variant,
        catalog: Boolean(catalog),
      })
      if (catalog && isCatalogSlotTakenError(e) && onSlotTaken) {
        onSlotTaken(message)
        return
      }
      setInstallError(message)
    } finally {
      setInstalling(false)
    }
  }

  const clientModeLabel = detected ? displayClientMode(detected) : null

  return (
    <CreateFlowPanel header={pageHeader}>
      <form
        onSubmit={event => {
          event.preventDefault()
          if (step === 2 && !installed) void runInstall()
        }}
      >
        <CreateStepFlow
          ariaLabel="Add remote server steps"
          className="cu-create-step-flow--3"
          currentStep={step}
          onStepChange={target => {
            if (canSelectStep(target)) goToStep(target)
          }}
          canSelectStep={canSelectStep}
          steps={REMOTE_WIZARD_STEP_DETAILS}
          stepLabels={REMOTE_WIZARD_STEPS}
          titleId={STEP_TITLE_ID}
        >
          {step === 0 ? (
            <div className="cu-form-stack cu-agent-form-stack">
              {catalog ? (
                <>
                  <div className="cu-remote-oauth-provenance">
                    <span>
                      Marketplace entry{' '}
                      <strong>
                        {catalog.entry.name} v{catalog.entry.version}
                      </strong>
                    </span>
                    <RemoteOAuthProvenanceBadge
                      block={catalog.block}
                      publisher={catalog.publisher}
                      trusted={catalog.trusted}
                    />
                  </div>

                  <Field
                    description="Taken from the Marketplace entry. It cannot be changed here."
                    label="Remote server URL"
                    htmlFor="remote-base-url"
                  >
                    <TextInput id="remote-base-url" monospace readOnly value={catalog.baseUrl} />
                  </Field>

                  <Field
                    description="Assigned by the Marketplace to this slot, so the slot holds a single server."
                    label="Server name"
                    htmlFor="remote-server-name"
                  >
                    <TextInput
                      id="remote-server-name"
                      monospace
                      readOnly
                      placeholder="Assigned after detection"
                      value={serverName}
                    />
                  </Field>

                  <Field
                    description="The Marketplace slot you are installing."
                    label="Grant scope"
                    htmlFor="remote-grant-scope"
                  >
                    <TextInput
                      id="remote-grant-scope"
                      readOnly
                      value={grantScopeLabel(grantScope)}
                    />
                  </Field>
                </>
              ) : (
                <Field
                  description="The base URL of the remote MCP server (its OAuth metadata is discovered from here)."
                  error={baseUrlError || undefined}
                  label="Remote server URL"
                  htmlFor="remote-base-url"
                  required
                >
                  <TextInput
                    id="remote-base-url"
                    invalid={Boolean(baseUrlError)}
                    monospace
                    onChange={event => changeBaseUrl(event.target.value)}
                    placeholder="https://mcp.example.com/mcp"
                    disabled={detecting}
                    autoFocus
                    value={baseUrl}
                  />
                </Field>
              )}

              {showTenantField ? (
                <Field
                  label="Microsoft Entra tenant ID"
                  description="This server signs in with Microsoft Entra ID. Enter your organization's Directory (tenant) ID — a GUID shown on the Microsoft Entra admin center overview."
                  error={tenantId.length > 0 ? tenantIdError || undefined : undefined}
                  htmlFor="remote-entra-tenant-id"
                  required
                >
                  <TextInput
                    id="remote-entra-tenant-id"
                    monospace
                    // Mounted before the first discover in catalog mode, while disabled.
                    autoFocus={!catalog}
                    value={tenantId}
                    placeholder="00000000-0000-0000-0000-000000000000"
                    disabled={detecting}
                    invalid={tenantId.length > 0 && tenantIdError !== ''}
                    onChange={event => {
                      setTenantId(event.target.value)
                      if (detected || transport) resetDetection()
                    }}
                  />
                </Field>
              ) : null}

              {catalog ? null : (
                <Field
                  description="Kubernetes resource name: lowercase alphanumeric and hyphens, max 63 chars."
                  error={serverNameError || undefined}
                  label="Server name"
                  htmlFor="remote-server-name"
                  required
                >
                  <TextInput
                    id="remote-server-name"
                    invalid={Boolean(serverNameError)}
                    monospace
                    onChange={event =>
                      setServerName(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                    }
                    placeholder="example-remote"
                    disabled={detecting}
                    value={serverName}
                  />
                </Field>
              )}

              {discoverError ? (
                <div className="cu-banner cu-banner--error" role="alert">
                  {discoverError}
                </div>
              ) : null}

              {deadTransport && catalog ? (
                <div className="cu-banner cu-banner--error" role="alert">
                  {describeCatalogTransportDead(deadTransport.httpStatus)}
                </div>
              ) : null}

              {deadTransport && !catalog ? (
                <div className="cu-banner cu-banner--error" role="alert">
                  <div>{describeTransportProbe(deadTransport)}</div>
                  {suggestedBaseUrl ? (
                    <div className="cu-transport-suggestion">
                      <Button
                        onClick={() => changeBaseUrl(suggestedBaseUrl)}
                        size="sm"
                        variant="ghost"
                      >
                        Use {suggestedBaseUrl}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 1 && detected ? (
            <div className="cu-form-stack cu-agent-form-stack">
              {catalogDrift ? <CatalogDriftNotice drift={catalogDrift} /> : null}

              {noRefresh ? (
                <div className="cu-banner cu-banner--warning" role="status">
                  This authorization server does not support token refresh, so users will have to
                  re-authorize periodically to keep this connector working.
                </div>
              ) : null}

              {inconclusiveTransport ? (
                <div className="cu-banner cu-banner--warning" role="status">
                  {describeTransportProbe(inconclusiveTransport)}
                </div>
              ) : null}

              <section className="cu-summary-list" aria-label="Detected OAuth configuration">
                <div className="cu-summary-list__row">
                  <span>Registration mode</span>
                  <strong>{REGISTRATION_MODE_LABEL[detected.registrationMode]}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Client mode</span>
                  <strong>{clientModeLabel}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Issuer</span>
                  <strong>{detected.issuer}</strong>
                </div>
                {entraProfile ? (
                  <div className="cu-summary-list__row">
                    <span>Authorization server</span>
                    <strong>Microsoft Entra ID</strong>
                  </div>
                ) : null}
                <div className="cu-summary-list__row">
                  <span>Resource</span>
                  <strong>
                    {entraProfile
                      ? `${detected.resource} (not sent to Microsoft Entra ID)`
                      : detected.resource}
                  </strong>
                </div>
                {aliveTransport ? (
                  <div className="cu-summary-list__row">
                    <span>MCP endpoint</span>
                    <strong>
                      {aliveTransport.challenge ? 'Reachable (sign-in required)' : 'Reachable'}
                    </strong>
                  </div>
                ) : null}
                <div className="cu-summary-list__row">
                  <span>Authorization endpoint</span>
                  <strong>{detected.endpoints.authorization}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Token endpoint</span>
                  <strong>{detected.endpoints.token}</strong>
                </div>
                {detected.endpoints.registration ? (
                  <div className="cu-summary-list__row">
                    <span>Registration endpoint</span>
                    <strong>{detected.endpoints.registration}</strong>
                  </div>
                ) : null}
                {detected.quirks.bearerInBody ? (
                  <div className="cu-summary-list__row">
                    <span>Token transport</span>
                    <strong>Sent in the request body</strong>
                  </div>
                ) : null}
              </section>

              {detected.scopeAudienceMissing ? (
                <div className="cu-banner cu-banner--warning" role="status">
                  This server doesn’t advertise its own scope. Enter it before installing; sign-in
                  scopes alone would send a Microsoft Graph token to the server.
                </div>
              ) : null}

              {/* An empty advertised scope is itself the violation and arrives as `''`. */}
              {detected.scopeAudienceViolation !== undefined ? (
                <div className="cu-banner cu-banner--warning" role="status">
                  {detected.scopeAudienceViolation
                    ? `The server suggests the scope "${detected.scopeAudienceViolation}", which would mint a token for another API. Replace it with this server's own scope before installing.`
                    : "The server advertises an empty scope, which OAuth does not allow. It is left out of the scopes below; check they include this server's own scope before installing."}
                </div>
              ) : null}

              <Field
                label="Scopes"
                htmlFor="remote-scopes"
                error={scopesError || undefined}
                description={
                  entraProfile
                    ? 'Space-separated. offline_access is always added so connections can refresh. Leave empty to use the scopes the server advertises.'
                    : 'Space-separated scopes requested at sign-in. Leave empty to use the scopes the server advertises.'
                }
              >
                <TextInput
                  id="remote-scopes"
                  monospace
                  invalid={scopesError !== ''}
                  value={scopesInput}
                  onChange={event => setScopesInput(event.target.value)}
                />
              </Field>

              <p className="cu-field__hint">{REGISTRATION_MODE_HINT[detected.registrationMode]}</p>

              {callbackBlocker ? (
                <div className="cu-banner cu-banner--error" role="alert">
                  {callbackBlocker}
                </div>
              ) : null}

              {asEndpointHosts ? (
                <AsEndpointHostsSummary hosts={asEndpointHosts} withExplanation />
              ) : null}

              {needsCredentials && catalog && (catalogGuide || catalogConsoleUrl) ? (
                <RemoteOAuthSetupGuide guide={catalogGuide} providerConsoleUrl={catalogConsoleUrl}>
                  {preRegisteredRedirectUri ? (
                    <Field
                      label="Redirect URI"
                      description="Register this exact URI in the provider’s OAuth client before users connect."
                    >
                      <RedirectUriCopy uri={preRegisteredRedirectUri} onCopy={copyRedirectUri} />
                    </Field>
                  ) : null}
                </RemoteOAuthSetupGuide>
              ) : null}

              {needsCredentials && catalog && !catalogGuide && !catalogConsoleUrl ? (
                <div className="cu-banner cu-banner--info" role="note">
                  This entry ships no setup guide from the Marketplace curator. Register an OAuth
                  app at the provider with the redirect URI below, one app per slot.
                </div>
              ) : null}

              {needsCredentials &&
              preRegisteredRedirectUri &&
              !(catalog && (catalogGuide || catalogConsoleUrl)) ? (
                <Field
                  label="Redirect URI"
                  description="Register this exact URI in the provider’s OAuth client before users connect."
                >
                  <RedirectUriCopy uri={preRegisteredRedirectUri} onCopy={copyRedirectUri} />
                </Field>
              ) : null}

              {needsCredentials ? (
                <div className="cu-form-grid">
                  <Field
                    description="The client_id of the pre-registered OAuth client for this server."
                    label="Client ID"
                    htmlFor="remote-client-id"
                    required
                  >
                    <TextInput
                      id="remote-client-id"
                      monospace
                      onChange={event => setClientId(event.target.value)}
                      placeholder="pre-registered client_id"
                      value={clientId}
                    />
                  </Field>
                  <Field
                    description="Stored as a Kubernetes Secret and only ever sent to the pinned token endpoint."
                    label="Client secret"
                    htmlFor="remote-client-secret"
                    required
                  >
                    <TextInput
                      id="remote-client-secret"
                      type="password"
                      autoComplete="off"
                      onChange={event => setClientSecret(event.target.value)}
                      placeholder="pre-registered client_secret"
                      value={clientSecret}
                    />
                  </Field>
                </div>
              ) : null}

              {catalog ? (
                <Field
                  description="Fixed by the Marketplace slot you are installing."
                  label="Grant scope"
                  htmlFor="remote-grant-scope"
                >
                  <TextInput id="remote-grant-scope" readOnly value={grantScopeLabel(grantScope)} />
                </Field>
              ) : (
                <Field
                  description="Whether each user authorizes their own token or the context shares one."
                  label="Grant scope"
                  htmlFor="remote-grant-scope"
                >
                  <SelectInput
                    id="remote-grant-scope"
                    onChange={event => setGrantScope(event.target.value as RemoteGrantScope)}
                    value={grantScope}
                  >
                    {GRANT_SCOPE_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label} — {option.description}
                      </option>
                    ))}
                  </SelectInput>
                </Field>
              )}
            </div>
          ) : null}

          {step === 2 && installed ? (
            <div className="cu-form-stack cu-agent-form-stack">
              <p className="cu-field__hint">
                {serverName} is installed. Register this redirect URI in the provider’s OAuth
                client, then give agents access from{' '}
                {catalog ? 'its Marketplace card' : 'the Installed Connectors list'}.
              </p>
              {installed.changedSincePreview ? (
                <div className="cu-banner cu-banner--warning" role="status">
                  The authorization server changed since detection, so this redirect URI differs
                  from the one shown before. Register this one.
                </div>
              ) : null}
              <Field label="Redirect URI" description="Register this exact URI at the provider.">
                <RedirectUriCopy uri={installed.redirectUri} onCopy={copyRedirectUri} />
              </Field>
            </div>
          ) : null}

          {step === 2 && !installed && detected && installMode ? (
            <div className="cu-form-stack cu-agent-form-stack">
              <section className="cu-summary-list" aria-label="Install summary">
                {catalog ? (
                  <div className="cu-summary-list__row">
                    <span>Marketplace entry</span>
                    <strong>
                      {catalog.entry.name} v{catalog.entry.version}
                    </strong>
                  </div>
                ) : null}
                <div className="cu-summary-list__row">
                  <span>Server name</span>
                  <strong>{serverName}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Remote URL</span>
                  <strong>{trimmedBaseUrl}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Registration mode</span>
                  <strong>{REGISTRATION_MODE_LABEL[detected.registrationMode]}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Client mode</span>
                  <strong>{clientModeLabel}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Grant scope</span>
                  <strong>{grantScopeLabel(grantScope)}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Authorization endpoint</span>
                  <strong>{detected.endpoints.authorization}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Token endpoint</span>
                  <strong>{detected.endpoints.token}</strong>
                </div>
                <div className="cu-summary-list__row">
                  <span>Scopes</span>
                  <strong>{effectiveScopes.join(' ') || '—'}</strong>
                </div>
                {preRegisteredRedirectUri ? (
                  <div className="cu-summary-list__row">
                    <span>Redirect URI</span>
                    <strong>{preRegisteredRedirectUri}</strong>
                  </div>
                ) : null}
              </section>

              {asEndpointHosts ? <AsEndpointHostsSummary hosts={asEndpointHosts} /> : null}

              {noRefresh ? (
                <div className="cu-banner cu-banner--warning" role="status">
                  Reminder: this server does not support token refresh — users will re-authorize
                  periodically.
                </div>
              ) : null}

              {inconclusiveTransport ? (
                <div className="cu-banner cu-banner--warning" role="status">
                  {describeTransportProbe(inconclusiveTransport)}
                </div>
              ) : null}

              {unverifiedToConfirm.length > 0 ? (
                <div className="cu-banner cu-banner--warning" role="status">
                  <div>
                    These scopes name a Microsoft Entra API that this platform cannot tie to this
                    server. A token for that API will be sent to the server.
                  </div>
                  <ul className="cu-unverified-scopes">
                    {unverifiedToConfirm.map(scope => (
                      <li key={scope}>{scope}</li>
                    ))}
                  </ul>
                  <CheckboxField
                    checked={unverifiedConfirmed}
                    disabled={installing}
                    label="I confirm these scopes belong to this server’s own API."
                    onChange={event => setUnverifiedConfirmed(event.target.checked)}
                  />
                </div>
              ) : null}

              {installError ? (
                <div className="cu-banner cu-banner--error" role="alert">
                  {installError}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="cu-create-actions">
            {installed ? (
              <Button onClick={onInstalled} size="sm" variant="primary">
                Done
              </Button>
            ) : null}
            {installed ? null : (
              <Button
                disabled={detecting || installing}
                onClick={() => (step === 0 ? onCancel() : goToStep(step - 1))}
                size="sm"
                variant="ghost"
              >
                {step === 0 ? 'Cancel' : 'Back'}
              </Button>
            )}

            {step === 0 ? (
              detected ? (
                <Button
                  disabled={!identifiersValid}
                  onClick={() => goToStep(1)}
                  size="sm"
                  variant="primary"
                >
                  Continue
                </Button>
              ) : (
                <Button
                  disabled={!canDetect || !tenantReady || detecting}
                  loading={detecting}
                  onClick={() => void runDetect()}
                  size="sm"
                  variant="primary"
                >
                  {detecting ? 'Detecting…' : 'Detect'}
                </Button>
              )
            ) : null}

            {step === 1 ? (
              <Button
                disabled={!step1Valid}
                onClick={() => goToStep(2)}
                size="sm"
                variant="primary"
              >
                Continue
              </Button>
            ) : null}

            {step === 2 && !installed ? (
              <Button
                disabled={!step1Valid || installing || confirmationPending}
                loading={installing}
                size="sm"
                type="submit"
                variant="primary"
              >
                {installing ? 'Installing…' : 'Install remote server'}
              </Button>
            ) : null}
          </div>
        </CreateStepFlow>
      </form>
    </CreateFlowPanel>
  )
}

function RedirectUriCopy({ uri, onCopy }: RedirectUriCopyProps) {
  return (
    <div className="cu-table-actions">
      <TextInput value={uri} readOnly monospace aria-label="Redirect URI" />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        icon
        onClick={() => onCopy(uri)}
        aria-label="Copy redirect URI"
      >
        <IconCopy width={16} height={16} />
      </Button>
    </div>
  )
}

function AsEndpointHostsSummary({ hosts, withExplanation = false }: AsEndpointHostsSummaryProps) {
  return (
    <>
      {withExplanation ? (
        <div className="cu-banner cu-banner--info" role="note">
          This authorization server does not identify itself in its OAuth responses (RFC 9207), so
          the connector trusts these hosts because they share the issuer’s domain. Confirm they
          belong to the provider before installing.
        </div>
      ) : null}
      <section className="cu-summary-list" aria-label="Authorization server hosts">
        <div className="cu-summary-list__row">
          <span>Authorization host</span>
          <strong>{hosts.authorization}</strong>
        </div>
        <div className="cu-summary-list__row">
          <span>Token host</span>
          <strong>{hosts.token}</strong>
        </div>
        {hosts.registration ? (
          <div className="cu-summary-list__row">
            <span>Registration host</span>
            <strong>{hosts.registration}</strong>
          </div>
        ) : null}
      </section>
    </>
  )
}

function grantScopeLabel(scope: RemoteGrantScope): string {
  return scope === 'user' ? 'Per user' : 'Per context'
}

function CatalogDriftNotice({ drift }: CatalogDriftNoticeProps) {
  // Whether a curator guide is missing for the credentials step is said once, by the
  // credentials step itself; the drift notice only reports the drift.
  return (
    <div className="cu-banner cu-banner--warning" role="status">
      The provider changed its configuration since this Marketplace entry was published (it expects{' '}
      {CATALOG_EXPECTED_REGISTRATION_LABEL[drift.expected]}, discovery found{' '}
      {REGISTRATION_MODE_LABEL[drift.detected]}), so the entry may be out of date. The install
      follows what discovery found.
    </div>
  )
}
