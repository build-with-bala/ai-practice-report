import { expect, test } from "bun:test";
import { shingleSimilarity } from "../../../core/text/similarity";

test("identical → 1", () => expect(shingleSimilarity("fix the login bug", "fix the login bug")).toBe(1));
test("disjoint → 0", () => expect(shingleSimilarity("aaaaaaaa", "zzzzzzzz")).toBe(0));
test("near", () => expect(shingleSimilarity("fix the login bug", "fix the login bug please")).toBeGreaterThan(0.6));
test("empty → 0", () => {
  expect(shingleSimilarity("", "x")).toBe(0);
  expect(shingleSimilarity("", "")).toBe(0);
});
test("case and whitespace normalized", () => expect(shingleSimilarity("Fix  The\nBug now", "fix the bug now")).toBe(1));
test("short strings compare whole", () => {
  expect(shingleSimilarity("ab", "ab")).toBe(1);
  expect(shingleSimilarity("ab", "abc")).toBe(0);
});
