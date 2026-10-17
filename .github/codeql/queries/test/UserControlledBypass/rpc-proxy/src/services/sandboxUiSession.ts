import jwt from "jsonwebtoken";

export function verifySandboxUiSession(value: string): unknown {
  return jwt.verify(value, "fixture-secret");
}
