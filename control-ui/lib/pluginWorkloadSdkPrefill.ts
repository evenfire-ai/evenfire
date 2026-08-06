/**
 * Decide whether an asynchronous recipe-prefill response may update the
 * operator's recipient selection. A response is stale when a newer recipe
 * selection has been made, and it is never allowed to overwrite an explicit
 * recipient edit made while the request was pending.
 */
export function shouldApplyRecipePrefill(
  requestId: number,
  currentRequestId: number,
  recipientsEdited: boolean
): boolean {
  return requestId === currentRequestId && !recipientsEdited
}
