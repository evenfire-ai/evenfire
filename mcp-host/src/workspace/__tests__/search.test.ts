import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { searchWorkspace } from "../search";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "clerum-search-test-"));
}

describe("searchWorkspace", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when workspace is empty", async () => {
    const results = await searchWorkspace(tmpDir, "hello");
    expect(results).toEqual([]);
  });

  it("finds an exact keyword match", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "API design decisions were made on Tuesday.");
    const results = await searchWorkspace(tmpDir, "API design");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("API design");
  });

  it("scores full match higher than partial match", async () => {
    await fs.writeFile(
      path.join(tmpDir, "full.md"),
      "The API design decisions were documented.",
    );
    await fs.writeFile(
      path.join(tmpDir, "partial.md"),
      "The API endpoint was created last week.",
    );

    const results = await searchWorkspace(tmpDir, "API design decisions");
    expect(results.length).toBeGreaterThanOrEqual(2);
    // full.md matches 3/3 keywords; partial.md matches 1/3
    const fullResult = results.find((r) => r.path === "full.md");
    const partialResult = results.find((r) => r.path === "partial.md");
    expect(fullResult).toBeDefined();
    expect(partialResult).toBeDefined();
    expect(fullResult!.score).toBeGreaterThan(partialResult!.score);
  });

  it("applies recency boost to daily log files", async () => {
    await fs.mkdir(path.join(tmpDir, "daily"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "daily", "2026-02-25.md"),
      "The deployment was successful.",
    );
    await fs.writeFile(
      path.join(tmpDir, "notes.md"),
      "The deployment was successful.",
    );

    const results = await searchWorkspace(tmpDir, "deployment successful");
    const dailyResult = results.find((r) => r.path.startsWith("daily"));
    const notesResult = results.find((r) => r.path === "notes.md");
    expect(dailyResult).toBeDefined();
    expect(notesResult).toBeDefined();
    // Daily logs get 1.2x boost — score should be higher
    expect(dailyResult!.score).toBeGreaterThan(notesResult!.score);
  });

  it("applies identity boost to MEMORY.md", async () => {
    await fs.writeFile(
      path.join(tmpDir, "MEMORY.md"),
      "Database schema finalized.",
    );
    await fs.writeFile(
      path.join(tmpDir, "other.md"),
      "Database schema finalized.",
    );

    const results = await searchWorkspace(tmpDir, "database schema finalized");
    const memoryResult = results.find((r) => r.path === "MEMORY.md");
    const otherResult = results.find((r) => r.path === "other.md");
    expect(memoryResult).toBeDefined();
    expect(otherResult).toBeDefined();
    expect(memoryResult!.score).toBeGreaterThan(otherResult!.score);
  });

  it("respects the limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(path.join(tmpDir, `file${i}.md`), "keyword content here");
    }
    const results = await searchWorkspace(tmpDir, "keyword", { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("truncates long paragraphs to 500 chars", async () => {
    const longContent = "keyword " + "x".repeat(600);
    await fs.writeFile(path.join(tmpDir, "long.md"), longContent);
    const results = await searchWorkspace(tmpDir, "keyword");
    expect(results[0].content.length).toBeLessThanOrEqual(510); // 500 + "…"
  });

  it("returns results sorted by score descending", async () => {
    await fs.writeFile(path.join(tmpDir, "a.md"), "cats and dogs");
    await fs.writeFile(path.join(tmpDir, "b.md"), "cats dogs and birds");

    const results = await searchWorkspace(tmpDir, "cats dogs");
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("is case-insensitive", async () => {
    await fs.writeFile(path.join(tmpDir, "doc.md"), "The API Design is important.");
    const results = await searchWorkspace(tmpDir, "api design");
    expect(results.length).toBeGreaterThan(0);
  });

  it("only searches .md files", async () => {
    await fs.writeFile(path.join(tmpDir, "notes.txt"), "secret keyword here");
    await fs.writeFile(path.join(tmpDir, "notes.md"), "other content");
    const results = await searchWorkspace(tmpDir, "keyword");
    const txtResult = results.find((r) => r.path === "notes.txt");
    expect(txtResult).toBeUndefined();
  });
});
