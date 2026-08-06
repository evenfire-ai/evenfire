import { randomUUID } from 'node:crypto'
import { pool } from '../../db.js'
import {
  TeamNameConflictError,
  activateDeferredInvitation,
  createDeferredInvitationForTeams,
  createTeam,
  setTeamAgents,
  setTeamContexts,
} from '../directory/index.js'
import { registerAndSendInvitations } from '../invitationFlowRegistrationService.js'
import { loadMicrosoftDirectory } from './service.js'
import { getIdentityProviderSetupById, updateIdentityProviderSetup } from './setup.js'

const IMPORT_LEASE_DURATION = '5 minutes'
const IMPORT_LEASE_RENEW_INTERVAL_MS = 60_000

type TeamPlan = {
  id: string
  selected?: boolean
  manual?: boolean
  externalTeamId?: string | null
  existingTeamId?: string | null
  name?: string
  contextIds?: string[]
  agentNames?: string[]
}

type MemberPlan = {
  externalSubject: string
  selected?: boolean
  displayName?: string
  email: string
  userPrincipalName: string
  teamRefs?: string[]
}

type ImportOptions = {
  createTeams?: boolean
  createMembers?: boolean
  sendInvitations?: boolean
  allowMemberLogin?: boolean
}

type VerifiedMember = {
  email: string
  userPrincipalName: string
  displayName: string
}

type ImportExecution = {
  stage: 'teams' | 'members' | 'complete'
  teamIds: Record<string, string>
  createdTeamIds: string[]
  processedMemberSubjects: string[]
  createdMembers: number
  existingMembers: number
  invitationsSent: number
  verifiedMembers: Record<string, VerifiedMember>
  lastError?: string
}

export type MicrosoftImportExecutionResult = {
  complete: boolean
  stage: ImportExecution['stage']
  processed: number
  total: number
  percent: number
  createdTeams: number
  createdMembers: number
  existingMembers: number
  invitationsSent: number
  lastError: string | null
}

export async function renewMicrosoftImportLease(
  setupId: string,
  lockToken: string
): Promise<'renewed' | 'lost' | 'unknown'> {
  try {
    const renewed = await pool.query(
      `UPDATE identity_provider_setup_sessions
          SET import_lock_expires_at = NOW() + ($3::text)::interval,
              updated_at = NOW()
        WHERE id = $1
          AND import_lock_token = $2
        RETURNING id`,
      [setupId, lockToken, IMPORT_LEASE_DURATION]
    )
    return (renewed.rowCount ?? 0) === 1 ? 'renewed' : 'lost'
  } catch {
    // A transient database error does not prove another executor owns the
    // lease. The heartbeat must retry; only a successful zero-row update
    // establishes token loss.
    return 'unknown'
  }
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === 'object' && !Array.isArray(item)
      )
    : []
}

function strings(value: unknown): string[] {
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean)
    )
  )
}

function teamPlans(value: unknown): TeamPlan[] {
  return records(value)
    .map(item => ({
      id: String(item.id || '').trim(),
      selected: item.selected !== false,
      manual: item.manual === true,
      externalTeamId: String(item.externalTeamId || '').trim() || null,
      existingTeamId: String(item.existingTeamId || '').trim() || null,
      name: String(item.name || '').trim(),
      contextIds: strings(item.contextIds),
      agentNames: strings(item.agentNames),
    }))
    .filter(item => item.id && item.selected)
}

function memberPlans(value: unknown): MemberPlan[] {
  return records(value)
    .map(item => ({
      externalSubject: String(item.externalSubject || '').trim(),
      selected: item.selected !== false,
      displayName: String(item.displayName || '').trim(),
      email: String(item.email || '')
        .trim()
        .toLowerCase(),
      userPrincipalName: String(item.userPrincipalName || '')
        .trim()
        .toLowerCase(),
      teamRefs: strings(item.teamRefs),
    }))
    .filter(item => item.externalSubject && item.email && item.userPrincipalName && item.selected)
}

function importOptions(value: unknown): ImportOptions {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    createTeams: row.createTeams !== false,
    createMembers: row.createMembers !== false,
    sendInvitations: row.sendInvitations !== false,
    allowMemberLogin: row.allowMemberLogin !== false,
  }
}

function executionState(value: Record<string, unknown>): ImportExecution {
  const stage = ['teams', 'members', 'complete'].includes(String(value.stage))
    ? (String(value.stage) as ImportExecution['stage'])
    : 'teams'
  const rawTeamIds =
    value.teamIds && typeof value.teamIds === 'object' && !Array.isArray(value.teamIds)
      ? (value.teamIds as Record<string, unknown>)
      : {}
  const rawVerifiedMembers =
    value.verifiedMembers &&
    typeof value.verifiedMembers === 'object' &&
    !Array.isArray(value.verifiedMembers)
      ? (value.verifiedMembers as Record<string, unknown>)
      : {}
  return {
    stage,
    teamIds: Object.fromEntries(
      Object.entries(rawTeamIds)
        .map(([key, item]) => [key, String(item || '').trim()])
        .filter(([, item]) => Boolean(item))
    ),
    createdTeamIds: strings(value.createdTeamIds),
    processedMemberSubjects: strings(value.processedMemberSubjects),
    createdMembers: Number(value.createdMembers || 0),
    existingMembers: Number(value.existingMembers || 0),
    invitationsSent: Number(value.invitationsSent || 0),
    verifiedMembers: Object.fromEntries(
      Object.entries(rawVerifiedMembers).flatMap(([externalSubject, item]) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return []
        const member = item as Record<string, unknown>
        const email = String(member.email || '')
          .trim()
          .toLowerCase()
        const userPrincipalName = String(member.userPrincipalName || '')
          .trim()
          .toLowerCase()
        if (!email || !userPrincipalName) return []
        return [
          [
            externalSubject,
            {
              email,
              userPrincipalName,
              displayName: String(member.displayName || '').trim() || email,
            },
          ],
        ]
      })
    ),
    lastError: String(value.lastError || '') || undefined,
  }
}

async function ensureVerifiedMemberSnapshot(
  connectionId: string,
  plans: MemberPlan[],
  execution: ImportExecution
): Promise<ImportExecution> {
  if (plans.every(plan => execution.verifiedMembers[plan.externalSubject])) return execution

  const directory = await loadMicrosoftDirectory(connectionId)
  const availableUsers = new Map(
    directory.users.filter(user => user.accountEnabled).map(user => [user.id, user])
  )
  const verifiedMembers: Record<string, VerifiedMember> = {}
  for (const plan of plans) {
    const user = availableUsers.get(plan.externalSubject)
    if (!user) {
      throw Object.assign(new Error('A selected Microsoft member is unavailable'), { status: 409 })
    }
    verifiedMembers[plan.externalSubject] = {
      email: user.email.trim().toLowerCase(),
      userPrincipalName: user.userPrincipalName.trim().toLowerCase(),
      displayName: user.displayName.trim() || user.email,
    }
  }
  return { ...execution, verifiedMembers }
}

async function resolveTeam(
  plan: TeamPlan,
  allowCreate: boolean,
  resolvedByName: Map<string, string>
): Promise<{ teamId: string; created: boolean }> {
  if (plan.existingTeamId) {
    const existing = await pool.query(`SELECT id FROM teams WHERE id = $1 LIMIT 1`, [
      plan.existingTeamId,
    ])
    if ((existing.rowCount ?? 0) === 0) throw new Error(`Evenfire team not found: ${plan.name}`)
    return { teamId: plan.existingTeamId, created: false }
  }
  const name = String(plan.name || '').trim()
  if (!name) throw new Error('Every selected team needs an Evenfire team name')
  const normalizedName = name.toLowerCase()
  const alreadyResolved = resolvedByName.get(normalizedName)
  if (alreadyResolved) return { teamId: alreadyResolved, created: false }
  const existing = await pool.query(
    `SELECT id FROM teams WHERE LOWER(BTRIM(name)) = LOWER(BTRIM($1)) LIMIT 1`,
    [name]
  )
  const existingId = String((existing.rows[0] as { id?: string } | undefined)?.id || '')
  if (existingId) {
    resolvedByName.set(normalizedName, existingId)
    return { teamId: existingId, created: false }
  }
  if (!allowCreate) throw new Error(`Create teams must be confirmed before creating ${name}`)
  let teamId: string
  let created = true
  try {
    teamId = String((await createTeam(name)).id)
  } catch (error) {
    if (!(error instanceof TeamNameConflictError)) throw error
    const concurrent = await pool.query(
      `SELECT id FROM teams WHERE LOWER(BTRIM(name)) = LOWER(BTRIM($1)) LIMIT 1`,
      [name]
    )
    teamId = String((concurrent.rows[0] as { id?: string } | undefined)?.id || '')
    if (!teamId) throw error
    created = false
  }
  resolvedByName.set(normalizedName, teamId)
  return { teamId, created }
}

async function applyTeamStage(input: {
  connectionId: string
  plans: TeamPlan[]
  options: ImportOptions
  execution: ImportExecution
  allowedAgentNames: ReadonlySet<string>
  allowedContextIds: ReadonlySet<string>
  operatorSub: string
}): Promise<ImportExecution> {
  const teamIds = { ...input.execution.teamIds }
  const createdTeamIds = new Set(input.execution.createdTeamIds)
  const resolvedByName = new Map<string, string>()
  const accessByTeamId = new Map<string, { contextIds: Set<string>; agentNames: Set<string> }>()

  for (const plan of input.plans) {
    let teamId = teamIds[plan.id]
    if (!teamId) {
      const resolved = await resolveTeam(plan, input.options.createTeams !== false, resolvedByName)
      teamId = resolved.teamId
      teamIds[plan.id] = teamId
      if (resolved.created) createdTeamIds.add(teamId)
    }
    const access = accessByTeamId.get(teamId) || {
      contextIds: new Set<string>(),
      agentNames: new Set<string>(),
    }
    for (const contextId of plan.contextIds || []) {
      if (input.allowedContextIds.has(contextId)) access.contextIds.add(contextId)
    }
    for (const agentName of plan.agentNames || []) {
      if (input.allowedAgentNames.has(agentName)) access.agentNames.add(agentName)
    }
    accessByTeamId.set(teamId, access)
    if (plan.externalTeamId) {
      await pool.query(
        `INSERT INTO identity_provider_team_mappings(
           connection_id, external_team_id, team_id, external_display_name
         )
         VALUES($1, $2, $3, $4)
         ON CONFLICT (connection_id, external_team_id)
         DO UPDATE SET team_id = EXCLUDED.team_id,
                       external_display_name = EXCLUDED.external_display_name,
                       updated_at = NOW()`,
        [input.connectionId, plan.externalTeamId, teamId, plan.name || 'Microsoft Team']
      )
    }
  }

  for (const [teamId, access] of accessByTeamId) {
    await setTeamContexts(teamId, Array.from(access.contextIds), input.operatorSub)
    await setTeamAgents(teamId, Array.from(access.agentNames), input.operatorSub)
  }

  return {
    ...input.execution,
    stage: 'members',
    teamIds,
    createdTeamIds: Array.from(createdTeamIds),
    lastError: undefined,
  }
}

async function upsertImportedMember(input: {
  connectionId: string
  externalSubject: string
  email: string
  userPrincipalName: string
  displayName: string
  teamIds: string[]
  allowMemberLogin: boolean
}): Promise<{ userId: string; existing: boolean }> {
  const [linkedIdentity, existingEmail] = await Promise.all([
    pool.query(
      `SELECT user_id
         FROM identity_provider_identities
        WHERE connection_id = $1 AND external_subject = $2
        LIMIT 1`,
      [input.connectionId, input.externalSubject]
    ),
    pool.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [input.email]),
  ])
  const linkedUserId = String(
    (linkedIdentity.rows[0] as { user_id?: string } | undefined)?.user_id || ''
  )
  const emailMatchedUserId = String(
    (existingEmail.rows[0] as { id?: string } | undefined)?.id || ''
  )
  const existingId = linkedUserId || emailMatchedUserId
  const userResult = existingId
    ? await pool.query(
        `UPDATE users
            SET name = $2, updated_at = NOW()
          WHERE id = $1
        RETURNING id`,
        [existingId, input.displayName || null]
      )
    : await pool.query(`INSERT INTO users(email, name) VALUES($1, $2) RETURNING id`, [
        input.email,
        input.displayName || null,
      ])
  const userId = String((userResult.rows[0] as { id: string }).id)
  await pool.query(
    `INSERT INTO profiles(user_id, display_name)
     VALUES($1, $2)
     ON CONFLICT (user_id)
     DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = NOW()`,
    [userId, input.displayName || null]
  )
  for (const teamId of input.teamIds) {
    await pool.query(
      `INSERT INTO team_members(team_id, user_id, role, status)
       VALUES($1, $2, 'member', 'active')
       ON CONFLICT (team_id, user_id)
       DO UPDATE SET status = 'active', updated_at = NOW()`,
      [teamId, userId]
    )
  }
  // An email match alone is not proof that the Microsoft account owns an
  // existing Evenfire account. Existing accounts are updated and assigned to
  // teams, but identity linking remains invitation-backed unless the subject
  // was already linked. Newly created users can be linked directly because the
  // import created both sides of the relationship in this operation.
  if (input.allowMemberLogin && (!emailMatchedUserId || Boolean(linkedUserId))) {
    const identity = await pool.query(
      `INSERT INTO identity_provider_identities(
         provider, connection_id, user_id, external_subject, email,
         user_principal_name, display_name
       )
       VALUES('microsoft', $1, $2, $3, $4, $5, $6)
       ON CONFLICT (connection_id, external_subject)
       DO UPDATE SET email = EXCLUDED.email,
                     user_principal_name = EXCLUDED.user_principal_name,
                     display_name = EXCLUDED.display_name
       WHERE identity_provider_identities.user_id = EXCLUDED.user_id
       RETURNING user_id`,
      [
        input.connectionId,
        userId,
        input.externalSubject,
        input.email,
        input.userPrincipalName,
        input.displayName,
      ]
    )
    if ((identity.rowCount ?? 0) !== 1) {
      throw Object.assign(new Error('Microsoft identity is already linked to another member'), {
        status: 409,
      })
    }
  }
  return { userId, existing: Boolean(existingId) }
}

async function existingImportInvitation(connectionId: string, externalSubject: string) {
  const result = await pool.query(
    `SELECT i.id, i.token, i.email, i.status, i.created_at, i.expires_at,
            COALESCE(
              ARRAY_AGG(DISTINCT t.name) FILTER (WHERE t.name IS NOT NULL),
              ARRAY[]::TEXT[]
            ) AS team_names
       FROM invitations i
  LEFT JOIN invitation_teams it ON it.invitation_id = i.id
  LEFT JOIN teams t ON t.id = COALESCE(it.team_id, i.team_id)
      WHERE i.identity_provider_connection_id = $1
        AND i.identity_provider_subject = $2
        AND i.status IN ('draft', 'pending')
   GROUP BY i.id
   ORDER BY CASE i.status WHEN 'pending' THEN 0 ELSE 1 END, i.created_at DESC
      LIMIT 1`,
    [connectionId, externalSubject]
  )
  return (
    (result.rows[0] as
      | {
          id: string
          token: string
          email: string
          status: 'draft' | 'pending'
          created_at: Date
          expires_at: Date
          team_names: string[]
        }
      | undefined) || null
  )
}

async function applyMemberChunk(input: {
  connectionId: string
  plans: MemberPlan[]
  options: ImportOptions
  execution: ImportExecution
}): Promise<ImportExecution> {
  const processed = new Set(input.execution.processedMemberSubjects)
  const chunk = input.plans.filter(plan => !processed.has(plan.externalSubject)).slice(0, 10)
  const deliveries: Array<{
    invitationId: string
    externalSubject: string
    email: string
    invitationUuid: string
    teamName: string | null
    teamNames: string[]
    purpose: 'member_invitation'
    issuedAt: string
    expiresAt: string
    existingMember: boolean
  }> = []
  let createdMembers = input.execution.createdMembers
  let existingMembers = input.execution.existingMembers
  let invitationsSent = input.execution.invitationsSent

  for (const plan of chunk) {
    const verifiedMember = input.execution.verifiedMembers[plan.externalSubject]
    if (!verifiedMember) {
      throw Object.assign(new Error('Microsoft member verification is missing'), { status: 409 })
    }
    const teamIds = Array.from(
      new Set((plan.teamRefs || []).map(teamRef => input.execution.teamIds[teamRef] || teamRef))
    ).filter(Boolean)
    const [existing, linkedIdentity] = await Promise.all([
      pool.query(`SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`, [
        verifiedMember.email,
      ]),
      pool.query(
        `SELECT user_id
           FROM identity_provider_identities
          WHERE connection_id = $1
            AND external_subject = $2
          LIMIT 1`,
        [input.connectionId, plan.externalSubject]
      ),
    ])
    const isExisting = (existing.rowCount ?? 0) > 0
    const isLinked = (linkedIdentity.rowCount ?? 0) > 0

    if (isLinked || !input.options.sendInvitations) {
      const result = await upsertImportedMember({
        connectionId: input.connectionId,
        externalSubject: plan.externalSubject,
        email: verifiedMember.email,
        userPrincipalName: verifiedMember.userPrincipalName,
        displayName: plan.displayName || verifiedMember.displayName,
        teamIds,
        allowMemberLogin: input.options.allowMemberLogin !== false,
      })
      if (result.existing) existingMembers += 1
      else createdMembers += 1
      processed.add(plan.externalSubject)
      continue
    }

    let invitation = await existingImportInvitation(input.connectionId, plan.externalSubject)
    if (invitation?.status === 'pending') {
      processed.add(plan.externalSubject)
      invitationsSent += 1
      if (isExisting) existingMembers += 1
      else createdMembers += 1
      continue
    }
    if (!invitation) {
      try {
        const prepared = await createDeferredInvitationForTeams({
          inviteeName: plan.displayName || verifiedMember.displayName,
          email: verifiedMember.email,
          teamAssignments: teamIds.map(teamId => ({ teamId, role: 'member' })),
          fallbackRole: 'member',
          identityProvider: {
            provider: 'microsoft',
            connectionId: input.connectionId,
            subject: plan.externalSubject,
            userPrincipalName: verifiedMember.userPrincipalName,
          },
        })
        invitation = {
          id: prepared.id,
          token: prepared.token,
          email: prepared.email,
          status: 'draft',
          created_at: prepared.created_at,
          expires_at: prepared.expires_at,
          team_names: prepared.teams.map(team => team.name),
        }
      } catch (error) {
        if (String((error as { code?: unknown } | null)?.code || '') !== '23505') throw error
        invitation = await existingImportInvitation(input.connectionId, plan.externalSubject)
        if (!invitation) throw error
      }
    }
    deliveries.push({
      invitationId: invitation.id,
      externalSubject: plan.externalSubject,
      email: invitation.email,
      invitationUuid: invitation.token,
      teamName: invitation.team_names[0] || null,
      teamNames: invitation.team_names,
      purpose: 'member_invitation',
      issuedAt: invitation.created_at.toISOString(),
      expiresAt: invitation.expires_at.toISOString(),
      existingMember: isExisting,
    })
  }

  let lastError: string | undefined
  if (deliveries.length > 0) {
    const response = await registerAndSendInvitations(deliveries)
    const resultByInvitation = new Map(
      response.results.map(result => [result.invitationUuid, result])
    )
    for (const delivery of deliveries) {
      const result = resultByInvitation.get(delivery.invitationUuid)
      if (!result?.sent) {
        lastError = result?.error || 'Invitation delivery failed'
        continue
      }
      await activateDeferredInvitation(delivery.invitationId)
      processed.add(delivery.externalSubject)
      invitationsSent += 1
      if (delivery.existingMember) existingMembers += 1
      else createdMembers += 1
    }
  }

  return {
    ...input.execution,
    stage: processed.size >= input.plans.length ? 'complete' : 'members',
    processedMemberSubjects: Array.from(processed),
    createdMembers,
    existingMembers,
    invitationsSent,
    lastError,
  }
}

function resultFor(
  execution: ImportExecution,
  teamCount: number,
  memberCount: number
): MicrosoftImportExecutionResult {
  const processed =
    (execution.stage === 'teams' ? 0 : teamCount) + execution.processedMemberSubjects.length
  const total = teamCount + memberCount
  return {
    complete: execution.stage === 'complete',
    stage: execution.stage,
    processed,
    total,
    percent: total === 0 ? 100 : Math.min(100, Math.round((processed / total) * 100)),
    createdTeams: execution.createdTeamIds.length,
    createdMembers: execution.createdMembers,
    existingMembers: execution.existingMembers,
    invitationsSent: execution.invitationsSent,
    lastError: execution.lastError || null,
  }
}

async function executeMicrosoftImportLocked(input: {
  setupId: string
  allowedAgentNames: ReadonlySet<string>
  allowedContextIds: ReadonlySet<string>
  operatorSub: string
}): Promise<MicrosoftImportExecutionResult> {
  const setup = await getIdentityProviderSetupById(input.setupId)
  if (!setup?.connectionId || !['configuring', 'importing'].includes(setup.status))
    throw Object.assign(new Error('Microsoft setup is not authorized'), { status: 409 })
  const teams = teamPlans(setup.draft.teams)
  const members = memberPlans(setup.draft.members)
  const options = importOptions(setup.draft.options)
  if (options.createMembers === false) {
    throw Object.assign(new Error('Create members must be confirmed'), { status: 409 })
  }
  let execution = executionState(setup.execution)

  if (execution.stage !== 'complete' && members.length > 0) {
    execution = await ensureVerifiedMemberSnapshot(setup.connectionId, members, execution)
  }

  await pool.query(
    `UPDATE identity_provider_connections
        SET allow_member_login = $2, updated_at = NOW()
      WHERE id = $1`,
    [setup.connectionId, options.allowMemberLogin !== false]
  )

  if (execution.stage === 'teams') {
    execution = await applyTeamStage({
      connectionId: setup.connectionId,
      plans: teams,
      options,
      execution,
      allowedAgentNames: input.allowedAgentNames,
      allowedContextIds: input.allowedContextIds,
      operatorSub: input.operatorSub,
    })
  } else if (execution.stage === 'members') {
    execution = await applyMemberChunk({
      connectionId: setup.connectionId,
      plans: members,
      options,
      execution,
    })
  }

  if (execution.stage === 'complete') {
    const domains = Array.from(
      new Set(
        Object.values(execution.verifiedMembers)
          .map(member => member.email.split('@')[1]?.trim().toLowerCase() || '')
          .filter(Boolean)
      )
    )
    await pool.query(
      `UPDATE identity_provider_connections
          SET allow_member_login = $2,
              allowed_email_domains = $3::text[],
              updated_at = NOW()
        WHERE id = $1`,
      [setup.connectionId, options.allowMemberLogin !== false, domains]
    )
    await updateIdentityProviderSetup({
      setupId: setup.id,
      currentStep: 9,
      status: 'completed',
      execution,
    })
  } else {
    await updateIdentityProviderSetup({
      setupId: setup.id,
      currentStep: 9,
      status: 'importing',
      execution,
    })
  }

  return resultFor(execution, teams.length, members.length)
}

export async function executeMicrosoftImport(input: {
  setupId: string
  allowedAgentNames: ReadonlySet<string>
  allowedContextIds: ReadonlySet<string>
  operatorSub: string
}): Promise<MicrosoftImportExecutionResult> {
  const lockToken = randomUUID()
  const claimed = await pool.query(
    `UPDATE identity_provider_setup_sessions
        SET import_lock_token = $2,
            import_lock_expires_at = NOW() + ($3::text)::interval,
            updated_at = NOW()
      WHERE id = $1
        AND status IN ('configuring', 'importing')
        AND (import_lock_token IS NULL OR import_lock_expires_at < NOW())
      RETURNING id`,
    [input.setupId, lockToken, IMPORT_LEASE_DURATION]
  )
  if ((claimed.rowCount ?? 0) !== 1) {
    throw Object.assign(new Error('Microsoft import is already running'), { status: 409 })
  }
  let renewalRunning = false
  let leaseLost = false
  const renewLease = async () => {
    if (renewalRunning || leaseLost) return
    renewalRunning = true
    try {
      leaseLost = (await renewMicrosoftImportLease(input.setupId, lockToken)) === 'lost'
    } finally {
      renewalRunning = false
    }
  }
  const renewalTimer = setInterval(() => void renewLease(), IMPORT_LEASE_RENEW_INTERVAL_MS)
  renewalTimer.unref()
  try {
    const result = await executeMicrosoftImportLocked(input)
    if (leaseLost) {
      throw Object.assign(new Error('Microsoft import lease was lost'), { status: 409 })
    }
    return result
  } finally {
    clearInterval(renewalTimer)
    await pool.query(
      `UPDATE identity_provider_setup_sessions
          SET import_lock_token = NULL,
              import_lock_expires_at = NULL,
              updated_at = NOW()
        WHERE id = $1
          AND import_lock_token = $2`,
      [input.setupId, lockToken]
    )
  }
}
