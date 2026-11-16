import { expect, test } from "bun:test";
import { classifyIntent } from "../../../core/text/intent";
import { intentCases } from "./intent.cases";

test.each(intentCases)("classifyIntent(%j) → %s", (text, want) => {
  expect(classifyIntent(text)).toBe(want);
});

test("every intent has at least 6 cases", () => {
  const n: Record<string, number> = {};
  for (const [, i] of intentCases) n[i] = (n[i] ?? 0) + 1;
  for (const i of ["spec", "question", "ack", "correction", "redirect", "command", "continuation"]) expect(n[i]).toBeGreaterThanOrEqual(6);
});
