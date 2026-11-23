import { describe, expect, test } from "bun:test";
import { promptWindowByTool } from "../../../core/analysis/promptwindow";
import { buildSessionTable } from "../../../core/analysis/sessions";
import type { Exclusions } from "../../../core/analysis/types";
import type { Ev, PromptEv } from "../../../core/model/events";
import type { Origin, ToolId, Window } from "../../../core/model/ids";
import { scanResultOf } from "../../kit/scanresult";

const T0 = Date.UTC(2026, 10, 2, 9, 0);
const MIN = 60_000;
const features = { words: 5, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: false, techCats: {} } as const;
let k = 0;
const prompt = (tool: ToolId, window: Window, origin: Origin = "human", ts = T0 + ++k * MIN): PromptEv =>
  ({ k: "prompt", tool, source: `${tool}.${window}`, ts, window, origin, intent: "spec", textHash: `h${++k}`, features });
const many = (n: number, f: () => PromptEv): PromptEv[] => Array.from({ length: n }, f);
const windows = (events: Ev[], exclude?: Exclusions) => {
  const raw = scanResultOf(events);
  return promptWindowByTool(raw, buildSessionTable(raw, { now: raw.finishedAt, timeZone: "UTC", ...(exclude ? { exclude } : {}) }));
};

describe("promptWindowByTool", () => {
  test("the window with more human prompts wins", () => {
    const m = windows([...many(3, () => prompt("claude-code", "detail")), ...many(5, () => prompt("claude-code", "lifetime"))]);
    expect(m.get("claude-code")).toBe("lifetime");
  });

  test("a tie goes to detail", () => {
    const m = windows([...many(4, () => prompt("codex", "detail")), ...many(4, () => prompt("codex", "lifetime"))]);
    expect(m.get("codex")).toBe("detail");
  });

  test("only human prompts count toward the choice", () => {
    const m = windows([...many(3, () => prompt("codex", "detail")), ...many(2, () => prompt("codex", "lifetime")),
      ...many(9, () => prompt("codex", "lifetime", "scripted"))]);
    expect(m.get("codex")).toBe("detail");
  });

  test("a tool with prompts in one window maps to that window, human or not", () => {
    const m = windows([...many(2, () => prompt("cursor", "lifetime")), ...many(2, () => prompt("copilot", "detail", "scripted"))]);
    expect(m.get("cursor")).toBe("lifetime");
    expect(m.get("copilot")).toBe("detail");
    expect(m.has("codex")).toBe(false);
  });

  test("each tool is decided on its own", () => {
    const m = windows([...many(1, () => prompt("claude-code", "detail")), ...many(3, () => prompt("claude-code", "lifetime")),
      ...many(3, () => prompt("codex", "detail")), ...many(1, () => prompt("codex", "lifetime"))]);
    expect([m.get("claude-code"), m.get("codex")]).toEqual(["lifetime", "detail"]);
  });

  test("excluded tools and prompts outside the date range are left out", () => {
    const early = many(5, () => prompt("codex", "lifetime", "human", T0 - 10 * MIN));
    const m = windows([...early, ...many(2, () => prompt("codex", "detail")), ...many(2, () => prompt("cursor", "detail"))],
      { tools: ["cursor"], from: T0 });
    expect(m.get("codex")).toBe("detail");
    expect(m.has("cursor")).toBe(false);
  });
});
