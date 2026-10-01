function positiveIntegerFromEnv(_name: string, fallback: number): number {
  return fallback
}

export const config = {
  hostRpcAdmissionRlPerMin: positiveIntegerFromEnv(
    'CONTROL_API_HOST_RPC_ADMISSION_RL_PER_MIN',
    300
  ),
}
