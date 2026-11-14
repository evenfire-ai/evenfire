// Return only fixed labels: stderr can contain credentials or response data.
const signatures: ReadonlyArray<readonly [string, string]> = [
  [
    '[bootstrap-instances] ERROR: cannot inspect an existing Context',
    'context1 bootstrap read failed',
  ],
  [
    '[bootstrap-instances] ERROR: cannot validate Context response',
    'context1 bootstrap response invalid',
  ],
  ['[bootstrap-instances] ERROR: jq is required', 'context1 bootstrap requires jq'],
  ['[bootstrap-instances] ERROR: cannot render instances', 'context1 bootstrap render failed'],
  [
    '[bootstrap-instances] ERROR: cannot render seed instances',
    'context1 bootstrap seed render failed',
  ],
  [
    '[bootstrap-instances] ERROR: cannot classify instance declarations',
    'context1 bootstrap classification failed',
  ],
  [
    '[bootstrap-instances] ERROR: cannot prepare initial context1',
    'context1 bootstrap creation preparation failed',
  ],
  [
    '[bootstrap-instances] ERROR: invalid context1 last-applied configuration',
    'context1 bootstrap baseline invalid',
  ],
  ['Error from server (Forbidden)', 'Kubernetes request forbidden'],
  ['Error from server (AlreadyExists)', 'Kubernetes object already exists'],
  ['spec.mcpServers: Required value', 'context1 connector list rejected'],
  ['MCP request failed', 'MCP request failed'],
  ['MCP response missing or rejected', 'MCP response missing or rejected'],
  ['MCP result mismatch', 'MCP result mismatch'],
  ...[
    'ISSUE628_RESTART_SCOPE_REQUIRED',
    'ISSUE628_RESTART_READINESS_FAILED',
    'ISSUE628_RESTART_IP_UNKNOWN',
    'ISSUE628_RESTART_STOP_FAILED',
    'ISSUE628_RESTART_START_FAILED',
    'ISSUE628_RESTART_IP_CHANGED',
    'ISSUE628_RESTART_STOP_UNOBSERVED',
  ].map(reason => [reason, reason] as const),
]

export function commandFailureReason(stderr: string): string | undefined {
  return signatures.find(([signature]) => stderr.includes(signature))?.[1]
}
