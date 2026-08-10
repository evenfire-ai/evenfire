import { describe, it, expect } from "vitest";
import { parseBackgroundPrefix } from "../types";

describe("parseBackgroundPrefix", () => {
  it("should detect /bg prefix and strip it", () => {
    const result = parseBackgroundPrefix("/bg research competitors");
    expect(result).toEqual({ isBackground: true, content: "research competitors" });
  });

  it("should handle /bg with extra whitespace", () => {
    const result = parseBackgroundPrefix("/bg   research competitors");
    expect(result).toEqual({ isBackground: true, content: "research competitors" });
  });

  it("should return isBackground=false for normal messages", () => {
    const result = parseBackgroundPrefix("hello world");
    expect(result).toEqual({ isBackground: false, content: "hello world" });
  });

  it("should not match /bgfoo (must be /bg followed by space)", () => {
    const result = parseBackgroundPrefix("/bgfoo bar");
    expect(result).toEqual({ isBackground: false, content: "/bgfoo bar" });
  });

  it("should reject /bg with no instruction", () => {
    const result = parseBackgroundPrefix("/bg");
    expect(result).toEqual({ isBackground: false, content: "/bg" });
  });

  it("should reject /bg with only whitespace after", () => {
    const result = parseBackgroundPrefix("/bg   ");
    expect(result).toEqual({ isBackground: false, content: "/bg   " });
  });
});
