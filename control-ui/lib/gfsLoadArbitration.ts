export type GfsLoadToken =
  | { kind: 'foreground'; navigationSequence: number; backgroundSequenceAtStart: number }
  | { kind: 'background'; navigationSequence: number; backgroundSequence: number }

/** Own the sequence rules for foreground navigation and soft stream refreshes. */
export class GfsLoadArbiter {
  private navigationSequence = 0
  private backgroundSequence = 0

  beginForeground(): GfsLoadToken {
    this.navigationSequence += 1
    return {
      kind: 'foreground',
      navigationSequence: this.navigationSequence,
      backgroundSequenceAtStart: this.backgroundSequence,
    }
  }

  beginBackground(): GfsLoadToken {
    this.backgroundSequence += 1
    return {
      kind: 'background',
      navigationSequence: this.navigationSequence,
      backgroundSequence: this.backgroundSequence,
    }
  }

  /** A committed stream state supersedes older background reads, not user work. */
  beginStreamRevalidation(): void {
    this.backgroundSequence += 1
  }

  isCurrent(token: GfsLoadToken): boolean {
    return isCurrentGfsLoad(token, this.navigationSequence, this.backgroundSequence)
  }
}

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
