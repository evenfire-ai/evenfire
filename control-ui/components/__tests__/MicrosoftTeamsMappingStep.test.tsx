import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MicrosoftTeamsMappingStep } from '../MicrosoftTeamsImportWizard/MappingSteps'
import type {
  MicrosoftDirectoryResponse,
  MicrosoftSetupTeamDraft,
} from '../MicrosoftTeamsImportWizard/types'

function directoryFixture(): MicrosoftDirectoryResponse {
  return {
    users: [],
    teams: [],
    evenfireTeams: [
      { id: 'team-operations', name: 'Operations', memberCount: 4 },
      { id: 'team-support', name: 'Support', memberCount: 2 },
    ],
    agents: [],
    contexts: [],
    teamAgents: {},
    teamContexts: {},
  }
}

function manualTeamFixture(): MicrosoftSetupTeamDraft {
  return {
    id: 'manual:team-1',
    selected: true,
    manual: true,
    externalTeamId: null,
    externalTeamName: null,
    existingTeamId: null,
    name: 'New launch team',
    contextIds: [],
    agentNames: [],
  }
}

afterEach(() => {
  cleanup()
})

describe('MicrosoftTeamsMappingStep', () => {
  it('opens existing Evenfire teams from a free-text destination field', () => {
    const onUpdateTeamDestination = vi.fn()

    render(
      <MicrosoftTeamsMappingStep
        directory={directoryFixture()}
        teams={[manualTeamFixture()]}
        duplicateTeamIds={new Set()}
        onReplaceTeams={vi.fn()}
        onUpdateTeam={vi.fn()}
        onUpdateTeamDestination={onUpdateTeamDestination}
        onAddManualTeam={vi.fn()}
      />
    )

    fireEvent.focus(screen.getByRole('combobox', { name: 'Evenfire team for manual team' }))
    fireEvent.click(screen.getByRole('option', { name: /Operations.*4 members/ }))

    expect(onUpdateTeamDestination).toHaveBeenCalledWith('manual:team-1', 'Operations')
  })
})
