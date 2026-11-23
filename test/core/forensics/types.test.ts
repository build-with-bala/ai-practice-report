import { expect, test } from "bun:test";
import type { CheckResult, CheckValues } from "../../../core/forensics/types";

/*
 * Compile-time pins for the closed `values` vocabulary, in the pattern the checks use (a values object built with
 * `satisfies CheckValues`, then spread into a result). If a `@ts-expect-error` below stops being an error, the suite's
 * type check (`bunx tsc --noEmit`) fails: the hole has reopened.
 */

test("values objects are checked where they are built", () => {
  const tools: CheckResult["tools"] = [];
  // @ts-expect-error an unlisted key
  const leaky = { id: "C6" as const, n: 1, values: { missing: 1, cwd: "/somewhere" } satisfies CheckValues, tools };
  // @ts-expect-error a string under a key other than `date`
  const stringy = { id: "C6" as const, n: 1, values: { missing: "1" } satisfies CheckValues, tools };
  // @ts-expect-error a number under `date`
  const undated = { values: { date: 20261001 } satisfies CheckValues };
  const fine = { id: "C6" as const, n: 1, values: { missing: 1, date: "2026-10-01" } satisfies CheckValues, tools };
  const c: CheckResult = { ...fine, status: "pass", reason: "ok" };
  // @ts-expect-error a reason outside the closed list
  const odd: CheckResult = { ...fine, status: "pass", reason: "made-up" };
  expect([leaky.n, stringy.n, undated.values.date, c.values.missing, odd.n]).toEqual([1, 1, 20261001, 1, 1]);
});
