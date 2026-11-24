import type { CommitFact, RepoFacts } from "../../core/git/types";
import type { Ev, PromptEv, SessionEv } from "../../core/model/events";
import type { Intent } from "../../core/model/ids";
import { EventStore } from "../../core/model/store";
import type { ScanResult } from "../../core/scan";

/*
 * A large synthetic ScanResult built in memory, for scale tests: no files, no clock, no random source. Everything in it
 * is invented: ids start `synth-`, hashes are `synth-…` tokens, anchor tails carry `Synth`, paths sit under
 * `/synthetic/`.
 *
 * The mix follows a Claude Code transcript store: top-level sessions of 4 to 8 typed turns, each turn a human prompt
 * (and its history line in the lifetime window), 3 model calls (usage, plus a message and a request anchor each), 6 tool
 * calls (reads, a search, edits, a test run that sometimes fails) and a turn end; every third turn delegates to a
 * subagent session with a brief, its own model calls, tool calls and turn. Markers: an interrupt instead of a turn end
 * now and then, commits, PR links, auto-compactions, clears, model switches. Repo signals: 4 repos holding the sessions'
 * 8 projects, with a commit for every commit marker. Top-level sessions start a fixed `SPACING` apart, so the time span
 * grows with the event count and the mix (sessions running at once included) is the same at every size. Each source's
 * coverage comes last, as a reader writes it, with its real record count.
 */

const T0 = Date.UTC(2026, 6, 1);
const SEC = 1_000;
const MIN = 60 * SEC;
/** Between two top-level session starts, whatever their number: sessions last 24 to 48 min, so 2 or 3 run at once. */
const SPACING = 20 * MIN;
/** How long the synthetic scan took. */
const SCAN_MS = 30 * SEC;
const TURN = 6 * MIN;
const PROJECTS = 8;
const REPOS = 4;
const TOOL = "claude-code";
const DETAIL = "claude-code.transcripts";
const LIFETIME = "claude-code.history";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const FOLLOW_UPS: readonly Intent[] = ["continuation", "correction", "question", "ack", "spec", "continuation", "redirect"];

const pad = (n: number, w = 6): string => String(n).padStart(w, "0");
const projectKey = (p: number): string => `synth-p-${p}`;
const repoKey = (r: number): string => `synth-r-${r}`;

/** A message or request id tail in the recognized scheme (`01` + 12 base58 digits rising with time), marked synthetic. */
function idTail(ts: number, seq: number): string {
  let v = Math.floor((ts - T0) / SEC) * 64 + (seq % 64);
  let digits = "";
  for (let i = 0; i < 12; i++) {
    digits = B58[v % 58]! + digits;
    v = Math.floor(v / 58);
  }
  return `01${digits}SynthSynthSynth`;
}

/** A ScanResult of exactly `events` events (coverage included), the same for the same `events`. */
export function synthStore(events: number): ScanResult {
  const store = new EventStore();
  const wanted = Math.max(0, Math.floor(events));
  const coverages = Math.min(2, wanted); // the detail coverage, then the lifetime one: written last, kept first
  let left = wanted - coverages;
  const records = { [DETAIL]: 0, [LIFETIME]: 0 } as Record<string, number>;
  let files = 0; // one transcript per session
  const add = (e: Ev): void => {
    if (left === 0) return;
    left--;
    if (e.k === "session") files++;
    records[(e as { source: string }).source]!++;
    store.add(e);
  };

  const commits: CommitFact[][] = Array.from({ length: REPOS }, () => []);
  const sessionsPerRepo = new Array<number>(REPOS).fill(0);
  let latest = T0;
  let hashes = 0;
  let anchors = 0;
  let commitNo = 0;
  let turnNo = 0;

  const cov = (source: string, window: "detail" | "lifetime", fileCount: number): Ev => ({
    k: "coverage", tool: TOOL, source, window, status: "ok", beta: false, files: fileCount, bytes: records[source]! * 600,
    records: records[source]!, skipped: {}, unknownTypes: {}, versions: ["2.0.0"],
  });

  const modelCall = (sessionId: string, ts: number, model: string, size: number): void => {
    add({ k: "usage", tool: TOOL, source: DETAIL, ts, sessionId, model, inTok: 40 + size, outTok: 300 + size * 7, cacheR: 20_000 + size * 90, cacheW: 1_500 + size * 3 });
    add({ k: "anchor", tool: TOOL, source: DETAIL, kind: "cc-msg", ts, idTail: idTail(ts, anchors++) });
    add({ k: "anchor", tool: TOOL, source: DETAIL, kind: "cc-req", ts, idTail: idTail(ts, anchors++) });
  };
  const prompt = (sessionId: string, ts: number, origin: PromptEv["origin"], intent: Intent, taskStart: boolean, words: number): PromptEv => ({
    k: "prompt", tool: TOOL, source: DETAIL, ts, sessionId, window: "detail", origin, intent, textHash: `synth-h-${pad(hashes++, 8)}`,
    features: { words, lenBucket: words > 80 ? 3 : words > 30 ? 2 : words > 8 ? 1 : 0, hasContext: taskStart, fileRefs: taskStart ? 2 : 0,
      listLines: taskStart ? 3 : 0, constraintTerms: taskStart ? 1 : 0, isTaskStart: taskStart, techCats: taskStart ? { testing: 1 } : {}, chars: words * 6 },
  });

  for (let i = 0; left > 0; i++) {
    const id = `${TOOL}:synth-s-${pad(i)}`;
    const p = i % PROJECTS;
    const repo = p % REPOS;
    sessionsPerRepo[repo]!++;
    const turns = 4 + (i % 5);
    const start = T0 + i * SPACING;
    const end = start + turns * TURN;
    latest = Math.max(latest, end);
    const model = i % 3 === 0 ? "claude-opus-4-1" : "claude-sonnet-4-5";
    const session: SessionEv = { k: "session", tool: TOOL, source: DETAIL, id, window: "detail", origin: "human", start, end, models: [model],
      projectKey: projectKey(p), surface: "cli", version: "2.0.0", inRepo: true };
    if (i % 4 === 0) session.effort = "high";
    add(session);

    for (let j = 0; j < turns; j++) {
      const t = start + j * TURN;
      const step = (n: number): number => t + n * 15 * SEC;
      const taskStart = j === 0 || (i % 5 === 0 && j === 2);
      const human = prompt(id, t, "human", taskStart ? "spec" : FOLLOW_UPS[(i + j) % FOLLOW_UPS.length]!, taskStart, taskStart ? 60 + (i % 40) : 4 + ((i + j) % 20));
      add(human);
      add({ ...human, source: LIFETIME, window: "lifetime", features: { ...human.features } });
      if (i % 5 === 0 && j === 2) add({ k: "marker", tool: TOOL, source: DETAIL, ts: t - SEC, sessionId: id, kind: "clear" });
      if (i % 7 === 3 && j === 1) add({ k: "marker", tool: TOOL, source: DETAIL, ts: t - SEC, sessionId: id, kind: "model-switch", detail: "opus" });

      modelCall(id, step(1), model, j);
      add({ k: "tool", tool: TOOL, source: DETAIL, ts: step(2), sessionId: id, name: "Read", category: "read", ok: true, ms: 40 });
      add({ k: "tool", tool: TOOL, source: DETAIL, ts: step(3), sessionId: id, name: "Grep", category: "search", ok: true, ms: 120 });
      modelCall(id, step(4), model, j + 1);
      add({ k: "tool", tool: TOOL, source: DETAIL, ts: step(5), sessionId: id, name: "Edit", category: "edit", ok: true, editExt: "ts", linesAdded: 12 + (j % 9), linesRemoved: 3 + (j % 4) });
      add({ k: "tool", tool: TOOL, source: DETAIL, ts: step(6), sessionId: id, name: "Bash", category: "test", checks: ["test"], ok: (i + j) % 7 !== 0,
        exit: (i + j) % 7 !== 0 ? 0 : 1, ms: 9_000, toolchain: "js" });
      add({ k: "tool", tool: TOOL, source: DETAIL, ts: step(7), sessionId: id, name: "Read", category: "read", ok: true, ms: 30 });
      add({ k: "tool", tool: TOOL, source: DETAIL, ts: step(8), sessionId: id, name: "Edit", category: "edit", ok: true, editExt: "ts", linesAdded: 4, linesRemoved: 1 });

      if (j % 3 === 2) {
        const childId = `${TOOL}:synth-s-${pad(i)}-a${j}`;
        const c0 = step(10);
        const childEnd = c0 + 60 * SEC;
        add({ k: "tool", tool: TOOL, source: DETAIL, ts: step(9), sessionId: id, name: "Task", category: "delegate", ok: true, delegateTo: childId });
        add({ k: "session", tool: TOOL, source: DETAIL, id: childId, window: "detail", origin: "subagent", start: c0, end: childEnd,
          models: ["claude-haiku-4-5"], parentId: id, projectKey: projectKey(p), surface: "cli", version: "2.0.0", spawnDepth: 1, agentType: "general-purpose", inRepo: true });
        add(prompt(childId, c0, "subagent", "spec", true, 120));
        modelCall(childId, c0 + 5 * SEC, "claude-haiku-4-5", j);
        add({ k: "tool", tool: TOOL, source: DETAIL, ts: c0 + 10 * SEC, sessionId: childId, name: "Glob", category: "search", ok: true });
        add({ k: "tool", tool: TOOL, source: DETAIL, ts: c0 + 15 * SEC, sessionId: childId, name: "Read", category: "read", ok: true });
        add({ k: "tool", tool: TOOL, source: DETAIL, ts: c0 + 20 * SEC, sessionId: childId, name: "Read", category: "read", ok: true });
        modelCall(childId, c0 + 25 * SEC, "claude-haiku-4-5", j + 1);
        add({ k: "tool", tool: TOOL, source: DETAIL, ts: c0 + 30 * SEC, sessionId: childId, name: "Grep", category: "search", ok: true });
        add({ k: "turn", tool: TOOL, source: DETAIL, ts: childEnd, sessionId: childId, window: "detail", model: "claude-haiku-4-5", status: "completed", ms: 60 * SEC });
      }

      modelCall(id, step(15), model, j + 2);
      const done = step(16);
      if (turnNo % 11 === 10) {
        add({ k: "marker", tool: TOOL, source: DETAIL, ts: done, sessionId: id, kind: "interrupt", detail: "user" });
      } else {
        add({ k: "turn", tool: TOOL, source: DETAIL, ts: done, sessionId: id, window: "detail", model, status: "completed", ms: done - t });
      }
      if (turnNo % 4 === 3) {
        const shaKey = `synth-c-${pad(commitNo, 7)}`;
        const fact: CommitFact = { ts: done + 30 * SEC, shaKey, ai: "claude", files: [`synth-f-${commitNo % 50}`, `synth-f-${(commitNo + 7) % 50}`], owner: true, mine: true };
        if (commitNo % 9 === 8) fact.rework = "fixup";
        commits[repo]!.push(fact);
        commitNo++;
        add({ k: "marker", tool: TOOL, source: DETAIL, ts: done + 20 * SEC, sessionId: id, kind: "commit", detail: shaKey });
      }
      if (i % 6 === 5 && j === turns - 2) add({ k: "marker", tool: TOOL, source: DETAIL, ts: done + 25 * SEC, sessionId: id, kind: "compact-auto" });
      turnNo++;
    }
    if (i % 10 === 9) add({ k: "marker", tool: TOOL, source: DETAIL, ts: end - 10 * SEC, sessionId: id, kind: "pr-link", detail: `synth-pr-${pad(i)}` });
  }

  const repos: RepoFacts[] = [];
  const roots = new Map<string, string>();
  const cwds = new Map<string, string>();
  for (let r = 0; r < REPOS; r++) {
    if (sessionsPerRepo[r] === 0) continue;
    const projects = Array.from({ length: PROJECTS }, (_, p) => p).filter((p) => p % REPOS === r);
    repos.push({
      repoKey: repoKey(r), projectKeys: projects.map(projectKey), identity: true, commits: commits[r]!, commitsTruncated: false, fileLists: true,
      instructions: { files: ["claude"], namesChecks: ["test"], touched: 3, lastTouched: T0 },
      hooks: { entries: 1, checks: ["test"], disabled: false },
      ci: { present: true, checks: ["test", "build"] },
      precommit: { present: false, checks: [] },
    });
    roots.set(repoKey(r), `/synthetic/repo-${r}`);
    for (const p of projects) cwds.set(projectKey(p), `/synthetic/repo-${r}/project-${p}`);
  }

  if (coverages >= 1) store.add(cov(DETAIL, "detail", Math.max(1, files)));
  if (coverages >= 2) store.add(cov(LIFETIME, "lifetime", 1));

  const finishedAt = latest + MIN;
  return {
    store, coverage: [...store.all("coverage")], warnings: [], cwds, salt: new Uint8Array(32),
    startedAt: finishedAt - SCAN_MS, finishedAt, tempClean: true,
    repos: { status: "ok", repos, roots, skipped: {}, since: T0, ms: 0 },
  };
}
