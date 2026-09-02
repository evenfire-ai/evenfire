import type { AccessSectionDefinition } from './types'

export const WORKFLOW_ACCESS_SECTIONS: AccessSectionDefinition[] = [
  {
    key: 'trigger-users',
    title: 'Members',
    description: 'Members authorized to trigger this workflow directly from Desktop App.',
    pickLabel: 'Pick a user to grant trigger access',
    emptyCreate: 'No members selected. Add members before deploy, or grant access later from Edit.',
    emptyEdit: 'No members have trigger access yet.',
    grantLabel: 'Add member',
    revokeLabel: 'Remove member trigger access',
    entityKind: 'user',
  },
  {
    key: 'trigger-teams',
    title: 'Teams',
    description:
      'Teams whose active members can trigger this workflow in the matching connector scope.',
    pickLabel: 'Pick a team to grant trigger access',
    emptyCreate: 'No teams selected for trigger access.',
    emptyEdit: 'No teams have trigger access yet.',
    grantLabel: 'Add team',
    revokeLabel: 'Remove team trigger access',
    entityKind: 'team',
  },
  {
    key: 'approval-target-teams',
    title: 'Approval target teams',
    description: 'Teams that can receive and decide workflow approval requests for this recipe.',
    pickLabel: 'Pick a team to allow as approval target',
    emptyCreate: 'No approval target teams selected.',
    emptyEdit: 'No teams are allowed as approval targets yet.',
    grantLabel: 'Allow team',
    revokeLabel: 'Remove approval target team',
    entityKind: 'team',
  },
]
