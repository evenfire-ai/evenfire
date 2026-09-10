export function tokenDeclaresV2(token: string): boolean {
  return token.startsWith("v2.");
}

export function verifyUserDelegationV2(token: string): object | null {
  return tokenDeclaresV2(token) ? { operation: "mcp.invoke" } : null;
}
