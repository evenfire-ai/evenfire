export async function authorizeActionV2(_claims: unknown, _bound: unknown): Promise<void> {
  await fetch('/internal/action-authority/checkpoint')
}
