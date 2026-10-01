export const rateLimitPool = {
  async query(text: string, values?: unknown[]) {
    return { rows: [{ text, values }] }
  },
}
