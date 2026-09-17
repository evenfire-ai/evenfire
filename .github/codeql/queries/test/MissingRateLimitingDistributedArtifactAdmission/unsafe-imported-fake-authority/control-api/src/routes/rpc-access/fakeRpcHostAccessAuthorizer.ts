export async function authorizeRpcHostAccess(
  _gateway: unknown,
  _claims: unknown,
  _userId: string,
  hostRef: string,
  _directory: unknown,
) {
  return { authorized: true, connection: { hostRef } }
}
