import http, { type IncomingMessage, type ServerResponse } from "node:http";

export type Np08FixtureServer = {
  name: string;
  contextRef: string;
  hostNames: string[];
  url: string;
  live: boolean;
  enabled: boolean;
  deployed: boolean;
  ready: boolean;
  authoritative: boolean;
  generation: number;
};

export type Np08ForwardDecision =
  | { allowed: true; targetUrl: string; generation: number }
  | { allowed: false; reason: "unknown_host" | "wrong_context" | "unknown_server" | "not_live" };

/**
 * Test-only mutable authority. It deliberately models Host -> Context ->
 * McpServer instead of a global name lookup so a cross-context test cannot
 * pass vacuously because A and B happen to use different server names.
 */
export class MutableNp08Authority {
  private readonly servers = new Map<string, Np08FixtureServer>();
  private readonly hostContexts = new Map<string, string>();

  addServer(server: Np08FixtureServer): void {
    this.servers.set(server.name, { ...server, hostNames: [...server.hostNames] });
    for (const hostName of server.hostNames) this.hostContexts.set(hostName, server.contextRef);
  }

  setHostContext(hostName: string, contextRef: string): void {
    this.hostContexts.set(hostName, contextRef);
  }

  mutateServer(name: string, patch: Partial<Np08FixtureServer>): void {
    const current = this.servers.get(name);
    if (!current) throw new Error(`fixture server not found: ${name}`);
    this.servers.set(name, {
      ...current,
      ...patch,
      hostNames: patch.hostNames ? [...patch.hostNames] : [...current.hostNames],
      generation: patch.generation ?? current.generation + 1,
    });
  }

  authorize(hostName: string, serverName: string): Np08ForwardDecision {
    const contextRef = this.hostContexts.get(hostName);
    if (!contextRef) return { allowed: false, reason: "unknown_host" };
    const server = this.servers.get(serverName);
    if (!server) return { allowed: false, reason: "unknown_server" };
    if (server.contextRef !== contextRef || !server.hostNames.includes(hostName)) {
      return { allowed: false, reason: "wrong_context" };
    }
    if (!server.live || !server.enabled || !server.deployed || !server.ready || !server.authoritative) {
      return { allowed: false, reason: "not_live" };
    }
    return { allowed: true, targetUrl: server.url, generation: server.generation };
  }
}

export class InstrumentedUpstream {
  readonly connections = 0;
  readonly requests = 0;
  readonly bytesReceived = 0;
  private connectionCount = 0;
  private requestCount = 0;
  private receivedBytes = 0;
  private readonly server: http.Server;
  private listeningPort: number | null = null;

  constructor(
    private readonly handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void = (
      _req,
      res
    ) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }
  ) {
    this.server = http.createServer((req, res) => {
      this.requestCount += 1;
      const chunks: Buffer[] = [];
      req.on("data", chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.receivedBytes += buffer.length;
        chunks.push(buffer);
      });
      req.on("end", () => this.handler(req, res, Buffer.concat(chunks)));
    });
    this.server.on("connection", () => {
      this.connectionCount += 1;
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("fixture upstream did not bind");
    this.listeningPort = address.port;
    return `http://127.0.0.1:${address.port}/mcp`;
  }

  async close(): Promise<void> {
    if (!this.listeningPort) return;
    await new Promise<void>((resolve, reject) => this.server.close(error => (error ? reject(error) : resolve())));
    this.listeningPort = null;
  }

  get connectionCountValue(): number {
    return this.connectionCount;
  }

  get requestCountValue(): number {
    return this.requestCount;
  }

  get bytesReceivedValue(): number {
    return this.receivedBytes;
  }
}
