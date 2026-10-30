/** One execution owns feedback; any number of continuations may await its promise. */
export function runChatSwitchRequest(
  execute: () => Promise<void>,
  isCurrent: () => boolean,
  onCurrentError: (error: unknown) => void
): Promise<void> {
  return execute().catch(error => {
    if (isCurrent()) onCurrentError(error)
    throw error
  })
}
