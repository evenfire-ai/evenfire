export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  correlationId: string;
  workflowName: string;
  stepId?: string;
  timestamp: string;
  context?: Record<string, unknown>;
}

let _correlationId = "";
let _workflowName = "";

export function initLogger(correlationId: string, workflowName: string): void {
  _correlationId = correlationId;
  _workflowName = workflowName;
}

export function emitLog(
  level: LogEntry["level"],
  message: string,
  context?: Record<string, unknown>,
): void {
  const entry: LogEntry = {
    level,
    message,
    correlationId: _correlationId,
    workflowName: _workflowName,
    timestamp: new Date().toISOString(),
    stepId: context?.stepId as string | undefined,
    context,
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}
