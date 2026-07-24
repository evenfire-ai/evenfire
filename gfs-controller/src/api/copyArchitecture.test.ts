import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (name: string): string => readFileSync(join(process.cwd(), "src/api", name), "utf8");

describe("Copy architecture boundary", () => {
  it("does not depend on Move or request delete authority", () => {
    const copySources = [source("./copy.ts"), source("./copyRoute.ts")].join("\n");

    expect(copySources).not.toMatch(/from\s+["']\.\/move["']/);
    expect(copySources).not.toMatch(/MoveError|planMove|requiredChecks/);
    expect(copySources).not.toMatch(/op:\s*["']delete["']|authorizeDelete|\.delete\s*\(/);
  });
});
