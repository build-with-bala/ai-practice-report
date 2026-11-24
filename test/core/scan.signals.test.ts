import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ccSid, iso, slug } from "../fixtures/claude-code";

const CHILD = path.join(import.meta.dir, "..", "kit", "scan-child.ts");
/** Four transcripts of typed prompts: a full scan takes seconds, so a signal sent once the scan is under way finds it reading. */
const FILES = 4;
const PROMPTS = 30_000;

let root: string;
let home: string;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "scan-signals-test-"));
  home = path.join(root, "home");
  const dir = path.join(home, ".claude", "projects", slug("/work/signals"));
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now() - 2 * 86_400_000;
  for (let f = 0; f < FILES; f++) {
    const id = ccSid(`G${f}`);
    const lines: string[] = [];
    for (let i = 0; i < PROMPTS; i++) {
      lines.push(JSON.stringify({
        type: "user", sessionId: id, timestamp: iso(t0 + i * 1_000), cwd: "/work/signals", version: "2.1.300", entrypoint: "cli",
        promptSource: "typed", turnOrigin: "human", message: { role: "user", content: `Fix the failing importer test ${i} and rerun the suite` },
      }));
    }
    writeFileSync(path.join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Run { code: number; signal: string | number | null; out: string; leftovers: string[] }
type Mode = "default" | "owned" | "tail" | "overlap" | "overlap-listener" | "stubborn" | "late";

/**
 * Runs the child (test/kit/scan-child.ts) in its own TMPDIR; once it has printed every marker of `on` (by default
 * `copied`: the scan is inside a plugin and holds a temp folder) it sends `sig`, and with `again`, sends it a second
 * time `again` ms later. Ordered by markers, never by a delay that assumes how fast the child runs.
 */
async function runChild(mode: Mode, sig: "SIGINT" | "SIGTERM", o: { on?: string[]; again?: number } = {}): Promise<Run> {
  const tmp = mkdtempSync(path.join(root, "tmp-"));
  const child = Bun.spawn([process.execPath, CHILD, home, tmp, mode], { stdout: "pipe", stderr: "ignore", env: { ...process.env, TMPDIR: tmp } });
  const markers = o.on ?? ["copied"];
  let out = "";
  let sent = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const decoder = new TextDecoder();
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      out += decoder.decode(chunk, { stream: true });
      if (!sent && markers.every((m) => out.includes(m))) {
        sent = true;
        child.kill(sig);
        if (o.again !== undefined) timers.push(setTimeout(() => child.kill(sig), o.again));
      }
    }
  })();
  const code = await child.exited;
  await reading;
  for (const t of timers) clearTimeout(t);
  return { code, signal: child.signalCode, out, leftovers: readdirSync(tmp).filter((n) => n.startsWith("aipr-")) };
}

// Windows has no POSIX signals: a child cannot be sent a SIGINT its handlers would see, so these run on macOS and Linux.
describe.skipIf(process.platform === "win32")("a signal during a scan (child process)", () => {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    test(`${sig} mid-scan: the child ends promptly by that signal, nothing after scan() runs, no aipr-* folder is left`, async () => {
      const r = await runChild("default", sig);
      expect(r.out).toContain("ready");
      expect(r.out).toContain("copied"); // the scan had made its temp folder when the signal came
      expect(r.out).not.toContain("after-scan");
      expect(r.code).not.toBe(0);
      expect(r.signal).toBe(sig);
      expect(r.leftovers).toEqual([]);
    }, 30_000);
  }

  test("handleSignals false: the application's own SIGINT handler aborts; scan() cleans up and resolves with aborted coverage", async () => {
    const r = await runChild("owned", "SIGINT");
    expect(r.code).toBe(0);
    const line = r.out.split("\n").find((l) => l.startsWith("after-scan "));
    expect(line).toBeDefined();
    const got = JSON.parse(line!.slice("after-scan ".length)) as { status: string; note: string; records: number; tempClean: boolean };
    expect(got).toMatchObject({ status: "error", note: "aborted", tempClean: true });
    expect(got.records).toBeLessThan(FILES * PROMPTS); // stopped part-way
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("a SIGINT during the last job's synchronous work, after its last await: the child ends by it, nothing after scan() runs, no aipr-* is left", async () => {
    const r = await runChild("tail", "SIGINT");
    expect(r.out).toContain("copied");
    expect(r.out).not.toContain("after-scan");
    expect(r.signal).toBe("SIGINT");
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("two scans at once and one SIGINT: the child ends by it once both have cleaned up, and neither scan's caller goes on", async () => {
    const r = await runChild("overlap", "SIGINT", { on: ["copied A", "copied B"] });
    expect(r.out).toContain("copied A");
    expect(r.out).toContain("copied B");
    expect(r.out).not.toContain("after-scan A");
    expect(r.out).not.toContain("after-scan B");
    expect(r.signal).toBe("SIGINT");
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("two scans at once while the application keeps a SIGINT listener of its own: the re-raise goes to it, and both scans resolve with aborted coverage", async () => {
    const r = await runChild("overlap-listener", "SIGINT", { on: ["copied A", "copied B"] });
    expect(r.code).toBe(0);
    expect(r.out).toContain("app-listener");
    for (const name of ["A", "B"]) {
      const line = r.out.split("\n").find((l) => l.startsWith(`after-scan ${name} `));
      expect([name, line === undefined ? undefined : JSON.parse(line.slice(`after-scan ${name} `.length))])
        .toEqual([name, { status: "error", note: "aborted", tempClean: true }]);
    }
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("a scan that enters while another unwinds from a SIGINT is aborted at once: never located, and the child ends by the signal", async () => {
    const r = await runChild("late", "SIGINT", { on: ["copied A"] });
    expect(r.out).toContain("copied A");
    expect(r.out).toContain("entering B"); // scan B started while scan A was still inside the trap
    expect(r.out).not.toContain("located B"); // aborted as it entered: its plugin was never located, let alone run
    expect(r.out).not.toContain("after-scan");
    expect(r.signal).toBe("SIGINT");
    expect(r.leftovers).toEqual([]);
  }, 30_000);

  test("a second SIGINT while a plugin ignores the abort: the child ends by it at once, its temp files removed first", async () => {
    const r = await runChild("stubborn", "SIGINT", { again: 200 });
    expect(r.out).toContain("copied");
    expect(r.out).not.toContain("after-scan");
    expect(r.out).not.toContain("stubborn-done"); // the plugin's 3 s of work never finished: the second signal ended the child
    expect(r.signal).toBe("SIGINT");
    expect(r.leftovers).toEqual([]);
  }, 30_000);
});
