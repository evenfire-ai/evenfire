import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { HttpForwarder } from "../src/httpForwarder";

describe("HttpForwarder", () => {
  let backend: http.Server;
  let backendPort: number;
  let forwarder: HttpForwarder;
  let backendHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeEach(async () => {
    forwarder = new HttpForwarder({ requestTimeout: 5000, maxResponseSize: 1048576, maxBufferSize: 65536 });

    await new Promise<void>((resolve) => {
      backend = http.createServer((req, res) => {
        backendHandler(req, res);
      });
      backend.listen(0, () => {
        const addr = backend.address();
        if (addr && typeof addr !== "string") {
          backendPort = addr.port;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });

  function forwardViaProxy(
    method: string,
    headers: Record<string, string> = {},
    body?: string
  ): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      // Create a temporary proxy server that uses our forwarder
      const proxy = http.createServer(async (req, res) => {
        try {
          await forwarder.forward(req, res, `http://127.0.0.1:${backendPort}/mcp`);
        } catch {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("forward error");
          }
        }
      });

      proxy.listen(0, () => {
        const addr = proxy.address();
        if (!addr || typeof addr === "string") return reject(new Error("no addr"));
        const proxyPort = addr.port;

        const req = http.request(
          { hostname: "127.0.0.1", port: proxyPort, path: "/test", method, headers },
          (res) => {
            let data = "";
            res.on("data", (c: Buffer) => (data += c.toString()));
            res.on("end", () => {
              proxy.close();
              resolve({ status: res.statusCode || 0, body: data, headers: res.headers });
            });
          }
        );
        req.on("error", (err) => {
          proxy.close();
          reject(err);
        });
        if (body) req.write(body);
        req.end();
      });
    });
  }

  it("should forward request to backend", async () => {
    backendHandler = (_, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    };

    const res = await forwardViaProxy("POST");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("should preserve request headers", async () => {
    let receivedHeaders: http.IncomingHttpHeaders = {};
    backendHandler = (req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200);
      res.end("ok");
    };

    await forwardViaProxy("POST", {
      authorization: "Bearer test-token",
      "x-mcp-session": "session-123",
    });

    expect(receivedHeaders["authorization"]).toBe("Bearer test-token");
    expect(receivedHeaders["x-mcp-session"]).toBe("session-123");
  });

  it("should preserve response headers", async () => {
    backendHandler = (_, res) => {
      res.writeHead(200, { "X-Custom-Header": "custom-value" });
      res.end("ok");
    };

    const res = await forwardViaProxy("POST");
    expect(res.headers["x-custom-header"]).toBe("custom-value");
  });

  it("should pass through error status codes", async () => {
    backendHandler = (_, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end('{"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid Request"}}');
    };

    const res = await forwardViaProxy("POST");
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(-32600);
  });

  it("should return 502 when backend is unreachable", async () => {
    const deadForwarder = new HttpForwarder({ requestTimeout: 1000, maxResponseSize: 1048576, maxBufferSize: 65536 });

    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const proxy = http.createServer(async (req, proxyRes) => {
        await deadForwarder.forward(req, proxyRes, "http://127.0.0.1:1/mcp");
      });

      proxy.listen(0, () => {
        const addr = proxy.address();
        if (!addr || typeof addr === "string") return reject(new Error("no addr"));
        const req = http.request(
          { hostname: "127.0.0.1", port: addr.port, path: "/test", method: "POST" },
          (r) => {
            let data = "";
            r.on("data", (c: Buffer) => (data += c.toString()));
            r.on("end", () => {
              proxy.close();
              resolve({ status: r.statusCode || 0, body: data });
            });
          }
        );
        req.on("error", (err) => {
          proxy.close();
          reject(err);
        });
        req.end();
      });
    });

    expect(res.status).toBe(502);
  });

  it("should stream chunked responses", async () => {
    backendHandler = (_, res) => {
      res.writeHead(200, { "Transfer-Encoding": "chunked" });
      res.write("chunk1");
      setTimeout(() => {
        res.write("chunk2");
        res.end();
      }, 50);
    };

    const res = await forwardViaProxy("POST");
    expect(res.status).toBe(200);
    expect(res.body).toBe("chunk1chunk2");
  });
});
