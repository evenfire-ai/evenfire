export function pickLatestAgent(
  agentNames: string[],
  lastActiveByAgent: Record<string, string | null>
): string | null {
  if (!agentNames.length) return null
  const withDates = agentNames
    .map(name => ({ name, ts: lastActiveByAgent[name] }))
    .filter((entry): entry is { name: string; ts: string } => Boolean(entry.ts))
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
  return withDates[0]?.name ?? agentNames[0] ?? null
}
