'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useConfirmDialog } from '@components/ConfirmDialog'
import { CreatePageHeader } from '@components/CreatePageHeader'
import { CreateStepFlow } from '@components/CreateStepFlow'
import { IconUsers } from '@components/Sidebar/icons'
import { useToast } from '@components/Toast'
import { Button } from '@components/ui'
import { CONTROL_ROUTES } from '@constants/routes'
import {
  authorizeMicrosoftIdentityProviderSetup,
  createMicrosoftIdentityProviderSetup,
  executeMicrosoftIdentityProviderSetup,
  getActiveMicrosoftIdentityProviderSetup,
  getMicrosoftIdentityProviderDirectory,
} from '@lib/api'
import type { MicrosoftIdentityProviderSetup } from '@lib/identityProviders.types'
import { MicrosoftSetupGuideSteps } from './GuideSteps'
import {
  MicrosoftImportReviewStep,
  MicrosoftMembersMappingStep,
  MicrosoftTeamsMappingStep,
} from './MappingSteps'
import {
  MICROSOFT_IMPORT_DEBOUNCE_MS,
  MICROSOFT_IMPORT_STEP_DETAILS,
  MICROSOFT_IMPORT_STEP_LABELS,
  MICROSOFT_INVITATION_CHUNK_WAIT_MS,
} from './constants'
import {
  buildReviewTeams,
  createTeamDrafts,
  duplicateManualTeamIds,
  reconcileMemberDrafts,
} from './draft'
import type {
  MicrosoftDirectoryResponse,
  MicrosoftIdentityProviderSetupDraft,
  MicrosoftImportExecutionResult,
  MicrosoftSetupMemberDraft,
  MicrosoftSetupOptions,
  MicrosoftSetupTeamDraft,
} from './types'
import { useSetupPersistence } from './useSetupPersistence'

const DEFAULT_OPTIONS: MicrosoftSetupOptions = {
  createTeams: true,
  createMembers: true,
  sendInvitations: true,
  allowMemberLogin: true,
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds))
}

function setupDraft(
  draft: MicrosoftIdentityProviderSetupDraft,
  fallbackName: string,
  callbackUrl: string
): MicrosoftIdentityProviderSetupDraft {
  return {
    ...draft,
    displayName: draft.displayName || fallbackName,
    callbackUrl: draft.callbackUrl || callbackUrl,
    allowMemberLogin: draft.allowMemberLogin !== false,
    options: {
      ...DEFAULT_OPTIONS,
      allowMemberLogin: draft.allowMemberLogin !== false,
      ...(draft.options || {}),
    },
    teams: Array.isArray(draft.teams) ? draft.teams : [],
    members: Array.isArray(draft.members) ? draft.members : [],
  }
}

export function MicrosoftTeamsImportWizard() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const { confirm, confirmDialog } = useConfirmDialog()
  const hydratedRef = useRef(false)
  const latestDraftRef = useRef<MicrosoftIdentityProviderSetupDraft>({})
  const processingCancelledRef = useRef(false)

  const [step, setStep] = useState(0)
  const [maxStep, setMaxStep] = useState(0)
  const [setup, setSetup] = useState<MicrosoftIdentityProviderSetup | null>(null)
  const [draft, setDraft] = useState<MicrosoftIdentityProviderSetupDraft>({})
  const [callbackUrl, setCallbackUrl] = useState('')
  const [appName, setAppName] = useState('Evenfire')
  const [clientSecret, setClientSecret] = useState('')
  const [directory, setDirectory] = useState<MicrosoftDirectoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingDirectory, setLoadingDirectory] = useState(false)
  const [saving, setSaving] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState<MicrosoftImportExecutionResult | null>(null)
  const [error, setError] = useState('')

  const teams = draft.teams || []
  const members = draft.members || []
  const options = { ...DEFAULT_OPTIONS, ...(draft.options || {}) }
  const fallbackIntegrationName = `${appName} Teams Integration`
  const authorized = Boolean(
    setup?.connectionId && ['configuring', 'importing'].includes(setup.status)
  )
  const canAuthorize = Boolean(
    setup &&
    draft.clientId?.trim() &&
    draft.tenantId?.trim() &&
    (clientSecret.trim() || setup.hasClientSecret)
  )

  const reviewTeams = useMemo(
    () => (directory ? buildReviewTeams(directory, teams, members) : []),
    [directory, members, teams]
  )
  const selectedMembers = useMemo(() => members.filter(member => member.selected), [members])
  const newTeams = useMemo(
    () =>
      reviewTeams.filter(
        team => team.key !== 'no-team' && !team.existing && team.name.trim().length > 0
      ),
    [reviewTeams]
  )
  const newMemberCount = selectedMembers.filter(member => !member.existingMemberId).length
  const hasAssignedMembers = selectedMembers.some(member => member.teamRefs.length > 0)
  const duplicateTeamIds = useMemo(() => duplicateManualTeamIds(teams), [teams])
  const hasDuplicateManualTeams = duplicateTeamIds.size > 0

  latestDraftRef.current = draft

  const handlePersistenceError = useCallback((saveError: unknown) => {
    setError(saveError instanceof Error ? saveError.message : 'Failed to save setup progress')
  }, [])
  const handlePersistedSetup = useCallback(
    (nextSetup: MicrosoftIdentityProviderSetup) => setSetup(nextSetup),
    []
  )
  const persistSetup = useSetupPersistence({
    setup,
    draft,
    step,
    clientSecret,
    enabled: hydratedRef.current && !processing,
    debounceMs: MICROSOFT_IMPORT_DEBOUNCE_MS,
    onSetup: handlePersistedSetup,
    onError: handlePersistenceError,
  })

  function mergeDraft(patch: Partial<MicrosoftIdentityProviderSetupDraft>) {
    setDraft(current => ({ ...current, ...patch }))
  }

  async function loadDirectory(
    connectionId: string,
    currentDraft: MicrosoftIdentityProviderSetupDraft
  ) {
    setLoadingDirectory(true)
    try {
      const response = await getMicrosoftIdentityProviderDirectory(connectionId)
      setDirectory(response)
      const evenfireTeamByName = new Map(
        response.evenfireTeams.map(team => [team.name.trim().toLowerCase(), team])
      )
      const microsoftTeamById = new Map(response.teams.map(team => [team.id, team]))
      const microsoftUserById = new Map(response.users.map(user => [user.id, user]))
      const savedTeams =
        currentDraft.teams && currentDraft.teams.length > 0
          ? currentDraft.teams.map(team => {
              const importedTeam = team.externalTeamId
                ? microsoftTeamById.get(team.externalTeamId)
                : null
              const existingTeam =
                response.evenfireTeams.find(item => item.id === importedTeam?.importedTeamId) ||
                evenfireTeamByName.get(team.name.trim().toLowerCase())
              return {
                ...team,
                existingTeamId: existingTeam?.id || team.existingTeamId,
              }
            })
          : createTeamDrafts(response)
      const nextDraft = {
        ...currentDraft,
        teams: savedTeams,
        members: (currentDraft.members || []).map(member => {
          const currentUser = microsoftUserById.get(member.externalSubject)
          return {
            ...member,
            microsoftDisplayName: currentUser?.displayName || member.microsoftDisplayName,
            email: currentUser?.email || member.email,
            userPrincipalName: currentUser?.userPrincipalName || member.userPrincipalName,
            existingMemberId: currentUser?.existingMemberId || member.existingMemberId,
          }
        }),
      }
      setDraft(nextDraft)
      return nextDraft
    } finally {
      setLoadingDirectory(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    async function initialize() {
      setLoading(true)
      setError('')
      try {
        let response = await getActiveMicrosoftIdentityProviderSetup()
        const requestedConnectionId = searchParams.get('connectionId') || ''
        const startFresh = searchParams.get('fresh') === '1'
        if (
          startFresh ||
          (requestedConnectionId && response.setup?.connectionId !== requestedConnectionId)
        ) {
          response = await createMicrosoftIdentityProviderSetup({
            ...(requestedConnectionId ? { connectionId: requestedConnectionId } : {}),
            replaceActive: true,
          })
        } else if (!response.setup && requestedConnectionId) {
          response = await createMicrosoftIdentityProviderSetup({
            connectionId: requestedConnectionId,
          })
        }
        if (cancelled) return
        setCallbackUrl(response.callbackUrl)
        setAppName(response.appName || 'Evenfire')
        if (!response.setup) {
          setDraft(
            setupDraft(
              {},
              `${response.appName || 'Evenfire'} Teams Integration`,
              response.callbackUrl
            )
          )
          hydratedRef.current = true
          return
        }
        setSetup(response.setup)
        let nextDraft = setupDraft(
          response.setup.draft,
          `${response.appName || 'Evenfire'} Teams Integration`,
          response.callbackUrl
        )
        const nextStep = Math.max(0, Math.min(8, response.setup.currentStep - 1))
        setStep(nextStep)
        setMaxStep(nextStep)
        if (response.setup.connectionId && response.setup.status !== 'authorizing') {
          nextDraft = await loadDirectory(response.setup.connectionId, nextDraft)
        }
        if (cancelled) return
        setDraft(nextDraft)
        if (searchParams.get('connected') === '1') {
          setStep(5)
          setMaxStep(current => Math.max(current, 5))
          showToast('Microsoft authorization completed.', { tone: 'success' })
          router.replace(CONTROL_ROUTES.settings.microsoftConnect())
        } else if (searchParams.get('error')) {
          setStep(5)
          setMaxStep(current => Math.max(current, 5))
          setError(
            'Microsoft authorization could not be completed. Check the app values and consent, then try again.'
          )
          router.replace(CONTROL_ROUTES.settings.microsoftConnect())
        }
        hydratedRef.current = true
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : 'Failed to load Microsoft setup'
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void initialize()
    return () => {
      cancelled = true
      processingCancelledRef.current = true
    }
    // The OAuth callback query is consumed once during initialization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!setup) return
    function persistBeforeClose() {
      void fetch(
        `/control-api/api/v1/admin/identity-provider-setups/${encodeURIComponent(setup!.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          keepalive: true,
          body: JSON.stringify({ currentStep: step + 1, draft: latestDraftRef.current }),
        }
      )
    }
    window.addEventListener('pagehide', persistBeforeClose)
    return () => window.removeEventListener('pagehide', persistBeforeClose)
  }, [setup, step])

  async function beginSetup() {
    setSaving(true)
    setError('')
    try {
      const nextDraft = setupDraft(
        {
          displayName: draft.displayName || fallbackIntegrationName,
        },
        `${appName} Teams Integration`,
        callbackUrl
      )
      const response = await createMicrosoftIdentityProviderSetup({
        currentStep: 2,
        draft: nextDraft,
      })
      setSetup(response.setup)
      setDraft(nextDraft)
      setCallbackUrl(response.callbackUrl)
      hydratedRef.current = true
      setStep(1)
      setMaxStep(1)
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Failed to start Microsoft setup')
    } finally {
      setSaving(false)
    }
  }

  function canContinueFromStep(): boolean {
    if (step === 1) return draft.appRegistrationCreated === true
    if (step === 2) return Boolean(clientSecret.trim() || setup?.hasClientSecret)
    if (step === 3) return draft.permissionsGranted === true
    if (step === 4) return Boolean(draft.clientId?.trim() && draft.tenantId?.trim())
    if (step === 5) return authorized
    if (step === 6) {
      return (
        teams.every(team => !team.selected || Boolean(team.name.trim())) && !hasDuplicateManualTeams
      )
    }
    return true
  }

  async function continueStep() {
    if (!canContinueFromStep()) return
    let nextDraft = draft
    if (step === 6 && directory) {
      nextDraft = { ...draft, members: reconcileMemberDrafts(directory, teams, members) }
      setDraft(nextDraft)
    }
    const nextStep = Math.min(8, step + 1)
    setSaving(true)
    try {
      if (setup) {
        await persistSetup(nextStep, nextDraft)
      }
      setStep(nextStep)
      setMaxStep(current => Math.max(current, nextStep))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save setup progress')
    } finally {
      setSaving(false)
    }
  }

  async function authorizeMicrosoft() {
    if (!setup || !canAuthorize || authorized) return
    setSaving(true)
    setError('')
    try {
      await persistSetup(5, draft)
      const response = await authorizeMicrosoftIdentityProviderSetup(
        setup.id,
        `${window.location.origin}${CONTROL_ROUTES.settings.microsoftConnect()}`
      )
      window.location.assign(response.authorizeUrl)
    } catch (authorizeError) {
      setError(authorizeError instanceof Error ? authorizeError.message : 'Authorization failed')
      setSaving(false)
    }
  }

  function updateTeam(teamId: string, patch: Partial<MicrosoftSetupTeamDraft>) {
    mergeDraft({
      teams: teams.map(team => (team.id === teamId ? { ...team, ...patch } : team)),
    })
  }

  function updateTeamDestination(teamId: string, name: string) {
    const existing = directory?.evenfireTeams.find(
      team => team.name.trim().toLowerCase() === name.trim().toLowerCase()
    )
    updateTeam(teamId, {
      name,
      existingTeamId: existing?.id || null,
      contextIds: existing ? directory?.teamContexts[existing.id] || [] : [],
      agentNames: existing ? directory?.teamAgents[existing.id] || [] : [],
    })
  }

  function addManualTeam() {
    mergeDraft({
      teams: [
        ...teams,
        {
          id: `manual:${crypto.randomUUID()}`,
          selected: true,
          manual: true,
          externalTeamId: null,
          externalTeamName: null,
          existingTeamId: null,
          name: '',
          contextIds: [],
          agentNames: [],
        },
      ],
    })
  }

  function updateMember(memberId: string, patch: Partial<MicrosoftSetupMemberDraft>) {
    mergeDraft({
      members: members.map(member =>
        member.externalSubject === memberId ? { ...member, ...patch } : member
      ),
    })
  }

  function updateOptions(patch: Partial<MicrosoftSetupOptions>) {
    const nextOptions = { ...options, ...patch }
    mergeDraft({ options: nextOptions, allowMemberLogin: nextOptions.allowMemberLogin })
  }

  async function runImport() {
    if (!setup) return
    processingCancelledRef.current = false
    setProcessing(true)
    setError('')
    try {
      await persistSetup(8, draft)
      let result: MicrosoftImportExecutionResult | null = null
      do {
        result = await executeMicrosoftIdentityProviderSetup(setup.id)
        setProgress(result)
        if (!result.complete) {
          setSetup(current => (current ? { ...current, status: 'importing' } : current))
        }
        if (result.lastError) {
          setError(result.lastError)
          if (setup.connectionId) {
            await loadDirectory(setup.connectionId, latestDraftRef.current)
          }
          break
        }
        const processedMembers = Math.max(
          0,
          result.processed - teams.filter(team => team.selected).length
        )
        if (!result.complete && processedMembers > 0) {
          await wait(MICROSOFT_INVITATION_CHUNK_WAIT_MS)
        }
      } while (!result.complete && !processingCancelledRef.current)
      if (result?.complete) {
        showToast('Microsoft Teams integration completed.', { tone: 'success' })
        router.push(CONTROL_ROUTES.settings.microsoft)
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Microsoft import failed')
    } finally {
      setProcessing(false)
    }
  }

  async function confirmImport() {
    if (!options.createMembers || (newTeams.length > 0 && !options.createTeams)) return
    if (!options.sendInvitations && newMemberCount > 0) {
      const continueWithoutEmail = await confirm({
        title: 'Continue without invitation emails?',
        message:
          'Without invitations, you are responsible for distributing the Desktop App build and configuring each member environment so they can connect to this organization.',
        confirmLabel: 'I understand and wish to continue',
        cancelLabel: 'I want to send invitations',
      })
      if (!continueWithoutEmail) return
    }
    const actions = [
      newTeams.length > 0
        ? `create ${newTeams.length} team${newTeams.length === 1 ? '' : 's'}`
        : '',
      `create or update ${selectedMembers.length} member${selectedMembers.length === 1 ? '' : 's'}`,
      options.sendInvitations && newMemberCount > 0
        ? `send ${newMemberCount} invitation${newMemberCount === 1 ? '' : 's'}`
        : '',
    ].filter(Boolean)
    const approved = await confirm({
      title: 'Confirm Microsoft Teams import?',
      message: `You are about to ${actions.join(', ')}.`,
      confirmLabel: setup.status === 'importing' ? 'Continue import' : 'Confirm import',
    })
    if (approved) await runImport()
  }

  function canSelectStep(targetStep: number): boolean {
    return targetStep <= maxStep && !processing
  }

  const nextDisabled = saving || loadingDirectory || !canContinueFromStep()

  return (
    <div className="cu-agent-create-panel cu-agent-create-panel--with-header cu-ms-import">
      <div className="cu-agent-create-panel__header">
        <CreatePageHeader
          icon={<IconUsers />}
          title="Import from Microsoft Teams"
          subtitle="Connect a Microsoft organization, map teams, and invite Evenfire members."
          backLabel="Back to integrations"
          onBack={() => router.push(CONTROL_ROUTES.settings.microsoft)}
          backDisabled={processing}
          titleActions={
            <img
              className="cu-ms-import__brand"
              src="/brand/microsoft-teams.svg"
              alt="Microsoft Teams"
              width={24}
              height={24}
            />
          }
        />
      </div>

      <CreateStepFlow
        ariaLabel="Microsoft Teams integration steps"
        className="cu-create-step-flow--9"
        currentStep={step}
        onStepChange={setStep}
        canSelectStep={canSelectStep}
        steps={MICROSOFT_IMPORT_STEP_DETAILS}
        stepLabels={MICROSOFT_IMPORT_STEP_LABELS}
        titleId="microsoft-import-step-title"
      >
        {loading ? <div className="cu-muted">Loading Microsoft Teams setup...</div> : null}
        {!loading && step <= 5 ? (
          <MicrosoftSetupGuideSteps
            step={step}
            draft={draft}
            fallbackIntegrationName={fallbackIntegrationName}
            callbackUrl={callbackUrl}
            clientSecret={clientSecret}
            hasClientSecret={Boolean(setup?.hasClientSecret)}
            saving={saving}
            authorized={authorized}
            canAuthorize={canAuthorize}
            onDraftChange={mergeDraft}
            onClientSecretChange={setClientSecret}
            onBegin={() => void beginSetup()}
            onAuthorize={() => void authorizeMicrosoft()}
          />
        ) : null}

        {!loading && step === 6 && directory ? (
          <MicrosoftTeamsMappingStep
            directory={directory}
            teams={teams}
            duplicateTeamIds={duplicateTeamIds}
            onReplaceTeams={nextTeams => mergeDraft({ teams: nextTeams })}
            onUpdateTeam={updateTeam}
            onUpdateTeamDestination={updateTeamDestination}
            onAddManualTeam={addManualTeam}
          />
        ) : null}

        {!loading && step === 7 && directory ? (
          <MicrosoftMembersMappingStep
            directory={directory}
            teams={teams}
            members={members}
            onReplaceMembers={nextMembers => mergeDraft({ members: nextMembers })}
            onUpdateMember={updateMember}
          />
        ) : null}

        {!loading && step === 8 && directory ? (
          <MicrosoftImportReviewStep
            reviewTeams={reviewTeams}
            options={options}
            showCreateTeams={newTeams.length > 0}
            hasAssignedMembers={hasAssignedMembers}
            onUpdateOptions={updateOptions}
          />
        ) : null}

        {error ? <div className="cu-banner cu-banner--error">{error}</div> : null}

        {!loading && step > 0 ? (
          <div className="cu-create-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep(current => Math.max(0, current - 1))}
              disabled={saving || processing}
            >
              Back
            </Button>
            {step === 5 && !authorized ? null : step < 8 ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void continueStep()}
                disabled={nextDisabled || processing}
              >
                Continue
              </Button>
            ) : step === 8 ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void confirmImport()}
                disabled={
                  processing ||
                  selectedMembers.length === 0 ||
                  !options.createMembers ||
                  (newTeams.length > 0 && !options.createTeams)
                }
              >
                {setup?.status === 'importing' ? 'Continue creating and sending' : 'Confirm'}
              </Button>
            ) : null}
          </div>
        ) : null}
      </CreateStepFlow>

      {processing ? (
        <div className="cu-modal-backdrop cu-ms-import__progress-backdrop" role="presentation">
          <section
            className="cu-modal-panel cu-ms-import__progress-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="microsoft-import-progress-title"
          >
            <div className="cu-modal-panel__head">
              <h3 id="microsoft-import-progress-title" className="cu-modal-panel__title">
                Importing Microsoft Teams
              </h3>
            </div>
            <p className="cu-modal-copy">
              If you close Control UI, the process will pause after the current request. Return to
              this integration to continue.
            </p>
            <div className="cu-ms-import__progress-track" aria-label="Import progress">
              <span style={{ width: `${progress?.percent || 0}%` }} />
            </div>
            <strong>{progress?.percent || 0}%</strong>
            <span className="cu-muted">
              {progress?.stage === 'members'
                ? 'Creating members and sending invitations...'
                : 'Creating teams...'}
            </span>
          </section>
        </div>
      ) : null}
      {confirmDialog}
    </div>
  )
}
