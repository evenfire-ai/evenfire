export type ConnectionCaptureBinding = {
  run: string
  profile: string
  context: string
  scenario: string
  fixtureUserId: string
}
export function beginConnectionCapture(
  root: string,
  binding: ConnectionCaptureBinding
): {
  record(body: {
    id?: unknown
    connectionKey?: unknown
    displayName?: unknown
    createdBy?: unknown
  }): void
  close(): void
}
export function connectionCaptureName(scenario: string): string
export function validateConnectionCapture(
  value: unknown,
  binding: ConnectionCaptureBinding
): unknown
