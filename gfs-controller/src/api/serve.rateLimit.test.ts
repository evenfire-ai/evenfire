import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { GfsVerifiedClaims } from "../auth/verify";
import type { AuthzContext } from "../authz/permissionClient";
import { RateLimiter } from "../quota/rateLimit";
import { GfsServingHandler, type ServingDeps } from "./serve";

/**
 * Agent-plane rate limit (plan P4-S03). The limiter itself is unit-tested in
 * ../quota/quota.test.ts; these tests pin the WIRING: mutations spend the
 * token subject's budget, reads do not, subjects are independent, the window
 * elapses on the injected clock, and an absent limiter caps nothing.
 */

const RID = "00000000-0000-4000-8000-000000000021";
const REQUEST = "00000000-0000-4000-8000-000000000022";

function claims(sub: string): GfsVerifiedClaims {
  return { sub, drive: "main", scopes: ["gfs.read", "gfs.write"], pathBindings: [], iat: 1, exp: 2 };
}

function context(sub: string): AuthzContext {
  return {
    primarySubject: sub,
    subjects: [`agent:${sub}`],
    drive: "main",
    isOperator: false,
    requestId: REQUEST,
  };
}

/** A ServerResponse stand-in that records status, headers, and body. */
class Response extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  headersSent = false;
  body = "";
  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    this.headersSent = true;
    if (headers) Object.assign(this.headers, headers);
    return this;
  }
  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  end(value?: string): this {
    if (value) this.body += value;
    this.emit("close");
    return this;
  }
  get json(): { ok: boolean; error?: { code: string; retryAfterSeconds?: number } } {
    return JSON.parse(this.body);
  }
}

function putContent(auth = "Bearer local"): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify({ content: "new", ifMatch: 2 }))]) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  stream.method = "PUT";
  stream.url = `/v1/resources/${RID}/content`;
  stream.headers = { authorization: auth, "x-request-id": REQUEST };
  return stream as unknown as IncomingMessage;
}

function getChildren(): IncomingMessage {
  return {
    url: `/v1/resources/${RID}/children?limit=10`,
    method: "GET",
    headers: { authorization: "Bearer local" },
  } as unknown as IncomingMessage;
}

function fixture(options: { limit?: number; now?: () => number } = {}) {
  let clock = 1_000_000;
  const replaces: unknown[] = [];
  const deps: ServingDeps = {
    verifyToken: (token) => claims(token === "other" ? "host:other" : "host:agent"),
    resolveContext: async (resolved, requestId) => ({
      ...context(resolved.sub),
      requestId,
    }),
    authorize: async () => ({ allowed: true }),
    store: {
      getResource: async () => ({
        resourceId: RID,
        drive: "main",
        parentResourceId: RID,
        name: "docs",
        kind: "directory" as const,
        pathCache: "/docs",
        version: 1,
        bytes: 0,
        blobKey: null,
        contentSha256: null,
        deletedAt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      listChildren: async () => [],
    },
    blobs: { read: async () => Readable.from([]) },
    writeService: {
      replace: async (input: unknown) => {
        replaces.push(input);
        return {
          resourceId: RID,
          drive: "main",
          parentResourceId: RID,
          name: "f.txt",
          kind: "file" as const,
          pathCache: "/f.txt",
          version: 3,
          bytes: 3,
          blobKey: null,
          contentSha256: null,
          deletedAt: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
      },
    } as unknown as ServingDeps["writeService"],
    audit: { record: async () => undefined },
    rateLimit: new RateLimiter({
      limit: options.limit ?? 2,
      windowMs: 60_000,
      now: options.now ?? (() => clock),
    }),
  };
  return {
    deps,
    handler: new GfsServingHandler(deps),
    replaces,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("agent-plane rate limit", () => {
  it("caps mutations per subject and reports the window on the 429", async () => {
    const f = fixture({ limit: 2 });

    const first = new Response();
    await f.handler.tryHandle(putContent(), first as never);
    expect(first.statusCode).toBe(200);

    const second = new Response();
    await f.handler.tryHandle(putContent(), second as never);
    expect(second.statusCode).toBe(200);

    const third = new Response();
    await f.handler.tryHandle(putContent(), third as never);
    expect(third.statusCode).toBe(429);
    expect(third.json.error?.code).toBe("rate_limited");
    expect(third.json.error?.retryAfterSeconds).toBe(60);
    expect(third.headers["retry-after"]).toBe("60");
    expect(third.headers["x-ratelimit-limit"]).toBe("2");
    // The denied attempt never reached the write service.
    expect(f.replaces).toHaveLength(2);
  });

  it("leaves reads uncapped", async () => {
    const f = fixture({ limit: 1 });

    for (let i = 0; i < 3; i++) {
      const res = new Response();
      await f.handler.tryHandle(getChildren(), res as never);
      expect(res.statusCode).toBe(200);
    }
  });

  it("keeps subjects independent", async () => {
    const f = fixture({ limit: 1 });

    const first = new Response();
    await f.handler.tryHandle(putContent("Bearer local"), first as never);
    expect(first.statusCode).toBe(200);

    const second = new Response();
    await f.handler.tryHandle(putContent("Bearer other"), second as never);
    expect(second.statusCode).toBe(200);

    const third = new Response();
    await f.handler.tryHandle(putContent("Bearer other"), third as never);
    expect(third.statusCode).toBe(429);
  });

  it("admits again once the window elapses", async () => {
    const f = fixture({ limit: 1 });

    const first = new Response();
    await f.handler.tryHandle(putContent(), first as never);
    expect(first.statusCode).toBe(200);

    const blocked = new Response();
    await f.handler.tryHandle(putContent(), blocked as never);
    expect(blocked.statusCode).toBe(429);

    f.advance(60_001);

    const admitted = new Response();
    await f.handler.tryHandle(putContent(), admitted as never);
    expect(admitted.statusCode).toBe(200);
  });

  it("caps nothing when no limiter is injected", async () => {
    const f = fixture({ limit: 1 });
    const unlimited: ServingDeps = { ...f.deps, rateLimit: undefined };
    const handler = new GfsServingHandler(unlimited);

    for (let i = 0; i < 3; i++) {
      const res = new Response();
      await handler.tryHandle(putContent(), res as never);
      expect(res.statusCode).toBe(200);
    }
  });
});
