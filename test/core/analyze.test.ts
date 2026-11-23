import { describe, expect, test } from "bun:test";
import { analyze, type Analysis } from "../../core/analyze";
import { VERSION } from "../../core/index";
import type { CoverageEv, Ev, IdentityEv, PromptEv } from "../../core/model/events";
import { personaScan } from "../fixtures/personas";
import { expectNoCanaries, findCanaries } from "../kit/canary";
import { scanResultOf } from "../kit/scanresult";

const DAY = 86_400_000;
const UTC = { timeZone: "UTC" } as const;

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
      expect(p.label).toMatch(/^P-[0-9A-F]{4,6}$/);
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

  test("excluding the only tool leaves nothing to score", () => {
    const a = analyze(personaScan("expert"), { ...UTC, exclude: { tools: ["claude-code"] } });
    expect(a.exclusions.tools).toBe(1);
    expect(a.dimensions.every((d) => d.status !== "scored")).toBe(true);
    expect(a.projects).toEqual([]);
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
      expect(d.needs).toBeGreaterThan(0);
    }
    expect(a.overall.status).toBe("insufficient");
    expect(a.forensics.band).toBe("unverifiable");
    expect(impurities(a)).toEqual([]);
  });
});

describe("Review Focus 3: one persona under two zones", () => {
  test("every component other than the per-week rates has an equal x under UTC and Pacific/Auckland", () => {
    const raw = personaScan("intermediate", { hourUtc: 0 });
    const xs = (a: Analysis) => a.dimensions.flatMap((d) => d.components.map((c) => [c.id, c.x] as const));
    const utc = xs(analyze(raw, { timeZone: "UTC" }));
    const akl = xs(analyze(personaScan("intermediate", { hourUtc: 0 }), { timeZone: "Pacific/Auckland" }));
    const perWeek = new Set(["orc.headless", "jud.switches", "del.prs"]);
    expect(utc.length).toBe(22);
    expect(akl.filter(([id]) => !perWeek.has(id))).toEqual(utc.filter(([id]) => !perWeek.has(id)));
    expect(utc.filter(([, x]) => x !== null).length).toBeGreaterThan(10);
  });
});
