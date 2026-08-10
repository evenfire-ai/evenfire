/**
 * Scoring module — applies validators from prompts.ts to benchmark results.
 *
 * All scoring is deterministic (regex/keyword/format checks).
 * No LLM-based evaluation to keep results reproducible.
 */

import type { BenchmarkResult } from "./helpers.js";
import { ALL_PROMPTS, type BenchmarkPrompt } from "./prompts.js";

/**
 * Score a single benchmark result using the validator from its prompt definition.
 * Mutates result.score in place and returns the score.
 */
export function scoreResult(result: BenchmarkResult): number {
  if (!result.response || !result.success) {
    result.score = 0;
    return 0;
  }

  const prompt = ALL_PROMPTS.find((p) => p.id === result.testId);
  if (!prompt) {
    console.warn(`[Scoring] No prompt found for testId: ${result.testId}`);
    result.score = 0;
    return 0;
  }

  try {
    const score = prompt.validate(result.response);
    result.score = Math.max(0, Math.min(100, score));
  } catch (e) {
    console.warn(
      `[Scoring] Validator threw for ${result.testId}:`,
      e instanceof Error ? e.message : e,
    );
    result.score = 0;
  }

  return result.score;
}

/**
 * Score all results in a batch. Mutates each result.score.
 */
export function scoreAll(results: BenchmarkResult[]): void {
  for (const r of results) {
    scoreResult(r);
  }
}

/**
 * Compute aggregate scores grouped by provider.
 */
export function aggregateByProvider(
  results: BenchmarkResult[],
): Map<string, { avgScore: number; avgLatency: number; passRate: number; count: number }> {
  const grouped = new Map<string, BenchmarkResult[]>();
  for (const r of results) {
    const key = `${r.provider}/${r.model}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  const agg = new Map<
    string,
    { avgScore: number; avgLatency: number; passRate: number; count: number }
  >();

  for (const [key, provResults] of grouped) {
    const passed = provResults.filter((r) => r.success);
    const avgScore =
      passed.length > 0
        ? passed.reduce((s, r) => s + r.score, 0) / passed.length
        : 0;
    const avgLatency =
      passed.length > 0
        ? passed.reduce((s, r) => s + r.latencyMs, 0) / passed.length
        : 0;
    const passRate =
      provResults.length > 0 ? passed.length / provResults.length : 0;

    agg.set(key, {
      avgScore,
      avgLatency,
      passRate,
      count: provResults.length,
    });
  }

  return agg;
}

/**
 * Compute aggregate scores grouped by category.
 */
export function aggregateByCategory(
  results: BenchmarkResult[],
): Map<
  string,
  Map<string, { avgScore: number; avgLatency: number; count: number }>
> {
  const byCat = new Map<string, Map<string, BenchmarkResult[]>>();

  for (const r of results) {
    if (!byCat.has(r.category)) byCat.set(r.category, new Map());
    const provMap = byCat.get(r.category)!;
    const key = `${r.provider}/${r.model}`;
    if (!provMap.has(key)) provMap.set(key, []);
    provMap.get(key)!.push(r);
  }

  const result = new Map<
    string,
    Map<string, { avgScore: number; avgLatency: number; count: number }>
  >();

  for (const [cat, provMap] of byCat) {
    const catAgg = new Map<
      string,
      { avgScore: number; avgLatency: number; count: number }
    >();
    for (const [prov, rs] of provMap) {
      const passed = rs.filter((r) => r.success);
      catAgg.set(prov, {
        avgScore:
          passed.length > 0
            ? passed.reduce((s, r) => s + r.score, 0) / passed.length
            : 0,
        avgLatency:
          passed.length > 0
            ? passed.reduce((s, r) => s + r.latencyMs, 0) / passed.length
            : 0,
        count: rs.length,
      });
    }
    result.set(cat, catAgg);
  }

  return result;
}
