import fs from "node:fs";
import { authorizeBoundRequestV2 } from "../routeActionBindingV2";
import { tokenDeclaresV2, verifyUserDelegationV2 } from "../userDelegationV2";

declare function verifyRpcToken(token: string): object | null;

export function requireRpcAuth(req: any, res: any, next: () => void): void {
  fs.writeFileSync("/tmp/evenfire-codeql-rpc-auth", "checked");
  if (tokenDeclaresV2(req.token)) {
    const delegation = verifyUserDelegationV2(req.token);
    if (!delegation) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    req.userDelegationV2 = delegation;
    next();
    return;
  }
  const legacy = verifyRpcToken(req.token);
  if (!legacy) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

export function requireScope(_scope: string) {
  return (req: any, res: any, next: () => void): void => {
    fs.writeFileSync("/tmp/evenfire-codeql-rpc-scope", "checked");
    if (req.userDelegationV2) {
      void authorizeBoundRequestV2(req, res, next);
      return;
    }
    res.status(403).json({ error: "forbidden" });
    return;
  };
}
