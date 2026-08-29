export type TourStepId = 'welcome' | 'agents' | 'files' | 'mcpServers' | 'apps' | 'handoff'

/**
 * The tour, in order, for every user.
 *
 * Deliberately fixed rather than selected from what the user happens to have.
 * Each card carries commissioned artwork, so a card only some environments
 * reach is artwork most people never see, and a deck whose length moved with
 * the environment could not be designed or reviewed as one piece.
 *
 * Adding a step means commissioning its illustration. Copy still adapts to the
 * user — the agent card names their agent, and the last card changes when no
 * agent has been shared with them yet — but the deck itself does not.
 */
export const TOUR_STEPS: readonly TourStepId[] = [
  'welcome',
  'agents',
  'files',
  'mcpServers',
  'apps',
  'handoff',
]
