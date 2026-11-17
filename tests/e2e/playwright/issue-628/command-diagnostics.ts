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
  ['spec.mcpServers: Required value', 'context1 connector list rejected'],
  ['Error from server (Forbidden)', 'Kubernetes request forbidden'],
  ['Error from server (AlreadyExists)', 'Kubernetes object already exists'],
  ['Error from server (Invalid)', 'Kubernetes object invalid'],
  ['Error from server (NotFound)', 'Kubernetes object not found'],
  ['Error from server (Unauthorized)', 'Kubernetes authentication required'],
  ['You must be logged in to the server (Unauthorized)', 'Kubernetes authentication required'],
  ['Unable to connect to the server', 'Kubernetes API connection failed'],
  ['PROFILE_BUSY:', 'Minikube profile busy'],
  ['PROFILE_UNHEALTHY:', 'Minikube profile unhealthy'],
  ['PROFILE_LOCK_REQUIRED:', 'Minikube profile lease required'],
  ['PROFILE_OWNERSHIP_MISMATCH:', 'Minikube profile ownership mismatch'],
  ['HEAD_MARKER_MISMATCH:', 'Minikube source marker mismatch'],
  ['DEVELOPMENT_SCOPE_REQUIRED:', 'Minikube development scope rejected'],
  ['PORT_FORWARD_CONFLICT:', 'Minikube port-forward ownership conflict'],
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
  ['[provision-gfs-runtime] ERROR:', 'GFS runtime provisioning failed'],
]

export function commandFailureReason(stderr: string): string | undefined {
  return signatures.find(([signature]) => stderr.includes(signature))?.[1]
}
