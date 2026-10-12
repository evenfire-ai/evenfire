/** Upper bound for untrusted base64; padding makes the estimate exact for valid input. */
export function estimateBase64DecodedLength(dataBase64: string): number {
  const padding = dataBase64.endsWith('==') ? 2 : dataBase64.endsWith('=') ? 1 : 0
  return Math.floor((dataBase64.length * 3) / 4) - padding
}
