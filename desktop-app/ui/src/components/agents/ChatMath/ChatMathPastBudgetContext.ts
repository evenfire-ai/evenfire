import { createContext } from 'react'

/** Keys of the formulas over their message's drawing budget. */
export const ChatMathPastBudgetContext = createContext<ReadonlySet<string>>(new Set())
