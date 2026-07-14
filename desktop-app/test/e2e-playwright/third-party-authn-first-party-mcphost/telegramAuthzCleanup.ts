import {
  removeFakeTelegramProvider,
  removeTelegramCommunicationChannel,
  restoreChannelReaderTelegramApiRoot,
} from './fakeTelegramProvider'
import type { TelegramClientIdentity } from './telegramE2eClient'
import {
  cleanupE2ETeam,
  cleanupTelegramMediumBinding,
  cleanupWorkflowRecipe,
} from './workflowApprovalJourney'

export function cleanupTelegramAuthzFixture(params: {
  recipeNames: string[]
  teamIds: Array<string | undefined>
  identities: TelegramClientIdentity[]
}): void {
  for (const recipeName of params.recipeNames) {
    cleanupWorkflowRecipe(recipeName)
  }
  for (const teamId of params.teamIds) {
    cleanupE2ETeam(teamId)
  }
  removeTelegramCommunicationChannel()
  restoreChannelReaderTelegramApiRoot()
  removeFakeTelegramProvider()
  for (const identity of params.identities) {
    cleanupTelegramMediumBinding(identity)
  }
}
