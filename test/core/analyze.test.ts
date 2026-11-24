import { describe, expect, test } from "bun:test";
import { analyze, ExclusionError, type Analysis } from "../../core/analyze";
import { VERSION } from "../../core/index";
import type { CoverageEv, Ev, IdentityEv, PromptEv, PromptFeatures, SessionEv, ToolEv } from "../../core/model/events";
import type { ScanResult, Warning } from "../../core/scan";
import { personaScan } from "../fixtures/personas";
import { expectNoCanaries, findCanaries } from "../kit/canary";
import { scanResultOf } from "../kit/scanresult";

const DAY = 86_400_000;
const UTC = { timeZone: "UTC" } as const;
const CC = "claude-code.transcripts";
const CX = "codex.rollouts";
const features: PromptFeatures = { words: 8, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: true, techCats: {} };

const idEv = (hash: string, o: { sessionId?: string; tool?: "claude-code" | "codex" } = {}): IdentityEv => ({
  k: "identity", tool: o.tool ?? "claude-code", source: o.tool === "codex" ? CX : CC, scope: o.sessionId ? "session" : "config", hash,
  ...(o.sessionId ? { sessionId: o.sessionId } : {}),
});
const warning = (tool: Warning["tool"]): Warning => ({ code: "error", tool, source: tool === "scan" ? "scan" : `${tool}.x`, detail: "Error" });
const covEv = (source: string, window: "detail" | "lifetime", over: Partial<CoverageEv> = {}): CoverageEv => ({
  k: "coverage", tool: "claude-code", source, window, status: "ok", beta: false, files: 1, bytes: 1, records: 1, skipped: {}, unknownTypes: {}, versions: [], ...over,
});
const sessEv = (id: string, start: number, over: Partial<SessionEv> = {}): SessionEv =>
  ({ k: "session", tool: "claude-code", source: CC, id, window: "detail", origin: "human", start, end: start + 3_600_000, models: [], ...over });
const promptEv = (sessionId: string, ts: number, i: number): PromptEv =>
  ({ k: "prompt", tool: "claude-code", source: CC, ts, sessionId, window: "detail", origin: "human", intent: "spec", textHash: `p${i}`, features });
const toolEv = (sessionId: string, ts: number): ToolEv => ({ k: "tool", tool: "claude-code", source: CC, ts, sessionId, name: "Read", category: "read", ok: true });
/** A persona scan with extra events and warnings added. */
const withExtras = (raw: ScanResult, evs: Ev[], warnings: Warning[] = []): ScanResult => {
  for (const e of evs) raw.store.add(e);
  raw.warnings.push(...warnings);
  return raw;
};

/** Every path in `v` whose value is not plain data: a number that is not finite, or an object that is not a plain object or array. */
function impurities(v: unknown, path = "$", out: string[] = []): string[] {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) out.push(`${path}: ${v}`);
  } else if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") {
    out.push(`${path}: ${typeof v}`);
  } else if (v !== null && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== Array.prototype) out.push(`${path}: ${proto?.constructor?.name ?? "null prototype"}`);
    else for (const [k, x] of Object.entries(v)) impurities(x, `${path}.${k}`, out);
  }
  return out;
}

/** Every object in `v` that has a `value` key holding a number or null, with its path. */
function metrics(v: unknown, path = "$", out: Array<{ path: string; m: Record<string, unknown> }> = []): typeof out {
  if (v === null || typeof v !== "object") return out;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(v) && "value" in o && (o.value === null || typeof o.value === "number")) out.push({ path, m: o });
  for (const [k, x] of Object.entries(o)) metrics(x, `${path}.${k}`, out);
  return out;
}

describe("analyze()", () => {
  const expert = analyze(personaScan("expert"), UTC);

  test("deterministic plain data: two runs are deep-equal, a JSON round trip is lossless, every number is finite", () => {
    expect(analyze(personaScan("expert"), UTC)).toEqual(expert);
    expect(JSON.parse(JSON.stringify(expert))).toEqual(expert);
    expect(impurities(expert)).toEqual([]);
  });

  test("meta: the defaults, with now = raw.finishedAt", () => {
    const raw = personaScan("expert");
    expect(expert.meta).toEqual({ core: VERSION, reference: "v0", bootstrap: 200, seed: 0x5eed, now: raw.finishedAt, timeZone: "UTC", repoSignals: "ok" });
  });

  test("the default time zone is the process zone, read through Intl", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(analyze(scanResultOf([])).meta.timeZone).toBe(zone);
  });

  test("every metric carries its meta: window, n and sources", () => {
    const found = metrics(expert);
    expect(found.length).toBeGreaterThan(30);
    for (const { path, m } of found) {
      expect([path, m.window === "detail" || m.window === "lifetime"]).toEqual([path, true]);
      expect([path, typeof m.n === "number"]).toEqual([path, true]);
      expect([path, Array.isArray(m.sources)]).toEqual([path, true]);
    }
  });

  test("the persona scores, with bootstrap intervals that hold each point score", () => {
    const scored = expert.dimensions.filter((d) => d.status === "scored");
    expect(scored.length).toBeGreaterThanOrEqual(3);
    for (const d of scored) {
      expect(d.interval).not.toBeNull();
      const [lo, hi] = d.interval!;
      expect(lo).toBeLessThanOrEqual(d.score!);
      expect(hi).toBeGreaterThanOrEqual(d.score!);
    }
    expect(expert.overall.status).toBe("scored");
    expect(expert.overall.interval).not.toBeNull();
    expect(expert.overall.interval![0]).toBeLessThanOrEqual(expert.overall.score!);
    expect(expert.overall.interval![1]).toBeGreaterThanOrEqual(expert.overall.score!);
    expect(expert.overall.coverage).toBe(`${expert.overall.included.length}/7`);
    expect(expert.personas.length).toBeGreaterThan(0);
  });

  test("the seed and the replicate count reach the bootstrap; the point scores do not move", () => {
    const other = analyze(personaScan("expert"), { ...UTC, seed: 7, bootstrap: 50 });
    expect(other.meta).toMatchObject({ seed: 7, bootstrap: 50 });
    expect(other.dimensions.map((d) => [d.id, d.status, d.z, d.score])).toEqual(expert.dimensions.map((d) => [d.id, d.status, d.z, d.score]));
  });

  test("a forensic result never changes a score", () => {
    const releases = { version: 1, models: [{ match: "^claude-", released: "2099-01-01", source: "test" }], tools: {} };
    const a = analyze(personaScan("expert"), { ...UTC, releases });
    expect(a.forensics.checks.find((c) => c.id === "C9")!.status).toBe("fail");
    expect(a.forensics.band).toBe("inconsistent");
    expect(a.dimensions).toEqual(expert.dimensions);
    expect(a.overall).toEqual(expert.overall);
  });

  test("canaries in config names, cwds and model ids appear only under private", () => {
    const a = analyze(personaScan("expert", { canaries: true }), UTC);
    expectNoCanaries({ ...a, private: undefined });
    const inPrivate = findCanaries(a.private);
    expect(inPrivate).toContain("project");
    expect(inPrivate).toContain("slug");
    expect(findCanaries(a)).toEqual(inPrivate);
  });

  test("project keys and labels are keyed hashes, never raw names", () => {
    for (const p of expert.projects) {
      expect(p.key).toMatch(/^[0-9a-f]+$/);
      expect(p.label).toMatch(/^P-(?:[0-9A-F]{2}){2,8}$/);
    }
  });

  test("excluding the busiest project by label drops it and its sessions; its key does the same", () => {
    const busiest = expert.projects[0]!;
    const byLabel = analyze(personaScan("expert"), { ...UTC, exclude: { projects: [busiest.label] } });
    expect(byLabel.exclusions.projects).toBe(1);
    expect(byLabel.exclusions.sessions).toBeGreaterThanOrEqual(busiest.sessions);
    expect(byLabel.projects.find((p) => p.key === busiest.key)).toBeUndefined();
    const sessions = (a: Analysis): number => a.projects.reduce((s, p) => s + p.sessions, 0);
    expect(sessions(byLabel)).toBe(sessions(expert) - busiest.sessions);
    expect(byLabel.signals.evidence.sessions).toBeLessThan(expert.signals.evidence.sessions);
    expect(analyze(personaScan("expert"), { ...UTC, exclude: { projects: [busiest.key] } })).toEqual(byLabel);
  });

  test("excluding the only tool leaves nothing to score, and nothing of the tool anywhere", () => {
    const raw = withExtras(personaScan("expert"), [idEv("cc-account")], [warning("claude-code"), warning("scan")]);
    const a = analyze(raw, { ...UTC, exclude: { tools: ["claude-code"] } });
    expect(a.exclusions.tools).toBe(1);
    expect(a.dimensions.every((d) => d.status !== "scored")).toBe(true);
    expect(a.projects).toEqual([]);
    expect(a.identity).toEqual({ accounts: 0, hashes: [] });
    expect(a.coverage.rows).toEqual([]);
    expect(a.diagnostics.warnings).toEqual([warning("scan")]);
    const kept = analyze(withExtras(personaScan("expert"), [idEv("cc-account")], [warning("claude-code"), warning("scan")]), UTC);
    expect(kept.identity.hashes).toEqual(["cc-account"]);
    expect(kept.diagnostics.warnings).toEqual([warning("claude-code"), warning("scan")]);
    expect(kept.coverage.rows.length).toBeGreaterThan(0);
  });

  test("an excluded tool's warnings are dropped; other tools' and the scan's are kept", () => {
    const raw = scanResultOf([]);
    raw.warnings.push(warning("codex"), warning("claude-code"), warning("scan"));
    expect(analyze(raw, { ...UTC, exclude: { tools: ["codex"] } }).diagnostics.warnings).toEqual([warning("claude-code"), warning("scan")]);
  });

  test("a project exclusion fails closed: an unknown entry throws; labels match in any case; keys match exactly", () => {
    const busiest = expert.projects[0]!;
    expect(() => analyze(personaScan("expert"), { ...UTC, exclude: { projects: ["P-0000"] } })).toThrow(ExclusionError);
    expect(() => analyze(personaScan("expert"), { ...UTC, exclude: { projects: ["P-0000"] } })).toThrow(/"P-0000" matches no project label or key/);
    expect(() => analyze(personaScan("expert"), { ...UTC, exclude: { projects: ["/home/dev/x"] } })).toThrow(/^analyze: the project exclusion matches no project label or key$/);
    expect(() => analyze(personaScan("expert"), { ...UTC, exclude: { projects: [busiest.key.toUpperCase()] } })).toThrow(ExclusionError);
    const lower = analyze(personaScan("expert"), { ...UTC, exclude: { projects: [busiest.label.toLowerCase()] } });
    expect(lower.exclusions.projects).toBe(1);
    expect(analyze(personaScan("expert"), { ...UTC, exclude: { projects: [busiest.key] } })).toEqual(lower);
  });

  test("identity leaves out the sessions of excluded projects and periods", () => {
    const T = Date.UTC(2026, 10, 2, 9);
    const evs: Ev[] = [
      covEv(CC, "detail"),
      sessEv("in", T, { projectKey: "kA" }), sessEv("other", T, { projectKey: "kB" }), sessEv("early", T - 20 * DAY, { projectKey: "kA" }),
      sessEv("child", T, { projectKey: "kB", parentId: "other", origin: "subagent" }),
      idEv("h-in", { sessionId: "in" }), idEv("h-other", { sessionId: "other" }), idEv("h-early", { sessionId: "early" }),
      idEv("h-child", { sessionId: "child" }), idEv("h-config"), idEv("h-loose", { sessionId: undefined }),
      { ...idEv("h-unbound"), scope: "session" },
    ];
    const all = analyze(scanResultOf(evs), UTC);
    expect(all.identity).toEqual({ accounts: 7, hashes: ["h-child", "h-config", "h-early", "h-in", "h-loose", "h-other", "h-unbound"] });
    const a = analyze(scanResultOf(evs), { ...UTC, exclude: { projects: ["kB"], from: T - DAY } });
    expect(a.identity).toEqual({ accounts: 4, hashes: ["h-config", "h-in", "h-loose", "h-unbound"] });
  });

  test("identity: the distinct identity hashes, sorted", () => {
    const id = (hash: string, sessionId?: string): IdentityEv =>
      ({ k: "identity", tool: "claude-code", source: "claude-code.transcripts", scope: sessionId ? "session" : "config", hash, ...(sessionId ? { sessionId } : {}) });
    const a = analyze(scanResultOf([id("bb"), id("aa"), id("bb")]), UTC);
    expect(a.identity).toEqual({ accounts: 2, hashes: ["aa", "bb"] });
    expect(analyze(scanResultOf([id("aa")]), { ...UTC, exclude: { tools: ["claude-code"] } }).identity).toEqual({ accounts: 0, hashes: [] });
    expect(expert.identity).toEqual({ accounts: 0, hashes: [] });
  });

  test("purity: the scan result is not changed", () => {
    const raw = personaScan("intermediate");
    const before = JSON.stringify([raw.store.all("session"), raw.coverage, raw.warnings, raw.finishedAt]);
    analyze(raw, UTC);
    expect(JSON.stringify([raw.store.all("session"), raw.coverage, raw.warnings, raw.finishedAt])).toBe(before);
  });
});

describe("Review Focus 1: a home with nothing to score", () => {
  const unscored = new Set(["insufficient", "not-measurable", "not-measured"]);

  test("an empty ScanResult: nothing scores, the overall is insufficient, forensics unverifiable, nothing NaN", () => {
    const a = analyze(scanResultOf([]), UTC);
    for (const d of a.dimensions) {
      expect([d.id, unscored.has(d.status)]).toEqual([d.id, true]);
      expect(Number.isFinite(d.n)).toBe(true);
      expect(d.needs).toBeGreaterThan(0);
    }
    // every dimension lacks the data to be measured; Delivery needs repo signals, which are off here
    expect(a.dimensions.map((d) => [d.id, d.status])).toEqual([
      ["leverage", "not-measurable"], ["orchestration", "not-measurable"], ["verification", "not-measurable"], ["steering", "not-measurable"],
      ["context", "not-measurable"], ["judgment", "not-measurable"], ["delivery", "not-measured"],
    ]);
    expect(a.overall.status).toBe("insufficient");
    expect(a.overall.coverage).toBe("0/7");
    expect(a.forensics.band).toBe("unverifiable");
    expect(a.personas).toEqual([]);
    expect(a.exposure.tenureWeeks.value).toBeNull();
    expect(impurities(a)).toEqual([]);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });

  test("a lifetime-only ScanResult: exposure has tenure and weeks, and no detail dimension scores", () => {
    const now = Date.UTC(2026, 10, 16);
    const HIST = "claude-code.history";
    const cov: CoverageEv = { k: "coverage", tool: "claude-code", source: HIST, window: "lifetime", status: "ok", beta: false, files: 1, bytes: 1,
      records: 30, skipped: {}, unknownTypes: {}, versions: [] };
    const prompt = (i: number): PromptEv => ({ k: "prompt", tool: "claude-code", source: HIST, ts: now - (90 - 3 * i) * DAY, window: "lifetime",
      origin: "human", intent: "spec", textHash: `h${i}`,
      features: { words: 8, lenBucket: 1, hasContext: false, fileRefs: 0, listLines: 0, constraintTerms: 0, isTaskStart: true, techCats: {} } });
    const evs: Ev[] = [cov, ...Array.from({ length: 30 }, (_, i) => prompt(i))];
    const a = analyze(scanResultOf(evs, { finishedAt: now }), UTC);
    expect(a.exposure.tenureWeeks.window).toBe("lifetime");
    expect(a.exposure.tenureWeeks.value).toBeGreaterThanOrEqual(13);
    expect(a.exposure.activeWeeks.lifetime.value).toBeGreaterThan(10);
    expect(a.exposure.activeWeeks.detail.value).toBeNull();
    for (const d of a.dimensions) {
      expect([d.id, unscored.has(d.status)]).toEqual([d.id, true]);
      expect(Number.isFinite(d.n)).toBe(true);
      expect(d.needs).toBeGreaterThan(0);
    }
    // the detail layer is empty, so no component has data; Delivery needs repo signals, which are off here
    expect(a.dimensions.map((d) => [d.id, d.status])).toEqual([
      ["leverage", "not-measurable"], ["orchestration", "not-measurable"], ["verification", "not-measurable"], ["steering", "not-measurable"],
      ["context", "not-measurable"], ["judgment", "not-measurable"], ["delivery", "not-measured"],
    ]);
    expect(a.overall.status).toBe("insufficient");
    expect(impurities(a)).toEqual([]);
  });
});

describe("Review Focus 3: one persona under two zones", () => {
  const perWeek = new Set(["orc.headless", "jud.switches", "del.prs"]);
  const xs = (a: Analysis) => a.dimensions.flatMap((d) => d.components.map((c) => [c.id, c.x] as const));
  const localDay = (ms: number, timeZone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

  test.each([
    [0, "the same local date in both zones"],
    [12, "the next local date in Auckland"],
  ])("hourUtc %d (%s): the zone arrives, and every component other than the per-week rates has an equal x", (hourUtc) => {
    const utc = analyze(personaScan("intermediate", { hourUtc }), { timeZone: "UTC" });
    const akl = analyze(personaScan("intermediate", { hourUtc }), { timeZone: "Pacific/Auckland" });
    // the zone reaches the analysis: the day parts move, and so does the first active day
    expect(akl.private.dayParts).not.toEqual(utc.private.dayParts);
    const first = utc.exposure.tenureWeeks.from!;
    const firstWork = first + hourUtc * 3_600_000; // the persona's first active day starts at hourUtc
    expect(localDay(utc.exposure.tenureWeeks.from!, "UTC")).toBe(localDay(firstWork, "UTC"));
    expect(localDay(akl.exposure.tenureWeeks.from!, "Pacific/Auckland")).toBe(localDay(firstWork, "Pacific/Auckland"));
    if (hourUtc === 12) expect(localDay(firstWork, "Pacific/Auckland")).not.toBe(localDay(firstWork, "UTC"));
    else expect(localDay(firstWork, "Pacific/Auckland")).toBe(localDay(firstWork, "UTC"));
    const u = xs(utc);
    expect(u.length).toBe(22);
    expect(xs(akl).filter(([id]) => !perWeek.has(id))).toEqual(u.filter(([id]) => !perWeek.has(id)));
    expect(u.filter(([, x]) => x !== null).length).toBeGreaterThan(10);
  });
});

describe("the date range at analyze level", () => {
  const T = Date.UTC(2026, 8, 7, 10); // a Monday
  const FROM = T + 21 * DAY;
  /** Two sessions a week for 6 weeks, each with prompts, actions and an account hash; coverage spans the whole time. */
  const events = (): Ev[] => {
    const out: Ev[] = [covEv(CC, "detail", { from: T, to: T + 42 * DAY })];
    let i = 0;
    for (let w = 0; w < 6; w++) {
      for (const d of [0, 2]) {
        const start = T + (w * 7 + d) * DAY;
        const id = `s${w}-${d}`;
        out.push(sessEv(id, start), idEv(`h-${id}`, { sessionId: id }));
        for (let k = 0; k < 4; k++) out.push(promptEv(id, start + k * 600_000, i++), toolEv(id, start + k * 600_000 + 30_000));
      }
    }
    return out;
  };
  const late = (evs: Ev[]): Ev[] => evs.filter((e) => {
    const x = e as { ts?: number; start?: number; sessionId?: string };
    if (x.start !== undefined) return x.start >= FROM;
    if (x.ts !== undefined) return x.ts >= FROM;
    if (e.k === "identity") return x.sessionId === undefined || Number(x.sessionId.slice(1).split("-")[0]) >= 3;
    return true;
  });

  test("events before `from` contribute nothing to the signals, exposure weeks, coverage spans or identity", () => {
    const now = T + 42 * DAY;
    const o = { ...UTC, now, exclude: { from: FROM } };
    const all = analyze(scanResultOf(events(), { finishedAt: now }), o);
    const only = analyze(scanResultOf(late(events()), { finishedAt: now }), o);
    expect(only.signals.evidence.sessions).toBe(6);
    expect(all.signals).toEqual(only.signals);
    expect(all.exposure.activeWeeks).toEqual(only.exposure.activeWeeks);
    expect(all.exposure.tenureWeeks).toEqual(only.exposure.tenureWeeks);
    expect(all.exposure.weekly).toEqual(only.exposure.weekly);
    expect(all.coverage.rows).toEqual([{ tool: "claude-code", window: "detail", sources: [{ source: CC, status: "ok", beta: false }],
      from: FROM, to: T + 42 * DAY, sessions: 6, prompts: 24, formatChanged: false }]);
    expect(all.identity).toEqual(only.identity);
    expect(all.identity.accounts).toBe(6);
    expect(all.exclusions.sessions).toBe(6);
  });
});
