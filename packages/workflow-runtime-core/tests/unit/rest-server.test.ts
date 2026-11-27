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

const LOOPBACK_HOST = "127.0.0.1";

// Listens on a port the OS picks and returns it.
async function startOnFreePort(server: http.Server): Promise<number> {
  await start(server, 0);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address from the REST server");
  }
  return address.port;
}

async function request(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return requestRaw(
    port,
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    headers,
  );
}

async function requestRaw(
  port: number,
  method: string,
  path: string,
  rawBody?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: LOOPBACK_HOST,
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
    if (rawBody !== undefined) req.write(rawBody);
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

  it("GET /status requires the token when a validator is given", async () => {
    const goodToken = "fixture-good-token";
    const state = makeStateRef({ phase: "running" });
    const server = createServer(state, (token) => token === goodToken);
    const port = await startOnFreePort(server);
    try {
      const anonymous = await request(port, "GET", "/status");
      expect(anonymous).toEqual({ status: 401, body: { error: "Unauthorized" } });

      const wrong = await request(port, "GET", "/status", undefined, {
        Authorization: `Bearer ${goodToken}-other`,
      });
      expect(wrong).toEqual({ status: 401, body: { error: "Unauthorized" } });

      // Witness: the same server answers with the state for the right token.
      const authorized = await request(port, "GET", "/status", undefined, {
        Authorization: `Bearer ${goodToken}`,
      });
      expect(authorized).toEqual({
        status: 200,
        body: { workflowName: "test-wf", phase: "running", steps: {} },
      });
    } finally {
      await stop(server);
    }
  });

  it("createServer refuses a third argument", () => {
    const state = makeStateRef();
    const validator = (token: string) => token === "fixture-good-token";
    // The old (stateRef, onSignal, validateToken) shape, called the way an
    // untyped caller would.
    const untypedCreateServer = createServer as unknown as (
      ...args: unknown[]
    ) => http.Server;

    // Witness: the two-argument shape builds a server.
    expect(createServer(state, validator)).toBeInstanceOf(http.Server);

    expect(() => untypedCreateServer(state, undefined, validator)).toThrow(
      new TypeError(
        "createServer(stateRef, validateToken?) takes at most two arguments: the onSignal parameter was removed",
      ),
    );
    expect(() => untypedCreateServer(state, () => true, validator)).toThrow(
      TypeError,
    );
  });

  it("POST /api/v1/workflow/signal is not a route", async () => {
    const goodToken = "fixture-good-token";
    const state = makeStateRef({ phase: "running" });
    const server = createServer(state, (token) => token === goodToken);
    const port = await startOnFreePort(server);
    const signalPath = "/api/v1/workflow/signal";
    const notFound = { status: 404, body: { error: "Not found" } };
    try {
      const validSignal = await request(
        port,
        "POST",
        signalPath,
        { type: "cancel", requestId: "r1", receivedAt: new Date().toISOString() },
        { Authorization: `Bearer ${goodToken}` },
      );
      expect(validSignal).toEqual(notFound);

      const invalidToken = await request(
        port,
        "POST",
        signalPath,
        { type: "cancel", requestId: "r1", receivedAt: new Date().toISOString() },
        { Authorization: `Bearer ${goodToken}-other` },
      );
      expect(invalidToken).toEqual(notFound);

      const invalidJson = await requestRaw(port, "POST", signalPath, "not json{{{", {
        Authorization: `Bearer ${goodToken}`,
      });
      expect(invalidJson).toEqual(notFound);

      // Witness: the same server answers its health route.
      const health = await request(port, "GET", "/health");
      expect(health).toEqual({ status: 200, body: { status: "ok", phase: "running" } });
    } finally {
      await stop(server);
    }
  });
});
