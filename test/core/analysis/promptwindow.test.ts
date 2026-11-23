import { describe, expect, test } from "bun:test";
import { promptWindowByTool } from "../../../core/analysis/promptwindow";
import { buildSessionTable } from "../../../core/analysis/sessions";
import type { Exclusions } from "../../../core/analysis/types";
import type { Ev, PromptEv, SessionEv } from "../../../core/model/events";
import type { Origin, ToolId, Window } from "../../../core/model/ids";
import { scanResultOf } from "../../kit/scanresult";

const T0 = Date.UTC(2026, 10, 2, 9, 0);
const MIN = 60_000;
const features = { words: 5, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: false, techCats: {} } as const;
let k = 0;
/** A prompt; a detail one belongs to its tool's main session (`windows` adds those sessions), as real transcript prompts do. */
const prompt = (tool: ToolId, window: Window, origin: Origin = "human", ts = T0 + ++k * MIN): PromptEv =>
  ({ k: "prompt", tool, source: `${tool}.${window}`, ts, window, origin, intent: "spec", textHash: `h${++k}`, features,
    ...(window === "detail" ? { sessionId: `${tool}:main` } : {}) });
const many = (n: number, f: () => PromptEv): PromptEv[] => Array.from({ length: n }, f);
const mainSession = (tool: ToolId): SessionEv => ({
  k: "session", tool, source: `${tool}.detail`, id: `${tool}:main`, window: "detail", origin: "human", start: T0 - 1_000 * MIN, end: T0 + 10_000 * MIN, models: [],
});
const windows = (events: Ev[], exclude?: Exclusions) => {
  const mains = new Set<ToolId>();
  for (const e of events) if (e.k === "prompt" && e.sessionId === `${e.tool}:main`) mains.add(e.tool);
  const raw = scanResultOf([...[...mains].map(mainSession), ...events]);
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

  const session = (id: string, projectKey: string, start = T0): SessionEv => ({
    k: "session", tool: "codex", source: "codex.detail", id, window: "detail", origin: "human", start, end: start + 300 * MIN, models: [], projectKey,
  });
  const inSession = (id: string, ts?: number): PromptEv => ({ ...prompt("codex", "detail", "human", ts), sessionId: id });

  test("an excluded project's prompts do not sway the choice", () => {
    const evs: Ev[] = [session("codex:a", "kA"), session("codex:b", "kB"), ...many(2, () => inSession("codex:a")),
      ...many(9, () => inSession("codex:b")), ...many(5, () => prompt("codex", "lifetime"))];
    expect(windows(evs).get("codex")).toBe("detail");
    expect(windows(evs, { projects: ["kB"] }).get("codex")).toBe("lifetime");
  });

  test("an excluded tool's prompts do not count, and a tool left with none has no window", () => {
    const evs: Ev[] = [...many(3, () => prompt("codex", "detail")), ...many(1, () => prompt("codex", "lifetime")), ...many(3, () => prompt("cursor", "detail"))];
    const m = windows(evs, { tools: ["codex"] });
    expect([m.has("codex"), m.get("cursor")]).toEqual([false, "detail"]);
  });

  test("a date range decides with the prompts inside it, and sessions it drops do not count", () => {
    const late = T0 + 1_000 * MIN;
    const evs: Ev[] = [session("codex:old", "kA", T0 - 2_000 * MIN), ...many(9, () => inSession("codex:old", T0 + 5 * MIN)),
      ...many(4, () => prompt("codex", "detail", "human", late)), ...many(6, () => prompt("codex", "lifetime", "human", late))];
    expect(windows(evs).get("codex")).toBe("detail");
    expect(windows(evs, { from: late }).get("codex")).toBe("lifetime");
  });

  test("detail prompts of a session the store does not hold do not count: the window is chosen by what is read", () => {
    const evs: Ev[] = [...many(10, () => prompt("codex", "detail")), ...many(100, () => ({ ...prompt("codex", "detail"), sessionId: "codex:gone" })),
      ...many(50, () => prompt("codex", "lifetime"))];
    expect(windows(evs).get("codex")).toBe("lifetime");
  });

  test("a tool whose detail prompts are all host copies chooses by its remaining prompts", () => {
    const relayed = (tool: ToolId, id: string, i: number): PromptEv => ({ ...prompt(tool, "detail", "human", T0 + i * MIN), sessionId: id, textHash: `relayed-${i}` });
    const evs: Ev[] = [
      { ...mainSession("claude-code"), id: "claude-code:relayed" },
      { ...mainSession("copilot"), id: "copilot:host", surface: "vscode" },
      ...Array.from({ length: 6 }, (_, i) => [relayed("claude-code", "claude-code:relayed", i), relayed("copilot", "copilot:host", i)]).flat(),
      ...many(2, () => prompt("copilot", "lifetime")),
    ];
    const raw = scanResultOf(evs);
    const t = buildSessionTable(raw, { now: raw.finishedAt, timeZone: "UTC" });
    expect(t.hosts.has("copilot:host")).toBe(true);
    expect(promptWindowByTool(raw, t).get("copilot")).toBe("lifetime");
  });
});
