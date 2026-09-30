export type GfsLoadToken =
  | { kind: 'foreground'; navigationSequence: number; backgroundSequenceAtStart: number }
  | { kind: 'background'; navigationSequence: number; backgroundSequence: number }

/** Decide whether a list response still owns the visible folder state. */
export function isCurrentGfsLoad(
  token: GfsLoadToken,
  currentNavigationSequence: number,
  currentBackgroundSequence: number
): boolean {
  return token.kind === 'background'
    ? token.navigationSequence === currentNavigationSequence &&
        token.backgroundSequence === currentBackgroundSequence
    : token.navigationSequence === currentNavigationSequence
}
