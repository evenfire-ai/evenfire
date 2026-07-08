import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ResultStore } from "../resultStore";

interface TestEntry {
  value: string;
  storedAt: number;
}

function createStore(ttlMs: number = 1000): ResultStore<TestEntry> {
  return new ResultStore<TestEntry>(ttlMs, (e) => e.storedAt);
}

describe("ResultStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should store and retrieve entries", () => {
    const store = createStore();
    store.set("a", { value: "hello", storedAt: Date.now() });

    const result = store.get("a");
    expect(result).toBeDefined();
    expect(result!.value).toBe("hello");
  });

  it("should return undefined for missing entries", () => {
    const store = createStore();
    expect(store.get("missing")).toBeUndefined();
  });

  it("should delete entries", () => {
    const store = createStore();
    store.set("a", { value: "hello", storedAt: Date.now() });
    expect(store.delete("a")).toBe(true);
    expect(store.get("a")).toBeUndefined();
  });

  it("should evict entries older than TTL on get()", () => {
    const store = createStore(100); // 100ms TTL
    store.set("old", { value: "stale", storedAt: Date.now() });

    vi.advanceTimersByTime(200); // advance past TTL

    expect(store.get("old")).toBeUndefined();
  });

  it("should keep entries within TTL", () => {
    const store = createStore(1000);
    store.set("fresh", { value: "ok", storedAt: Date.now() });

    vi.advanceTimersByTime(500); // within TTL

    expect(store.get("fresh")).toBeDefined();
  });

  it("should getAndDelete in one call", () => {
    const store = createStore();
    store.set("a", { value: "hello", storedAt: Date.now() });

    const result = store.getAndDelete("a");
    expect(result).toBeDefined();
    expect(result!.value).toBe("hello");

    // Should be gone now
    expect(store.get("a")).toBeUndefined();
  });

  it("should return undefined from getAndDelete for missing entries", () => {
    const store = createStore();
    expect(store.getAndDelete("missing")).toBeUndefined();
  });

  it("should list entries via entries()", () => {
    const store = createStore();
    const now = Date.now();
    store.set("a", { value: "one", storedAt: now });
    store.set("b", { value: "two", storedAt: now });

    const entries = store.entries();
    expect(entries).toHaveLength(2);
  });

  it("should evict stale entries from entries()", () => {
    const store = createStore(100);
    store.set("old", { value: "stale", storedAt: Date.now() });

    vi.advanceTimersByTime(200);

    store.set("new", { value: "fresh", storedAt: Date.now() });

    const entries = store.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0][0]).toBe("new");
  });
});
