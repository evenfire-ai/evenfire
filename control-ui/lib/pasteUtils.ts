export function buildPastedValue(current: string, pasted: string, input: HTMLInputElement): string {
  const start = input.selectionStart ?? current.length
  const end = input.selectionEnd ?? start
  return `${current.slice(0, start)}${pasted}${current.slice(end)}`
}
