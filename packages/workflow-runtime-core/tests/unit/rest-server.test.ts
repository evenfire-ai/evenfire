import { describe, it, expect } from "vitest";
import * as http from "node:http";
import {
  createServer,
  start,
  stop,
  type WorkflowStateRef,
} from "../../src/rest-server/server";

function makeStateRef(
  overrides: Partial<WorkflowStateRef> = {},
): WorkflowStateRef {
  return {
    phase: "running",
    steps: {},
    workflowName: "test-wf",
    ...overrides,
  };
}

let nextPort = 19100;
function getPort() {
  return nextPort++;
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode!, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe("REST server", () => {
  it("GET /health returns status ok and current phase", async () => {
    const port = getPort();
    const state = makeStateRef({ phase: "running" });
    const server = createServer(state);
    await start(server, port);
    try {
      const resp = await request(port, "GET", "/health");
      expect(resp.status).toBe(200);
      expect(resp.body).toEqual({ status: "ok", phase: "running" });
    } finally {
      await stop(server);
    }
  });

  it("GET /status returns workflow state", async () => {
    const port = getPort();
    const state = makeStateRef({
      phase: "completed",
      steps: { "step-1": { phase: "completed", output: "done" } },
    });
    const server = createServer(state);
    await start(server, port);
    try {
      const resp = await request(port, "GET", "/status");
      expect(resp.status).toBe(200);
      expect((resp.body as any).workflowName).toBe("test-wf");
      expect((resp.body as any).phase).toBe("completed");
      expect((resp.body as any).steps["step-1"].phase).toBe("completed");
    } finally {
      await stop(server);
    }
  });

  it("POST /api/v1/workflow/signal accepts valid signal", async () => {
    const port = getPort();
    const state = makeStateRef();
    const received: unknown[] = [];
    const server = createServer(state, (signal) => received.push(signal));
    await start(server, port);
    try {
      const resp = await request(port, "POST", "/api/v1/workflow/signal", {
        type: "cancel",
        requestId: "r1",
        receivedAt: new Date().toISOString(),
      });
      expect(resp.status).toBe(202);
      expect(received).toHaveLength(1);
    } finally {
      await stop(server);
    }
  });

  it("POST /api/v1/workflow/signal returns 401 with invalid token", async () => {
    const port = getPort();
    const state = makeStateRef();
    const server = createServer(state, undefined, (token) => token === "valid");
    await start(server, port);
    try {
      const resp = await request(
        port,
        "POST",
        "/api/v1/workflow/signal",
        { type: "cancel", requestId: "r1", receivedAt: "" },
        { Authorization: "Bearer invalid" },
      );
      expect(resp.status).toBe(401);
    } finally {
      await stop(server);
    }
  });

  it("POST /api/v1/workflow/signal returns 400 for invalid body", async () => {
    const port = getPort();
    const state = makeStateRef();
    const server = createServer(state);
    await start(server, port);
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/api/v1/workflow/signal",
            method: "POST",
            headers: { "Content-Type": "application/json" },
          },
          (res) => {
            let data = "";
            res.on("data", (chunk: string) => (data += chunk));
            res.on("end", () => {
              expect(res.statusCode).toBe(400);
              resolve();
            });
          },
        );
        req.on("error", reject);
        req.write("not json{{{");
        req.end();
      });
    } finally {
      await stop(server);
    }
  });

  it("returns 404 for unknown routes", async () => {
    const port = getPort();
    const state = makeStateRef();
    const server = createServer(state);
    await start(server, port);
    try {
      const resp = await request(port, "GET", "/unknown");
      expect(resp.status).toBe(404);
    } finally {
      await stop(server);
    }
  });

  it("GET /health reflects phase changes", async () => {
    const port = getPort();
    const state = makeStateRef({ phase: "pending" });
    const server = createServer(state);
    await start(server, port);
    try {
      let resp = await request(port, "GET", "/health");
      expect((resp.body as any).phase).toBe("pending");

      state.phase = "running";
      resp = await request(port, "GET", "/health");
      expect((resp.body as any).phase).toBe("running");
    } finally {
      await stop(server);
    }
  });

  it("graceful shutdown closes server", async () => {
    const port = getPort();
    const state = makeStateRef();
    const server = createServer(state);
    await start(server, port);
    await stop(server);
    await expect(request(port, "GET", "/health")).rejects.toThrow();
  });

  it("POST /api/v1/workflow/signal accepts signal when token is valid", async () => {
    const port = getPort();
    const state = makeStateRef();
    const received: unknown[] = [];
    const server = createServer(state, (s) => received.push(s), (t) => t === "good-token");
    await start(server, port);
    try {
      const resp = await request(
        port,
        "POST",
        "/api/v1/workflow/signal",
        { type: "cancel", requestId: "r1", receivedAt: new Date().toISOString() },
        { Authorization: "Bearer good-token" },
      );
      expect(resp.status).toBe(202);
      expect(received).toHaveLength(1);
    } finally {
      await stop(server);
    }
  });

  it("POST /api/v1/workflow/signal returns 422 for invalid signal schema", async () => {
    const port = getPort();
    const state = makeStateRef();
    const server = createServer(state);
    await start(server, port);
    try {
      const resp = await request(port, "POST", "/api/v1/workflow/signal", {
        type: "unknown-type",
        requestId: "r1",
        receivedAt: "",
      });
      expect(resp.status).toBe(422);
    } finally {
      await stop(server);
    }
  });

  it("POST /api/v1/workflow/signal returns 422 when requestId is empty", async () => {
    const port = getPort();
    const state = makeStateRef();
    const server = createServer(state);
    await start(server, port);
    try {
      const resp = await request(port, "POST", "/api/v1/workflow/signal", {
        type: "cancel",
        requestId: "",
        receivedAt: new Date().toISOString(),
      });
      expect(resp.status).toBe(422);
    } finally {
      await stop(server);
    }
  });
});
