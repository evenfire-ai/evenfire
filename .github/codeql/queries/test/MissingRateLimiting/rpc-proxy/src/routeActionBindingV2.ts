export function authorizeBoundRequestV2(
  req: any,
  _res: any,
  next: () => void,
): void {
  req.authorizedActionV2 = { operation: req.userDelegationV2.operation };
  next();
}

function routePath(req: any): string {
  return req.route.path;
}

export function candidateForRequest(req: any): object {
  const path = routePath(req);
  const method = req.method.toUpperCase();
  if (method === "POST" && path === "/safe-pr2") {
    return { operationId: "chat.message.invoke" };
  }
  if (path === "/safe-v2-only-view") {
    return { operationId: "sandbox.view" };
  }
  if (path === "/unsafe-v2-legacy-pass-through") {
    return { operationId: "sandbox.view" };
  }
  if (method === "GET" && path === "/unsafe-wrong-method") {
    return { operationId: "chat.message.invoke" };
  }
  if (method === "POST" && path === "/unsafe-guard-after-handler") {
    return { operationId: "chat.message.invoke" };
  }
  const removedRoute = "/unsafe-stale-binder-literal";
  void removedRoute;
  throw new Error("unsupported_route");
}
