import {
  GFS_FIRST_PARTY_HOST_OPTION_VALUE,
  GFS_FIRST_PARTY_HOST_SUBJECT_ID,
} from '@constants/gfsGrantSubjects'
import type {
  AdminUser,
  GfsSubjectInput,
  HostResource,
  TeamListItem,
  WorkflowRecipeResource,
} from '@lib/api'
import type { GfsGrantSubjectOption, GfsGrantSubjectType } from './GfsGrantPanel.types'

function userLabel(user: AdminUser): string {
  return user.displayName || user.name || user.email
}

function teamLabel(team: TeamListItem): string {
  return team.name || team.id
}

function hostName(host: HostResource): string {
  return host.metadata?.name ?? 'unnamed-host'
}

function recipeName(recipe: WorkflowRecipeResource): string {
  return recipe.metadata?.name ?? 'unnamed-recipe'
}

function recipeNamespace(recipe: WorkflowRecipeResource): string {
  return recipe.metadata?.namespace ?? 'sandbox-recipes'
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
    }))
  }
  if (input.subjectType === 'team') {
    return input.teams.map(team => ({
      value: `team:${team.id}`,
      id: team.id,
      label: teamLabel(team),
      description: `${team.memberCount} ${team.memberCount === 1 ? 'member' : 'members'}`,
      badge: 'Team',
    }))
  }
  if (input.subjectType === 'firstPartyAgent') {
    return [
      {
        value: GFS_FIRST_PARTY_HOST_OPTION_VALUE,
        id: GFS_FIRST_PARTY_HOST_SUBJECT_ID,
        label: 'First-party agent runtime',
        description:
          input.hosts.length > 0
            ? `${input.hosts.length} active ${
                input.hosts.length === 1 ? 'agent' : 'agents'
              } share this runtime subject: ${input.hosts
                .map(hostName)
                .slice(0, 3)
                .join(', ')}${input.hosts.length > 3 ? ', ...' : ''}`
            : 'Shared runtime subject for HCC-provisioned first-party agents.',
        badge: 'Agent',
      },
    ]
  }
  if (input.subjectType === 'workflowPlugin') {
    return input.recipes.map(recipe => {
      const namespace = recipeNamespace(recipe)
      const name = recipeName(recipe)
      return {
        value: `host:3rd:${namespace}/${name}`,
        id: `3rd:${namespace}/${name}`,
        label: name,
        description: namespace,
        badge: 'Workflow',
      }
    })
  }
  return []
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
