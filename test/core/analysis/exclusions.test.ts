import { describe, expect, test } from "bun:test";
import { analyze } from "../../../core/analyze";
import { ExclusionError } from "../../../core/analysis/exclusions";
import { buildSessionTable } from "../../../core/analysis/sessions";
import type { ToolId } from "../../../core/model/ids";
import { scanResultOf } from "../../kit/scanresult";

const opts = { timeZone: "UTC" };
const T0 = Date.UTC(2026, 10, 2, 9, 0);

describe("exclusions fail closed", () => {
  const raw = () => scanResultOf([{ k: "session", tool: "claude-code", source: "claude-code.transcripts", id: "s", window: "detail", origin: "human", start: T0, end: T0 + 1, models: [] }]);
  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ["an unknown tool", { tools: ["claude"] }, /tool exclusion/],
    ["a tool list that is no list", { tools: "codex" }, /tool exclusion/],
    ["a NaN start", { from: Number.NaN }, /date range/],
    ["a NaN end", { to: Number.NaN }, /date range/],
    ["an infinite end", { to: Infinity }, /date range/],
    ["a start that is no number", { from: "2026-01-01" }, /date range/],
    ["a start later than the end", { from: T0 + 10, to: T0 }, /later than/],
  ];
  for (const [what, exclude, msg] of bad) {
    test(`${what} throws ExclusionError from analyze and from buildSessionTable`, () => {
      const ex = exclude as never;
      expect(() => analyze(raw(), { ...opts, exclude: ex })).toThrow(ExclusionError);
      expect(() => analyze(raw(), { ...opts, exclude: ex })).toThrow(msg);
      expect(() => buildSessionTable(raw(), { ...opts, exclude: ex })).toThrow(ExclusionError);
    });
  }

  test("a range end beyond what a date can hold throws ExclusionError, not a date-library error", () => {
    for (const exclude of [{ from: 9e15 }, { to: -9e15 }, { from: 0, to: 8.7e15 }]) {
      expect(() => buildSessionTable(raw(), { ...opts, exclude })).toThrow(ExclusionError);
      expect(() => analyze(raw(), { ...opts, exclude })).toThrow(/date range/);
    }
    expect(() => buildSessionTable(raw(), { ...opts, exclude: { from: -8.64e15, to: 8.64e15 } })).not.toThrow();
  });

  test("a direct buildSessionTable call with a project key nothing carries throws ExclusionError", () => {
    expect(() => buildSessionTable(raw(), { ...opts, exclude: { projects: ["kNowhere"] } })).toThrow(ExclusionError);
  });

  test("a valid range and known tools pass; equal ends are a valid one-instant range", () => {
    expect(() => buildSessionTable(raw(), { ...opts, exclude: { tools: ["codex", "jetbrains-ai"], from: T0, to: T0 } })).not.toThrow();
  });

  test("the message quotes only an entry shaped like a label, a keyed hash, or a known tool", () => {
    const msg = (f: () => unknown): string => { try { f(); } catch (e) { return (e as Error).message; } return ""; };
    expect(msg(() => buildSessionTable(raw(), { ...opts, exclude: { tools: ["AcmeSecret" as ToolId] } }))).not.toContain("AcmeSecret");
    expect(msg(() => analyze(raw(), { ...opts, exclude: { projects: ["AcmeSecretProject"] } }))).not.toContain("AcmeSecret");
    expect(msg(() => analyze(raw(), { ...opts, exclude: { projects: ["P-00AB"] } }))).toContain('"P-00AB"');
    expect(msg(() => analyze(raw(), { ...opts, exclude: { projects: ["0123456789abcdef"] } }))).toContain('"0123456789abcdef"');
    expect(msg(() => analyze(raw(), { ...opts, exclude: { projects: ["codex"] } }))).toContain('"codex"');
    expect(msg(() => analyze(raw(), { ...opts, exclude: { projects: ["deadbeef"] } }))).not.toContain("deadbeef");
  });
});
