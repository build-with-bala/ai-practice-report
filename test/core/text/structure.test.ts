import { expect, test } from "bun:test";
import { promptFeatures } from "../../../core/text/structure";

test("short prompt", () => {
  const f = promptFeatures("fix the bug");
  expect(f).toMatchObject({ words: 3, lenBucket: 0, hasContext: false, fileRefs: 0, listLines: 0, isTaskStart: false, techCats: {} });
  expect("simToPrev" in f).toBe(false);
});
test("empty", () => {
  expect(promptFeatures("  ")).toMatchObject({ words: 0, lenBucket: 0 });
});
test("length buckets", () => {
  const w = (n: number) => promptFeatures(Array(n).fill("a").join(" ")).lenBucket;
  expect([w(4), w(5), w(19), w(20), w(59), w(60), w(199), w(200)]).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);
});
test("fenced block and file ref", () => {
  const f = promptFeatures("see src/api.ts\n```\nconst x = 1\n```");
  expect(f.hasContext).toBe(true);
  expect(f.fileRefs).toBe(1);
});
test("stack trace and paste context", () => {
  expect(promptFeatures("TypeError: x is undefined").hasContext).toBe(true);
  expect(promptFeatures("hello", { hasPaste: true }).hasContext).toBe(true);
});
test("list lines", () => {
  expect(promptFeatures("todo:\n- a\n* b\n1. c\n2) d").listLines).toBe(4);
});
test("constraints", () => {
  expect(promptFeatures("must keep the API; don't break callers").constraintTerms).toBeGreaterThanOrEqual(2);
});
test("options, tech and similarity", () => {
  const f = promptFeatures("add redis cache to the database", { isTaskStart: true, prevText: "add redis cache to the database layer" });
  expect(f.isTaskStart).toBe(true);
  expect(f.simToPrev).toBeGreaterThan(0.6);
  expect(f.techCats.data).toBeGreaterThanOrEqual(2);
});
