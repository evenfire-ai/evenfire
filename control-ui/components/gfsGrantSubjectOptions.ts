import type {
  AdminUser,
  GfsSubjectInput,
  HostResource,
  TeamListItem,
  WorkflowRecipeResource,
} from '@lib/api'
import type {
  GfsBulkSubjectInput,
  GfsGrantSubjectOption,
  GfsGrantSubjectType,
} from './GfsGrantPanel.types'

function userLabel(user: AdminUser): string {
  return user.displayName || user.name || user.email
}

function teamLabel(team: TeamListItem): string {
  return team.name || team.id
}

function hostLifecycleLabel(host: HostResource): 'Stateful' | 'Stateless' {
  return host.spec?.lifecycle?.stateless === true ? 'Stateless' : 'Stateful'
}

export function gfsGrantSubjectFieldLabel(subjectType: GfsGrantSubjectType): string {
  if (subjectType === 'team') return 'Team'
  if (subjectType === 'firstPartyAgent') return 'First-party agent'
  if (subjectType === 'workflowPlugin') return 'Workflow / plugin'
  return 'User'
}

export function gfsGrantSubjectSearchPlaceholder(subjectType: GfsGrantSubjectType): string {
  if (subjectType === 'workflowPlugin') return 'Search workflows or plugins...'
  return `Search ${gfsGrantSubjectFieldLabel(subjectType).toLowerCase()}s...`
}

export function gfsGrantSubjectPlaceholder(
  subjectType: GfsGrantSubjectType,
  loading: boolean
): string {
  const label = gfsGrantSubjectFieldLabel(subjectType).toLowerCase()
  return loading ? `Loading ${label} options...` : `Choose a ${label}`
}

export function buildGfsGrantSubjectOptions(input: {
  subjectType: GfsGrantSubjectType
  users: AdminUser[]
  teams: TeamListItem[]
  hosts: HostResource[]
  recipes: WorkflowRecipeResource[]
}): GfsGrantSubjectOption[] {
  if (input.subjectType === 'user') {
    return input.users.map(user => ({
      value: `user:${user.id}`,
      id: user.id,
      label: userLabel(user),
      description: user.email,
      badge: 'User',
      subject: { type: 'user', id: user.id },
    }))
  }
  if (input.subjectType === 'team') {
    return input.teams.map(team => ({
      value: `team:${team.id}`,
      id: team.id,
      label: teamLabel(team),
      description: `${team.memberCount} ${team.memberCount === 1 ? 'member' : 'members'}`,
      badge: 'Team',
      subject: { type: 'team', id: team.id },
    }))
  }
  if (input.subjectType === 'firstPartyAgent') {
    return input.hosts.flatMap(host => {
      const name = host.metadata?.name?.trim()
      const namespace = host.metadata?.namespace?.trim()
      if (!namespace || !name) return []
      const lifecycle = hostLifecycleLabel(host)
      const id = `1st:${namespace}/${name}`
      return [
        {
          value: `host:${id}`,
          id,
          label: `${name} (${lifecycle})`,
          description: `${namespace} · ${lifecycle.toLowerCase()} first-party MCP host`,
          badge: 'Agent',
          subject: { type: 'host', id },
        },
      ]
    })
  }
  if (input.subjectType === 'workflowPlugin') {
    return input.recipes.flatMap(recipe => {
      const namespace = recipe.metadata?.namespace?.trim()
      const name = recipe.metadata?.name?.trim()
      if (!namespace || !name) return []
      const id = `3rd:${namespace}/${name}`
      return [
        {
          value: `host:${id}`,
          id,
          label: name,
          description: namespace,
          badge: 'Workflow',
          subject: { type: 'host', id },
        },
      ]
    })
  }
  return []
}

export function buildGfsBulkSubjectOptions(input: {
  users: AdminUser[]
  teams: TeamListItem[]
  hosts: HostResource[]
  recipes: WorkflowRecipeResource[]
}): GfsGrantSubjectOption[] {
  return [
    ...buildGfsGrantSubjectOptions({ ...input, subjectType: 'user' }),
    ...buildGfsGrantSubjectOptions({ ...input, subjectType: 'team' }),
    ...buildGfsGrantSubjectOptions({ ...input, subjectType: 'firstPartyAgent' }),
    ...buildGfsGrantSubjectOptions({ ...input, subjectType: 'workflowPlugin' }),
  ]
}

export function toGfsBulkSubjectInputs(options: GfsGrantSubjectOption[]): GfsBulkSubjectInput[] {
  return options.map(option => option.subject)
}

export function summarizeGfsBulkSubjectTypes(subjects: GfsBulkSubjectInput[]): string {
  const counts = subjects.reduce(
    (summary, subject) => ({ ...summary, [subject.type]: summary[subject.type] + 1 }),
    { user: 0, team: 0, host: 0 }
  )
  return (['user', 'team', 'host'] as const)
    .filter(type => counts[type] > 0)
    .map(type => `${counts[type]} ${type}${counts[type] === 1 ? '' : 's'}`)
    .join(', ')
}

export function toGfsSubjectInput(
  subjectType: GfsGrantSubjectType,
  selectedSubject: GfsGrantSubjectOption | null
): GfsSubjectInput {
  if (subjectType === 'operator') return { type: 'operator' }
  if (!selectedSubject) throw new Error('subject_required')
  if (subjectType === 'firstPartyAgent' || subjectType === 'workflowPlugin') {
    return { type: 'host', id: selectedSubject.id }
  }
  return { type: subjectType, id: selectedSubject.id }
}
