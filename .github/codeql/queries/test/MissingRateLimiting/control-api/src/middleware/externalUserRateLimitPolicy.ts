export function externalUserRateLimitOptions(
  policy: string,
  stage: string,
): unknown {
  return { policy, stage };
}

const POLICIES = {
  rpc_token: { bucketType: "external_rpc_token", maxPerMinute: 10 },
};
