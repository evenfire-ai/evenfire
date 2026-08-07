import { ServerRoute } from './types'

export class Router {
  private routes: Map<string, ServerRoute> = new Map()

  update(servers: ServerRoute[]): { added: string[]; removed: string[] } {
    const newNames = new Set(servers.map(s => s.name))
    const oldNames = new Set(this.routes.keys())

    const added: string[] = []
    const removed: string[] = []

    for (const server of servers) {
      if (!oldNames.has(server.name)) {
        added.push(server.name)
      }
      this.routes.set(server.name, server)
    }

    for (const name of oldNames) {
      if (!newNames.has(name)) {
        this.routes.delete(name)
        removed.push(name)
      }
    }

    return { added, removed }
  }

  resolve(serverName: string): ServerRoute | undefined {
    return this.routes.get(serverName)
  }

  allRoutes(): ServerRoute[] {
    return Array.from(this.routes.values())
  }

  hasReadyServers(): boolean {
    for (const route of this.routes.values()) {
      if (route.ready) return true
    }
    return false
  }

  size(): number {
    return this.routes.size
  }

  clear(): void {
    this.routes.clear()
  }
}
