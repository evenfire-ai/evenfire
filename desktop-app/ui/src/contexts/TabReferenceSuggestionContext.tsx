import { createContext, useContext } from 'react'
import type { TabReferenceSuggestionValue } from './TabReferenceSuggestionContext.types'

// Inert by default: only the drawer's chat sits beside the tab whose file is
// suggested, so every other composer (the full-page chat, tests) offers none.
const inertTabReferenceSuggestion: TabReferenceSuggestionValue = {
  candidate: null,
  accept: () => 'duplicate',
}

const TabReferenceSuggestionContext = createContext<TabReferenceSuggestionValue>(
  inertTabReferenceSuggestion
)

export function useTabReferenceSuggestionContext(): TabReferenceSuggestionValue {
  return useContext(TabReferenceSuggestionContext)
}

export { TabReferenceSuggestionContext }
