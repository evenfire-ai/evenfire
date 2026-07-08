export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
