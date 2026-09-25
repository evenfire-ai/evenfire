export async function resolveArtifactReadHostConnectionForUser(
  _subject: string,
  _hostRef: string,
): Promise<{ name: string } | null> {
  return { name: "canonical-host" };
}
