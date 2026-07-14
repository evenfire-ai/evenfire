import http, { IncomingMessage, ServerResponse } from "node:http";

export interface ForwarderConfig {
  requestTimeout: number;
  maxResponseSize: number;
  maxBufferSize: number; // Pre-commit buffer cap (bytes). Prevents unbounded memory during header-delay phase.
}

export class HttpForwarder {
  private config: ForwarderConfig;

  constructor(config: ForwarderConfig) {
    this.config = config;
  }

  async forward(
    req: IncomingMessage,
    res: ServerResponse,
    backendUrl: string
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const parsed = new URL(backendUrl);

      const proxyReq = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || 80,
          path: parsed.pathname + parsed.search,
          method: req.method,
          headers: this.buildHeaders(req, parsed.hostname),
          timeout: this.config.requestTimeout,
        },
        (proxyRes) => {
          const contentLength = parseInt(proxyRes.headers["content-length"] || "0", 10);
          // Known-length guard: reject immediately before sending any response bytes
          if (contentLength > this.config.maxResponseSize) {
            res.writeHead(413, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Response too large" }));
            proxyReq.destroy();
            resolve();
            return;
          }

          // For chunked/unknown-length responses, buffer initial chunks before
          // committing to a status code. This prevents the silent-truncation bug
          // where headers are sent as 200 and then the stream is destroyed mid-body.
          let headersSent = false;
          let totalSize = 0;
          const buffer: Buffer[] = [];

          proxyRes.on("data", (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize > this.config.maxResponseSize) {
              proxyRes.destroy();
              if (!headersSent) {
                headersSent = true;
                res.writeHead(413, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Response too large" }));
              } else {
                // Headers already sent — best we can do is terminate the stream.
                // Client will see an incomplete response (unavoidable).
                res.end();
              }
              resolve();
              return;
            }
            if (!headersSent) {
              buffer.push(chunk);
              // TM-2: Cap pre-commit buffer independently of maxResponseSize
              const bufferSize = buffer.reduce((sum, b) => sum + b.length, 0);
              if (bufferSize >= this.config.maxBufferSize) {
                headersSent = true;
                res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
                for (const b of buffer) { res.write(b); }
                buffer.length = 0;
              }
            } else {
              res.write(chunk);
            }
          });

          // After first data event, flush buffer and commit headers on next tick.
          // This gives us at least one chunk to check size before committing.
          proxyRes.once("data", () => {
            if (headersSent) return;
            process.nextTick(() => {
              if (headersSent) return;
              headersSent = true;
              res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
              for (const chunk of buffer) {
                res.write(chunk);
              }
              buffer.length = 0;
            });
          });

          proxyRes.on("end", () => {
            if (!headersSent) {
              // Small response that finished within buffering phase
              headersSent = true;
              res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
              for (const chunk of buffer) {
                res.write(chunk);
              }
            }
            res.end();
            resolve();
          });

          proxyRes.on("error", (err) => {
            if (!headersSent && !res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Backend error", message: err.message }));
            } else {
              res.end();
            }
            resolve();
          });
        }
      );

      req.on("aborted", () => {
        if (!proxyReq.destroyed) {
          proxyReq.destroy();
        }
      });

      proxyReq.on("error", (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Proxy error", message: err.message }));
        }
        resolve();
      });

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        if (!res.headersSent) {
          res.writeHead(504, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Gateway timeout" }));
        }
        resolve();
      });

      req.pipe(proxyReq);
    });
  }

  private buildHeaders(
    req: IncomingMessage,
    backendHost: string
  ): Record<string, string | string[] | undefined> {
    const headers = { ...req.headers };
    headers.host = backendHost;
    delete headers["connection"];
    return headers;
  }
}
