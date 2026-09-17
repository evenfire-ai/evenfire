export async function authorizeRpcHostAccess(
  _gateway: unknown,
  _claims: unknown,
  _userId: string,
  _hostRef: string,
  _directory: unknown,
): Promise<{ authorized: boolean; connection: { hostRef: string } }> {
  return { authorized: true, connection: { hostRef: 'canonical-host' } }
}
