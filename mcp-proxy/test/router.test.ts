import { describe, it, expect, beforeEach } from "vitest";
import { Router } from "../src/router";
import { ServerRoute } from "../src/types";

function makeRoute(name: string, overrides: Partial<ServerRoute> = {}): ServerRoute {
  return {
    name,
    url: `http://${name}.mcp-server:3000/mcp`,
    contextRef: "context1",
    managed: true,
    ready: true,
    port: 3000,
    ...overrides,
  };
}

describe("Router", () => {
  let router: Router;

  beforeEach(() => {
    router = new Router();
  });

  it("should add routes from update", () => {
    const { added, removed } = router.update([makeRoute("server-a"), makeRoute("server-b")]);
    expect(added).toEqual(["server-a", "server-b"]);
    expect(removed).toEqual([]);
    expect(router.size()).toBe(2);
  });

  it("should detect removed routes", () => {
    router.update([makeRoute("server-a"), makeRoute("server-b")]);
    const { added, removed } = router.update([makeRoute("server-a")]);
    expect(added).toEqual([]);
    expect(removed).toEqual(["server-b"]);
    expect(router.size()).toBe(1);
  });

  it("should update existing routes", () => {
    router.update([makeRoute("server-a", { ready: true })]);
    router.update([makeRoute("server-a", { ready: false })]);
    expect(router.resolve("server-a")!.ready).toBe(false);
  });

  it("should resolve by name", () => {
    router.update([makeRoute("server-a")]);
    const route = router.resolve("server-a");
    expect(route).toBeDefined();
    expect(route!.name).toBe("server-a");
  });

  it("should return undefined for unknown server", () => {
    expect(router.resolve("nonexistent")).toBeUndefined();
  });

  it("should detect added routes on subsequent updates", () => {
    router.update([makeRoute("server-a")]);
    const { added } = router.update([makeRoute("server-a"), makeRoute("server-b")]);
    expect(added).toEqual(["server-b"]);
  });

  it("should report hasReadyServers correctly", () => {
    expect(router.hasReadyServers()).toBe(false);
    router.update([makeRoute("server-a", { ready: false })]);
    expect(router.hasReadyServers()).toBe(false);
    router.update([makeRoute("server-a", { ready: true })]);
    expect(router.hasReadyServers()).toBe(true);
  });

  it("should list all routes", () => {
    router.update([makeRoute("server-a"), makeRoute("server-b")]);
    expect(router.allRoutes()).toHaveLength(2);
  });

  it("should clear all routes", () => {
    router.update([makeRoute("server-a")]);
    router.clear();
    expect(router.size()).toBe(0);
  });
});
