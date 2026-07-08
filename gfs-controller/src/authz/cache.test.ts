import { describe, expect, it, vi } from "vitest";
import { DecisionCache } from "./cache.js";
import {
  emitInvalidation,
  GFS_INVALIDATE_CHANNEL,
  InvalidationListener,
  type ListenClient,
  type PgNotification,
} from "./invalidation.js";

/**
 * P2-S03: short-TTL decision cache + LISTEN/NOTIFY invalidation, both fail-closed.
 * Acceptance: a revoked grant denies on the next op (no TTL wait — flush on
 * NOTIFY); fan-out failure never extends access (bypass on connection error).
 */

const KEY = { subjectsKey: "user:u1", resourceId: "r1", op: "read" };

describe("DecisionCache", () => {
  it("returns a cached decision within the TTL and misses after it", () => {
    let t = 1000;
    const cache = new DecisionCache({ ttlMs: 100, now: () => t });
    cache.set(KEY, true);
    expect(cache.get(KEY)).toBe(true);
    t += 99;
    expect(cache.get(KEY)).toBe(true);
    t += 1; // now at +100 = expiry boundary
    expect(cache.get(KEY)).toBeUndefined();
  });

  it("flushAll drops entries so the next op re-checks (immediate revocation)", () => {
    const cache = new DecisionCache({ ttlMs: 10_000 });
    cache.set(KEY, true);
    expect(cache.get(KEY)).toBe(true);
    cache.flushAll();
    expect(cache.get(KEY)).toBeUndefined();
  });

  it("serves and stores NOTHING while bypassed (fail-closed)", () => {
    const cache = new DecisionCache({ ttlMs: 10_000 });
    cache.set(KEY, true);
    cache.setBypassed(true);
    expect(cache.isBypassed).toBe(true);
    expect(cache.get(KEY)).toBeUndefined(); // existing entry not served
    cache.set(KEY, true); // ignored while bypassed
    expect(cache.size).toBe(0);
    cache.setBypassed(false);
    expect(cache.get(KEY)).toBeUndefined(); // was never stored
    cache.set(KEY, false);
    expect(cache.get(KEY)).toBe(false); // caching works again
  });

  it("evicts the oldest entry past maxEntries", () => {
    const cache = new DecisionCache({ ttlMs: 10_000, maxEntries: 2 });
    cache.set({ ...KEY, resourceId: "a" }, true);
    cache.set({ ...KEY, resourceId: "b" }, true);
    cache.set({ ...KEY, resourceId: "c" }, true); // evicts "a"
    expect(cache.size).toBe(2);
    expect(cache.get({ ...KEY, resourceId: "a" })).toBeUndefined();
    expect(cache.get({ ...KEY, resourceId: "c" })).toBe(true);
  });

  it("rejects a non-positive ttl", () => {
    expect(() => new DecisionCache({ ttlMs: 0 })).toThrow();
  });
});

class FakeListenClient implements ListenClient {
  connected = false;
  queries: string[] = [];
  private handlers: {
    notification?: (m: PgNotification) => void;
    error?: (e: Error) => void;
    end?: () => void;
  } = {};

  async connect(): Promise<void> {
    this.connected = true;
  }
  async query(sql: string): Promise<unknown> {
    this.queries.push(sql);
    return {};
  }
  on(event: "notification", listener: (msg: PgNotification) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown {
    (this.handlers as Record<string, unknown>)[event] = listener;
    return this;
  }
  fireNotification(channel: string, payload?: string): void {
    this.handlers.notification?.({ channel, payload });
  }
  fireError(err: Error): void {
    this.handlers.error?.(err);
  }
  fireEnd(): void {
    this.handlers.end?.();
  }
}

function spyCache() {
  return { flushAll: vi.fn(), setBypassed: vi.fn() };
}

describe("InvalidationListener", () => {
  it("connects, LISTENs, and enables caching on start", async () => {
    const client = new FakeListenClient();
    const cache = spyCache();
    await new InvalidationListener({ client, cache }).start();
    expect(client.connected).toBe(true);
    expect(client.queries).toContain(`LISTEN ${GFS_INVALIDATE_CHANNEL}`);
    expect(cache.flushAll).toHaveBeenCalled();
    expect(cache.setBypassed).toHaveBeenLastCalledWith(false);
  });

  it("flushes the cache on a NOTIFY for our channel (immediate revocation)", async () => {
    const client = new FakeListenClient();
    const cache = spyCache();
    await new InvalidationListener({ client, cache }).start();
    cache.flushAll.mockClear();
    client.fireNotification(GFS_INVALIDATE_CHANNEL);
    expect(cache.flushAll).toHaveBeenCalledTimes(1);
  });

  it("ignores a NOTIFY on a different channel", async () => {
    const client = new FakeListenClient();
    const cache = spyCache();
    await new InvalidationListener({ client, cache }).start();
    cache.flushAll.mockClear();
    client.fireNotification("some_other_channel");
    expect(cache.flushAll).not.toHaveBeenCalled();
  });

  it("enters fail-closed bypass on a connection error", async () => {
    const client = new FakeListenClient();
    const cache = spyCache();
    const onDegraded = vi.fn();
    await new InvalidationListener({ client, cache, onDegraded }).start();
    cache.setBypassed.mockClear();
    client.fireError(new Error("connection lost"));
    expect(cache.setBypassed).toHaveBeenCalledWith(true);
    expect(onDegraded).toHaveBeenCalled();
  });

  it("enters fail-closed bypass when the connection ends", async () => {
    const client = new FakeListenClient();
    const cache = spyCache();
    await new InvalidationListener({ client, cache }).start();
    cache.setBypassed.mockClear();
    client.fireEnd();
    expect(cache.setBypassed).toHaveBeenCalledWith(true);
  });

  it("rejects an unsafe channel name", () => {
    const client = new FakeListenClient();
    const cache = spyCache();
    expect(() => new InvalidationListener({ client, cache, channel: "bad; DROP" })).toThrow();
  });
});

describe("emitInvalidation", () => {
  it("issues a bare NOTIFY without a payload", async () => {
    const client = new FakeListenClient();
    await emitInvalidation(client);
    expect(client.queries).toContain(`NOTIFY ${GFS_INVALIDATE_CHANNEL}`);
  });

  it("uses pg_notify when a payload is provided", async () => {
    const client = new FakeListenClient();
    await emitInvalidation(client, GFS_INVALIDATE_CHANNEL, "r1");
    expect(client.queries.some((q) => q.includes("pg_notify"))).toBe(true);
  });

  it("rejects an unsafe channel name", async () => {
    const client = new FakeListenClient();
    await expect(emitInvalidation(client, "bad; DROP")).rejects.toThrow();
  });
});
