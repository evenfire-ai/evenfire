export function bindRouteActionV2(_req: any, claims: any): any {
  return claims
}

export function rejectUnadmittedV2DerivedView(req: any, res: any, next: () => void): void {
  const claims = req.userDelegationV2
  if (!claims) {
    next()
    return
  }
  bindRouteActionV2(req, claims)
  res.status(503).json({ error: 'authority_unavailable' })
}
