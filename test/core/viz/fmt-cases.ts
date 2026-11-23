import { fmt } from "../../../core/viz/fmt";

/** The brief's fmt cases as `[label, output]` pairs, shared by the in-process test and the cross-locale child. */
export const fmtCases = (): [string, string][] => [
  ["share 0.004", fmt.share(0.004)], ["share 0.61", fmt.share(0.61)], ["share 0.996", fmt.share(0.996)],
  ["count", fmt.count(1234567)], ["interval", fmt.interval([63, 78])], ["signed", fmt.signed(-0.42)],
  ["tokens 600k", fmt.tokens(600_000)], ["tokens 1.5M", fmt.tokens(1_500_000)],
  ["duration 14", fmt.duration(14 * 60_000)], ["duration 130", fmt.duration(130 * 60_000)],
  ["day", fmt.day(Date.UTC(2026, 10, 17, 23, 30), "Pacific/Auckland")],
  ["month", fmt.month("2026-11")], ["week", fmt.week("2026-W47")],
  ["span", fmt.span(Date.UTC(2026, 2, 3), Date.UTC(2026, 10, 18), "UTC")], ["decimal", fmt.decimal(1234.5, 1)],
  ["count big", fmt.count(9_876_543_210)],
  ["negatives", [fmt.score(-3), fmt.tokens(-1_500_000), fmt.duration(-130 * 60_000), fmt.count(-1234), fmt.decimal(-1.25, 1)].join(" ")],
  ["count huge", fmt.count(1e21)], ["week 53", fmt.week("2026-W53")], ["week 99", fmt.week("2026-W99")],
];
