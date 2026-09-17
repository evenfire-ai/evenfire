export async function resolveAuthorizedHostConnection(
  req: { params: { hostRef: string } },
  _res: unknown,
  _gateway: unknown,
  _directory: unknown,
) {
  return { hostRef: req.params.hostRef }
}
