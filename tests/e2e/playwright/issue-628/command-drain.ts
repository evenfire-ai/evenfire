// Keep the profile lease until foreground commands started by a timed-out test
// have completed. This does not cancel independently detached processes.
export class CommandDrain {
  private readonly pending = new Set<Promise<unknown>>()
  private closing = false

  open(): void {
    if (this.pending.size) throw new Error('Previous profile commands are still running')
    this.closing = false
  }

  isClosing(): boolean {
    return this.closing
  }

  async run<T>(start: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error('Profile command admission is closed')
    const command = start()
    this.pending.add(command)
    try {
      return await command
    } finally {
      this.pending.delete(command)
    }
  }

  async close(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.pending])
  }
}
